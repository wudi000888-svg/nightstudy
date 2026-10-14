import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  importPhraseRows,
  phraseTokens,
  readPhraseRows,
  type PhraseManifest,
} from './phrase-lib.js';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const source = '照顾';
  const exampleEn = 'I will take care of your plants tomorrow.';
  const exampleZh = '我明天会照顾你的植物。';
  const original = {
    kind: 'generated',
    review: 'pending',
    license: 'MIT',
    author: 'NightStudy contributors',
    authoringMethod: 'Codex-assisted original writing',
  };
  const row = {
    normalizedLemma: 'take care of',
    book: 'cet4-phrases',
    sourceWordId: 'existing-word',
    sourceFocusSenseId: 'existing-sense',
    sourceFocusTextSha256: hash(source),
    focusSenseId: 'existing-sense',
    senses: [
      {
        id: 'existing-sense',
        sourceText: source,
        sourceTextSha256: hash(source),
        definitionEn: 'To look after someone or something.',
        contentMetadata: {
          definitionEn: {
            kind: 'original-authoring',
            review: 'pending',
            license: 'MIT',
            author: 'NightStudy contributors',
            sourceLanguage: 'zh',
            sourceTextSha256: hash(source),
            sourceSenseId: 'existing-sense',
          },
        },
      },
    ],
    qualityWarnings: [],
    examples: [
      {
        exampleEn,
        exampleZh,
        contentMetadata: {
          exampleEn: { ...original, language: 'en' },
          exampleZh: { ...original, language: 'zh' },
        },
      },
    ],
    collocationTokens: ['take', 'care'],
  };
  return row;
}
function pack(rows: unknown[]) {
  const decoded = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const bytes = gzipSync(decoded);
  const manifest: PhraseManifest = {
    formatVersion: 1,
    id: 'phrase-books-v1',
    version: 'fixture',
    fileName: 'fixture.jsonl.gz',
    bytes: bytes.length,
    sha256: hash(bytes),
    jsonlSha256: hash(decoded),
    sourceUrl: 'https://example.test/fixture',
    license: 'MIT',
    wordCount: rows.length,
    kind: 'phrase-books',
    bookCounts: { 'cet4-phrases': rows.length, 'cet6-phrases': 0 },
    tagCounts: { 'phrase-books': rows.length },
    statistics: {},
  };
  return { bytes, manifest };
}
describe('phrase source pack parser without database mutation', () => {
  it('keeps existing identities and classifies authored glosses', () => {
    const p = pack([fixture()]);
    const [row] = readPhraseRows(p.bytes, p.manifest);
    expect(row!.sourceWordId).toBe('existing-word');
    expect(row!.focusSenseId).toBe('existing-sense');
    expect((row!.senses[0]!.contentMetadata.definitionEn as { kind: string }).kind).toBe(
      'original-authoring',
    );
  });
  it('rejects bad gzip checksum before parsing', () => {
    const p = pack([fixture()]);
    expect(() => readPhraseRows(Buffer.concat([p.bytes, Buffer.from('x')]), p.manifest)).toThrow(
      'checksum',
    );
  });
  it('rejects decoded digest mismatch', () => {
    const p = pack([fixture()]);
    p.manifest.jsonlSha256 = '0'.repeat(64);
    expect(() => readPhraseRows(p.bytes, p.manifest)).toThrow('checksum');
  });
  it('rejects source hash that claims trimmed original bytes', () => {
    const r = fixture();
    r.senses[0]!.sourceText += ' ';
    const p = pack([r]);
    expect(() => readPhraseRows(p.bytes, p.manifest)).toThrow('source_identity');
  });
  it('rejects invented model attribution on an original gloss', () => {
    const r = fixture();
    Object.assign(r.senses[0]!.contentMetadata.definitionEn, { model: 'not-used' });
    const p = pack([r]);
    expect(() => readPhraseRows(p.bytes, p.manifest)).toThrow('authoring_invalid');
  });
  it('rejects duplicate phrase rows', () => {
    const p = pack([fixture(), fixture()]);
    expect(() => readPhraseRows(p.bytes, p.manifest)).toThrow('duplicate_phrase');
  });
  it('requires literal phrase rather than inflected replacement', () => {
    const r = fixture();
    r.examples[0]!.exampleEn = 'She takes care of the garden.';
    const p = pack([r]);
    expect(() => readPhraseRows(p.bytes, p.manifest)).toThrow('exact_phrase');
  });
  it('rejects fabricated corpus labels without two-sentence provenance', () => {
    const r = fixture();
    Object.assign(r.examples[0]!.contentMetadata.exampleEn, {
      kind: 'corpus',
      license: 'CC-BY-2.0-FR',
    });
    const p = pack([r]);
    expect(() => readPhraseRows(p.bytes, p.manifest)).toThrow('corpus_attribution');
  });
  it('bounds exact collocation tokens and excludes grammatical stopwords', () => {
    expect(phraseTokens('take care of')).toEqual(['take', 'care']);
    expect(phraseTokens('in spite of')).toEqual(['spite']);
  });
  it('rejects a synthetic installer fixture outside a test database before connecting', async () => {
    const p = pack([fixture()]);
    p.manifest.id = 'phrase-books-fixture-v1';
    await expect(
      importPhraseRows(
        { id: 'fixture-site', databaseUrl: 'postgresql://fixture:fixture@127.0.0.1/ordinary_db' },
        readPhraseRows(p.bytes, p.manifest),
        p.manifest,
      ),
    ).rejects.toThrow('disposable_test_database');
  });
});
