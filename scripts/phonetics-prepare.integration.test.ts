import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { importPhoneticsSite, refreshPhoneticsCoverage } from './phonetics-prepare.js';
import { parsePhoneticsTsv, phoneticsPacks, type PhoneticsPack } from './phonetics-lib.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('PostgreSQL phonetics preparation preserves installed metadata on replay', () => {
  if (!databaseUrl) return;
  const url = new URL(databaseUrl);
  if (
    !url.pathname.endsWith('_test') ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  )
    throw new Error('phonetics_tests_require_local_isolated_test_database');
  const client = new Client({ connectionString: databaseUrl });
  const nonce = randomUUID();
  const prefix = `phonetics-it-${nonce}`;
  const letters = nonce
    .replaceAll('-', '')
    .replace(/[0-9]/g, (digit) => String.fromCharCode(107 + Number(digit)));
  const lemmas = ['owned', 'missing', 'partial', 'draft'].map((word) => `${word}${letters}`);
  const wordIds = lemmas.map((_, index) => `${prefix}-word-${index}`);
  const packIds = [`${prefix}-us`, `${prefix}-uk`];
  const site = { id: 'default', databaseUrl };
  // Synthetic namespaces exercise the real two-pack SQL path without importing any
  // source files, matching real catalog words, or modifying existing source packs.
  const prepared = (['us', 'uk'] as const).map((accent, index) => ({
    pack: {
      ...phoneticsPacks[accent],
      id: packIds[index]!,
      sourceEntryCount: lemmas.length,
    } as PhoneticsPack,
    parsed: parsePhoneticsTsv(
      lemmas.map((lemma) => `${lemma}\t${accent === 'us' ? '/tɛst/' : '/test/'}`).join('\n'),
    ),
  }));
  const rows = async (table: 'Word' | 'ContentPack', scope: string[] | null = null) =>
    (
      await client.query<{ row: Record<string, unknown> }>(
        `SELECT to_jsonb(t) AS row FROM "${table}" t ${scope ? 'WHERE id=ANY($1::text[])' : ''} ORDER BY id COLLATE "C"`,
        scope ? [scope] : [],
      )
    ).rows.map((row) => row.row);
  const withoutDerivedCoverage = (row: Record<string, unknown>) => {
    const copy = structuredClone(row);
    delete copy.updatedAt;
    delete (copy.tagCounts as Record<string, unknown>).coverage;
    return copy;
  };
  let originalWord: Record<string, unknown>;

  beforeAll(async () => {
    await client.connect();
    expect(
      (await client.query('SELECT "siteId" FROM "SiteState" WHERE id=\'singleton\'')).rows[0]
        ?.siteId,
    ).toBe(site.id);
    for (const [index, id] of wordIds.entries()) {
      await client.query(
        `INSERT INTO "Word" (id,lemma,"normalizedLemma","phonetic","phoneticUs","phoneticUk","phoneticSource",status,"goalTags","sourceRef","contentVersion","updatedAt")
         VALUES($1,$2,$2,$3,$4,$5,$6,$7,'{}','Original test metadata','integration-only','2001-01-01T00:00:00Z')`,
        [
          id,
          lemmas[index],
          index === 0 ? 'legacy-original' : '',
          index === 0 ? '/ɑ/' : '',
          index === 0 || index === 2 ? '/ɒ/' : '',
          index === 0 || index === 2 ? 'Existing authored pronunciation' : '',
          index === 3 ? 'draft' : 'published',
        ],
      );
    }
    originalWord = (await rows('Word', [wordIds[0]!]))[0]!;
  });
  afterAll(async () => {
    await client.query('DELETE FROM "ContentPack" WHERE id=ANY($1::text[])', [packIds]);
    await client.query('DELETE FROM "Word" WHERE id=ANY($1::text[])', [wordIds]);
    await client.end();
  });

  it('fills only blank accent IPA while counting all canonical matches and preserving original word metadata', async () => {
    const result = await importPhoneticsSite(site, prepared);
    expect(result.matchedPacks.map((pack) => pack.matchedWords)).toEqual([4, 4]);
    expect(result.coverageUpdatedPacks).toBe(2);
    const words = await rows('Word', wordIds);
    expect(words.find((word) => word.id === wordIds[0])).toEqual(originalWord);
    expect(words.find((word) => word.id === wordIds[1])).toMatchObject({
      phoneticUs: '/tɛst/',
      phoneticUk: '/test/',
    });
    expect(words.find((word) => word.id === wordIds[2])).toMatchObject({
      phoneticUs: '/tɛst/',
      phoneticUk: '/ɒ/',
    });
    expect(words.find((word) => word.id === wordIds[3])).toMatchObject({
      status: 'draft',
      sourceRef: 'Original test metadata',
      contentVersion: 'integration-only',
    });
    for (const pack of await rows('ContentPack', packIds)) {
      expect(pack.entryCount).toBe(4);
      expect(pack.tagCounts).toMatchObject({
        kind: 'phonetics',
        matchedWordCount: 4,
        coverage: result.coverage,
      });
    }
  });

  it('replays the complete two-pack SQL preparation with every ContentPack row and word timestamp byte-for-byte unchanged', async () => {
    await client.query(
      'UPDATE "ContentPack" SET "tagCounts"="tagCounts" || \'{"retainedAdditionalTag":true}\'::jsonb WHERE id=ANY($1::text[])',
      [packIds],
    );
    const beforePacks = await rows('ContentPack');
    const beforeWords = await rows('Word', wordIds);
    const result = await importPhoneticsSite(site, prepared);
    expect(result.matchedPacks.map((pack) => pack.matchedWords)).toEqual([4, 4]);
    expect(result.coverageUpdatedPacks).toBe(0);
    expect(await rows('ContentPack')).toEqual(beforePacks);
    expect(await rows('Word', wordIds)).toEqual(beforeWords);
  });

  it('allows a real coverage change after later content/audio work, but changes no other pack fields or word data', async () => {
    const before = await rows('ContentPack', packIds);
    const unrelated = (await rows('ContentPack')).filter(
      (row) => !packIds.includes(row.id as string),
    );
    await client.query('UPDATE "Word" SET "phonetic"=\'new-real-legacy-coverage\' WHERE id=$1', [
      wordIds[1],
    ]);
    const words = await rows('Word', wordIds);
    const result = await refreshPhoneticsCoverage(site, packIds);
    expect(result.matchedPacks).toEqual([]);
    expect(result.coverageUpdatedPacks).toBe(2);
    const after = await rows('ContentPack', packIds);
    for (const [index, row] of after.entries()) {
      expect(withoutDerivedCoverage(row)).toEqual(withoutDerivedCoverage(before[index]!));
      expect((row.tagCounts as Record<string, unknown>).coverage).toEqual(result.coverage);
      expect(result.coverage.legacy).toBe(
        ((before[index]!.tagCounts as Record<string, unknown>).coverage as { legacy: number })
          .legacy + 1,
      );
    }
    expect(
      (await rows('ContentPack')).filter((row) => !packIds.includes(row.id as string)),
    ).toEqual(unrelated);
    expect(await rows('Word', wordIds)).toEqual(words);
    const stablePacks = await rows('ContentPack');
    expect((await refreshPhoneticsCoverage(site, packIds)).coverageUpdatedPacks).toBe(0);
    expect(await rows('ContentPack')).toEqual(stablePacks);
    expect((await importPhoneticsSite(site, prepared)).coverageUpdatedPacks).toBe(0);
    expect(await rows('ContentPack')).toEqual(stablePacks);
  });

  it('does not create packs or change any word when coverage-only sees no installed source pack', async () => {
    const beforePacks = await rows('ContentPack');
    const beforeWords = await rows('Word', wordIds);
    const missing = [`${prefix}-not-installed`];
    expect((await refreshPhoneticsCoverage(site, missing)).coverageUpdatedPacks).toBe(0);
    expect(await rows('ContentPack')).toEqual(beforePacks);
    expect(await rows('Word', wordIds)).toEqual(beforeWords);
  });

  it('rejects a different realm before either importer or coverage refresh can write', async () => {
    const beforePacks = await rows('ContentPack');
    const beforeWords = await rows('Word', wordIds);
    await expect(importPhoneticsSite({ ...site, id: 'wrong-realm' }, prepared)).rejects.toThrow(
      'phonetics_site_binding_mismatch',
    );
    await expect(refreshPhoneticsCoverage({ ...site, id: 'wrong-realm' }, packIds)).rejects.toThrow(
      'phonetics_site_binding_mismatch',
    );
    expect(await rows('ContentPack')).toEqual(beforePacks);
    expect(await rows('Word', wordIds)).toEqual(beforeWords);
  });
});
