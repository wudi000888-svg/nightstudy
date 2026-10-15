import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Client } from 'pg';
import { z } from 'zod';
import type { SiteConfig } from '../apps/api/src/config.js';
import {
  contentBookLabels,
  contentBookDescriptions,
  loadContentManifest,
  normalizeContentLemma,
  type ContentGoal,
} from './content-lib.js';
import {
  legacyPhraseBookDescription,
  loadPhraseManifest,
  phraseBookDescription,
  phraseBookLabels,
  readPhraseRows,
} from './phrase-lib.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bookSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  goal: z.enum(['cet4', 'cet6', 'ielts', 'toefl', 'tem4', 'tem8', 'gre', 'postgraduate']),
  title: z.string().min(1).max(100),
  kind: z.enum(['vocabulary', 'phrases']),
  sourceId: z.string().min(1),
  description: z.string().min(1).max(1000),
  sourceCount: z.number().int().min(1),
  uniqueSourceCount: z.number().int().min(1),
  duplicateCount: z.number().int().min(0),
  wordCount: z.number().int().min(1),
  unmatchedCount: z.number().int().min(0),
  withEnglishDefinition: z.number().int().min(0),
});
const manifestSchema = z.object({
  formatVersion: z.literal(1),
  id: z.string().regex(/^exam-books-(?:v[1-9][0-9]*|fixture-[a-z0-9-]+)$/),
  version: z.string().min(1),
  kind: z.literal('exam-books'),
  fileName: z.string().regex(/^[a-z0-9.-]+\.jsonl\.gz$/),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024),
  sha256: digest,
  jsonlSha256: digest,
  membershipCount: z.number().int().min(1).max(100000),
  wordCount: z.number().int().min(1).max(100000),
  requiredDictionary: z.object({ id: z.string().min(1), sha256: digest }),
  sourceUrl: z.url().startsWith('https://'),
  license: z.string().min(1),
  books: z.array(bookSchema).min(1).max(30),
  limitations: z.array(z.string()),
});
export type ExamBookManifest = z.infer<typeof manifestSchema>;
export interface ExamBookRow {
  book: string;
  normalizedLemma: string;
}

export function loadExamBookManifest(
  file = new URL('../data/exam-books.manifest.json', import.meta.url),
): ExamBookManifest {
  const manifest = manifestSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (new Set(manifest.books.map((book) => book.id)).size !== manifest.books.length)
    throw new Error('duplicate_exam_book');
  for (const book of manifest.books)
    if (
      book.wordCount + book.unmatchedCount !== book.uniqueSourceCount ||
      book.uniqueSourceCount + book.duplicateCount !== book.sourceCount ||
      book.withEnglishDefinition > book.wordCount
    )
      throw new Error('exam_book_statistics_mismatch');
  return manifest;
}

export function readExamBookRows(bytes: Buffer, manifest: ExamBookManifest): ExamBookRow[] {
  if (bytes.length !== manifest.bytes || hash(bytes) !== manifest.sha256)
    throw new Error('exam_book_checksum_mismatch');
  const decoded = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 });
  if (hash(decoded) !== manifest.jsonlSha256) throw new Error('exam_book_jsonl_checksum_mismatch');
  const books = new Map(manifest.books.map((book) => [book.id, book]));
  const counts = new Map<string, number>();
  const lemmas = new Set<string>();
  const pairs = new Set<string>();
  const rows = new TextDecoder('utf-8', { fatal: true })
    .decode(decoded)
    .split('\n')
    .filter(Boolean)
    .map((line): ExamBookRow => {
      const row: unknown = JSON.parse(line);
      if (
        !row ||
        typeof row !== 'object' ||
        !('book' in row) ||
        !('normalizedLemma' in row) ||
        typeof row.book !== 'string' ||
        typeof row.normalizedLemma !== 'string' ||
        Object.keys(row).sort().join(',') !== 'book,normalizedLemma' ||
        !books.has(row.book) ||
        row.normalizedLemma !== normalizeContentLemma(row.normalizedLemma) ||
        !/^[a-z]+(?:['-][a-z]+)*(?: [a-z]+(?:['-][a-z]+)*){0,9}$/.test(row.normalizedLemma)
      )
        throw new Error('invalid_exam_book_row');
      const pair = `${row.book}\0${row.normalizedLemma}`;
      if (pairs.has(pair)) throw new Error('duplicate_exam_book_membership');
      pairs.add(pair);
      lemmas.add(row.normalizedLemma);
      counts.set(row.book, (counts.get(row.book) ?? 0) + 1);
      return { book: row.book, normalizedLemma: row.normalizedLemma };
    });
  if (
    rows.length !== manifest.membershipCount ||
    lemmas.size !== manifest.wordCount ||
    manifest.books.some((book) => counts.get(book.id) !== book.wordCount)
  )
    throw new Error('exam_book_membership_count_mismatch');
  return rows;
}

/** Membership-only installation; existing content and private learning rows are never replaced. */
export async function importExamBookRows(
  site: Pick<SiteConfig, 'id' | 'databaseUrl'>,
  rows: ExamBookRow[],
  manifest: ExamBookManifest,
  options: { dryRun?: boolean } = {},
) {
  if (
    manifest.id.startsWith('exam-books-fixture-') &&
    !decodeURIComponent(new URL(site.databaseUrl).pathname).endsWith('_test')
  )
    throw new Error('exam_fixture_requires_disposable_test_database');
  const client = new Client({ connectionString: site.databaseUrl, connectionTimeoutMillis: 10000 });
  const result = {
    siteId: site.id,
    packId: manifest.id,
    alreadyInstalled: false,
    dryRun: !!options.dryRun,
    newBooks: 0,
    refreshedBookPresentation: 0,
    memberships: rows.length,
    matchedWords: manifest.wordCount,
    unadmittedSourceEntries: manifest.books.reduce((sum, book) => sum + book.unmatchedCount, 0),
  };
  await client.connect();
  try {
    await client.query(
      options.dryRun ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN',
    );
    if (!options.dryRun)
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('NightStudy content installer'),hashtext($1))`,
        [site.id],
      );
    const binding = await client.query(
      `SELECT "siteId" FROM "SiteState" WHERE id='singleton'${options.dryRun ? '' : ' FOR UPDATE'}`,
    );
    if (binding.rows[0]?.siteId !== site.id) throw new Error('exam_database_site_binding_mismatch');
    const old = await client.query(`SELECT status,sha256 FROM "ContentPack" WHERE id=$1`, [
      manifest.id,
    ]);
    if (old.rowCount) {
      if (old.rows[0]?.status !== 'ready' || old.rows[0]?.sha256 !== manifest.sha256)
        throw new Error('conflicting_installed_exam_book_pack');
      result.alreadyInstalled = true;
      await client.query('COMMIT');
      return result;
    }
    const dictionary = await client.query(
      `SELECT id FROM "ContentPack" WHERE id=$1 AND sha256=$2 AND status='ready'`,
      [manifest.requiredDictionary.id, manifest.requiredDictionary.sha256],
    );
    if (!dictionary.rowCount) throw new Error('exam_required_dictionary_not_installed');
    // One set-based lookup, not a network round trip for every item in every book.
    const input = JSON.stringify(rows.map((row, ordinal) => ({ ...row, ordinal })));
    const resolved = await client.query<{
      book: string;
      wordId: string | null;
      focusSenseId: string | null;
      ordinal: number;
    }>(
      `SELECT x.book,w.id AS "wordId",s.id AS "focusSenseId",x.ordinal
       FROM jsonb_to_recordset($1::jsonb) AS x(book text,"normalizedLemma" text,ordinal int)
       LEFT JOIN "Word" w ON w."normalizedLemma"=x."normalizedLemma" AND w.status='published'
       LEFT JOIN LATERAL (
         SELECT id FROM "Sense" WHERE "wordId"=w.id AND btrim("definitionZh")<>''
         AND NOT (
           COALESCE("contentMetadata"#>>'{lexicalQuality,excludeFromLearning}','')='true'
           AND COALESCE("contentMetadata"#>>'{lexicalQuality,field}','')='definitionZh'
           AND COALESCE("contentMetadata"#>>'{lexicalQuality,sourceTextSha256}','')=
             encode(sha256(convert_to("definitionZh",'UTF8')),'hex')
         )
         ORDER BY (btrim("definitionEn")<>'') DESC,ordinal,id LIMIT 1
       ) s ON TRUE ORDER BY x.ordinal`,
      [input],
    );
    if (
      resolved.rows.length !== rows.length ||
      resolved.rows.some((row) => !row.wordId || !row.focusSenseId)
    )
      throw new Error('exam_dictionary_content_missing');
    const bookIds = manifest.books.map((book) => `content-${manifest.id}-${book.id}`);
    const collisions = await client.query(
      `SELECT id FROM "Book" WHERE id=ANY($1::text[]) OR slug=ANY($1::text[])`,
      [bookIds],
    );
    if (collisions.rowCount) throw new Error('exam_book_identity_conflict');
    if (!options.dryRun) {
      const baseDictionary = loadContentManifest();
      if (baseDictionary.id === manifest.requiredDictionary.id) {
        const legacyLabels: Record<ContentGoal, string> = {
          daily: '常用英语 · 词频前3000规则',
          'high-school': '高考方向 · ECDICT gk标签',
          cet4: '四级方向 · ECDICT cet4标签',
          cet6: '六级方向 · ECDICT cet6标签',
          ielts: '雅思方向 · ECDICT ielts标签',
        };
        const legacyDescription = `ECDICT固定基础CSV ${baseDictionary.version}。完整导入上游对应标签/频率规则范围，不是官方考试大纲或CEFR等级；原始释义无例句。`;
        for (const goal of Object.keys(legacyLabels) as ContentGoal[]) {
          const bookId = `content-${baseDictionary.id}-${goal}`;
          const refreshed = await client.query(
            `UPDATE "Book" SET title=CASE WHEN title=$3 THEN $4 ELSE title END,
             description=CASE WHEN description=$5 THEN $6 ELSE description END,"updatedAt"=NOW()
             WHERE id=$1 AND slug=$1 AND version=$2 AND "ownerId" IS NULL
             AND (title=$3 OR description=$5)`,
            [
              bookId,
              baseDictionary.id,
              legacyLabels[goal],
              contentBookLabels[goal],
              legacyDescription,
              contentBookDescriptions[goal],
            ],
          );
          result.refreshedBookPresentation += refreshed.rowCount ?? 0;
        }
      }
      const phraseManifest = loadPhraseManifest();
      const phraseRows = readPhraseRows(
        fs.readFileSync(new URL(`../data/${phraseManifest.fileName}`, import.meta.url)),
        phraseManifest,
      );
      for (const goal of ['cet4-phrases', 'cet6-phrases'] as const) {
        const bookId = `content-${phraseManifest.id}-${goal}`;
        const legacyTitle = goal === 'cet4-phrases' ? '四级方向常用词组' : '六级方向常用词组';
        const corpusCount = phraseRows.filter(
          (row) =>
            row.book === goal &&
            (row.examples[0]!.contentMetadata.exampleEn as Record<string, unknown>).kind ===
              'corpus',
        ).length;
        const refreshed = await client.query(
          `UPDATE "Book" SET title=CASE WHEN title=$4 THEN $5 ELSE title END,
           description=CASE WHEN description=$6 THEN $7 ELSE description END,"updatedAt"=NOW()
           WHERE id=$1 AND slug=$2 AND version=$3 AND "ownerId" IS NULL
           AND (title=$4 OR description=$6)`,
          [
            bookId,
            goal,
            phraseManifest.version,
            legacyTitle,
            phraseBookLabels[goal],
            legacyPhraseBookDescription(corpusCount),
            phraseBookDescription,
          ],
        );
        result.refreshedBookPresentation += refreshed.rowCount ?? 0;
      }
      for (const book of manifest.books) {
        const bookId = `content-${manifest.id}-${book.id}`;
        await client.query(
          `INSERT INTO "Book" (id,slug,title,description,goal,kind,status,version,"updatedAt")
           VALUES ($1,$1,$2,$3,$4,$5,'published',$6,NOW())`,
          [bookId, book.title, book.description, book.goal, book.kind, manifest.id],
        );
        const items = resolved.rows
          .filter((row) => row.book === book.id)
          .map((row, ordinal) => ({ wordId: row.wordId, focusSenseId: row.focusSenseId, ordinal }));
        await client.query(
          `INSERT INTO "BookItem" (id,"bookId","wordId","focusSenseId",ordinal)
           SELECT $1||':'||x."wordId",$1,x."wordId",x."focusSenseId",x.ordinal
           FROM jsonb_to_recordset($2::jsonb) AS x("wordId" text,"focusSenseId" text,ordinal int)`,
          [bookId, JSON.stringify(items)],
        );
        await client.query(
          `UPDATE "Word" SET "goalTags"=array_append("goalTags",$2)
           WHERE id=ANY($1::text[]) AND NOT ($2=ANY("goalTags"))`,
          [items.map((item) => item.wordId), book.goal],
        );
        result.newBooks++;
      }
      await client.query(
        `INSERT INTO "ContentPack" (id,version,status,"sourceUrl",sha256,license,"entryCount","phoneticCount","definitionZhCount","definitionEnCount","tagCounts","installedAt","updatedAt")
         VALUES ($1,$2,'ready',$3,$4,$5,$6,0,0,0,$7::jsonb,NOW(),NOW())`,
        [
          manifest.id,
          manifest.version,
          manifest.sourceUrl,
          manifest.sha256,
          manifest.license,
          manifest.wordCount,
          JSON.stringify({
            kind: 'exam-books',
            membershipCount: rows.length,
            bookCounts: Object.fromEntries(manifest.books.map((book) => [book.id, book.wordCount])),
            excludedMemberships: result.unadmittedSourceEntries,
          }),
        ],
      );
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
