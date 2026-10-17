import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import {
  learningSenseBindingHash,
  learningSenseTextHash as hash,
} from '../apps/api/src/modules/learning-sense-integrity.js';
import {
  importLearningSensesRows,
  loadLearningSensesFiles,
  type LearningSensesRow,
} from './learning-senses-lib.js';

const databaseUrl = process.env.CONTENT_TEST_DATABASE_URL;
it.skipIf(!databaseUrl)(
  'bounded bulk installation checks late chunks and rolls back a late replay drift',
  async () => {
    if (!new URL(databaseUrl!).pathname.endsWith('_test'))
      throw new Error('use_disposable_test_database');
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const base = loadLearningSensesFiles(),
      nonce = randomUUID(),
      prefix = 'bulk-' + nonce;
    const rows: LearningSensesRow[] = Array.from({ length: 200 }, (_, i) => {
      const wordId = prefix + '-word-' + i,
        lemma = 'bulkfixture-' + nonce + '-' + i;
      return {
        wordId,
        normalizedLemma: lemma,
        senses: Array.from({ length: 6 }, (_, j) => {
          // Synthetic boundary fixture, not dictionary content or a semantic quality claim.
          const sense = structuredClone(base.rows[0]!.senses[0]!);
          sense.id = prefix + '-sense-' + i + '-' + j;
          sense.wordId = wordId;
          sense.ordinal = j;
          sense.sourceBindings = [
            {
              ...sense.sourceBindings[0]!,
              id: sense.id + '-binding',
              wordId,
              learningSenseId: sense.id,
              sourceSenseId: sense.id + '-source',
              sourcePosSha256: hash('n.'),
              sourceDefinitionZhSha256: hash('批量边界测试源'),
              sourceDefinitionEnSha256: hash('Synthetic bulk boundary source.'),
            },
          ];
          for (const [k, e] of sense.examples.entries()) {
            Object.assign(e, {
              id: sense.id + '-example-' + k,
              wordId,
              learningSenseId: sense.id,
              exampleEn: `Synthetic context ${j} number ${k} contains ${lemma}.`,
            });
            e.contentMetadata.exampleEnSha256 = hash(e.exampleEn);
            e.contentMetadata.textHash = hash(e.exampleEn);
            e.contentMetadata.targetSurface = {
              lemma,
              form: lemma,
              kind: 'exact',
              review: 'codex-reviewed',
            };
          }
          sense.bindingHash = learningSenseBindingHash(sense);
          return sense;
        }),
      };
    });
    const manifest = {
      ...base.manifest,
      id: 'learning-senses-' + prefix,
      sha256: hash(nonce),
      wordCount: 200,
      senseCount: 1200,
      exampleCount: 2400,
      activeBookWords: 200,
      wordsWithCuratedMeanings: 200,
      wordsAwaitingAtomicReview: 0,
    };
    const siteId = (await client.query(`SELECT "siteId" FROM "SiteState" WHERE id='singleton'`))
      .rows[0]?.siteId;
    if (!siteId) throw new Error('test_database_not_prepared');
    const wordIds = rows.map((r) => r.wordId),
      senses = rows.flatMap((r) => r.senses);
    try {
      await client.query(
        `INSERT INTO "Word"(id,lemma,"normalizedLemma","goalTags","updatedAt")
      SELECT d.id,d.lemma,d.lemma,'{}',NOW() FROM jsonb_to_recordset($1::jsonb) d(id TEXT,lemma TEXT)`,
        [JSON.stringify(rows.map((r) => ({ id: r.wordId, lemma: r.normalizedLemma })))],
      );
      await client.query(
        `INSERT INTO "Sense"(id,"wordId",pos,"definitionZh","definitionEn")
      SELECT d.id,d."wordId",'n.','批量边界测试源','Synthetic bulk boundary source.'
      FROM jsonb_to_recordset($1::jsonb) d(id TEXT,"wordId" TEXT)`,
        [
          JSON.stringify(
            senses.map((s) => ({ id: s.sourceBindings[0]!.sourceSenseId, wordId: s.wordId })),
          ),
        ],
      );
      const site = { id: siteId, databaseUrl: databaseUrl! };
      await expect(importLearningSensesRows(site, rows, manifest)).resolves.toMatchObject({
        insertedSenses: 1200,
        insertedBindings: 1200,
        insertedExamples: 2400,
        alreadyInstalled: false,
      });
      await expect(importLearningSensesRows(site, rows, manifest)).resolves.toMatchObject({
        insertedSenses: 0,
        insertedBindings: 0,
        insertedExamples: 0,
        alreadyInstalled: true,
      });
      const lateExample = senses.at(-1)!.examples.at(-1)!;
      await client.query(`UPDATE "WordExample" SET "exampleZh"='故意修改的最后一块' WHERE id=$1`, [
        lateExample.id,
      ]);
      await expect(importLearningSensesRows(site, rows, manifest)).rejects.toThrow(
        'installed_row_drift:WordExample',
      );
      await client.query(`UPDATE "WordExample" SET "exampleZh"=$2 WHERE id=$1`, [
        lateExample.id,
        lateExample.exampleZh,
      ]);
      await client.query(`DELETE FROM "WordExample" WHERE id=$1`, [lateExample.id]);
      await expect(importLearningSensesRows(site, rows, manifest)).rejects.toThrow(
        'installed_row_missing:WordExample',
      );
      // The failed replay must leave the already installed meanings intact.
      expect(
        (
          await client.query(
            `SELECT count(*)::int n FROM "LearningSense" WHERE "wordId"=ANY($1::text[])`,
            [wordIds],
          )
        ).rows[0].n,
      ).toBe(1200);
    } finally {
      await client.query(`DELETE FROM "WordExample" WHERE "wordId"=ANY($1::text[])`, [wordIds]);
      await client.query(`DELETE FROM "SenseSourceBinding" WHERE "wordId"=ANY($1::text[])`, [
        wordIds,
      ]);
      await client.query(`DELETE FROM "LearningSense" WHERE "wordId"=ANY($1::text[])`, [wordIds]);
      await client.query(`DELETE FROM "Word" WHERE id=ANY($1::text[])`, [wordIds]);
      await client.query(`DELETE FROM "ContentPack" WHERE id=$1`, [manifest.id]);
      await client.end();
    }
  },
  30000,
);
