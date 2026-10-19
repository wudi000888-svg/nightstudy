import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it, vi } from 'vitest';
import {
  learningSenseBindingHash,
  learningSenseTextHash as hash,
} from '../apps/api/src/modules/learning-sense-integrity.js';
import {
  importLearningSensesRows,
  loadLearningSensesManifest,
  readLearningSensesRows,
  importLearningSensesBundle,
  learningSensesWordUnionHash,
  type LearningSensesBundle,
  type LearningSenseSourceAddition,
  loadLearningSensesBundle,
  prepareLearningSensesInstall,
  importPreparedLearningSenses,
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
    sense.contentMetadata.orthography = {
      displayLemma: lemma.toUpperCase(),
      normalizedLemma: lemma,
      displayLemmaSha256: hash(lemma.toUpperCase()),
      reviewer: 'Codex',
      decision: 'publish',
      expertCertified: false,
      reason: 'Synthetic case spelling reviewed explicitly for the installed atomic meaning.',
    };
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
      const installedMetadata = (
        await client.query(`SELECT "contentMetadata" FROM "LearningSense" WHERE id=$1`, [sense.id])
      ).rows[0]!.contentMetadata;
      expect(installedMetadata.orthography).toEqual(sense.contentMetadata.orthography);
      await client.query(
        `UPDATE "LearningSense" SET "contentMetadata"=jsonb_set("contentMetadata",'{orthography,displayLemma}','"tampered"') WHERE id=$1`,
        [sense.id],
      );
      await expect(
        importLearningSensesRows({ id: siteId, databaseUrl: databaseUrl! }, rows, manifest),
      ).rejects.toThrow('installed_row_drift');
      await client.query(`UPDATE "LearningSense" SET "contentMetadata"=$2::jsonb WHERE id=$1`, [
        sense.id,
        JSON.stringify(installedMetadata),
      ]);
      await client.query(`UPDATE "ContentPack" SET "entryCount"=0 WHERE id=$1`, [manifest.id]);
      await expect(
        importLearningSensesRows({ id: siteId, databaseUrl: databaseUrl! }, rows, manifest),
      ).rejects.toThrow('conflicting_installed_pack');
      await client.query(`UPDATE "ContentPack" SET "entryCount"=$2 WHERE id=$1`, [
        manifest.id,
        manifest.wordCount,
      ]);
      await client.query(
        `UPDATE "ContentPack" SET "tagCounts"=jsonb_set("tagCounts",'{contextExamples}','0') WHERE id=$1`,
        [manifest.id],
      );
      await expect(
        importLearningSensesRows({ id: siteId, databaseUrl: databaseUrl! }, rows, manifest),
      ).rejects.toThrow('conflicting_installed_pack');
      await client.query(
        `UPDATE "ContentPack" SET "tagCounts"=jsonb_set("tagCounts",'{contextExamples}',$2::jsonb) WHERE id=$1`,
        [manifest.id, JSON.stringify(manifest.exampleCount)],
      );
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

it.skipIf(!databaseUrl)(
  'original source additions preserve old sources, snapshot safely, replay strictly and roll back with late shard failures',
  async () => {
    if (!new URL(databaseUrl!).pathname.endsWith('_test'))
      throw new Error('use_a_disposable_test_database');
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const nonce = randomUUID(),
      base = loadLearningSensesManifest();
    const template = readLearningSensesRows(
      fs.readFileSync(new URL('../data/' + base.fileName, import.meta.url)),
      base,
    )[0]!.senses[0]!;
    const scratch = fs.mkdtempSync(
      path.join(process.env.TMPDIR || os.tmpdir(), 'nightstudy-source-additions-pg-'),
    );
    const leaves = [0, 1].map((index) => {
      const id = nonce + '-' + index,
        wordId = 'addition-word-' + id,
        lemma = 'additionfixture-' + id,
        sense = structuredClone(template);
      sense.id = 'addition-meaning-' + id;
      sense.wordId = wordId;
      sense.sourceBindings = [
        {
          ...sense.sourceBindings[0]!,
          id: 'addition-binding-' + id,
          wordId,
          learningSenseId: sense.id,
          sourceSenseId: 'addition-old-source-' + id,
          sourcePosSha256: hash('n.'),
          sourceDefinitionZhSha256: hash('原始旧义'),
          sourceDefinitionEnSha256: hash('Old original fixture meaning.'),
        },
      ];
      for (const [ordinal, e] of sense.examples.entries()) {
        Object.assign(e, {
          id: 'addition-example-' + id + '-' + ordinal,
          wordId,
          learningSenseId: sense.id,
          exampleEn: `We examine ${lemma} in synthetic context ${ordinal}.`,
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
      const rows = [{ wordId, normalizedLemma: lemma, senses: [sense] }];
      const manifest = {
        ...base,
        id: 'learning-senses-addition-' + id,
        fileName: `addition-${index}.jsonl.gz`,
        wordCount: 1,
        senseCount: 1,
        exampleCount: 2,
        activeBookWords: 2,
        wordsWithCuratedMeanings: 1,
        wordsAwaitingAtomicReview: 1,
      };
      return { rows, manifest, sourceRows: [] as LearningSenseSourceAddition[] };
    });
    const first = leaves[0]!,
      row = first.rows[0]!,
      meaning = row.senses[0]!,
      key = 'explicit-original-source';
    const addition: LearningSenseSourceAddition = {
      id: 'learning-source-' + hash(row.wordId + '\0' + key),
      wordId: row.wordId,
      normalizedLemma: row.normalizedLemma,
      pos: meaning.pos,
      definitionZh: meaning.definitionZh,
      definitionEn: meaning.definitionEn,
      exampleEn: '',
      exampleZh: '',
      ordinal: 1000000 + parseInt(hash(key).slice(0, 7), 16),
      contentMetadata: {
        kind: 'original-authoring',
        evidenceKind: 'codex-original-source-addition',
        author: 'NightStudy contributors',
        license: 'MIT',
        authoringMethod: 'Direct Codex bilingual writing',
        review: 'codex-reviewed',
        expertCertified: false,
        sourceAdditionVersion: 'codex-original-source-v1',
        semanticKey: key,
        definitionZhSha256: hash(meaning.definitionZh),
        definitionEnSha256: hash(meaning.definitionEn),
        editorialReview: {
          decision: 'publish',
          reviewer: 'Codex',
          expertCertified: false,
          semanticRationale:
            'Specific original synthetic source review; not an independently verified external dictionary.',
        },
      },
    };
    first.sourceRows = [addition];
    Object.assign(meaning.sourceBindings[0]!, {
      sourceSenseId: addition.id,
      sourcePosSha256: hash(addition.pos),
      sourceDefinitionZhSha256: hash(addition.definitionZh),
      sourceDefinitionEnSha256: hash(addition.definitionEn),
    });
    const sourceRaw = Buffer.from(JSON.stringify(addition) + '\n'),
      sourcePacked = gzipSync(sourceRaw);
    const { createHash } = await import('node:crypto');
    const bytesHash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const firstManifest = first.manifest as typeof first.manifest & {
      sourceAdditions?: {
        fileName: string;
        bytes: number;
        sha256: string;
        jsonlSha256: string;
        rowCount: number;
      };
    };
    firstManifest.sourceAdditions = {
      fileName: 'learning-sense-sources-fixture.jsonl.gz',
      bytes: sourcePacked.length,
      sha256: bytesHash(sourcePacked),
      jsonlSha256: bytesHash(sourceRaw),
      rowCount: 1,
    };
    fs.writeFileSync(path.join(scratch, firstManifest.sourceAdditions.fileName), sourcePacked);
    const pins = leaves.map((leaf, index) => {
      leaf.rows[0]!.senses[0]!.bindingHash = learningSenseBindingHash(leaf.rows[0]!.senses[0]!);
      const raw = Buffer.from(leaf.rows.map((r) => JSON.stringify(r)).join('\n') + '\n'),
        packed = gzipSync(raw);
      Object.assign(leaf.manifest, {
        bytes: packed.length,
        sha256: bytesHash(packed),
        jsonlSha256: bytesHash(raw),
      });
      fs.writeFileSync(path.join(scratch, leaf.manifest.fileName), packed);
      const manifestFileName = `learning-senses-addition-${index}.manifest.json`,
        bytes = Buffer.from(JSON.stringify(leaf.manifest));
      fs.writeFileSync(path.join(scratch, manifestFileName), bytes);
      return {
        id: leaf.manifest.id,
        manifestFileName,
        bytes: bytes.length,
        sha256: bytesHash(bytes),
        wordCount: 1,
        senseCount: 1,
        exampleCount: 2,
      };
    });
    const rows = leaves.flatMap((leaf) => leaf.rows),
      collection = {
        formatVersion: 2,
        kind: 'learning-senses-collection',
        id: 'learning-senses-collection-addition-' + nonce,
        version: 'fixture',
        sourceExportSha256: base.sourceExportSha256,
        bilingualOverlaySha256: base.bilingualOverlaySha256,
        requiredWordCount: 2,
        requiredWordsSha256: learningSensesWordUnionHash(rows),
        wordCount: 2,
        senseCount: 2,
        exampleCount: 4,
        editorialReview: 'codex-reviewed',
        semanticQualityCertified: false,
        exhaustiveBookCoverage: false,
        shards: pins,
      };
    const file = path.join(scratch, 'collection.manifest.json');
    fs.writeFileSync(file, JSON.stringify(collection));
    const bundle = loadLearningSensesBundle(file),
      baselineFile = path.join(scratch, 'before.json');
    const check = (extra: string[]) =>
      spawnSync(
        process.execPath,
        [
          'scripts/check-learning-senses-install.mjs',
          '--manifest',
          file,
          '--test-database-env',
          'CONTENT_TEST_DATABASE_URL',
          ...extra,
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, CONTENT_TEST_DATABASE_URL: databaseUrl },
        },
      );
    const ids = rows.map((r) => r.wordId),
      oldIds = ids.map((_, index) => 'addition-old-source-' + nonce + '-' + index);
    const siteId = (await client.query(`SELECT "siteId" FROM "SiteState" WHERE id='singleton'`))
      .rows[0]?.siteId;
    if (!siteId) throw new Error('test_database_not_prepared');
    try {
      for (const r of rows)
        await client.query(
          `INSERT INTO "Word"(id,lemma,"normalizedLemma","goalTags","updatedAt") VALUES($1,$2,$2,'{}',NOW())`,
          [r.wordId, r.normalizedLemma],
        );
      const insertOld = async (index: number) =>
        client.query(
          `INSERT INTO "Sense"(id,"wordId",pos,"definitionZh","definitionEn") VALUES($1,$2,'n.','原始旧义','Old original fixture meaning.')`,
          [oldIds[index], ids[index]],
        );
      await insertOld(0);
      expect(check(['--snapshot', baselineFile + '.failed']).status).not.toBe(0); // Preserve failed partials at a different path.
      expect(fs.existsSync(baselineFile)).toBe(false);
      await expect(
        importLearningSensesBundle({ id: siteId, databaseUrl: databaseUrl! }, bundle),
      ).rejects.toThrow('source_drift');
      expect(
        (await client.query(`SELECT count(*)::int n FROM "Sense" WHERE id=$1`, [addition.id]))
          .rows[0]!.n,
      ).toBe(0);
      expect(
        (
          await client.query(
            `SELECT count(*)::int n FROM "LearningSense" WHERE "wordId"=ANY($1::text[])`,
            [ids],
          )
        ).rows[0]!.n,
      ).toBe(0);
      await insertOld(1);
      expect(check(['--snapshot', baselineFile]).status).toBe(0);
      const snapshot = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
      expect(snapshot.formatVersion).toBe(2);
      const firstSnapshot = JSON.parse(
        fs.readFileSync(
          path.join(baselineFile + '.parts', snapshot.sites[siteId].leaves[0].fileName),
          'utf8',
        ),
      );
      expect(firstSnapshot.allowedNewSourceIds).toEqual([addition.id]);
      const before = (
        await client.query(`SELECT * FROM "Sense" WHERE id=ANY($1::text[]) ORDER BY id`, [oldIds])
      ).rows;
      const installed = await importLearningSensesBundle(
        { id: siteId, databaseUrl: databaseUrl! },
        bundle,
      );
      expect(installed.bundles.map((b) => b.insertedSourceSenses)).toEqual([1, 0]);
      expect(
        (
          await importLearningSensesBundle({ id: siteId, databaseUrl: databaseUrl! }, bundle)
        ).bundles.map((b) => b.insertedSourceSenses),
      ).toEqual([0, 0]);
      expect(
        (await client.query(`SELECT * FROM "Sense" WHERE id=ANY($1::text[]) ORDER BY id`, [oldIds]))
          .rows,
      ).toEqual(before);
      expect(check(['--baseline', baselineFile]).status).toBe(0);
      await client.query(
        `UPDATE "Sense" SET "contentMetadata"='{"changed":true}'::jsonb WHERE id=$1`,
        [oldIds[0]],
      );
      expect(check(['--baseline', baselineFile]).status).not.toBe(0);
      await client.query(`UPDATE "Sense" SET "contentMetadata"='{}'::jsonb WHERE id=$1`, [
        oldIds[0],
      ]);
      await client.query(
        `UPDATE "Sense" SET "definitionEn"="definitionEn" || ' changed' WHERE id=$1`,
        [addition.id],
      );
      await expect(
        importLearningSensesBundle({ id: siteId, databaseUrl: databaseUrl! }, bundle),
      ).rejects.toThrow('installed_row_drift:Sense');
      expect(check(['--baseline', baselineFile]).status).not.toBe(0);
      await client.query(`UPDATE "Sense" SET "definitionEn"=$2 WHERE id=$1`, [
        addition.id,
        addition.definitionEn,
      ]);
      await client.query(`UPDATE "LearningSense" SET status='published' WHERE id=$1`, [meaning.id]);
      expect(
        (await importLearningSensesBundle({ id: siteId, databaseUrl: databaseUrl! }, bundle))
          .alreadyInstalled,
      ).toBe(true);
      await client.query(`DELETE FROM "SenseSourceBinding" WHERE "sourceSenseId"=$1`, [
        addition.id,
      ]);
      await client.query(`DELETE FROM "Sense" WHERE id=$1`, [addition.id]);
      await expect(
        importLearningSensesBundle({ id: siteId, databaseUrl: databaseUrl! }, bundle),
      ).rejects.toThrow('installed_row_missing:Sense');
      expect(
        (await client.query(`SELECT count(*)::int n FROM "Sense" WHERE id=$1`, [addition.id]))
          .rows[0]!.n,
      ).toBe(0);
    } finally {
      await client.query(`DELETE FROM "WordExample" WHERE "wordId"=ANY($1::text[])`, [ids]);
      await client.query(`DELETE FROM "SenseSourceBinding" WHERE "wordId"=ANY($1::text[])`, [ids]);
      await client.query(`DELETE FROM "LearningSense" WHERE "wordId"=ANY($1::text[])`, [ids]);
      await client.query(`DELETE FROM "Word" WHERE id=ANY($1::text[])`, [ids]);
      await client.query(`DELETE FROM "ContentPack" WHERE id=ANY($1::text[])`, [
        leaves.map((leaf) => leaf.manifest.id),
      ]);
      await client.end();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  },
  30000,
);

it.skipIf(!databaseUrl)(
  'prepared shards preserve realm, replay and atomic rollback for late DB and input changes',
  async () => {
    if (!new URL(databaseUrl!).pathname.endsWith('_test'))
      throw new Error('use_a_disposable_test_database');
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const nonce = randomUUID(),
      base = loadLearningSensesManifest();
    const original = readLearningSensesRows(
      fs.readFileSync(new URL('../data/' + base.fileName, import.meta.url)),
      base,
    );
    const leaves = [0, 1].map((index) => {
      const suffix = nonce + '-' + index,
        wordId = 'collection-word-' + suffix,
        lemma = 'collectionfixture-' + suffix;
      const sense = structuredClone(original[0]!.senses[0]!);
      sense.id = 'collection-sense-' + suffix;
      sense.wordId = wordId;
      sense.sourceBindings = [
        {
          ...sense.sourceBindings[0]!,
          id: 'collection-binding-' + suffix,
          wordId,
          learningSenseId: sense.id,
          sourceSenseId: 'collection-source-' + suffix,
          sourcePosSha256: hash('n.'),
          sourceDefinitionZhSha256: hash('原创测试义'),
          sourceDefinitionEnSha256: hash('Original synthetic meaning.'),
        },
      ];
      for (const [ordinal, example] of sense.examples.entries()) {
        Object.assign(example, {
          id: 'collection-example-' + suffix + '-' + ordinal,
          wordId,
          learningSenseId: sense.id,
          exampleEn: `We use ${lemma} in synthetic context ${ordinal}.`,
        });
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
      return {
        manifest: {
          ...base,
          id: 'learning-senses-collection-test-' + suffix,
          wordCount: 1,
          senseCount: 1,
          exampleCount: 2,
          activeBookWords: 2,
          wordsWithCuratedMeanings: 1,
          wordsAwaitingAtomicReview: 1,
          sha256: hash(suffix),
        },
        rows: [{ wordId, normalizedLemma: lemma, senses: [sense] }],
      };
    });
    const rows = leaves.flatMap((leaf) => leaf.rows);
    const bundle: LearningSensesBundle = {
      kind: 'collection',
      bundles: leaves,
      rows,
      collection: {
        formatVersion: 2,
        kind: 'learning-senses-collection',
        id: 'learning-senses-collection-test-' + nonce,
        version: 'fixture',
        sourceExportSha256: base.sourceExportSha256,
        bilingualOverlaySha256: base.bilingualOverlaySha256,
        requiredWordCount: 2,
        requiredWordsSha256: learningSensesWordUnionHash(rows),
        wordCount: 2,
        senseCount: 2,
        exampleCount: 4,
        editorialReview: 'codex-reviewed',
        semanticQualityCertified: false,
        exhaustiveBookCoverage: false,
        shards: leaves.map((leaf, index) => ({
          manifestFileName: `learning-senses-collection-test-${index}.manifest.json`,
          bytes: 1,
          sha256: hash('fixture-' + index),
          id: leaf.manifest.id,
          wordCount: 1,
          senseCount: 1,
          exampleCount: 2,
        })),
      },
    };
    const scratch = fs.mkdtempSync(
      path.join(process.env.TMPDIR || os.tmpdir(), 'nightstudy-prepared-db-'),
    );
    for (const [index, leaf] of leaves.entries()) {
      const raw = Buffer.from(leaf.rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      const packed = gzipSync(raw);
      Object.assign(leaf.manifest, {
        fileName: 'prepared-' + index + '.jsonl.gz',
        bytes: packed.length,
        sha256: createHash('sha256').update(packed).digest('hex'),
        jsonlSha256: createHash('sha256').update(raw).digest('hex'),
      });
      fs.writeFileSync(path.join(scratch, leaf.manifest.fileName), packed);
      const bytes = Buffer.from(JSON.stringify(leaf.manifest));
      const pin = bundle.collection!.shards[index]!;
      Object.assign(pin, {
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      fs.writeFileSync(path.join(scratch, pin.manifestFileName), bytes);
    }
    const file = path.join(scratch, 'collection.manifest.json');
    fs.writeFileSync(file, JSON.stringify(bundle.collection));
    let plan = prepareLearningSensesInstall(file);
    const siteId = (await client.query(`SELECT "siteId" FROM "SiteState" WHERE id='singleton'`))
      .rows[0]?.siteId;
    if (!siteId) throw new Error('test_database_not_prepared');
    try {
      for (const row of rows)
        await client.query(
          `INSERT INTO "Word"(id,lemma,"normalizedLemma","goalTags","updatedAt") VALUES($1,$2,$2,'{}',NOW())`,
          [row.wordId, row.normalizedLemma],
        );
      const insertSource = async (index: number) =>
        client.query(
          `INSERT INTO "Sense"(id,"wordId",pos,"definitionZh","definitionEn") VALUES($1,$2,'n.','原创测试义','Original synthetic meaning.')`,
          [rows[index]!.senses[0]!.sourceBindings[0]!.sourceSenseId, rows[index]!.wordId],
        );
      await insertSource(0);
      await expect(
        importPreparedLearningSenses({ id: 'another-site', databaseUrl: databaseUrl! }, plan),
      ).rejects.toThrow('site_binding');
      await expect(
        importPreparedLearningSenses({ id: siteId, databaseUrl: databaseUrl! }, plan),
      ).rejects.toThrow('source_drift');
      expect(
        (
          await client.query(
            `SELECT count(*)::int n FROM "LearningSense" WHERE "wordId"=ANY($1::text[])`,
            [rows.map((r) => r.wordId)],
          )
        ).rows[0]!.n,
      ).toBe(0);
      expect(
        (
          await client.query(`SELECT count(*)::int n FROM "ContentPack" WHERE id=ANY($1::text[])`, [
            leaves.map((l) => l.manifest.id),
          ])
        ).rows[0]!.n,
      ).toBe(0);
      await insertSource(1);
      const originalQuery = Client.prototype.query;
      const tamperDuringInstall = async (packId: string, target: string) => {
        const originalBytes = fs.readFileSync(target);
        let changed = false;
        const spy = vi.spyOn(Client.prototype, 'query');
        spy.mockImplementation(async function (this: Client, ...args: unknown[]) {
          const result = await Reflect.apply(originalQuery, this, args);
          if (
            !changed &&
            typeof args[0] === 'string' &&
            args[0].includes('INSERT INTO "ContentPack"') &&
            Array.isArray(args[1]) &&
            args[1][0] === packId
          ) {
            changed = true;
            fs.appendFileSync(target, ' ');
          }
          return result;
        } as Client['query']);
        try {
          await expect(
            importPreparedLearningSenses({ id: siteId, databaseUrl: databaseUrl! }, plan),
          ).rejects.toThrow('prepared_input_changed');
          expect(changed).toBe(true);
        } finally {
          spy.mockRestore();
          fs.writeFileSync(target, originalBytes);
        }
        expect(
          (
            await client.query(
              `SELECT count(*)::int n FROM "LearningSense" WHERE "wordId"=ANY($1::text[])`,
              [rows.map((row) => row.wordId)],
            )
          ).rows[0]!.n,
        ).toBe(0);
        expect(
          (
            await client.query(
              `SELECT count(*)::int n FROM "ContentPack" WHERE id=ANY($1::text[])`,
              [leaves.map((leaf) => leaf.manifest.id)],
            )
          ).rows[0]!.n,
        ).toBe(0);
        plan = prepareLearningSensesInstall(file);
      };
      // Change an unread later leaf after the first pack INSERT; no partial pack may commit.
      await tamperDuringInstall(
        leaves[0]!.manifest.id,
        path.join(scratch, bundle.collection!.shards[1]!.manifestFileName),
      );
      // Change an already-read first leaf after the last pack INSERT. The final
      // identity check must still be inside the transaction, before COMMIT.
      await tamperDuringInstall(
        leaves[1]!.manifest.id,
        path.join(scratch, leaves[0]!.manifest.fileName),
      );
      const result = await importPreparedLearningSenses(
        { id: siteId, databaseUrl: databaseUrl! },
        plan,
      );
      expect(result.bundles.map((b) => b.insertedSenses)).toEqual([1, 1]);
      expect(
        (await importPreparedLearningSenses({ id: siteId, databaseUrl: databaseUrl! }, plan))
          .alreadyInstalled,
      ).toBe(true);
      const sourceBefore = (
        await client.query(`SELECT * FROM "Sense" WHERE "wordId"=ANY($1::text[]) ORDER BY id`, [
          rows.map((r) => r.wordId),
        ])
      ).rows;
      await importPreparedLearningSenses({ id: siteId, databaseUrl: databaseUrl! }, plan);
      expect(
        (
          await client.query(`SELECT * FROM "Sense" WHERE "wordId"=ANY($1::text[]) ORDER BY id`, [
            rows.map((r) => r.wordId),
          ])
        ).rows,
      ).toEqual(sourceBefore);
    } finally {
      const ids = rows.map((r) => r.wordId);
      await client.query(`DELETE FROM "WordExample" WHERE "wordId"=ANY($1::text[])`, [ids]);
      await client.query(`DELETE FROM "SenseSourceBinding" WHERE "wordId"=ANY($1::text[])`, [ids]);
      await client.query(`DELETE FROM "LearningSense" WHERE "wordId"=ANY($1::text[])`, [ids]);
      await client.query(`DELETE FROM "Word" WHERE id=ANY($1::text[])`, [ids]);
      await client.query(`DELETE FROM "ContentPack" WHERE id=ANY($1::text[])`, [
        leaves.map((l) => l.manifest.id),
      ]);
      await client.end();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  },
);
