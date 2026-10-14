import fs from 'node:fs/promises';
import { existsSync, constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { HttpError } from './context.js';

export const audioEntry = z
  .object({
    lemma: z.string().min(1).max(160),
    accent: z.enum(['US', 'UK']),
    kind: z.enum(['recorded', 'synthesized']),
    sourceName: z.string().max(300),
    sourceUrl: z.string().url().startsWith('https://'),
    license: z.string().min(1).max(160),
    attribution: z.string().min(1).max(2000),
    fileKey: z.string().regex(/^files\/[a-f0-9]{64}\.(?:wav|ogg|mp3)$/),
    fileSha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.enum(['audio/wav', 'audio/ogg', 'audio/mpeg']),
    phonetic: z.string().max(300).optional(),
    phoneticSource: z.string().max(500).optional(),
  })
  .passthrough();
export const audioCacheRoot = () => path.resolve(process.env.AUDIO_CACHE_DIR || '.local/audio');
export const audioPython = () => process.env.AUDIO_PYTHON || '/opt/nightstudy-audio/bin/python';
export function synthesisAvailable() {
  return (
    existsSync(audioPython()) &&
    existsSync(path.join(audioCacheRoot(), 'models/en_US-ljspeech-high.onnx')) &&
    existsSync(path.join(audioCacheRoot(), 'models/en_GB-cori-high.onnx'))
  );
}
export async function verifiedAudioBytes(entry: {
  fileKey: string;
  fileSha256: string;
  mimeType: string;
}) {
  if (
    !/^files\/[a-f0-9]{64}\.(?:wav|ogg|mp3)$/.test(entry.fileKey) ||
    !/^[a-f0-9]{64}$/.test(entry.fileSha256) ||
    !entry.fileKey.includes(entry.fileSha256)
  )
    throw new HttpError(503, 'audio_asset_invalid');
  const filename = path.join(audioCacheRoot(), entry.fileKey);
  const files = path.join(audioCacheRoot(), 'files');
  const folder = await fs.lstat(files).catch(() => null);
  if (!folder?.isDirectory() || folder.isSymbolicLink())
    throw new HttpError(503, 'audio_asset_unavailable');
  const [realFolder, realFilename] = await Promise.all([
    fs.realpath(files),
    fs.realpath(filename).catch(() => null),
  ]);
  if (
    !realFilename ||
    path.dirname(realFilename) !== realFolder ||
    realFilename !== path.join(realFolder, path.basename(filename))
  )
    throw new HttpError(503, 'audio_asset_unavailable');
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new HttpError(503, 'audio_asset_unavailable');
  });
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 32 || stat.size > 2 * 1024 * 1024)
      throw new HttpError(503, 'audio_asset_unavailable');
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (createHash('sha256').update(bytes).digest('hex') !== entry.fileSha256)
    throw new HttpError(503, 'audio_asset_invalid');
  const wav =
    bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE';
  const ogg = bytes.subarray(0, 4).toString() === 'OggS';
  const mp3 =
    bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
  if (!(
    (entry.mimeType === 'audio/wav' && wav) ||
    (entry.mimeType === 'audio/ogg' && ogg) ||
    (entry.mimeType === 'audio/mpeg' && mp3)
  ))
    throw new HttpError(503, 'audio_asset_invalid');
  return bytes;
}
let running = 0;
function renderOne(word: string, accent: 'US' | 'UK') {
  return new Promise<z.infer<typeof audioEntry>>((resolve, reject) => {
    const child = spawn(
      audioPython(),
      [
        'scripts/audio-pack.py',
        '--request-json',
        '--output',
        audioCacheRoot(),
        '--model-dir',
        path.join(audioCacheRoot(), 'models'),
        '--cpu-threads',
        '2',
      ],
      { shell: false, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let output = '',
      settled = false;
    const finish = (error?: Error, entry?: z.infer<typeof audioEntry>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else resolve(entry!);
    };
    const timer = setTimeout(() => finish(new HttpError(504, 'audio_generation_timeout')), 20000);
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString('utf8');
      if (output.length > 16384) finish(new HttpError(503, 'audio_generation_failed'));
    });
    child.once('error', () => finish(new HttpError(503, 'audio_generation_unavailable')));
    child.once('close', (code) => {
      try {
        if (code !== 0) throw new Error('renderer_failed');
        const entry = audioEntry.parse(JSON.parse(output));
        if (entry.lemma !== word || entry.accent !== accent || entry.kind !== 'synthesized')
          throw new Error('renderer_binding_mismatch');
        finish(undefined, entry);
      } catch {
        finish(new HttpError(503, 'audio_generation_failed'));
      }
    });
    child.stdin.on('error', () => finish(new HttpError(503, 'audio_generation_failed')));
    child.stdin.end(JSON.stringify({ word, accent }));
  });
}
export async function prepareWordAudio(
  prisma: PrismaClient,
  word: { id: string; normalizedLemma: string; phoneticUs: string; phoneticUk: string },
) {
  if (!synthesisAvailable()) throw new HttpError(503, 'audio_generation_unavailable');
  if (!word.phoneticUs.trim() || !word.phoneticUk.trim())
    throw new HttpError(409, 'audio_missing_phonetics');
  if (running >= 2) throw new HttpError(429, 'audio_generation_busy');
  running++;
  try {
    for (const accent of ['US', 'UK'] as const) {
      const existing = await prisma.wordAudio.findUnique({
        where: { wordId_accent: { wordId: word.id, accent } },
      });
      if (existing?.status === 'ready') {
        try {
          await verifiedAudioBytes(existing);
          continue;
        } catch {
          /* Recover a lost cache file. */
        }
      }
      const jobId = `pronunciation:${word.id}:${accent}`;
      await prisma.job.upsert({
        where: { id: jobId },
        create: {
          id: jobId,
          type: 'pronunciation',
          status: 'pending',
          runAfter: new Date(Date.now() + 45000),
          payload: { wordId: word.id, accent },
        },
        update: {},
      });
      const claim = await prisma.$queryRaw<
        Array<{ id: string }>
      >`UPDATE "Job" SET "status"='running',"lockedUntil"=NOW()+INTERVAL '45 seconds',"runAfter"=NOW()+INTERVAL '45 seconds',"updatedAt"=NOW() WHERE "id"=${jobId} AND ("status"<>'running' OR "lockedUntil"<NOW()) RETURNING "id"`;
      if (!claim.length) throw new HttpError(409, 'audio_preparing');
      try {
        const entry = await renderOne(word.normalizedLemma, accent);
        await verifiedAudioBytes(entry);
        const {
          lemma: _,
          phonetic: __,
          phoneticSource: ___,
          ...metadata
        } = audioEntry.strip().parse(entry);
        await prisma.$transaction(async (tx) => {
          await tx.wordAudio.upsert({
            where: { wordId_accent: { wordId: word.id, accent } },
            create: { wordId: word.id, ...metadata },
            update: { ...metadata, status: 'ready' },
          });
          await tx.job.update({
            where: { id: jobId },
            data: {
              status: 'completed',
              lockedUntil: null,
              result: { fileSha256: entry.fileSha256 },
            },
          });
        });
      } catch (error) {
        await prisma.job.update({
          where: { id: jobId },
          data: {
            status: 'failed',
            lockedUntil: null,
            result: { code: 'audio_generation_failed' },
          },
        });
        throw error;
      }
    }
  } finally {
    running--;
  }
}
