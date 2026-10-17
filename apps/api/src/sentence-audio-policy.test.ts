import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSentenceAudioPolicy, parseSentenceAudioHoldPolicy } from './sentence-audio-policy.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const folders: string[] = [];
function entry() {
  const text = 'The old record lay beside the window.';
  const textHash = sha(text);
  return {
    id: 'sentence-audio-hold-' + sha(textHash + '\0US'),
    text,
    textHash,
    accent: 'US',
    learningSenseId: 'learning-sense-' + 'a'.repeat(64),
    exampleId: 'sense-example-' + 'b'.repeat(64),
    riskCategory: 'insufficient-regional-evidence',
    review: {
      reviewer: 'Codex',
      decision: 'hold',
      expertCertified: false,
      reason: 'This exact accent and context await independent lexical verification.',
    },
  };
}
function payload(entries = [entry()]) {
  return Buffer.from(JSON.stringify({ formatVersion: 1, id: 'sentence-audio-holds-v1', entries }));
}
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sentence-policy-'));
  folders.push(directory);
  const meaning = Buffer.from('{"kind":"learning-senses-collection","formatVersion":2}');
  const meaningName = 'learning-senses-collection-fixture.manifest.json';
  fs.writeFileSync(path.join(directory, meaningName), meaning);
  const bytes = payload();
  fs.writeFileSync(path.join(directory, 'sentence-audio-holds-v1.json'), bytes);
  const manifest = {
    formatVersion: 1,
    id: 'sentence-audio-holds-v1',
    fileName: 'sentence-audio-holds-v1.json',
    bytes: bytes.length,
    sha256: sha(bytes),
    holdCount: 1,
    learningSensesManifestFileName: meaningName,
    learningSensesManifestSha256: sha(meaning),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, 'sentence-audio-holds-v1.manifest.json'), manifestBytes);
  const collection = {
    id: 'sentence-audio-v4',
    learningSensesManifestFileName: meaningName,
    learningSensesManifestSha256: sha(meaning),
    pronunciationHoldsManifestFileName: 'sentence-audio-holds-v1.manifest.json',
    pronunciationHoldsManifestSha256: sha(manifestBytes),
  };
  fs.writeFileSync(
    path.join(directory, 'sentence-audio-v4.collection.json'),
    JSON.stringify(collection),
  );
  return { directory, manifest, collection };
}
afterEach(() => {
  for (const directory of folders.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('fixed exact sentence pronunciation publication holds', () => {
  it('holds one accent only and accepts an explicit empty policy', () => {
    const { directory } = fixture();
    const policy = loadSentenceAudioPolicy(directory);
    const row = entry();
    expect(policy.byIdentity.has(row.textHash + '\0US')).toBe(true);
    expect(policy.byIdentity.has(row.textHash + '\0UK')).toBe(false);
    expect(parseSentenceAudioHoldPolicy(payload([])).entries).toEqual([]);
  });
  it('allows a complete historical installation with no v4 policy, but rejects partial policy files', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sentence-no-policy-'));
    folders.push(directory);
    expect(loadSentenceAudioPolicy(directory).entries).toEqual([]);
    fs.writeFileSync(path.join(directory, 'sentence-audio-holds-v1.json'), payload());
    expect(() => loadSentenceAudioPolicy(directory)).toThrow('installation_incomplete');
  });
  it('rejects a changed payload, root pin or meaning collection instead of reactivating old audio', () => {
    const { directory, collection } = fixture();
    const filename = path.join(directory, 'sentence-audio-holds-v1.json');
    const original = fs.readFileSync(filename);
    fs.writeFileSync(filename, Buffer.alloc(original.length, 32));
    expect(() => loadSentenceAudioPolicy(directory)).toThrow('checksum');
    fs.writeFileSync(filename, original);
    collection.pronunciationHoldsManifestSha256 = '0'.repeat(64);
    fs.writeFileSync(
      path.join(directory, 'sentence-audio-v4.collection.json'),
      JSON.stringify(collection),
    );
    expect(() => loadSentenceAudioPolicy(directory)).toThrow('meaning_pin_mismatch');
  });
  it('rejects symlinks and unsafe payload names', () => {
    const { directory, manifest, collection } = fixture();
    const filename = path.join(directory, 'sentence-audio-holds-v1.json');
    fs.renameSync(filename, path.join(directory, 'saved.json'));
    fs.symlinkSync(path.join(directory, 'saved.json'), filename);
    expect(() => loadSentenceAudioPolicy(directory)).toThrow('file_invalid');
    fs.unlinkSync(filename);
    fs.renameSync(path.join(directory, 'saved.json'), filename);
    manifest.fileName = '../sentence-audio-holds-v1.json';
    const changed = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(path.join(directory, 'sentence-audio-holds-v1.manifest.json'), changed);
    collection.pronunciationHoldsManifestSha256 = sha(changed);
    fs.writeFileSync(
      path.join(directory, 'sentence-audio-v4.collection.json'),
      JSON.stringify(collection),
    );
    expect(() => loadSentenceAudioPolicy(directory)).toThrow();
  });
  it.each(['text', 'textHash', 'accent', 'id', 'riskCategory', 'learningSenseId', 'exampleId'])(
    'rejects an invalid %s without widening the hold',
    (field) => {
      const row = { ...entry(), [field]: 'invalid' };
      expect(() => parseSentenceAudioHoldPolicy(payload([row]))).toThrow();
    },
  );
  it('rejects duplicate identities and duplicate JSON keys including escaped key aliases', () => {
    expect(() => parseSentenceAudioHoldPolicy(payload([entry(), entry()]))).toThrow(
      'identity_invalid',
    );
    const raw = payload()
      .toString()
      .replace('"formatVersion":1', '"formatVersion":1,"format\\u0056ersion":1');
    expect(() => parseSentenceAudioHoldPolicy(Buffer.from(raw))).toThrow('duplicate_json_key');
  });
  it('rejects certified assertions, blank explanations and control characters', () => {
    for (const change of [
      { expertCertified: true },
      { reason: ' '.repeat(20) },
      { reason: 'Not a valid\u0000publication hold explanation.' },
    ]) {
      const row = entry();
      Object.assign(row.review, change);
      expect(() => parseSentenceAudioHoldPolicy(payload([row]))).toThrow();
    }
  });
});
