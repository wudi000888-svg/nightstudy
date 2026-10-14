import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { audioEntry, synthesisAvailable, verifiedAudioBytes } from './audio.js';

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
  it('does not advertise synthesis when Python or either required model is absent', () => {
    expect(synthesisAvailable()).toBe(false);
    process.env.AUDIO_PYTHON = process.execPath;
    expect(synthesisAvailable()).toBe(false);
    fs.mkdirSync(path.join(process.env.AUDIO_CACHE_DIR!, 'models'));
    fs.writeFileSync(
      path.join(process.env.AUDIO_CACHE_DIR!, 'models/en_US-ljspeech-high.onnx'),
      'test marker; not a model',
    );
    expect(synthesisAvailable()).toBe(false);
  });
});
