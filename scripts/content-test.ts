import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  contentFixtureRows,
  runContentPostgresFixture,
  writeContentFixture,
} from './content-fixture.js';
import {
  mapEcdictRow,
  normalizeContentLemma,
  parseCsvChunks,
  readEcdict,
  stableWordId,
  verifyContentSource,
} from './content-lib.js';
import { loadExamBookManifest, readExamBookRows } from './exam-books-lib.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-content-test-'));
let checked = 0;
try {
  const fixture = writeContentFixture(directory);
  await verifyContentSource(fixture.sourcePath, fixture.manifest);
  checked++;
  // A membership pack adds books, not new dictionary entries. Validate its own
  // scoped counts rather than assuming the whole site always has five books.
  const examManifest = loadExamBookManifest();
  const examRows = readExamBookRows(
    fs.readFileSync(new URL(`../data/${examManifest.fileName}`, import.meta.url)),
    examManifest,
  );
  assert.equal(examRows.length, examManifest.membershipCount);
  assert.equal(new Set(examRows.map((row) => row.normalizedLemma)).size, examManifest.wordCount);
  checked++;
  const parsed = [];
  for await (const row of readEcdict(fixture.sourcePath)) parsed.push(row);
  assert.deepEqual(parsed, contentFixtureRows());
  checked++;
  const chunked = [];
  for await (const fields of parseCsvChunks(
    Readable.from(['a,b\r', '\n"中,', '文","escaped "', '"quote"""\r', '\n']),
  ))
    chunked.push(fields);
  assert.deepEqual(chunked, [
    ['a', 'b'],
    ['中,文', 'escaped "quote"'],
  ]);
  checked++;
  await assert.rejects(async () => {
    for await (const _row of parseCsvChunks(Readable.from(['a\n"broken']))) {
      /* consume */
    }
  }, /unterminated/);
  checked++;
  assert.equal(normalizeContentLemma('  ＲＡＩＮ ’ TEST  '), "rain ' test");
  assert.equal(stableWordId(normalizeContentLemma('ＲＡＩＮ')), stableWordId('rain'));
  checked++;
  const mixed = mapEcdictRow(contentFixtureRows()[4]!);
  assert.equal(mixed.senses.filter((sense) => sense.definitionZh).length, 2);
  assert.equal(mixed.senses.filter((sense) => sense.definitionEn).length, 3);
  assert.equal(
    mixed.senses.every((sense) => !(sense.definitionEn && sense.definitionZh)),
    true,
  );
  checked++;
  assert.equal(
    mapEcdictRow({ ...contentFixtureRows()[0]!, phonetic: 'RAW-SOURCE-FIELD' }).phonetic,
    'RAW-SOURCE-FIELD',
  );
  checked++;
  assert.equal(mapEcdictRow(contentFixtureRows()[6]!).senses.length, 0);
  checked++;
  await assert.rejects(
    verifyContentSource(fixture.sourcePath, { ...fixture.manifest, sha256: '0'.repeat(64) }),
    /checksum/,
  );
  checked++;
  const databaseUrl = process.env.CONTENT_TEST_DATABASE_URL;
  if (databaseUrl)
    checked += await runContentPostgresFixture(databaseUrl, path.join(directory, 'postgres'));
  console.log(
    JSON.stringify({
      action: 'content.test',
      passedChecks: checked,
      postgres: databaseUrl ? 'passed' : 'skipped',
      syntheticOnly: true,
    }),
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
