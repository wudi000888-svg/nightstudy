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
  it('accepts only explicit reviewed surface identity, still requiring its actual occurrence', () => {
    const targetSurface = {
      lemma: 'window',
      form: 'windows',
      kind: 'inflected-form',
      review: 'codex-reviewed',
    };
    const f = fixture({
      ...valid,
      examples: [{ ...valid.examples[0], exampleEn: 'The windows are open.', targetSurface }],
    });
    expect(readBilingualRows(f.bytes, f.manifest)[0]!.examples[0]!.targetSurface).toEqual(
      targetSurface,
    );
    for (const changed of [
      { ...targetSurface, lemma: 'door' },
      { ...targetSurface, form: 'window' },
      { ...targetSurface, form: 'doors' },
      { ...targetSurface, review: 'pending' },
    ]) {
      const bad = fixture({
        ...valid,
        examples: [
          { ...valid.examples[0], exampleEn: 'The windows are open.', targetSurface: changed },
        ],
      });
      expect(() => readBilingualRows(bad.bytes, bad.manifest)).toThrow();
    }
  });
  it('binds POS additions to the exact Chinese source and requires attribution', () => {
    const sense = {
      ...valid.senses[0],
      pos: 'n.',
      sourceDefinitionZhSha256: hash('窗户'),
      contentMetadata: {
        ...valid.senses[0]!.contentMetadata,
        pos: { kind: 'original-authoring', license: 'MIT' },
      },
    };
    const good = fixture({ ...valid, senses: [sense] });
    expect(readBilingualRows(good.bytes, good.manifest)[0]!.senses[0]!.pos).toBe('n.');
    const bad = fixture({ ...valid, senses: [{ ...sense, sourceDefinitionZhSha256: undefined }] });
    expect(() => readBilingualRows(bad.bytes, bad.manifest)).toThrow('pos_source_identity');
  });
  it('accepts only dual-source-bound, separately authored Chinese example corrections', () => {
    const correction = {
      id: 'published-window-example',
      sourceExampleEnSha256: hash('Please close the window.'),
      sourceExampleZhSha256: hash('请打开窗户。'),
      exampleZh: '请关上窗户。',
      reason: 'The source Chinese reverses the action.',
      contentMetadata: {
        exampleZh: {
          kind: 'original-authoring',
          author: 'NightStudy contributors',
          license: 'MIT',
          review: 'pending',
          sourceLanguage: 'en',
          sourceTextSha256: hash('Please close the window.'),
          translatedFrom: { kind: 'corpus', source: 'Synthetic source' },
        },
      },
    };
    const value = { ...valid, exampleCorrections: [correction] };
    const good = fixture(value);
    expect(readBilingualRows(good.bytes, good.manifest)[0]!.exampleCorrections).toEqual([
      correction,
    ]);
    for (const changed of [
      { ...correction, sourceExampleEnSha256: undefined },
      { ...correction, sourceExampleZhSha256: 'invalid' },
      { ...correction, exampleEn: 'A replacement English sentence.' },
      { ...correction, exampleZh: ' ' },
      { ...correction, reason: ' ' },
      {
        ...correction,
        contentMetadata: {
          ...correction.contentMetadata,
          exampleEn: correction.contentMetadata.exampleZh,
        },
      },
      {
        ...correction,
        contentMetadata: {
          exampleZh: { ...correction.contentMetadata.exampleZh, kind: 'machine-translation' },
        },
      },
    ]) {
      const bad = fixture({ ...valid, exampleCorrections: [changed] });
      expect(() => readBilingualRows(bad.bytes, bad.manifest)).toThrow();
    }
    const duplicate = fixture({ ...valid, exampleCorrections: [correction, correction] });
    expect(() => readBilingualRows(duplicate.bytes, duplicate.manifest)).toThrow(
      'duplicate_example_correction',
    );
    const newEnglishProvenance = {
      kind: 'original-authoring',
      author: 'NightStudy contributors',
      license: 'MIT',
      review: 'pending',
      language: 'en',
      sourceTextSha256: hash('The window is closed.'),
    };
    const paired = {
      ...correction,
      exampleEn: 'The window is closed.',
      exampleZh: '窗户已经关上了。',
      contentMetadata: {
        exampleZh: {
          ...correction.contentMetadata.exampleZh,
          sourceTextSha256: hash('The window is closed.'),
          translatedFrom: newEnglishProvenance,
        },
        exampleEn: newEnglishProvenance,
      },
    };
    const full = fixture({ ...valid, exampleCorrections: [paired] });
    expect(readBilingualRows(full.bytes, full.manifest)[0]!.exampleCorrections).toEqual([paired]);
    for (const changed of [
      {
        ...correction,
        contentMetadata: {
          exampleZh: { ...correction.contentMetadata.exampleZh, translatedFrom: undefined },
        },
      },
      {
        ...correction,
        contentMetadata: {
          exampleZh: { ...correction.contentMetadata.exampleZh, translatedFrom: [] },
        },
      },
      {
        ...paired,
        contentMetadata: {
          ...paired.contentMetadata,
          exampleZh: {
            ...paired.contentMetadata.exampleZh,
            translatedFrom: correction.contentMetadata.exampleZh.translatedFrom,
          },
        },
      },
      {
        ...correction,
        contentMetadata: {
          exampleZh: { ...correction.contentMetadata.exampleZh, sourceLanguage: undefined },
        },
      },
      {
        ...correction,
        contentMetadata: {
          exampleZh: { ...correction.contentMetadata.exampleZh, sourceTextSha256: undefined },
        },
      },
      {
        ...correction,
        contentMetadata: {
          exampleZh: { ...correction.contentMetadata.exampleZh, sourceLanguage: 'zh' },
        },
      },
      {
        ...correction,
        contentMetadata: {
          exampleZh: {
            ...correction.contentMetadata.exampleZh,
            sourceTextSha256: hash(correction.exampleZh),
          },
        },
      },
      {
        ...paired,
        contentMetadata: {
          ...paired.contentMetadata,
          exampleEn: { ...paired.contentMetadata.exampleEn, language: undefined },
        },
      },
      {
        ...paired,
        contentMetadata: {
          ...paired.contentMetadata,
          exampleEn: { ...paired.contentMetadata.exampleEn, sourceTextSha256: undefined },
        },
      },
      {
        ...paired,
        contentMetadata: {
          ...paired.contentMetadata,
          exampleEn: { ...paired.contentMetadata.exampleEn, language: 'zh-CN' },
        },
      },
      {
        ...paired,
        contentMetadata: {
          ...paired.contentMetadata,
          exampleEn: {
            ...paired.contentMetadata.exampleEn,
            sourceTextSha256: correction.sourceExampleEnSha256,
          },
        },
      },
      {
        ...paired,
        contentMetadata: {
          ...paired.contentMetadata,
          exampleZh: correction.contentMetadata.exampleZh,
        },
      },
    ]) {
      const bad = fixture({ ...valid, exampleCorrections: [changed] });
      expect(() => readBilingualRows(bad.bytes, bad.manifest)).toThrow();
    }
  });
  it('requires complete, exact English binding for authored example text and its Chinese translation', () => {
    const authorship = {
      kind: 'original-authoring',
      author: 'NightStudy contributors',
      license: 'MIT',
      review: 'pending',
      sourceTextSha256: hash(valid.examples[0]!.exampleEn),
    };
    const metadata = {
      exampleEn: { ...authorship, language: 'en' },
      exampleZh: { ...authorship, sourceLanguage: 'en' },
    };
    const example = { ...valid.examples[0], contentMetadata: metadata };
    const good = fixture({ ...valid, examples: [example] });
    expect(readBilingualRows(good.bytes, good.manifest)[0]!.examples[0]!.contentMetadata).toEqual(
      metadata,
    );
    for (const field of ['exampleEn', 'exampleZh'] as const) {
      const language = field === 'exampleEn' ? 'language' : 'sourceLanguage';
      for (const patch of [
        { sourceTextSha256: undefined },
        { sourceTextSha256: hash(example.exampleZh!) },
        { [language]: undefined },
        { [language]: 'zh' },
        { author: undefined },
        { license: undefined },
        { review: undefined },
      ]) {
        const bad = fixture({
          ...valid,
          examples: [
            {
              ...example,
              contentMetadata: { ...metadata, [field]: { ...metadata[field], ...patch } },
            },
          ],
        });
        expect(() => readBilingualRows(bad.bytes, bad.manifest)).toThrow(
          'authorship_source_mismatch',
        );
      }
      for (const provenance of [{}, [], null, 'not-provenance']) {
        const bad = fixture({
          ...valid,
          examples: [{ ...example, contentMetadata: { ...metadata, [field]: provenance } }],
        });
        expect(() => readBilingualRows(bad.bytes, bad.manifest)).toThrow('missing_provenance');
      }
    }
  });
});
