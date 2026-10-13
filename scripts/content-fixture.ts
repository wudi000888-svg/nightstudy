import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import {
  importContentIntoSite,
  mapEcdictRow,
  normalizeContentLemma,
  type ContentManifest,
  type EcdictRow,
} from './content-lib.js';

// Original synthetic parser/import data. It is never a learning dictionary or IPA source.
export function contentFixtureRows(): EcdictRow[] {
  const base: EcdictRow = {
    word: '',
    phonetic: '',
    definition: '',
    translation: '',
    pos: '',
    collins: '',
    oxford: '',
    tag: '',
    bnc: '0',
    frq: '0',
    exchange: '',
    detail: '',
    audio: '',
  };
  return [
    {
      ...base,
      word: 'fixture-rain',
      translation: 'n. 合成测试义项',
      definition: 'n. An original test entry.',
      tag: 'gk cet4 cet6 ielts',
      frq: '10',
    },
    {
      ...base,
      word: 'fixture-admin',
      translation: 'n. 上游测试文字，不覆盖管理编辑',
      tag: 'cet4',
      bnc: '20',
    },
    {
      ...base,
      word: 'fixture-quote',
      translation: 'n. 带有逗号, 和 "双引号" 的测试',
      definition: 'An unpaired English test definition.',
      tag: 'gk',
    },
    { ...base, word: 'fixture-café', translation: 'n. UTF-8合成字段', tag: 'cet6' },
    {
      ...base,
      word: 'fixture-multiline',
      translation: 'n. 第一行\\nv. 第二行',
      definition: 'First English line.\nSecond English line.\nThird English line.',
      tag: 'ielts',
    },
    { ...base, word: 'fixture-en-only', definition: 'An English-only synthetic field.' },
    { ...base, word: 'fixture-empty' },
    { ...base, word: 'ＦＩＸＴＵＲＥ-case', translation: 'n. 规范化测试', frq: '3000' },
  ];
}

export function writeContentFixture(
  directory: string,
  rows = contentFixtureRows(),
): { sourcePath: string; manifest: ContentManifest } {
  fs.mkdirSync(directory, { recursive: true });
  const columns = Object.keys(rows[0]!) as (keyof EcdictRow)[];
  const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const csv =
    [
      columns.join(','),
      ...rows.map((row) => columns.map((column) => cell(row[column])).join(',')),
    ].join('\r\n') + '\r\n';
  const sourcePath = path.resolve(directory, 'synthetic-ecdict-format.csv');
  fs.writeFileSync(sourcePath, csv, 'utf8');
  const bytes = fs.readFileSync(sourcePath);
  const tagCounts: Record<string, number> = {},
    bookCounts: Record<string, number> = { daily: 0, 'high-school': 0, cet4: 0, cet6: 0, ielts: 0 };
  for (const row of rows) {
    row.tag
      .split(/\s+/)
      .filter(Boolean)
      .forEach((tag) => {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      });
    const entry = mapEcdictRow(row);
    if (entry.focusSenseId)
      entry.goalTags.forEach((goal) => {
        bookCounts[goal] = (bookCounts[goal] || 0) + 1;
      });
  }
  const manifest: ContentManifest = {
    formatVersion: 1,
    id: 'nightstudy-test-fixture-v1',
    version: 'original-synthetic-v1',
    sourceUrl: 'https://github.com/wudi000888-svg/nightstudy/blob/main/scripts/content-fixture.ts',
    fileName: path.basename(sourcePath),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    license: 'MIT',
    statistics: {
      entryCount: rows.length,
      phoneticCount: 0,
      definitionZhCount: rows.filter((row) => row.translation).length,
      definitionEnCount: rows.filter((row) => row.definition).length,
      tagCounts,
      bookCounts,
    },
  };
  fs.writeFileSync(
    path.join(directory, 'synthetic.manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  return { sourcePath, manifest };
}

export async function runContentPostgresFixture(
  databaseUrl: string,
  directory: string,
): Promise<number> {
  if (!new URL(databaseUrl).pathname.endsWith('_test'))
    throw new Error('CONTENT_TEST_DATABASE_URL must be a disposable database ending in _test');
  const fixture = writeContentFixture(directory, contentFixtureRows().slice(0, 3));
  const names = ['fixture-rain', 'fixture-admin', 'fixture-quote', 'fixture-rollback'];
  const bookIds = ['daily', 'high-school', 'cet4', 'cet6', 'ielts'].map(
    (goal) => `content-${fixture.manifest.id}-${goal}`,
  );
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  let ownNamespace = false,
    checks = 0;
  let state:
    | { siteId: string; contentVersion: string; initialized: boolean; initializedAt: Date | null }
    | undefined;
  try {
    state = (
      await client.query<typeof state & {}>(
        `SELECT "siteId","contentVersion","initialized","initializedAt" FROM "SiteState" WHERE "id"='singleton'`,
      )
    ).rows[0];
    if (!state) throw new Error('test_database_not_prepared');
    const namespace = await client.query(
      `SELECT 1 FROM "Word" WHERE "normalizedLemma"=ANY($1::text[]) UNION ALL SELECT 1 FROM "ContentPack" WHERE "id"=$2`,
      [names, fixture.manifest.id],
    );
    if (namespace.rowCount) throw new Error('test_fixture_namespace_not_clean');
    ownNamespace = true;
    const before = (
      await client.query(
        `SELECT (SELECT count(*) FROM "Word") AS words,(SELECT count(*) FROM "ContentPack") AS packs`,
      )
    ).rows[0];
    await assert.rejects(
      importContentIntoSite({ id: state.siteId, databaseUrl }, fixture.sourcePath, {
        ...fixture.manifest,
        sha256: '0'.repeat(64),
      }),
      /checksum/,
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT (SELECT count(*) FROM "Word") AS words,(SELECT count(*) FROM "ContentPack") AS packs`,
        )
      ).rows[0],
      before,
    );
    checks++;
    await client.query(
      `INSERT INTO "Word" ("id","lemma","normalizedLemma","goalTags","sourceRef","contentVersion","updatedAt") VALUES ('fixture-preserved-demo-id','fixture-rain','fixture-rain',ARRAY['daily'],'NightStudy original demo','demo-test',NOW())`,
    );
    await client.query(
      `INSERT INTO "Sense" ("id","wordId","pos","definitionZh","definitionEn","exampleEn","ordinal") VALUES ('fixture-original-sense','fixture-preserved-demo-id','n.','保留的原创测试释义','An original synthetic definition.','Original synthetic example.',0)`,
    );
    await client.query(
      `INSERT INTO "Word" ("id","lemma","normalizedLemma","phonetic","goalTags","sourceRef","contentVersion","updatedAt") VALUES ('fixture-preserved-admin-id','fixture-admin','fixture-admin','KEEP-ADMIN',ARRAY['daily'],'local authored test','edit-admin-test',NOW())`,
    );
    await client.query(
      `INSERT INTO "Sense" ("id","wordId","pos","definitionZh","ordinal") VALUES ('fixture-admin-sense','fixture-preserved-admin-id','n.','必须保留的管理员测试编辑',0)`,
    );
    const site = { id: state.siteId, databaseUrl };
    const result = await importContentIntoSite(site, fixture.sourcePath, fixture.manifest, {
      batchSize: 2,
    });
    assert.equal(result.sourceEntries, 3);
    assert.equal(result.newWords, 1);
    assert.equal(result.updatedDemoWords, 1);
    checks++;
    const demo = (
      await client.query(
        `SELECT "id","sourceRef" FROM "Word" WHERE "normalizedLemma"='fixture-rain'`,
      )
    ).rows[0];
    assert.equal(demo.id, 'fixture-preserved-demo-id');
    assert.equal(demo.sourceRef, `pack:${fixture.manifest.id}`);
    assert.equal(
      (await client.query(`SELECT 1 FROM "Sense" WHERE "id"='fixture-original-sense'`)).rowCount,
      1,
    );
    checks++;
    const protectedWord = (
      await client.query(
        `SELECT "id","phonetic","contentVersion","goalTags" FROM "Word" WHERE "normalizedLemma"='fixture-admin'`,
      )
    ).rows[0];
    assert.equal(protectedWord.id, 'fixture-preserved-admin-id');
    assert.equal(protectedWord.phonetic, 'KEEP-ADMIN');
    assert.equal(protectedWord.contentVersion, 'edit-admin-test');
    assert.deepEqual(protectedWord.goalTags, ['daily']);
    assert.equal(
      (
        await client.query(
          `SELECT "id" FROM "Sense" WHERE "wordId"='fixture-preserved-admin-id' ORDER BY "ordinal","id" LIMIT 1`,
        )
      ).rows[0].id,
      'fixture-admin-sense',
    );
    checks++;
    const replay = await importContentIntoSite(site, fixture.sourcePath, fixture.manifest);
    assert.equal(replay.alreadyInstalled, true);
    assert.equal(replay.newWords, 0);
    assert.equal(replay.newSenses, 0);
    checks++;
    await assert.rejects(
      importContentIntoSite({ id: 'wrong-site', databaseUrl }, fixture.sourcePath, {
        ...fixture.manifest,
        id: 'fixture-invalid-site',
      }),
      /site_binding/,
    );
    checks++;
    const rollback = writeContentFixture(path.join(directory, 'rollback'), [
      contentFixtureRows()[0]!,
      contentFixtureRows()[1]!,
      { ...contentFixtureRows()[2]!, word: 'fixture-rollback' },
    ]);
    rollback.manifest.id = 'fixture-invalid-statistics';
    rollback.manifest.statistics.entryCount++;
    await assert.rejects(
      importContentIntoSite(site, rollback.sourcePath, rollback.manifest),
      /statistics/,
    );
    assert.equal(
      (await client.query(`SELECT 1 FROM "Word" WHERE "normalizedLemma"='fixture-rollback'`))
        .rowCount,
      0,
    );
    assert.equal(
      (await client.query(`SELECT 1 FROM "ContentPack" WHERE "id"='fixture-invalid-statistics'`))
        .rowCount,
      0,
    );
    checks++;
    return checks;
  } finally {
    if (ownNamespace) {
      await client.query(`DELETE FROM "BookItem" WHERE "bookId"=ANY($1::text[])`, [bookIds]);
      await client.query(`DELETE FROM "Book" WHERE "id"=ANY($1::text[])`, [bookIds]);
      await client.query(`DELETE FROM "Word" WHERE "normalizedLemma"=ANY($1::text[])`, [names]);
      await client.query(`DELETE FROM "ContentPack" WHERE "id"=$1`, [fixture.manifest.id]);
      if (state)
        await client.query(
          `UPDATE "SiteState" SET "contentVersion"=$1,"initialized"=$2,"initializedAt"=$3 WHERE "id"='singleton' AND "siteId"=$4`,
          [state.contentVersion, state.initialized, state.initializedAt, state.siteId],
        );
    }
    await client.end();
  }
}
