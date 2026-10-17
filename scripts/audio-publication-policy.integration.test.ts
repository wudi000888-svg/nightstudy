import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContentPack, Prisma } from '@prisma/client';
import { createDatabase } from '../apps/api/src/db.js';
import type { SiteConfig } from '../apps/api/src/config.js';
import {
  parseSentenceAudioHoldPolicy,
  type SentenceAudioPolicy,
} from '../apps/api/src/sentence-audio-policy.js';
import { importSentenceAudioSite } from './audio-prepare.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
suite('PostgreSQL exact sentence publication holds and old-pack replay', () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('An isolated *_test database is required');
  const db = createDatabase(url);
  const prefix = 'publication-policy-it-' + randomUUID();
  const wordId = prefix + '-word';
  const senseId = 'learning-sense-' + sha(prefix + '-sense');
  const exampleId = 'sense-example-' + sha(prefix + '-example');
  const text = `Original publication policy test sentence ${prefix}.`;
  const textHash = sha(text);
  const data = Buffer.from(
    JSON.stringify({
      formatVersion: 1,
      id: 'sentence-audio-holds-v1',
      entries: [
        {
          id: 'sentence-audio-hold-' + sha(textHash + '\0US'),
          text,
          textHash,
          accent: 'US',
          learningSenseId: senseId,
          exampleId,
          riskCategory: 'wrong-lexeme',
          review: {
            reviewer: 'Codex',
            decision: 'hold',
            expertCertified: false,
            reason: 'Original isolated SQL metadata fixture, never a real speech asset.',
          },
        },
      ],
    }),
  );
  const policy: SentenceAudioPolicy = {
    ...parseSentenceAudioHoldPolicy(data),
    manifestSha256: sha(prefix + '-policy-manifest'),
    manifest: {
      formatVersion: 1,
      id: 'sentence-audio-holds-v1',
      fileName: 'sentence-audio-holds-v1.json',
      bytes: data.length,
      sha256: sha(data),
      holdCount: 1,
      learningSensesManifestFileName: 'learning-senses-collection-fixture.manifest.json',
      learningSensesManifestSha256: sha(prefix + '-meanings'),
    },
  };
  const site: SiteConfig = {
    id: 'default',
    title: 'Isolated publication policy SQL fixture',
    publicUrl: 'https://example.test',
    basePath: '',
    hosts: ['example.test'],
    databaseUrl: url,
    authSecret: 'unused-publication-policy-secret-'.repeat(3),
    bootstrapToken: 'unused-publication-policy-bootstrap-'.repeat(3),
    registrationOpen: true,
  };
  const source: Parameters<typeof importSentenceAudioSite>[2] = {
    id: prefix,
    status: 'ready',
    lemmaCount: 1,
    entryCount: 2,
    source: {
      url: 'https://example.test/isolated-metadata.tar.gz',
      sha256: sha(prefix + '-archive'),
      sizeBytes: 1,
    },
    manifestSha256: sha(prefix + '-manifest'),
    sourceManifestSha256: sha(prefix + '-sources'),
  };
  const entries = (['US', 'UK'] as const).map((accent) => ({
    lemma: text,
    text,
    textHash,
    accent,
    kind: 'synthesized' as const,
    sourceName: 'Original SQL metadata fixture, not speech',
    sourceUrl: 'https://example.test/metadata',
    license: 'MIT',
    attribution: 'No audio file is generated or certified by this SQL fixture.',
    fileKey: `files/${'a'.repeat(64)}.mp3`,
    fileSha256: 'a'.repeat(64),
    mimeType: 'audio/mpeg' as const,
  }));
  const manifest: Parameters<typeof importSentenceAudioSite>[1] = {
    schemaVersion: 2,
    version: 'sentence-audio-v4-9998',
    status: 'ready',
    sourceManifestSha256: source.sourceManifestSha256,
    statistics: {
      lemmaCount: 1,
      entryCount: 2,
      recordedCount: 0,
      synthesizedCount: 2,
      failedCount: 0,
    },
    entries,
  };
  let previousPolicyPack: ContentPack | null = null;
  let capturedPreviousPolicy = false;
  beforeAll(async () => {
    expect((await db.siteState.findUniqueOrThrow({ where: { id: 'singleton' } })).siteId).toBe(
      site.id,
    );
    previousPolicyPack = await db.contentPack.findUnique({
      where: { id: 'sentence-audio-holds-v1' },
    });
    capturedPreviousPolicy = true;
    await db.word.create({
      data: {
        id: wordId,
        lemma: prefix,
        normalizedLemma: prefix,
        sourceRef: 'Original SQL fixture',
        contentVersion: prefix,
        status: 'published',
      },
    });
    await db.learningSense.create({
      data: {
        id: senseId,
        wordId,
        pos: 'n.',
        definitionZh: '原始测试释义',
        definitionEn: 'Original SQL test definition.',
        status: 'published',
        contentVersion: prefix,
        bindingHash: sha(prefix),
        contentMetadata: {},
      },
    });
    await db.wordExample.create({
      data: {
        id: exampleId,
        wordId,
        learningSenseId: senseId,
        contentVersion: prefix,
        status: 'published',
        contextLabel: 'Isolated SQL fixture',
        exampleEn: text,
        exampleZh: '原始隔离测试例句。',
        contentMetadata: { textHash },
      },
    });
    await db.sentenceAudio.createMany({
      data: entries.map(({ lemma: _, ...entry }) => ({
        id: prefix + '-' + entry.accent,
        ...entry,
        status: 'ready',
      })),
    });
  });
  afterAll(async () => {
    await db.sentenceAudio.deleteMany({ where: { textHash } });
    await db.wordExample.deleteMany({ where: { id: exampleId } });
    await db.learningSense.deleteMany({ where: { id: senseId } });
    await db.word.deleteMany({ where: { id: wordId } });
    await db.contentPack.deleteMany({ where: { id: source.id } });
    if (capturedPreviousPolicy) {
      await db.$transaction(async (tx) => {
        await tx.contentPack.deleteMany({ where: { id: 'sentence-audio-holds-v1' } });
        if (previousPolicyPack)
          await tx.contentPack.create({
            data: {
              ...previousPolicyPack,
              tagCounts: previousPolicyPack.tagCounts as Prisma.InputJsonValue,
            },
          });
      });
    }
    await db.$disconnect();
  });
  const rows = () => db.sentenceAudio.findMany({ where: { textHash }, orderBy: { accent: 'asc' } });
  it('withdraws old ready US and keeps UK ready when an old baseline is replayed', async () => {
    await importSentenceAudioSite(site, manifest, source, policy);
    const first = await rows();
    expect(first.map(({ accent, status }) => ({ accent, status }))).toEqual([
      { accent: 'UK', status: 'ready' },
      { accent: 'US', status: 'missing' },
    ]);
    const ledger = await db.contentPack.findUniqueOrThrow({
      where: { id: 'sentence-audio-holds-v1' },
    });
    await importSentenceAudioSite(site, manifest, source, policy);
    expect(await rows()).toEqual(first);
    expect(await db.contentPack.findUniqueOrThrow({ where: { id: ledger.id } })).toEqual(ledger);
  });
  it('rolls back on a stale sense/example binding and rejects a mismatched site', async () => {
    const before = await rows();
    const wrongEntry = { ...policy.entries[0]!, exampleId: 'sense-example-' + 'f'.repeat(64) };
    const stale = {
      ...policy,
      entries: [wrongEntry],
      byIdentity: new Map([[textHash + '\0US', wrongEntry]]),
    };
    await expect(importSentenceAudioSite(site, manifest, source, stale)).rejects.toThrow(
      'database_binding_mismatch',
    );
    expect(await rows()).toEqual(before);
    await expect(
      importSentenceAudioSite({ ...site, id: 'another-site' }, manifest, source, policy),
    ).rejects.toThrow('site_binding_mismatch');
    expect(await rows()).toEqual(before);
  });
});
