import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../apps/api/src/db.js';
import type { SiteConfig } from '../apps/api/src/config.js';
import { importAudioSite } from './audio-prepare.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
type PreparedManifest = Parameters<typeof importAudioSite>[1];
type PackSource = Parameters<typeof importAudioSite>[2];

suite('PostgreSQL audio installer SQL transaction helpers', () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('Audio installer tests require an isolated database ending in _test');
  const db = createDatabase(url),
    runId = randomUUID(),
    prefix = `audio-import-it-${runId}`;
  const suffix = runId
    .replaceAll('-', '')
    .replace(/[0-9]/g, (value) => String.fromCharCode(97 + Number(value)));
  const words = Array.from({ length: 1001 }, (_, index) => ({
    id: `${prefix}-word-${index}`,
    lemma: `install${suffix}${String.fromCharCode(97 + Math.floor(index / 676), 97 + (Math.floor(index / 26) % 26), 97 + (index % 26))}`,
  }));
  const ids = words.map((word) => word.id);
  const site: SiteConfig = {
    id: 'default',
    title: 'Audio SQL fixture',
    publicUrl: 'https://example.test',
    basePath: '',
    hosts: ['example.test'],
    databaseUrl: url,
    authSecret: 'unused-audio-sql-test-secret-'.repeat(3),
    bootstrapToken: 'unused-audio-sql-bootstrap-'.repeat(3),
    registrationOpen: true,
  };
  // The production loader validates a fixed 8,798-lemma artifact before calling this SQL
  // helper. Only these test literals are narrowed for a small, namespaced SQL fixture.
  // No file is generated or certified, no artifact validation/download is being tested.
  const source = {
    id: prefix as PackSource['id'],
    status: 'ready' as const,
    source: {
      url: 'https://example.test/synthetic-sql-fixture.tar.gz',
      sha256: '4'.repeat(64),
      sizeBytes: 1,
    },
    lemmaCount: words.length as PackSource['lemmaCount'],
    entryCount: (words.length * 2) as PackSource['entryCount'],
    sourceManifestSha256: '5'.repeat(64),
    manifestSha256: '6'.repeat(64),
  } satisfies PackSource;
  const entries = words.flatMap((word) =>
    (['US', 'UK'] as const).map((accent) => ({
      lemma: word.lemma,
      accent,
      kind: 'synthesized' as const,
      sourceName: 'Synthetic SQL metadata fixture; not speech',
      sourceUrl: 'https://example.test/synthetic-sql-fixture',
      license: 'MIT',
      attribution: 'Original automated test metadata only',
      fileKey: `files/${'7'.repeat(64)}.wav`,
      fileSha256: '7'.repeat(64),
      mimeType: 'audio/wav' as const,
      phonetic: accent === 'US' ? '/tɛst/' : '/test/',
      phoneticSource: `Test-only algorithmic ${accent}`,
    })),
  );
  const manifest: PreparedManifest = {
    schemaVersion: 1,
    version: 'audio-v1',
    status: 'ready',
    sourceManifestSha256: source.sourceManifestSha256,
    statistics: {
      lemmaCount: words.length,
      entryCount: entries.length,
      recordedCount: 0,
      synthesizedCount: entries.length,
      failedCount: 0,
    },
    entries,
  };
  let importedIds: Array<{ id: string; wordId: string; accent: string }> = [];

  beforeAll(async () => {
    expect((await db.siteState.findUniqueOrThrow({ where: { id: 'singleton' } })).siteId).toBe(
      site.id,
    );
    await db.word.createMany({
      data: words.map((word, index) => ({
        id: word.id,
        lemma: word.lemma,
        normalizedLemma: word.lemma,
        goalTags: ['daily'],
        phoneticUs: index === 1 || index === 2 ? '' : '/ɑ/',
        phoneticUk: index === 2 ? '' : '/ɒ/',
        phoneticSource: 'Original fixture source',
        status: index === 3 ? 'draft' : 'published',
        sourceRef: 'Original automated test fixture',
        contentVersion: 'integration-only',
      })),
    });
    await db.sense.createMany({
      data: words.map((word) => ({
        id: `${word.id}-sense`,
        wordId: word.id,
        pos: 'n.',
        definitionZh: '保留原有测试释义',
      })),
    });
  }, 60000);
  afterAll(async () => {
    await db.contentPack.deleteMany({ where: { id: prefix } });
    await db.word.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  }, 60000);

  it('imports 2002 entries across 1000-row chunks without replacing canonical word IDs, existing IPA or draft content', async () => {
    await importAudioSite(site, manifest, source);
    importedIds = await db.wordAudio.findMany({
      where: { wordId: { in: ids } },
      select: { id: true, wordId: true, accent: true },
      orderBy: [{ wordId: 'asc' }, { accent: 'asc' }],
    });
    expect(importedIds).toHaveLength(2002);
    const original = await db.word.findUniqueOrThrow({ where: { id: words[0]!.id } });
    expect(original.phoneticUs).toBe('/ɑ/');
    expect(original.phoneticUk).toBe('/ɒ/');
    expect(original.phoneticSource).toBe('Original fixture source');
    const partial = await db.word.findUniqueOrThrow({ where: { id: words[1]!.id } });
    expect(partial.phoneticUs).toBe('/tɛst/');
    expect(partial.phoneticUk).toBe('/ɒ/');
    expect(partial.phoneticSource).toContain('Test-only algorithmic US');
    const missing = await db.word.findUniqueOrThrow({ where: { id: words[2]!.id } });
    expect(missing.phoneticUs).toBe('/tɛst/');
    expect(missing.phoneticUk).toBe('/test/');
    expect(missing.phoneticSource).toContain('Test-only algorithmic US');
    expect(missing.phoneticSource).toContain('Test-only algorithmic UK');
    const draft = await db.word.findUniqueOrThrow({
      where: { id: words[3]!.id },
      include: { senses: true },
    });
    expect(draft.status).toBe('draft');
    expect(draft.senses[0]?.definitionZh).toBe('保留原有测试释义');
    const pack = await db.contentPack.findUniqueOrThrow({ where: { id: prefix } });
    expect(pack.entryCount).toBe(2002);
    expect(pack.tagCounts).toMatchObject({
      kind: 'audio',
      recordedCount: 0,
      synthesizedCount: 2002,
    });
  });

  it('reimports idempotently with stable WordAudio IDs, unchanged original IPA and no duplicated source append', async () => {
    const before = await db.word.findUniqueOrThrow({ where: { id: words[2]!.id } });
    await importAudioSite(site, manifest, source);
    const afterIds = await db.wordAudio.findMany({
      where: { wordId: { in: ids } },
      select: { id: true, wordId: true, accent: true },
      orderBy: [{ wordId: 'asc' }, { accent: 'asc' }],
    });
    expect(afterIds).toEqual(importedIds);
    const after = await db.word.findUniqueOrThrow({ where: { id: words[2]!.id } });
    expect(after.phoneticSource).toBe(before.phoneticSource);
    expect(after.phoneticUs).toBe(before.phoneticUs);
    expect(after.phoneticUk).toBe(before.phoneticUk);
  });

  it('rolls back an incomplete canonical match without changing existing audio metadata or the installed pack', async () => {
    const first = await db.wordAudio.findUniqueOrThrow({
      where: { wordId_accent: { wordId: words[0]!.id, accent: 'US' } },
    });
    const pack = await db.contentPack.findUniqueOrThrow({ where: { id: prefix } });
    const broken: PreparedManifest = {
      ...manifest,
      entries: entries.map((entry, index) =>
        index === entries.length - 1
          ? { ...entry, lemma: `unknown${suffix}` }
          : { ...entry, sourceName: 'Must never be committed' },
      ),
    };
    await expect(importAudioSite(site, broken, source)).rejects.toThrow(
      'audio_dictionary_incomplete',
    );
    const after = await db.wordAudio.findUniqueOrThrow({
      where: { wordId_accent: { wordId: words[0]!.id, accent: 'US' } },
    });
    expect(after).toEqual(first);
    expect(await db.contentPack.findUniqueOrThrow({ where: { id: prefix } })).toEqual(pack);
    expect(await db.wordAudio.count({ where: { wordId: { in: ids } } })).toBe(2002);
  });

  it('refuses a mismatched realm before any import writes are performed', async () => {
    const before = await db.contentPack.findUniqueOrThrow({ where: { id: prefix } });
    await expect(importAudioSite({ ...site, id: 'wrong-realm' }, manifest, source)).rejects.toThrow(
      'audio_site_binding_mismatch',
    );
    expect(await db.contentPack.findUniqueOrThrow({ where: { id: prefix } })).toEqual(before);
    expect(await db.wordAudio.count({ where: { wordId: { in: ids } } })).toBe(2002);
  });
});
