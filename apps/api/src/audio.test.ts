import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  audioEntry,
  sentenceTextHash,
  normalizeSentenceText,
  verifiedAudioBytes,
} from './audio.js';

function pcmTone() {
  const bytes = Buffer.alloc(44 + 256);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(256, 40);
  for (let index = 0; index < 128; index++)
    bytes.writeInt16LE(
      Math.round(Math.sin((index * 2 * Math.PI * 440) / 16000) * 1000),
      44 + index * 2,
    );
  return bytes;
}
async function trackAssetReads(filenames: Set<string>) {
  const first = filenames.values().next().value!;
  const probe = await fsp.open(first, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const handles = new WeakSet<object>();
  const originalOpen = fsp.open.bind(fsp),
    originalReadFile = prototype.readFile;
  let count = 0;
  const opens = vi.spyOn(fsp, 'open').mockImplementation(async (filename, flags, mode) => {
    const handle = await originalOpen(filename, flags, mode);
    if (typeof filename === 'string' && filenames.has(filename)) handles.add(handle);
    return handle;
  });
  const reads = vi.spyOn(prototype, 'readFile').mockImplementation(function (
    this: object,
    ...args: unknown[]
  ) {
    if (handles.has(this)) count++;
    return Reflect.apply(originalReadFile, this, args);
  });
  return {
    count: () => count,
    restore: () => {
      reads.mockRestore();
      opens.mockRestore();
    },
  };
}

describe('audio asset metadata and filesystem boundaries', () => {
  let directory = '',
    originalCache: string | undefined,
    originalPython: string | undefined;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-audio-unit-'));
    originalCache = process.env.AUDIO_CACHE_DIR;
    originalPython = process.env.AUDIO_PYTHON;
    process.env.AUDIO_CACHE_DIR = path.join(directory, 'cache');
    process.env.AUDIO_PYTHON = path.join(directory, 'absent-python');
    fs.mkdirSync(path.join(process.env.AUDIO_CACHE_DIR, 'files'), { recursive: true });
  });
  afterEach(() => {
    if (originalCache === undefined) delete process.env.AUDIO_CACHE_DIR;
    else process.env.AUDIO_CACHE_DIR = originalCache;
    if (originalPython === undefined) delete process.env.AUDIO_PYTHON;
    else process.env.AUDIO_PYTHON = originalPython;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function fixture(bytes = pcmTone()) {
    const hash = createHash('sha256').update(bytes).digest('hex'),
      fileKey = `files/${hash}.wav`;
    fs.writeFileSync(path.join(process.env.AUDIO_CACHE_DIR!, fileKey), bytes);
    return { fileKey, fileSha256: hash, mimeType: 'audio/wav' };
  }
  it('validates the licensed asset shape without accepting URL or path traversal as a file key', () => {
    const metadata = {
      ...fixture(),
      lemma: 'rain',
      accent: 'US',
      kind: 'synthesized',
      sourceName: 'Synthetic PCM test tone; not speech',
      sourceUrl: 'https://example.test/test-fixture',
      license: 'MIT',
      attribution: 'Original synthetic test tone',
    };
    expect(audioEntry.safeParse(metadata).success).toBe(true);
    for (const fileKey of [
      '../private.wav',
      '/etc/passwd',
      'https://example.test/audio.wav',
      'files/../../private.wav',
    ])
      expect(audioEntry.safeParse({ ...metadata, fileKey }).success).toBe(false);
    expect(audioEntry.safeParse({ ...metadata, accent: 'AU' }).success).toBe(false);
    expect(audioEntry.safeParse({ ...metadata, sourceUrl: 'http://example.test' }).success).toBe(
      false,
    );
  });
  it('verifies digest and MIME signatures before returning bytes', async () => {
    const entry = fixture();
    await expect(verifiedAudioBytes(entry)).resolves.toEqual(pcmTone());
    await expect(verifiedAudioBytes({ ...entry, mimeType: 'audio/ogg' })).rejects.toMatchObject({
      code: 'audio_asset_invalid',
    });
    const changed = Buffer.from(pcmTone());
    changed[44] = changed[44]! ^ 1;
    fs.writeFileSync(path.join(process.env.AUDIO_CACHE_DIR!, entry.fileKey), changed);
    await expect(verifiedAudioBytes(entry)).rejects.toMatchObject({ code: 'audio_asset_invalid' });
    await expect(verifiedAudioBytes({ ...entry, fileKey: '../private.wav' })).rejects.toMatchObject(
      { code: 'audio_asset_invalid' },
    );
  });
  it('rejects a leaf symlink and an intermediate cache-directory symlink to private files', async () => {
    const bytes = pcmTone(),
      hash = createHash('sha256').update(bytes).digest('hex');
    const privateDirectory = path.join(directory, 'private');
    fs.mkdirSync(privateDirectory);
    const privateFilename = path.join(privateDirectory, `${hash}.wav`);
    fs.writeFileSync(privateFilename, bytes);
    const entry = { fileKey: `files/${hash}.wav`, fileSha256: hash, mimeType: 'audio/wav' };
    const target = path.join(process.env.AUDIO_CACHE_DIR!, entry.fileKey);
    fs.writeFileSync(target, bytes);
    await verifiedAudioBytes(entry);
    fs.unlinkSync(target);
    fs.symlinkSync(privateFilename, target);
    await expect(verifiedAudioBytes(entry)).rejects.toMatchObject({
      code: 'audio_asset_unavailable',
    });
    fs.unlinkSync(target);
    fs.rmdirSync(path.join(process.env.AUDIO_CACHE_DIR!, 'files'));
    fs.symlinkSync(privateDirectory, path.join(process.env.AUDIO_CACHE_DIR!, 'files'));
    await expect(verifiedAudioBytes(entry)).rejects.toMatchObject({
      code: 'audio_asset_unavailable',
    });
  });
  it('reuses verified bytes only after a new descriptor stat, and rejects tampering even when mtime is restored', async () => {
    const entry = fixture();
    const target = path.join(process.env.AUDIO_CACHE_DIR!, entry.fileKey);
    const reads = await trackAssetReads(new Set([target]));
    try {
      const first = await verifiedAudioBytes(entry);
      first[0] = 0;
      expect(await verifiedAudioBytes(entry)).toEqual(pcmTone());
      expect(reads.count()).toBe(1);
      const originalStat = fs.statSync(target);
      const changed = pcmTone();
      changed[50] = changed[50]! ^ 1;
      fs.writeFileSync(target, changed);
      fs.utimesSync(target, originalStat.atime, originalStat.mtime);
      await expect(verifiedAudioBytes(entry)).rejects.toMatchObject({
        code: 'audio_asset_invalid',
      });
      expect(reads.count()).toBe(2);
      fs.writeFileSync(target, pcmTone());
      expect(await verifiedAudioBytes(entry)).toEqual(pcmTone());
      expect(reads.count()).toBe(3);
    } finally {
      reads.restore();
    }
  });
  it('evicts the least recently used audio once the 32 MiB byte limit is reached', async () => {
    const entries = Array.from({ length: 17 }, (_, index) => {
      const bytes = Buffer.alloc(2 * 1024 * 1024);
      pcmTone().copy(bytes);
      bytes[bytes.length - 1] = index;
      return fixture(bytes);
    });
    const reads = await trackAssetReads(
      new Set(entries.map((entry) => path.join(process.env.AUDIO_CACHE_DIR!, entry.fileKey))),
    );
    try {
      for (const entry of entries) await verifiedAudioBytes(entry);
      expect(reads.count()).toBe(17);
      await verifiedAudioBytes(entries[16]!);
      expect(reads.count()).toBe(17);
      await verifiedAudioBytes(entries[0]!);
      expect(reads.count()).toBe(18);
    } finally {
      reads.restore();
    }
  });
  it('deduplicates sentence whitespace and quote forms while keeping lexical case', () => {
    expect(normalizeSentenceText('  It’s  raining.  ')).toBe("It's raining.");
    expect(sentenceTextHash('  It’s  raining.  ')).toBe(sentenceTextHash("It's raining."));
    expect(sentenceTextHash('US')).not.toBe(sentenceTextHash('us'));
  });
});
