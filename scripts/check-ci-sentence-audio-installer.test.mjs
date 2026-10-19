/** Synthetic boundary cases only; these are not real media or release receipts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseSentenceAudioHoldPolicy } from './check-sentence-audio-policy.mjs';
import { checkInstallerMetadata, checkInstallerReviews, checkInstallerFileSet, verifyInstaller } from './check-ci-sentence-audio-installer.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = v => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' :
  v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
const PUBLIC = '0ae4679da6df6459cb2cfe21867942bb8eaa4ae9828def149f08816c42f4ef1b';
const FINAL = 'eaaf987f693cfad6a6a3cb5768b8ef855a1f0300d4c06257bf8683ecf86f69dd';
const VOICES = '3dafe3867fc2005ce1cf0be24485e771671121f4cca185521b17b8d381e7489f';

function fixture() {
  const text = 'This example compares two proposed readings.', textHash = sha(text);
  const record = { id: 'sentence-pronunciation-' + sha(textHash + '\0UK'), text, textHash, accent: 'UK',
    learningSenseId: 'learning-sense-' + 'a'.repeat(64), exampleId: 'sense-example-' + 'b'.repeat(64),
    originalPhonemes: ['ə kˈɒntɹast.'], replacements: [{ sentence: 0, start: 2, from: 'kˈɒntɹast', to: 'kəntɹˈɑːst' }],
    review: { reviewer: 'Codex', decision: 'publish', expertCertified: false, reason: 'Synthetic lexical-context boundary fixture; never an actual publication approval.' } };
  const correction = { record, sha256: sha(canonical(record)), correctedPhonemes: ['ə kəntɹˈɑːst.'] };
  const group = { textHash, originalPhonemes: record.originalPhonemes, accents: {
    UK: { state: 'reviewed-correction', correction, hold: null },
    US: { state: 'reviewed-retain', correction: null, hold: null } } };
  const voices = { voices: Object.fromEntries(['UK', 'US'].map(accent => [accent,
    { sourceName: 'Synthetic ' + accent, sourceUrl: 'https://example.org/voice', license: 'MIT', attribution: 'Synthetic test voice' }])) };
  const entries = ['UK', 'US'].map((accent, i) => ({ text, lemma: text, textHash, accent, kind: 'synthesized',
    ...voices.voices[accent], fileKey: 'files/' + String(i + 1).repeat(64) + '.mp3', fileSha256: String(i + 1).repeat(64),
    originalFileSha256: String(i + 3).repeat(64), cacheKey: String(i + 5).repeat(64), sizeBytes: 100, mimeType: 'audio/mpeg',
    ...(accent === 'UK' ? { pronunciationCorrectionSha256: correction.sha256, pronunciationCorrectionId: record.id } : {}) }));
  const request = { packId: 'sentence-audio-v4-0002', targets: [{ text, textHash, accents: ['US', 'UK'],
    references: [{ learningSenseId: record.learningSenseId, exampleId: record.exampleId }] }], batchApproval: { workers: 4 } };
  const accepted = { generatedPairs: 2, batchApproval: request.batchApproval, media: entries.map(e => ({
    textHash, accent: e.accent, fileSha256: e.fileSha256, originalWavSha256: e.originalFileSha256, cacheKey: e.cacheKey })) };
  const counts = { lemmaCount: 1, entryCount: 2, recordedCount: 0, synthesizedCount: 2, failedCount: 0 };
  const descriptor = { id: request.packId, version: request.packId, status: 'ready', ...counts };
  const manifest = { version: request.packId, schemaVersion: 2, status: 'ready', statistics: counts, entries };
  const source = { requestedSentences: request.targets, sentences: request.targets, batchApproval: request.batchApproval,
    engineSource: voices, reusedMediaReferences: [], baselinePacks: [], meaningPackSha256: PUBLIC, finalPolicySha256: FINAL,
    pronunciationReviews: { appliedClipCount: 1, engineVersion: '1.8.0', expertCertified: false } };
  const policy = parseSentenceAudioHoldPolicy(Buffer.from(JSON.stringify({ formatVersion: 1, id: 'sentence-audio-holds-v1', entries: [] })));
  const review = { formatVersion: 1, id: 'sentence-pronunciation-v1', engineVersion: '1.8.0', voicesManifestSha256: VOICES, entries: [record] };
  return { request, accepted, descriptor, source, manifest, voices, policy, review, controls: new Map([[textHash, group]]) };
}

test('mature entry comparison accepts an exact synthetic metadata boundary', () => {
  assert.deepEqual(checkInstallerMetadata(fixture()), { eligible: 2, held: 0 });
});
test('accepted MP3 substitution and voice attribution changes are rejected', () => {
  for (const mutate of [f => { f.accepted.media[0].fileSha256 = 'f'.repeat(64); },
    f => { f.manifest.entries[0].sourceName = 'Different voice attribution'; }]) {
    const f = fixture(); mutate(f);
    assert.throws(() => checkInstallerMetadata(f), /sentence_audio_target_or_attribution_changed/);
  }
});
test('missing media, duplicate keys and changed descriptor counts cannot hide scope', () => {
  for (const mutate of [f => { f.accepted.media.pop(); }, f => { f.manifest.entries[1] = { ...f.manifest.entries[0] }; },
    f => { f.descriptor.entryCount = 1; }]) {
    const f = fixture(); mutate(f);
    assert.throws(() => checkInstallerMetadata(f), /installer_|sentence_audio_packs_overlap/);
  }
});
test('a globally held accent cannot be made ready by an installed MP3', () => {
  const f = fixture(), e = f.manifest.entries[0], r = f.review.entries[0];
  const hold = { id: 'sentence-audio-hold-' + sha(e.textHash + '\0UK'), text: e.text, textHash: e.textHash, accent: 'UK',
    learningSenseId: r.learningSenseId, exampleId: r.exampleId, riskCategory: 'insufficient-regional-evidence',
    review: { reviewer: 'Codex', decision: 'hold', expertCertified: false, reason: 'Synthetic held target must remain unavailable during this boundary test.' } };
  f.policy = parseSentenceAudioHoldPolicy(Buffer.from(JSON.stringify({ formatVersion: 1, id: 'sentence-audio-holds-v1', entries: [hold] })));
  assert.throws(() => checkInstallerMetadata(f), /installer_only_independently_accepted_pairs/);
});
test('complete original correction records and count must survive sidecar copying', () => {
  const f = fixture(); assert.equal(checkInstallerReviews(f.source, f.manifest, f.review, f.controls), 1);
  f.review.entries[0] = structuredClone(f.review.entries[0]);
  f.review.entries[0].review.reason += ' Altered after acceptance.';
  assert.throws(() => checkInstallerReviews(f.source, f.manifest, f.review, f.controls), /installer_complete_review_records/);
});
test('missing correction sidecars, invented corrections and count changes fail', () => {
  for (const mutate of [f => { f.review = null; }, f => { f.source.pronunciationReviews.appliedClipCount = 2; },
    f => { f.manifest.entries[1].pronunciationCorrectionSha256 = 'f'.repeat(64); }]) {
    const f = fixture(); mutate(f);
    assert.throws(() => checkInstallerReviews(f.source, f.manifest, f.review, f.controls), /installer_/);
  }
});

function withFiles(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-installer-fixture-'));
  try {
    const f = fixture(); fs.mkdirSync(path.join(root, 'files')); fs.mkdirSync(path.join(root, 'licenses'));
    for (const name of ['manifest.json', 'sources.manifest.json', 'pronunciation-holds.json', 'pronunciation-reviews.json', 'licenses/MIT.txt'])
      fs.writeFileSync(path.join(root, name), 'Synthetic metadata; not real media.');
    for (const e of f.manifest.entries) fs.writeFileSync(path.join(root, e.fileKey), 'Synthetic-not-real-audio');
    run(root, f);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('real extracted file inventory permits MP3s and metadata but rejects WAV/model/log extras', () => {
  withFiles((root, f) => {
    assert.equal(checkInstallerFileSet(root, f.manifest, true).size, 2);
    for (const name of ['files/' + 'f'.repeat(64) + '.wav', 'model.onnx', 'route.jsonl']) {
      fs.writeFileSync(path.join(root, name), 'Synthetic forbidden file');
      assert.throws(() => checkInstallerFileSet(root, f.manifest, true), /installer_exact_mp3_only_files/);
      fs.unlinkSync(path.join(root, name));
    }
  });
});
test('symlink or unlisted correction sidecars cannot pass extracted closure', () => {
  withFiles((root, f) => {
    assert.throws(() => checkInstallerFileSet(root, f.manifest, false), /installer_exact_mp3_only_files/);
    const name = path.join(root, 'files', 'f'.repeat(64) + '.mp3');
    fs.symlinkSync(path.join(root, f.manifest.entries[0].fileKey), name);
    assert.throws(() => checkInstallerFileSet(root, f.manifest, true), /installer_regular_leaf_only/);
  });
});
test('actual wrapper rejects changed archive bytes before opening any extraction or global inputs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-installer-pin-fixture-'));
  try {
    const request = { mode: 'batch', publicRootSha256: PUBLIC, finalPolicySha256: FINAL };
    const requestRaw = JSON.stringify(request), requestSha = sha(requestRaw);
    const accepted = { kind: 'nightstudy-ci-sentence-audio-batch-independent-check-v1', state: 'VERIFIED_SELECTED_BATCH_ONLY',
      requestSha256: requestSha, checkerSourceSha256: '16fbaf7f522a0f26382a923df7670b623fa49df4f82a8b6b225f1e2af71913d8',
      batchWorkerSha256: '4be14408ff260feb89e5e58e7740b4b522b9a7f05d22d2b1d8009669610a252a',
      purePilotHelperSha256: '8d4c07d943331228790aa6d0376b664677180705c0b590d42c6c73b32dcc9057',
      publicRootSha256: PUBLIC, finalPolicySha256: FINAL, completeMp3EofDecodes: 2, generatedPairs: 2,
      originalWavsFullyRead: 2, allCurrentReferencesBound: true, selectionPairUnionVerified: true,
      reviewedFrozenRawCallsVerified: true, decoderInputProtocol: 'fd', seekablePinnedInput: true,
      oldUnapprovedCandidateSelection: 'NOT_SELECTED', oldUnapprovedCandidates: 89880, publicationAuthorized: false };
    const pack = 'sentence-audio-v4-0002', archive = path.join(root, 'nightstudy-' + pack + '.tar.gz');
    fs.writeFileSync(archive, 'Synthetic changed compressed bytes; not an actual tar archive.');
    const descriptor = { id: pack, manifestSha256: 'a'.repeat(64), sourceManifestSha256: 'b'.repeat(64),
      source: { url: 'https://example.org/nightstudy-' + pack + '.tar.gz', sizeBytes: fs.statSync(archive).size, sha256: 'f'.repeat(64) } };
    const files = { request: requestRaw, check: JSON.stringify(accepted), descriptor: JSON.stringify(descriptor) };
    const args = { archive, extracted: path.join(root, 'must-not-be-opened'), 'policy-manifest': 'must-not-be-opened' };
    for (const [name, raw] of Object.entries(files)) {
      args[name] = path.join(root, name === 'descriptor' ? pack + '.manifest.json' : name + '.json');
      args[name + '-sha256'] = sha(raw); fs.writeFileSync(args[name], raw);
    }
    await assert.rejects(verifyInstaller(args), /installer_input_identity_or_sha/);
    descriptor.source.sizeBytes += 1;
    fs.writeFileSync(args.descriptor, JSON.stringify(descriptor)); args['descriptor-sha256'] = sha(JSON.stringify(descriptor));
    await assert.rejects(verifyInstaller(args), /installer_input_bounds/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
