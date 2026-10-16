import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import {
  learningSenseBindingHash,
  learningSenseTextHash as hash,
} from '../apps/api/src/modules/learning-sense-integrity.js';
import {
  importLearningSensesRows,
  loadLearningSensesManifest,
  readLearningSensesRows,
} from './learning-senses-lib.js';

const databaseUrl = process.env.CONTENT_TEST_DATABASE_URL;
it.skipIf(!databaseUrl)(
  'atomic meaning install is insert-only, realm bound, drift rejecting and verified on replay',
  async () => {
    if (!new URL(databaseUrl!).pathname.endsWith('_test'))
      throw new Error('use_a_disposable_test_database');
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const nonce = randomUUID();
    const wordId = 'meaning-word-' + nonce;
    const sourceId = 'meaning-source-' + nonce;
    const lemma = 'meaningfixture-' + nonce;
    const manifest = {
      ...loadLearningSensesManifest(),
      id: 'learning-senses-test-' + nonce,
      wordCount: 1,
      senseCount: 1,
      exampleCount: 2,
      activeBookWords: 1,
      wordsWithCuratedMeanings: 1,
      wordsAwaitingAtomicReview: 0,
      sha256: hash(nonce),
    };
    const template = loadLearningSensesManifest();
    const original = readLearningSensesRows(
      fs.readFileSync(new URL('../data/' + template.fileName, import.meta.url)),
      template,
    );
    const sense = structuredClone(original[0]!.senses[0]!);
    sense.id = 'meaning-' + nonce;
    sense.wordId = wordId;
    sense.sourceBindings = [
      {
        ...sense.sourceBindings[0]!,
        id: 'meaning-binding-' + nonce,
        wordId,
        learningSenseId: sense.id,
        sourceSenseId: sourceId,
        sourcePosSha256: hash('n.'),
        sourceDefinitionZhSha256: hash('原创测试义'),
        sourceDefinitionEnSha256: hash('Original synthetic meaning.'),
      },
    ];
    for (const [index, example] of sense.examples.entries()) {
      example.id = 'meaning-example-' + nonce + '-' + index;
      example.wordId = wordId;
      example.learningSenseId = sense.id;
      example.exampleEn = `We use ${lemma} in synthetic example number ${index}.`;
      example.contentMetadata.exampleEnSha256 = hash(example.exampleEn);
      example.contentMetadata.textHash = hash(example.exampleEn);
      example.contentMetadata.targetSurface = {
        lemma,
        form: lemma,
        kind: 'exact',
        review: 'codex-reviewed',
      };
    }
    sense.bindingHash = learningSenseBindingHash(sense);
    const rows = [{ wordId, normalizedLemma: lemma, senses: [sense] }];
    const siteId = (await client.query(`SELECT "siteId" FROM "SiteState" WHERE id='singleton'`))
      .rows[0]!?.siteId;
    if (!siteId) throw new Error('test_database_not_prepared');
    try {
      await client.query(
        `INSERT INTO "Word"(id,lemma,"normalizedLemma","goalTags","updatedAt") VALUES($1,$2,$2,'{}',NOW())`,
        [wordId, lemma],
      );
      await client.query(
        `INSERT INTO "Sense"(id,"wordId",pos,"definitionZh","definitionEn") VALUES($1,$2,'n.','原创测试义','Original synthetic meaning.')`,
        [sourceId, wordId],
      );
      const originalSource = (await client.query(`SELECT * FROM "Sense" WHERE id=$1`, [sourceId]))
        .rows[0]!;
      const originalWord = (await client.query(`SELECT * FROM "Word" WHERE id=$1`, [wordId]))
        .rows[0]!;
      await expect(
        importLearningSensesRows({ id: 'wrong-site', databaseUrl: databaseUrl! }, rows, manifest),
      ).rejects.toThrow('site_binding');
      await expect(
        importLearningSensesRows({ id: siteId, databaseUrl: databaseUrl! }, rows, manifest),
      ).resolves.toMatchObject({
        insertedSenses: 1,
        insertedBindings: 1,
        insertedExamples: 2,
        alreadyInstalled: false,
      });
      await expect(
        importLearningSensesRows({ id: siteId, databaseUrl: databaseUrl! }, rows, manifest),
      ).resolves.toMatchObject({
        insertedSenses: 0,
        insertedBindings: 0,
        insertedExamples: 0,
        alreadyInstalled: true,
      });
      expect(
        (await client.query(`SELECT * FROM "Sense" WHERE id=$1`, [sourceId])).rows[0]!,
      ).toEqual(originalSource);
      expect((await client.query(`SELECT * FROM "Word" WHERE id=$1`, [wordId])).rows[0]!).toEqual(
        originalWord,
      );
      await client.query(`UPDATE "Sense" SET pos='v.' WHERE id=$1`, [sourceId]);
      await expect(
        importLearningSensesRows({ id: siteId, databaseUrl: databaseUrl! }, rows, manifest),
      ).rejects.toThrow('source_drift');
      await client.query(`UPDATE "Sense" SET pos='n.' WHERE id=$1`, [sourceId]);
      // A held source can be explicitly republished only after its original
      // bytes have been restored; verify that restoration before isolating the
      // separate site-example-edit conflict below.
      await client.query(`UPDATE "LearningSense" SET status='published' WHERE id=$1`, [sense.id]);
      await expect(
        importLearningSensesRows({ id: siteId, databaseUrl: databaseUrl! }, rows, manifest),
      ).resolves.toMatchObject({
        alreadyInstalled: true,
        insertedSenses: 0,
        insertedBindings: 0,
        insertedExamples: 0,
      });
      await client.query(`UPDATE "WordExample" SET "exampleZh"='站点编辑后的内容' WHERE id=$1`, [
        sense.examples[0]!.id,
      ]);
      await expect(
        importLearningSensesRows({ id: siteId, databaseUrl: databaseUrl! }, rows, manifest),
      ).rejects.toThrow('installed_row_drift');
      expect(
        (
          await client.query(`SELECT "exampleZh" FROM "WordExample" WHERE id=$1`, [
            sense.examples[0]!.id,
          ])
        ).rows[0]!.exampleZh,
      ).toBe('站点编辑后的内容');
      // A second install whose later binding fails must roll back its earlier insert.
      const first = structuredClone(sense);
      first.id += '-rollback';
      first.bindingHash = '';
      for (const b of first.sourceBindings) {
        b.id += '-rollback';
        b.learningSenseId = first.id;
      }
      for (const e of first.examples) {
        e.id += '-rollback';
        e.learningSenseId = first.id;
      }
      first.bindingHash = learningSenseBindingHash(first);
      const second = structuredClone(first);
      second.id += '-missing';
      for (const b of second.sourceBindings) {
        b.id += '-missing';
        b.learningSenseId = second.id;
        b.sourceSenseId += '-missing';
      }
      for (const [index, e] of second.examples.entries()) {
        e.id += '-missing';
        e.learningSenseId = second.id;
        e.exampleEn += ` Another context ${index}.`;
        e.contentMetadata.exampleEnSha256 = hash(e.exampleEn);
        e.contentMetadata.textHash = hash(e.exampleEn);
      }
      second.bindingHash = learningSenseBindingHash(second);
      const rollbackManifest = {
        ...manifest,
        id: manifest.id + '-rollback',
        senseCount: 2,
        exampleCount: 4,
      };
      await expect(
        importLearningSensesRows(
          { id: siteId, databaseUrl: databaseUrl! },
          [{ ...rows[0]!, senses: [first, second] }],
          rollbackManifest,
        ),
      ).rejects.toThrow('source_drift');
      expect(
        (
          await client.query(`SELECT count(*)::int AS n FROM "LearningSense" WHERE id=$1`, [
            first.id,
          ])
        ).rows[0]!.n,
      ).toBe(0);
      expect(
        (
          await client.query(`SELECT count(*)::int AS n FROM "ContentPack" WHERE id=$1`, [
            rollbackManifest.id,
          ])
        ).rows[0]!.n,
      ).toBe(0);
    } finally {
      await client.query(`DELETE FROM "WordExample" WHERE "wordId"=$1`, [wordId]);
      await client.query(`DELETE FROM "SenseSourceBinding" WHERE "wordId"=$1`, [wordId]);
      await client.query(`DELETE FROM "LearningSense" WHERE "wordId"=$1`, [wordId]);
      await client.query(`DELETE FROM "Word" WHERE id=$1`, [wordId]);
      await client.query(`DELETE FROM "ContentPack" WHERE id=ANY($1::text[])`, [
        [manifest.id, manifest.id + '-rollback'],
      ]);
      await client.end();
    }
  },
);
