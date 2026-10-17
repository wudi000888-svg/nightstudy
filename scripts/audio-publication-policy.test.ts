import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateAudioPublicationSidecars } from './audio-prepare.js';
import {
  parseSentenceAudioHoldPolicy,
  type SentenceAudioPolicy,
} from '../apps/api/src/sentence-audio-policy.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const text = 'The original mock sentence contains a record.';
  const textHash = sha(text);
  const hold = {
    id: 'sentence-audio-hold-' + sha(textHash + '\0US'),
    text,
    textHash,
    accent: 'US',
    learningSenseId: 'learning-sense-' + 'a'.repeat(64),
    exampleId: 'sense-example-' + 'b'.repeat(64),
    riskCategory: 'wrong-lexeme',
    review: {
      reviewer: 'Codex',
      decision: 'hold',
      expertCertified: false,
      reason: 'Original test metadata: this exact reading must remain unavailable.',
    },
  };
  const bytes = Buffer.from(
    JSON.stringify({ formatVersion: 1, id: 'sentence-audio-holds-v1', entries: [hold] }),
  );
  const parsed = parseSentenceAudioHoldPolicy(bytes);
  const policy: SentenceAudioPolicy = {
    ...parsed,
    manifestSha256: 'f'.repeat(64),
    manifest: {
      formatVersion: 1,
      id: 'sentence-audio-holds-v1',
      fileName: 'sentence-audio-holds-v1.json',
      bytes: bytes.length,
      sha256: sha(bytes),
      holdCount: 1,
      learningSensesManifestFileName: 'learning-senses-collection-fixture.manifest.json',
      learningSensesManifestSha256: 'e'.repeat(64),
    },
  };
  const source: Parameters<typeof validateAudioPublicationSidecars>[0] = {
    id: 'sentence-audio-v4-9998',
    status: 'ready',
    lemmaCount: 1,
    entryCount: 1,
    source: {
      url: 'https://example.test/mock-metadata.tar.gz',
      sha256: 'd'.repeat(64),
      sizeBytes: 1,
    },
    sourceManifestSha256: 'c'.repeat(64),
    manifestSha256: 'b'.repeat(64),
  };
  const media = {
    lemma: text,
    text,
    textHash,
    accent: 'UK' as const,
    kind: 'synthesized' as const,
    sourceName: 'Original synthetic test metadata, not actual speech',
    sourceUrl: 'https://example.test/metadata',
    license: 'MIT',
    attribution: 'Original automated test metadata only',
    fileKey: `files/${'0'.repeat(64)}.mp3`,
    fileSha256: '0'.repeat(64),
    mimeType: 'audio/mpeg' as const,
  };
  const manifest: Parameters<typeof validateAudioPublicationSidecars>[1] = {
    schemaVersion: 2,
    version: source.id,
    status: 'ready',
    sourceManifestSha256: source.sourceManifestSha256,
    statistics: {
      lemmaCount: 1,
      entryCount: 1,
      recordedCount: 0,
      synthesizedCount: 1,
      failedCount: 0,
    },
    entries: [media],
  };
  const metadata = {
    pronunciationHolds: {
      fileName: 'pronunciation-holds.json',
      sourceFileName: 'private-audit.json',
      bytes: bytes.length,
      sha256: sha(bytes),
      holdCount: 1,
      appliedClipCount: 1,
    },
    requestedSentences: [
      {
        text,
        textHash,
        references: [{ learningSenseId: hold.learningSenseId, exampleId: hold.exampleId }],
      },
    ],
    heldMediaReferences: [
      {
        holdId: hold.id,
        textHash,
        accent: 'US',
        learningSenseId: hold.learningSenseId,
        exampleId: hold.exampleId,
        riskCategory: hold.riskCategory,
      },
    ],
    reusedMediaReferences: [] as { textHash: string; accent: 'US' | 'UK' }[],
    coverage: {
      requestedSentenceCount: 1,
      requestedClipCount: 2,
      reusedClipCount: 0,
      generatedClipCount: 1,
      fullyReusedSentenceCount: 0,
      partiallyReusedSentenceCount: 0,
      heldClipCount: 1,
      eligibleClipCount: 1,
      heldSentenceCount: 1,
      fullyHeldSentenceCount: 0,
    },
  };
  const read = async (name: string) => {
    if (name !== 'pronunciation-holds.json') throw new Error('Unexpected sidecar path');
    return bytes;
  };
  return { source, manifest, metadata, read, policy, bytes, textHash };
}
describe('installer publication holds before cache activation', () => {
  it('preserves exact policy bytes and covers the other accent without fabricating the held clip', async () => {
    const f = fixture();
    const files = await validateAudioPublicationSidecars(
      f.source,
      f.manifest,
      f.metadata,
      f.read,
      f.policy,
    );
    expect(files).toEqual([{ name: 'pronunciation-holds.json', bytes: f.bytes }]);
  });
  it('rejects a missing release policy in a new v4 pack', async () => {
    const f = fixture();
    await expect(
      validateAudioPublicationSidecars(f.source, f.manifest, {}, f.read, f.policy),
    ).rejects.toThrow('policy_missing_from_pack');
  });
  it('rejects a changed sidecar or an unsafe name before any cache copy', async () => {
    const f = fixture();
    await expect(
      validateAudioPublicationSidecars(
        f.source,
        f.manifest,
        f.metadata,
        async () => Buffer.alloc(f.bytes.length, 32),
        f.policy,
      ),
    ).rejects.toThrow('checksum');
    f.metadata.pronunciationHolds.fileName = '../pronunciation-holds.json';
    await expect(
      validateAudioPublicationSidecars(f.source, f.manifest, f.metadata, f.read, f.policy),
    ).rejects.toThrow('path_invalid');
  });
  it('requires the actual current sense/example reference, not a matching text alone', async () => {
    const f = fixture();
    f.metadata.requestedSentences[0]!.references[0]!.exampleId = 'sense-example-' + '9'.repeat(64);
    await expect(
      validateAudioPublicationSidecars(f.source, f.manifest, f.metadata, f.read, f.policy),
    ).rejects.toThrow('reference_mismatch');
  });
  it('rejects a held accent resurrected from generated media or a baseline', async () => {
    for (const route of ['generated', 'reused']) {
      const f = fixture();
      if (route === 'generated')
        f.manifest.entries.push({ ...f.manifest.entries[0]!, accent: 'US' });
      else f.metadata.reusedMediaReferences.push({ textHash: f.textHash, accent: 'US' });
      await expect(
        validateAudioPublicationSidecars(f.source, f.manifest, f.metadata, f.read, f.policy),
      ).rejects.toThrow('held_or_duplicate_media');
    }
  });
  it('rejects hidden ordinary gaps and dishonest coverage totals', async () => {
    const f = fixture();
    f.manifest.entries = [];
    await expect(
      validateAudioPublicationSidecars(f.source, f.manifest, f.metadata, f.read, f.policy),
    ).rejects.toThrow('coverage_mismatch');
    const another = fixture();
    another.metadata.coverage.heldClipCount = 0;
    await expect(
      validateAudioPublicationSidecars(
        another.source,
        another.manifest,
        another.metadata,
        another.read,
        another.policy,
      ),
    ).rejects.toThrow('coverage_mismatch');
  });
  it('counts a reused other accent as partial reuse when the first accent is held', async () => {
    const f = fixture();
    f.manifest.entries = [];
    f.metadata.reusedMediaReferences.push({ textHash: f.textHash, accent: 'UK' });
    f.metadata.coverage.generatedClipCount = 0;
    f.metadata.coverage.reusedClipCount = 1;
    f.metadata.coverage.partiallyReusedSentenceCount = 1;
    await expect(
      validateAudioPublicationSidecars(f.source, f.manifest, f.metadata, f.read, f.policy),
    ).resolves.toHaveLength(1);
    f.metadata.coverage.fullyReusedSentenceCount = 1;
    await expect(
      validateAudioPublicationSidecars(f.source, f.manifest, f.metadata, f.read, f.policy),
    ).rejects.toThrow('coverage_mismatch');
  });
});
