import { it, expect } from 'vitest';
import { Client } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { importBilingualRows, type BilingualManifest, type BilingualRow } from './bilingual-lib.js';
const databaseUrl = process.env.CONTENT_TEST_DATABASE_URL;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
it.skipIf(!databaseUrl)(
  'installs atomically in one realm, keeps source edits and word identity, and replays without duplicate examples',
  async () => {
    if (!new URL(databaseUrl!).pathname.endsWith('_test'))
      throw new Error('use_a_disposable_test_database');
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const nonce = randomUUID();
    const wordId = 'bilingual-fixture-' + nonce;
    const lemma = 'fixture-' + nonce;
    const senseId = wordId + '-sense';
    const editedId = wordId + '-edited';
    const packId = 'bilingual-test-' + nonce;
    const manifest: BilingualManifest = {
      formatVersion: 1,
      id: packId,
      version: 'original-synthetic-1',
      fileName: 'synthetic.jsonl.gz',
      bytes: 1,
      sha256: hash('synthetic'),
      jsonlSha256: hash('synthetic-jsonl'),
      sourceUrl: 'https://example.invalid/original-test',
      license: 'MIT',
      wordCount: 1,
      scope: 'original test fixture only',
    };
    const source = '原创合成测试释义。';
    const metadata = {
      kind: 'machine-translation',
      sourceTextSha256: hash(source),
      review: 'pending',
      model: 'synthetic-test-not-a-real-model',
    };
    const rows: BilingualRow[] = [
      {
        normalizedLemma: lemma,
        senses: [
          {
            id: senseId,
            definitionEn: 'An original synthetic test definition.',
            contentMetadata: { definitionEn: metadata },
          },
          {
            id: editedId,
            definitionEn: 'This must not replace the edited source.',
            contentMetadata: { definitionEn: metadata },
          },
        ],
        examples: [
          {
            exampleEn: `We use ${lemma} only as a synthetic fixture.`,
            exampleZh: '我们只将此词用于合成测试。',
            contentMetadata: {
              exampleEn: { kind: 'generated', review: 'pending', license: 'MIT' },
              exampleZh: { kind: 'generated', review: 'pending', license: 'MIT' },
            },
          },
        ],
        warnings: [
          {
            code: 'synthetic-warning',
            message: '仅用于校对警告边界测试。',
            senseId,
            sourceTextSha256: hash(source),
          },
          {
            code: 'synthetic-meaning-warning',
            message: '同一义项的第二项独立校对警告。',
            senseId,
            sourceTextSha256: hash(source),
          },
          {
            code: 'synthetic-warning',
            message: '仅用于校对警告边界测试。',
            senseId,
            sourceTextSha256: hash(source),
          },
        ],
      },
    ];
    try {
      const state = (await client.query(`SELECT "siteId" FROM "SiteState" WHERE id='singleton'`))
        .rows[0];
      if (!state) throw new Error('test_database_not_prepared');
      await client.query(
        `INSERT INTO "Word"(id,lemma,"normalizedLemma","goalTags","sourceRef","contentVersion","updatedAt") VALUES($1,$2,$2,'{}','synthetic','synthetic',NOW())`,
        [wordId, lemma],
      );
      await client.query(
        `INSERT INTO "Sense"(id,"wordId",pos,"definitionZh") VALUES($1,$3,'n.',$4),($2,$3,'n.','管理员已编辑的不同释义')`,
        [senseId, editedId, wordId, source],
      );
      const before = (await client.query(`SELECT * FROM "Word" WHERE id=$1`, [wordId])).rows[0];
      await expect(
        importBilingualRows({ id: 'wrong-realm', databaseUrl: databaseUrl! }, rows, manifest),
      ).rejects.toThrow('site_binding_mismatch');
      const result = await importBilingualRows(
        { id: state.siteId, databaseUrl: databaseUrl! },
        rows,
        manifest,
      );
      expect(result).toMatchObject({
        matchedWords: 1,
        translatedFields: 1,
        examples: 1,
        conflicts: 1,
      });
      const senses = (
        await client.query(`SELECT * FROM "Sense" WHERE "wordId"=$1 ORDER BY id`, [wordId])
      ).rows;
      expect(senses.find((s) => s.id === senseId)).toMatchObject({
        definitionZh: source,
        definitionEn: 'An original synthetic test definition.',
        contentMetadata: {
          definitionEn: metadata,
          packId,
          lexicalWarnings: [
            {
              code: 'synthetic-warning',
              message: '仅用于校对警告边界测试。',
              senseId,
              sourceTextSha256: hash(source),
            },
            {
              code: 'synthetic-meaning-warning',
              message: '同一义项的第二项独立校对警告。',
              senseId,
              sourceTextSha256: hash(source),
            },
          ],
        },
      });
      expect(senses.find((s) => s.id === editedId)).toMatchObject({
        definitionZh: '管理员已编辑的不同释义',
        definitionEn: '',
        contentMetadata: {},
      });
      expect((await client.query(`SELECT * FROM "Word" WHERE id=$1`, [wordId])).rows[0]).toEqual(
        before,
      );
      const pack = (await client.query(`SELECT * FROM "ContentPack" WHERE id=$1`, [packId]))
        .rows[0];
      expect(pack.tagCounts).toMatchObject({
        kind: 'bilingual',
        pairedDefinitionWords: 1,
        bilingualExampleWords: 1,
        conflicts: 1,
      });
      expect(
        await importBilingualRows({ id: state.siteId, databaseUrl: databaseUrl! }, rows, manifest),
      ).toMatchObject({ alreadyInstalled: true });
      expect(
        (
          await client.query(`SELECT count(*)::int AS n FROM "WordExample" WHERE "wordId"=$1`, [
            wordId,
          ])
        ).rows[0].n,
      ).toBe(1);
      await expect(
        importBilingualRows({ id: state.siteId, databaseUrl: databaseUrl! }, rows, {
          ...manifest,
          sha256: hash('different'),
        }),
      ).rejects.toThrow('conflicting_installed_pack');
      const missingId = packId + '-missing';
      await expect(
        importBilingualRows(
          { id: state.siteId, databaseUrl: databaseUrl! },
          [...rows, { normalizedLemma: 'missing-' + nonce, senses: [], examples: [] }],
          { ...manifest, id: missingId, wordCount: 2 },
        ),
      ).rejects.toThrow('words_missing_from_site');
      expect(
        (await client.query(`SELECT id FROM "ContentPack" WHERE id=$1`, [missingId])).rowCount,
      ).toBe(0);
      expect(
        (
          await client.query(`SELECT count(*)::int AS n FROM "WordExample" WHERE "wordId"=$1`, [
            wordId,
          ])
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await client.query(
        `DELETE FROM "Word" WHERE id=$1 AND "normalizedLemma"=$2 AND "sourceRef"='synthetic'`,
        [wordId, lemma],
      );
      await client.query(`DELETE FROM "ContentPack" WHERE id=ANY($1::text[])`, [
        [packId, packId + '-missing'],
      ]);
      await client.end();
    }
  },
);

it.skipIf(!databaseUrl).each(['archived', 'draft'])(
  'prepares an existing %s canonical word without publishing it or changing edits and progress',
  async (status) => {
    if (!new URL(databaseUrl!).pathname.endsWith('_test'))
      throw new Error('use_a_disposable_test_database');
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const nonce = randomUUID();
    const wordId = 'bilingual-disabled-' + nonce;
    const otherWordId = wordId + '-other';
    const lemma = 'hidden-fixture-' + nonce;
    const userId = 'bilingual-user-' + nonce;
    const email = nonce + '@example.test';
    const publicBookId = 'bilingual-public-' + nonce;
    const privateBookId = 'bilingual-private-' + nonce;
    const senseId = wordId + '-source';
    const editedId = wordId + '-edited';
    const changedId = wordId + '-source-edited';
    const unrelatedId = otherWordId + '-sense';
    const packId = 'bilingual-disabled-pack-' + nonce;
    const source = '合成停用词的原始释义。';
    const metadata = {
      kind: 'machine-translation',
      sourceTextSha256: hash(source),
      review: 'pending',
      model: 'synthetic-test-not-a-real-model',
    };
    const manifest: BilingualManifest = {
      formatVersion: 1,
      id: packId,
      version: 'synthetic-disabled-1',
      fileName: 'synthetic.jsonl.gz',
      bytes: 1,
      sha256: hash(packId),
      jsonlSha256: hash(packId + '-jsonl'),
      sourceUrl: 'https://example.invalid/disabled-test',
      license: 'MIT',
      wordCount: 1,
      scope: 'synthetic disabled fixture only',
    };
    const rows: BilingualRow[] = [
      {
        normalizedLemma: lemma,
        senses: [senseId, editedId, changedId, unrelatedId].map((id) => ({
          id,
          definitionEn: 'An original synthetic translation of the unchanged source.',
          contentMetadata: { definitionEn: metadata },
        })),
        examples: [
          {
            exampleEn: `We keep ${lemma} as a synthetic fixture.`,
            exampleZh: '我们将此词保留为合成测试条目。',
            contentMetadata: {
              exampleEn: { kind: 'generated', review: 'pending', license: 'MIT' },
              exampleZh: { kind: 'generated', review: 'pending', license: 'MIT' },
            },
          },
        ],
      },
    ];
    try {
      const state = (await client.query(`SELECT "siteId" FROM "SiteState" WHERE id='singleton'`))
        .rows[0];
      if (!state) throw new Error('test_database_not_prepared');
      await client.query(
        `INSERT INTO "Word"(id,lemma,"normalizedLemma","goalTags",status,"sourceRef","contentVersion","updatedAt")
         VALUES($1,$2,$2,'{}',$3,'synthetic-disabled','admin-edited-fixture',NOW()),
               ($4,$5,$5,'{}','published','synthetic-disabled','synthetic',NOW())`,
        [wordId, lemma, status, otherWordId, lemma + '-other'],
      );
      await client.query(
        `INSERT INTO "Sense"(id,"wordId",pos,"definitionZh","definitionEn","contentMetadata")
         VALUES($1,$5,'n.',$6,'','{}'),
               ($2,$5,'n.',$6,'Administrator-authored target.',
                  '{"definitionEn":{"kind":"site-authored","review":"source"},"customNote":"preserve"}'),
               ($3,$5,'n.','管理员已改变的原始释义','','{"customNote":"edited source"}'),
               ($4,$7,'n.',$6,'','{"customNote":"different canonical word"}')`,
        [senseId, editedId, changedId, unrelatedId, wordId, source, otherWordId],
      );
      await client.query(
        `INSERT INTO "User"(id,name,email,"updatedAt") VALUES($1,'Bilingual synthetic fixture',$2,NOW())`,
        [userId, email],
      );
      await client.query(
        `INSERT INTO "StudyProgress"(id,"userId","wordId","fsrsJson","dueAt","lastReviewAt","firstLearnedAt",revision,"updatedAt")
         VALUES($1,$2,$3,'{"state":2,"reps":5,"lapses":1,"stability":12.5,"difficulty":6}',
                '2030-01-10T04:00:00Z','2026-01-02T04:00:00Z','2026-01-01T04:00:00Z',7,NOW())`,
        [wordId + '-progress', userId, wordId],
      );
      await client.query(
        `INSERT INTO "Book"(id,slug,title,description,goal,status,version,"ownerId","updatedAt")
         VALUES($1,$1,'Synthetic public source book','','daily','published','ecdict-synthetic',NULL,NOW()),
               ($2,$2,'Synthetic private book','','daily','published','private-fixture',$3,NOW())`,
        [publicBookId, privateBookId, userId],
      );
      await client.query(
        `INSERT INTO "BookItem"(id,"bookId","wordId","focusSenseId",ordinal)
         VALUES($1,$2,$5,$6,0),($3,$4,$5,$6,0)`,
        [
          publicBookId + '-item',
          publicBookId,
          privateBookId + '-item',
          privateBookId,
          wordId,
          senseId,
        ],
      );
      const wordsBefore = (
        await client.query(`SELECT * FROM "Word" WHERE id=ANY($1::text[]) ORDER BY id`, [
          [wordId, otherWordId],
        ])
      ).rows;
      const guardedBefore = (
        await client.query(`SELECT * FROM "Sense" WHERE id=ANY($1::text[]) ORDER BY id`, [
          [editedId, changedId, unrelatedId],
        ])
      ).rows;
      const progressBefore = (
        await client.query(`SELECT * FROM "StudyProgress" WHERE "userId"=$1`, [userId])
      ).rows;
      const booksBefore = (
        await client.query(`SELECT * FROM "Book" WHERE id=ANY($1::text[]) ORDER BY id`, [
          [publicBookId, privateBookId],
        ])
      ).rows;
      const bookItemsBefore = (
        await client.query(`SELECT * FROM "BookItem" WHERE "wordId"=$1 ORDER BY id`, [wordId])
      ).rows;
      expect(
        await importBilingualRows({ id: state.siteId, databaseUrl: databaseUrl! }, rows, manifest),
      ).toMatchObject({ matchedWords: 1, translatedFields: 1, examples: 1, conflicts: 3 });
      expect(
        (
          await client.query(`SELECT * FROM "Word" WHERE id=ANY($1::text[]) ORDER BY id`, [
            [wordId, otherWordId],
          ])
        ).rows,
      ).toEqual(wordsBefore);
      expect(
        (
          await client.query(`SELECT * FROM "Sense" WHERE id=ANY($1::text[]) ORDER BY id`, [
            [editedId, changedId, unrelatedId],
          ])
        ).rows,
      ).toEqual(guardedBefore);
      expect(
        (await client.query(`SELECT * FROM "Sense" WHERE id=$1`, [senseId])).rows[0],
      ).toMatchObject({
        wordId,
        definitionZh: source,
        definitionEn: rows[0]!.senses[0]!.definitionEn,
        contentMetadata: { definitionEn: metadata, packId },
      });
      expect(
        (await client.query(`SELECT * FROM "StudyProgress" WHERE "userId"=$1`, [userId])).rows,
      ).toEqual(progressBefore);
      expect(
        (
          await client.query(`SELECT * FROM "Book" WHERE id=ANY($1::text[]) ORDER BY id`, [
            [publicBookId, privateBookId],
          ])
        ).rows,
      ).toEqual(booksBefore);
      expect(
        (await client.query(`SELECT * FROM "BookItem" WHERE "wordId"=$1 ORDER BY id`, [wordId]))
          .rows,
      ).toEqual(bookItemsBefore);
      const pack = (await client.query(`SELECT * FROM "ContentPack" WHERE id=$1`, [packId]))
        .rows[0];
      expect(pack.status).toBe('ready');
      expect(pack.tagCounts).toMatchObject({
        sourceBookItems: 0,
        pairedFocusItems: 0,
        sourceBookWords: 0,
        pairedFocusWords: 0,
      });
    } finally {
      await client.query(`DELETE FROM "Book" WHERE id=ANY($1::text[])`, [
        [publicBookId, privateBookId],
      ]);
      await client.query(`DELETE FROM "User" WHERE id=$1 AND email=$2`, [userId, email]);
      await client.query(
        `DELETE FROM "Word" WHERE id=ANY($1::text[]) AND "sourceRef"='synthetic-disabled'`,
        [[wordId, otherWordId]],
      );
      await client.query(`DELETE FROM "ContentPack" WHERE id=$1`, [packId]);
      await client.end();
    }
  },
);
