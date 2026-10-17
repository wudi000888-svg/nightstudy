import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { readSentenceAudioCollection, sentenceAudioPackId } from './audio-collection.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const directories: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nightstudy-audio-collection-'));
  directories.push(root);
  const meaning = Buffer.from('{"formatVersion":2,"kind":"learning-senses-collection"}');
  const meaningName = 'learning-senses-collection-test.manifest.json';
  await fs.writeFile(path.join(root, meaningName), meaning);
  const policyBytes = Buffer.from(
    JSON.stringify({ formatVersion: 1, id: 'sentence-audio-holds-v1', entries: [] }),
  );
  await fs.writeFile(path.join(root, 'sentence-audio-holds-v1.json'), policyBytes);
  const policyManifest = Buffer.from(
    JSON.stringify({
      formatVersion: 1,
      id: 'sentence-audio-holds-v1',
      fileName: 'sentence-audio-holds-v1.json',
      bytes: policyBytes.length,
      sha256: hash(policyBytes),
      holdCount: 0,
      learningSensesManifestFileName: meaningName,
      learningSensesManifestSha256: hash(meaning),
    }),
  );
  await fs.writeFile(path.join(root, 'sentence-audio-holds-v1.manifest.json'), policyManifest);
  const pins = [];
  for (const id of ['sentence-audio-v4-0001', 'sentence-audio-v4-0002']) {
    const bytes = Buffer.from(JSON.stringify({ id, lemmaCount: 2, entryCount: 3 }));
    const fileName = id + '.manifest.json';
    await fs.writeFile(path.join(root, fileName), bytes);
    pins.push({
      id,
      fileName,
      bytes: bytes.length,
      sha256: hash(bytes),
      lemmaCount: 2,
      entryCount: 3,
    });
  }
  const collection = {
    formatVersion: 1,
    kind: 'sentence-audio-collection',
    id: 'sentence-audio-v4',
    learningSensesManifestSha256: hash(meaning),
    learningSensesManifestFileName: meaningName,
    pronunciationHoldsManifestFileName: 'sentence-audio-holds-v1.manifest.json',
    pronunciationHoldsManifestSha256: hash(policyManifest),
    entryCount: 6,
    packs: pins,
  };
  const file = path.join(root, 'sentence-audio-v4.collection.json');
  const write = () => fs.writeFile(file, JSON.stringify(collection));
  await write();
  return { root, file, collection, write };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
describe('fixed sentence audio collection pins', () => {
  it('accepts independent accent deltas without assuming entryCount = sentenceCount * 2', async () => {
    const { file } = await fixture();
    const result = await readSentenceAudioCollection(file);
    expect(result.pins).toHaveLength(2);
    expect(result.collection.entryCount).toBe(6);
  });
  it('rejects overlapping pack identities and false totals before any installation', async () => {
    const { file, collection, write } = await fixture();
    collection.packs[1] = { ...collection.packs[0]! };
    await write();
    await expect(readSentenceAudioCollection(file)).rejects.toThrow('scope_mismatch');
    collection.entryCount++;
    await write();
    await expect(readSentenceAudioCollection(file)).rejects.toThrow('scope_mismatch');
  });
  it('rejects mutated child pins, unsafe names and a changed meaning collection', async () => {
    const { root, file, collection, write } = await fixture();
    const child = collection.packs[0]!;
    const original = await fs.readFile(path.join(root, child.fileName));
    await fs.writeFile(path.join(root, child.fileName), Buffer.alloc(original.length, 32));
    await expect(readSentenceAudioCollection(file)).rejects.toThrow('pin_hash_mismatch');
    await fs.writeFile(path.join(root, child.fileName), original);
    collection.learningSensesManifestSha256 = '0'.repeat(64);
    await write();
    await expect(readSentenceAudioCollection(file)).rejects.toThrow('meaning_pin_mismatch');
    child.fileName = '../sentence-audio-v4-0001.manifest.json';
    await write();
    await expect(readSentenceAudioCollection(file)).rejects.toThrow();
  });
  it('rejects symlinked pin files and moving or reserved pack identifiers', async () => {
    const { root, file, collection } = await fixture();
    const child = collection.packs[0]!;
    await fs.rename(path.join(root, child.fileName), path.join(root, 'original.json'));
    await fs.symlink(path.join(root, 'original.json'), path.join(root, child.fileName));
    await expect(readSentenceAudioCollection(file)).rejects.toThrow('pin_file_invalid');
    for (const id of [
      'sentence-audio-v4-0000',
      'sentence-audio-v4-latest',
      '../sentence-audio-v4-0001',
    ])
      expect(sentenceAudioPackId.safeParse(id).success).toBe(false);
  });
});
