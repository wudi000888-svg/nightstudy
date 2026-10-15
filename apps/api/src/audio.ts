import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
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
    fileKey: z.string().regex(/^files\/[a-f0-9]{64}\.(?:wav|ogg|mp3|flac)$/),
    fileSha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.enum(['audio/wav', 'audio/ogg', 'audio/mpeg', 'audio/flac']),
    phonetic: z.string().max(300).optional(),
    phoneticSource: z.string().max(500).optional(),
  })
  .passthrough();
export const audioCacheRoot = () => path.resolve(process.env.AUDIO_CACHE_DIR || '.local/audio');
// Python is used only to safely unpack prebuilt content artifacts, never speech.
export const audioPython = () => process.env.AUDIO_PYTHON || 'python3';
export const normalizeSentenceText = (text: string) =>
  text.normalize('NFKC').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
export const sentenceTextHash = (text: string) =>
  createHash('sha256').update(normalizeSentenceText(text)).digest('hex');
const audioByteCache = new Map<string, { stamp: string; bytes: Buffer }>();
const maxCachedBytes = 32 * 1024 * 1024;
const maxCachedFiles = 256;
let cachedBytes = 0;
function forgetCachedAudio(key: string) {
  const previous = audioByteCache.get(key);
  if (previous) cachedBytes -= previous.bytes.length;
  audioByteCache.delete(key);
}
function cacheAudio(key: string, stamp: string, bytes: Buffer) {
  forgetCachedAudio(key);
  while (cachedBytes + bytes.length > maxCachedBytes || audioByteCache.size >= maxCachedFiles) {
    const oldest = audioByteCache.keys().next().value;
    if (!oldest) break;
    forgetCachedAudio(oldest);
  }
  audioByteCache.set(key, { stamp, bytes: Buffer.from(bytes) });
  cachedBytes += bytes.length;
}
export async function verifiedAudioBytes(entry: {
  fileKey: string;
  fileSha256: string;
  mimeType: string;
}) {
  if (
    !/^files\/[a-f0-9]{64}\.(?:wav|ogg|mp3|flac)$/.test(entry.fileKey) ||
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
  let stamp = '';
  const cacheKey = `${realFilename}:${entry.fileSha256}:${entry.mimeType}`;
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size < 32n || stat.size > 2n * 1024n * 1024n)
      throw new HttpError(503, 'audio_asset_unavailable');
    stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const cached = audioByteCache.get(cacheKey);
    if (cached?.stamp === stamp) {
      audioByteCache.delete(cacheKey);
      audioByteCache.set(cacheKey, cached);
      return Buffer.from(cached.bytes);
    }
    forgetCachedAudio(cacheKey);
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (createHash('sha256').update(bytes).digest('hex') !== entry.fileSha256)
    throw new HttpError(503, 'audio_asset_invalid');
  const wav =
    bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE';
  const ogg = bytes.subarray(0, 4).toString() === 'OggS';
  const flac = bytes.subarray(0, 4).toString() === 'fLaC';
  const mp3 =
    bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
  if (!(
    (entry.mimeType === 'audio/wav' && wav) ||
    (entry.mimeType === 'audio/ogg' && ogg) ||
    (entry.mimeType === 'audio/flac' && flac) ||
    (entry.mimeType === 'audio/mpeg' && mp3)
  ))
    throw new HttpError(503, 'audio_asset_invalid');
  cacheAudio(cacheKey, stamp, bytes);
  return bytes;
}
