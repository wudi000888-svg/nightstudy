import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import {
  importExamBookRows,
  loadExamBookManifest,
  readExamBookRows,
  type ExamBookManifest,
} from './exam-books-lib.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

it.runIf(!!databaseUrl)(
  'installs canonical memberships atomically, preserves private/word content, and replays without duplicates',
  async () => {
    const url = new URL(databaseUrl!);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !decodeURIComponent(url.pathname).endsWith('_test') ||
      ['host', 'hostaddr', 'service'].some((key) => url.searchParams.has(key))
    )
      throw new Error('exam_integration_requires_local_disposable_test_database');
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const nonce = randomUUID();
    const prefix = `exam-fixture-${nonce}`;
    const letters = nonce
      .replaceAll('-', '')
      .replace(/[0-9]/g, (value) => String.fromCharCode(107 + Number(value)));
    const lemma = 'fixture' + letters;
    const lemma2 = 'second' + letters;
    const wordIds = [prefix + '-word-a', prefix + '-word-b'];
    const dictionaryId = prefix + '-dictionary';
    const base = loadExamBookManifest();
    const rawRows = [
      { book: 'tem4', normalizedLemma: lemma },
      { book: 'tem8', normalizedLemma: lemma },
      { book: 'tem8', normalizedLemma: lemma2 },
    ];
    const decoded = Buffer.from(rawRows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const bytes = gzipSync(decoded);
    const manifest: ExamBookManifest = {
      ...base,
      id: `exam-books-fixture-${nonce}`,
      bytes: bytes.length,
      sha256: hash(bytes),
      jsonlSha256: hash(decoded),
      wordCount: 2,
      membershipCount: 3,
      requiredDictionary: { id: dictionaryId, sha256: '0'.repeat(64) },
      books: [
        {
          ...base.books[2]!,
          id: 'tem4',
          goal: 'tem4',
          sourceCount: 1,
          uniqueSourceCount: 1,
          duplicateCount: 0,
          wordCount: 1,
          unmatchedCount: 0,
          withEnglishDefinition: 1,
        },
        {
          ...base.books[3]!,
          id: 'tem8',
          goal: 'tem8',
          sourceCount: 2,
          uniqueSourceCount: 2,
          duplicateCount: 0,
          wordCount: 2,
          unmatchedCount: 0,
          withEnglishDefinition: 2,
        },
      ],
    };
    const rows = readExamBookRows(bytes, manifest);
    const bookIds = manifest.books.map((book) => `content-${manifest.id}-${book.id}`);
    let ownsFixture = false;
    const privateDigest = async () => {
      const output: Record<string, unknown> = {};
      for (const table of [
        'User',
        'UserSettings',
        'UserWord',
        'StudyProgress',
        'ReviewLog',
        'DailyPlan',
        'StudySession',
      ]) {
        const result = await client.query(
          `SELECT count(*)::text AS count,md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS digest FROM "${table}" t`,
        );
        output[table] = result.rows[0];
      }
      return output;
    };
    try {
      const state = await client.query(`SELECT "siteId" FROM "SiteState" WHERE id='singleton'`);
      const site = { id: String(state.rows[0]?.siteId), databaseUrl: databaseUrl! };
      expect(site.id).not.toBe('undefined');
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO "ContentPack" (id,version,status,"sourceUrl",sha256,license,"entryCount","phoneticCount","definitionZhCount","definitionEnCount","tagCounts","updatedAt") VALUES ($1,'fixture','ready','https://example.invalid/fixture',$2,'MIT',2,0,2,2,'{}',NOW())`,
        [dictionaryId, '0'.repeat(64)],
      );
      for (const [index, item] of [lemma, lemma2].entries()) {
        await client.query(
          `INSERT INTO "Word" (id,lemma,"normalizedLemma","goalTags","sourceRef","contentVersion","updatedAt") VALUES ($1,$2,$2,ARRAY['daily'],'Synthetic test only','fixture',NOW())`,
          [wordIds[index], item],
        );
        await client.query(
          `INSERT INTO "Sense" (id,"wordId",pos,"definitionZh","definitionEn","exampleEn","exampleZh") VALUES ($1,$2,'n.','仅用于测试的释义','Synthetic meaning only','This is a synthetic fixture.','这是测试夹具。')`,
          [wordIds[index] + '-sense', wordIds[index]],
        );
      }
      await client.query(
        `INSERT INTO "Sense" (id,"wordId",pos,"definitionZh","definitionEn",ordinal,"contentMetadata")
       VALUES ($1,$2,'n.','不可用于学习的测试释义','Excluded test meaning',-999,$3::jsonb)`,
        [
          wordIds[0] + '-held',
          wordIds[0],
          JSON.stringify({
            lexicalQuality: {
              excludeFromLearning: true,
              field: 'definitionZh',
              sourceTextSha256: hash(Buffer.from('不可用于学习的测试释义')),
            },
          }),
        ],
      );
      await client.query('COMMIT');
      ownsFixture = true;
      const beforePrivate = await privateDigest();
      const beforeSenses = (
        await client.query(
          `SELECT to_jsonb(s) AS row FROM "Sense" s WHERE "wordId"=ANY($1::text[]) ORDER BY id`,
          [wordIds],
        )
      ).rows;
      expect((await importExamBookRows(site, rows, manifest, { dryRun: true })).dryRun).toBe(true);
      expect(
        (
          await client.query(`SELECT count(*)::int AS count FROM "Book" WHERE id=ANY($1::text[])`, [
            bookIds,
          ])
        ).rows[0].count,
      ).toBe(0);
      await expect(
        importExamBookRows({ ...site, id: site.id + '-wrong' }, rows, manifest),
      ).rejects.toThrow('site_binding_mismatch');
      const missing = rows.map((row, index) =>
        index ? row : { ...row, normalizedLemma: 'missing' + letters },
      );
      await expect(importExamBookRows(site, missing, manifest)).rejects.toThrow('content_missing');
      expect(
        (await client.query(`SELECT "goalTags" FROM "Word" WHERE id=$1`, [wordIds[0]])).rows[0]
          .goalTags,
      ).toEqual(['daily']);
      const installed = await importExamBookRows(site, rows, manifest);
      expect(installed.newBooks).toBe(2);
      expect(installed.memberships).toBe(3);
      const items = (
        await client.query(
          `SELECT "bookId","wordId",ordinal FROM "BookItem" WHERE "bookId"=ANY($1::text[]) ORDER BY "bookId",ordinal`,
          [bookIds],
        )
      ).rows;
      expect(items).toHaveLength(3);
      expect(new Set(items.map((item) => item.wordId))).toEqual(new Set(wordIds));
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM "BookItem" WHERE "bookId"=ANY($1::text[]) AND "focusSenseId"=$2`,
            [bookIds, wordIds[0] + '-held'],
          )
        ).rows[0].count,
      ).toBe(0);
      expect(
        (await client.query(`SELECT "goalTags" FROM "Word" WHERE id=$1`, [wordIds[0]])).rows[0]
          .goalTags,
      ).toEqual(['daily', 'tem4', 'tem8']);
      expect((await importExamBookRows(site, rows, manifest)).alreadyInstalled).toBe(true);
      await expect(
        importExamBookRows(site, rows, { ...manifest, sha256: 'f'.repeat(64) }),
      ).rejects.toThrow('conflicting_installed');
      expect(
        (
          await client.query(
            `SELECT to_jsonb(s) AS row FROM "Sense" s WHERE "wordId"=ANY($1::text[]) ORDER BY id`,
            [wordIds],
          )
        ).rows,
      ).toEqual(beforeSenses);
      expect(await privateDigest()).toEqual(beforePrivate);
    } finally {
      if (ownsFixture) {
        await client.query('BEGIN');
        await client.query(`DELETE FROM "BookItem" WHERE "bookId"=ANY($1::text[])`, [bookIds]);
        await client.query(`DELETE FROM "Book" WHERE id=ANY($1::text[])`, [bookIds]);
        await client.query(`DELETE FROM "Sense" WHERE "wordId"=ANY($1::text[])`, [wordIds]);
        await client.query(`DELETE FROM "Word" WHERE id=ANY($1::text[])`, [wordIds]);
        await client.query(`DELETE FROM "ContentPack" WHERE id=ANY($1::text[])`, [
          [dictionaryId, manifest.id],
        ]);
        await client.query('COMMIT');
      } else await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  },
);
