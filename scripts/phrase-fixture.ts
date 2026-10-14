// Original synthetic parser/PG-test fixture only; not learning material or an ECDICT source.
// Tests must create/delete only these exact identities in an explicitly disposable *_test database.
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { PhraseManifest, PhraseRow } from './phrase-lib.js';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function createPhraseFixture() {
  const sourceText = '测试夹具短语';
  const sourceTextSha256 = hash(sourceText);
  const base = {
    kind: 'generated',
    review: 'pending',
    license: 'MIT',
    author: 'NightStudy contributors',
    authoringMethod: 'Original synthetic test fixture',
  };
  const row: PhraseRow = {
    normalizedLemma: 'fixture phrase',
    book: 'cet4-phrases',
    sourceWordId: 'phrase-fixture-word-v1',
    sourceFocusSenseId: 'phrase-fixture-sense-v1',
    sourceFocusTextSha256: sourceTextSha256,
    focusSenseId: 'phrase-fixture-sense-v1',
    senses: [
      {
        id: 'phrase-fixture-sense-v1',
        sourceText,
        sourceTextSha256,
        definitionEn: 'A synthetic phrase used solely by tests.',
        contentMetadata: {
          definitionEn: {
            kind: 'original-authoring',
            review: 'pending',
            license: 'MIT',
            author: 'NightStudy contributors',
            sourceLanguage: 'zh',
            sourceTextSha256,
            sourceSenseId: 'phrase-fixture-sense-v1',
          },
        },
      },
    ],
    qualityWarnings: [],
    examples: [
      {
        exampleEn: 'Please check the fixture phrase before running the test.',
        exampleZh: '运行测试前，请检查这个夹具短语。',
        contentMetadata: {
          exampleEn: { ...base, language: 'en' },
          exampleZh: { ...base, language: 'zh' },
        },
      },
    ],
    collocationTokens: ['fixture', 'phrase'],
  };
  const decoded = Buffer.from(JSON.stringify(row) + '\n');
  const bytes = gzipSync(decoded);
  const manifest: PhraseManifest = {
    formatVersion: 1,
    id: 'phrase-books-fixture-v1',
    version: 'fixture-v1',
    fileName: 'phrase-fixture.jsonl.gz',
    bytes: bytes.length,
    sha256: hash(bytes),
    jsonlSha256: hash(decoded),
    sourceUrl: 'https://example.test/original-phrase-fixture',
    license: 'MIT',
    wordCount: 1,
    kind: 'phrase-books',
    bookCounts: { 'cet4-phrases': 1, 'cet6-phrases': 0 },
    tagCounts: { 'phrase-books': 1 },
    statistics: {},
  };
  return {
    row,
    rows: [row],
    manifest,
    bytes,
    sourceText,
    wordId: row.sourceWordId,
    senseId: row.sourceFocusSenseId,
  };
}
