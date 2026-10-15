import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { loadExamBookManifest, readExamBookRows, type ExamBookRow } from './exam-books-lib.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const manifest = loadExamBookManifest();
const bytes = fs.readFileSync(new URL(`../data/${manifest.fileName}`, import.meta.url));
const rows = readExamBookRows(bytes, manifest);
function changed(next: unknown[]) {
  const decoded = Buffer.from(next.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const packed = gzipSync(decoded);
  return () =>
    readExamBookRows(packed, {
      ...manifest,
      bytes: packed.length,
      sha256: hash(packed),
      jsonlSha256: hash(decoded),
    });
}

it('loads the actual pinned pack and preserves distinct exam categories without invented levels', () => {
  expect(rows).toHaveLength(48162);
  expect(new Set(rows.map((row) => row.normalizedLemma)).size).toBe(17348);
  expect(manifest.books.map((book) => book.goal)).toContain('tem4');
  expect(manifest.books.map((book) => book.goal)).toContain('tem8');
  expect(manifest.books.map((book) => book.goal)).toContain('toefl');
  expect(manifest.books.map((book) => book.goal)).not.toContain('tem6');
  expect(manifest.books.map((book) => book.goal)).not.toContain('cet8');
  expect(manifest.books.find((book) => book.id === 'tem4-open')?.wordCount).toBe(4024);
  expect(manifest.books.find((book) => book.id === 'tem4-open')?.unmatchedCount).toBe(1);
});

it('distributes only membership facts and separates content rights from the application licence', () => {
  expect(rows.every((row) => Object.keys(row).sort().join(',') === 'book,normalizedLemma')).toBe(
    true,
  );
  const sources = JSON.parse(
    fs.readFileSync(new URL('../data/exam-books.sources.json', import.meta.url), 'utf8'),
  );
  const tem4 = sources.sources.find((source: { id: string }) => source.id === 'tem4');
  expect(tem4.license).toBe('NOASSERTION');
  expect(tem4.codeLicense).toBe('MIT');
  expect(manifest.license).toContain('CC-BY-SA-4.0');
  const queue = JSON.parse(
    fs.readFileSync(new URL('../data/exam-books.review-queue.json', import.meta.url), 'utf8'),
  );
  expect(queue.entries).toHaveLength(
    manifest.books.reduce((sum, book) => sum + book.unmatchedCount, 0),
  );
  expect(queue.entries.some((row: { book: string }) => row.book === 'tem8-open')).toBe(true);
});

it('rejects altered bytes before decoding a content pack', () => {
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  expect(() => readExamBookRows(corrupt, manifest)).toThrow('checksum');
});

it('rejects unknown books and a duplicate canonical word inside one book', () => {
  expect(changed([{ ...rows[0], book: 'nonexistent' }, ...rows.slice(1)])).toThrow(
    'invalid_exam_book_row',
  );
  expect(changed([...rows, rows[0]])).toThrow('duplicate_exam_book_membership');
});

it('rejects hidden dictionary expressions, non-normalized words and truncated membership lists', () => {
  expect(changed([{ ...rows[0], definitionZh: 'Must not be copied' }, ...rows.slice(1)])).toThrow(
    'invalid_exam_book_row',
  );
  expect(changed([{ ...rows[0], normalizedLemma: ' ＲＡＩＮ ' }, ...rows.slice(1)])).toThrow(
    'invalid_exam_book_row',
  );
  expect(changed(rows.slice(1) as ExamBookRow[])).toThrow('membership_count');
});
