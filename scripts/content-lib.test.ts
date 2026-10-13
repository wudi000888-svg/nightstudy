import { beforeAll, afterAll, describe, expect, it } from 'vitest';
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

let directory: string;
beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-content-vitest-'));
});
afterAll(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('pinned content tooling', () => {
  it('round-trips UTF8, multiline and escaped CSV without discarding fields', async () => {
    const fixture = writeContentFixture(path.join(directory, 'csv'));
    const rows = [];
    for await (const row of readEcdict(fixture.sourcePath)) rows.push(row);
    expect(rows).toEqual(contentFixtureRows());
  });
  it('handles quoted fields and CRLF across stream chunks', async () => {
    const rows = [];
    for await (const row of parseCsvChunks(
      Readable.from(['a,b\r', '\n"中,', '文","escaped "', '"quote"""\r', '\n']),
    ))
      rows.push(row);
    expect(rows).toEqual([
      ['a', 'b'],
      ['中,文', 'escaped "quote"'],
    ]);
  });
  it('rejects a truncated quoted field', async () => {
    await expect(
      (async () => {
        for await (const _ of parseCsvChunks(Readable.from(['a\n"broken']))) {
          /* consume */
        }
      })(),
    ).rejects.toThrow('unterminated');
  });
  it('uses the same stable identity for normalized spelling variants', () => {
    expect(normalizeContentLemma('  ＲＡＩＮ ’ TEST  ')).toBe("rain ' test");
    expect(stableWordId(normalizeContentLemma('ＲＡＩＮ'))).toBe(stableWordId('rain'));
  });
  it('preserves multiple definitions without inventing cross-language alignment or examples', () => {
    const row = mapEcdictRow(contentFixtureRows()[4]!);
    expect(row.senses.filter((sense) => sense.definitionZh)).toHaveLength(2);
    expect(row.senses.filter((sense) => sense.definitionEn)).toHaveLength(3);
    expect(row.senses.every((sense) => !(sense.definitionEn && sense.definitionZh))).toBe(true);
    expect(mapEcdictRow(contentFixtureRows()[6]!).senses).toEqual([]);
  });
  it('preserves raw source transcription and does not assign a region', () => {
    const row = mapEcdictRow({ ...contentFixtureRows()[0]!, phonetic: 'RAW-SOURCE-FIELD' });
    expect(row.phonetic).toBe('RAW-SOURCE-FIELD');
    expect(row).not.toHaveProperty('phoneticUs');
    expect(row).not.toHaveProperty('phoneticUk');
  });
  it('rejects wrong source size or SHA before import', async () => {
    const fixture = writeContentFixture(path.join(directory, 'checksum'));
    await expect(
      verifyContentSource(fixture.sourcePath, fixture.manifest),
    ).resolves.toBeUndefined();
    await expect(
      verifyContentSource(fixture.sourcePath, {
        ...fixture.manifest,
        bytes: fixture.manifest.bytes + 1,
      }),
    ).rejects.toThrow('size');
    await expect(
      verifyContentSource(fixture.sourcePath, { ...fixture.manifest, sha256: '0'.repeat(64) }),
    ).rejects.toThrow('checksum');
  });
  it.skipIf(!process.env.CONTENT_TEST_DATABASE_URL)(
    'keeps PG state unchanged on checksum failure, preserves edits and replays safely',
    async () => {
      expect(
        await runContentPostgresFixture(
          process.env.CONTENT_TEST_DATABASE_URL!,
          path.join(directory, 'postgres'),
        ),
      ).toBe(7);
    },
  );
});
