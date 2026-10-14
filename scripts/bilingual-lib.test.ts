import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readBilingualRows, type BilingualManifest } from './bilingual-lib.js';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixture(value: unknown) {
  const text = JSON.stringify(value) + '\n';
  const bytes = gzipSync(text);
  const manifest: BilingualManifest = {
    formatVersion: 1,
    id: 'synthetic-bilingual-fixture',
    version: 'fixture-1',
    fileName: 'fixture.jsonl.gz',
    bytes: bytes.length,
    sha256: hash(bytes),
    jsonlSha256: hash(text),
    sourceUrl: 'https://example.invalid/fixture',
    license: 'MIT',
    wordCount: 1,
    scope: 'synthetic test only',
  };
  return { bytes, manifest };
}
const valid = {
  normalizedLemma: 'window',
  senses: [
    {
      id: 'synthetic-window-sense',
      definitionEn: 'An opening with glass in a wall.',
      contentMetadata: {
        definitionEn: {
          kind: 'machine-translation',
          sourceTextSha256: hash('窗户'),
          review: 'pending',
        },
      },
    },
  ],
  examples: [
    {
      exampleEn: 'Please close the window.',
      exampleZh: '请关上窗户。',
      contentMetadata: {
        exampleEn: { kind: 'generated', review: 'pending' },
        exampleZh: { kind: 'generated', review: 'pending' },
      },
    },
  ],
};
describe('bilingual content pack boundary', () => {
  it('preserves exact sense identity and independent bilingual usage', () => {
    const { bytes, manifest } = fixture(valid);
    expect(readBilingualRows(bytes, manifest)).toEqual([valid]);
  });
  it('rejects tampered compressed bytes and uncompressed content', () => {
    const { bytes, manifest } = fixture(valid);
    expect(() => readBilingualRows(bytes, { ...manifest, sha256: '0'.repeat(64) })).toThrow(
      'checksum',
    );
    expect(() => readBilingualRows(bytes, { ...manifest, jsonlSha256: '0'.repeat(64) })).toThrow(
      'checksum',
    );
  });
  it('requires original-language checksum for every translated field', () => {
    const { bytes, manifest } = fixture({
      ...valid,
      senses: [{ ...valid.senses[0], contentMetadata: {} }],
    });
    expect(() => readBilingualRows(bytes, manifest)).toThrow('translation_identity');
  });
  it('requires an exact English target word in usage and both sources', () => {
    const f = fixture({
      ...valid,
      examples: [{ ...valid.examples[0], exampleEn: 'The windows are open.' }],
    });
    expect(() => readBilingualRows(f.bytes, f.manifest)).toThrow('missing_exact_word');
    const missing = fixture({
      ...valid,
      examples: [{ ...valid.examples[0], contentMetadata: { exampleEn: { kind: 'generated' } } }],
    });
    expect(() => readBilingualRows(missing.bytes, missing.manifest)).toThrow('missing_provenance');
  });
  it('rejects a count mismatch and nonnormalized identity', () => {
    const f = fixture(valid);
    expect(() => readBilingualRows(f.bytes, { ...f.manifest, wordCount: 2 })).toThrow(
      'count_mismatch',
    );
    const bad = fixture({ ...valid, normalizedLemma: ' Window ' });
    expect(() => readBilingualRows(bad.bytes, bad.manifest)).toThrow('unnormalized_word');
  });
});
