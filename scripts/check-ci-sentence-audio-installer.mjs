/** Per-pack acceptance after the real audio-extract.py; no DB, model or decoder. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyPinnedSentenceEntries } from './check-audio-install.mjs';
import {
  parseSentenceAudioHoldPolicy, verifySentenceAudioPackHolds, sentenceAudioIdentity,
} from './check-sentence-audio-policy.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MIB = 1024 * 1024;
const PUBLIC = '0ae4679da6df6459cb2cfe21867942bb8eaa4ae9828def149f08816c42f4ef1b';
const FINAL = 'eaaf987f693cfad6a6a3cb5768b8ef855a1f0300d4c06257bf8683ecf86f69dd';
const VOICES = '3dafe3867fc2005ce1cf0be24485e771671121f4cca185521b17b8d381e7489f';
const BASE = '3b7f791260a3d7490f89304c58afab7bc062a092271f67c2aa4a9b4c4cd367c7';
const HOLDS = '138e3923cccc0a2b77f4dc0d2da38e9d24c5fd336e26a4b83bfa274c679129e3';
const HOLD_MANIFEST = 'f61bdf164dbeb594c8ee45d91e3996a97e2aee8537ef297ddafd0f3b6344e956';
const CHECKER = '16fbaf7f522a0f26382a923df7670b623fa49df4f82a8b6b225f1e2af71913d8';
const HELPERS = {
  'check-audio-install.mjs': '632099b70041c27201c88abf6a14bd77d8723fcfdb471b92b9af1f43da6f8fec',
  'check-sentence-audio-policy.mjs': 'f095bce8ed7c5bb7687e1b85576de559f1713b1ec7435b022ea55e1832c53165',
  'audio-extract.py': 'ccfe7e54a54882d15429d10e1aa21d00713f5e53a703a35858628701c24098fa',
};
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const need = (ok, reason) => { if (!ok) throw new Error(reason); };
const canonical = (v) => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' :
  v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
const identity = (s) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');
const key = (e) => sentenceAudioIdentity(e.textHash, e.accent);
const same = (a, b, reason) => need(isDeepStrictEqual(a, b), reason);

function reader() {
  const seen = new Map();
  const open = (name, maximum, expected, size) => {
    const file = path.resolve(name);
    need(fs.realpathSync(file) === file, 'installer_real_input_path');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true });
    try {
      need(before.isFile() && before.size > 0n && before.size <= BigInt(maximum) &&
        (size === undefined || before.size === BigInt(size)), 'installer_input_bounds');
      return { file, fd, before, expected };
    } catch (error) { fs.closeSync(fd); throw error; }
  };
  const finish = (handle, digest) => {
    need(identity(handle.before) === identity(fs.fstatSync(handle.fd, { bigint: true })) &&
      identity(handle.before) === identity(fs.lstatSync(handle.file, { bigint: true })) &&
      (handle.expected === undefined || digest === handle.expected), 'installer_input_identity_or_sha');
    seen.set(handle.file, identity(handle.before));
  };
  const read = (name, cap, expected, size) => {
    const handle = open(name, cap, expected, size);
    try {
      const raw = Buffer.alloc(Number(handle.before.size));
      let offset = 0;
      while (offset < raw.length) {
        const count = fs.readSync(handle.fd, raw, offset, raw.length - offset, null);
        need(count > 0, 'installer_input_truncated'); offset += count;
      }
      need(fs.readSync(handle.fd, Buffer.alloc(1), 0, 1, null) === 0, 'installer_input_grew');
      finish(handle, sha(raw));
      return raw;
    } finally { fs.closeSync(handle.fd); }
  };
  const pin = (p, cap) => {
    need(p && Object.keys(p).sort().join(',') === 'bytes,fileName,sha256' &&
      typeof p.fileName === 'string' && /^[A-Za-z0-9._/-]+$/.test(p.fileName) &&
      !path.isAbsolute(p.fileName) && !p.fileName.split('/').some(v => !v || v === '.' || v === '..') &&
      /^[a-f0-9]{64}$/.test(p.sha256) && Number.isSafeInteger(p.bytes) && p.bytes > 0 && p.bytes <= cap,
      'installer_explicit_relative_pin');
    return JSON.parse(read(path.join(ROOT, p.fileName), cap, p.sha256, p.bytes));
  };
  return { read, pin, async hash(name, cap, expected, size) {
    const handle = open(name, cap, expected, size), h = crypto.createHash('sha256');
    try {
      let bytes = 0n;
      for await (const block of fs.createReadStream(handle.file, { fd: handle.fd, autoClose: false, highWaterMark: 256 * 1024 })) {
        bytes += BigInt(block.length); need(bytes <= handle.before.size, 'installer_hash_input_grew'); h.update(block);
      }
      need(bytes === handle.before.size, 'installer_hash_input_truncated');
      const digest = h.digest('hex'); finish(handle, digest); return digest;
    } finally { fs.closeSync(handle.fd); }
  }, unchanged() {
    for (const [file, prior] of seen) need(identity(fs.lstatSync(file, { bigint: true })) === prior, 'installer_final_input_changed');
  } };
}

/** Independently match each complete applicable record, not merely its count. */
export function checkInstallerReviews(source, manifest, review, controls) {
  const expected = manifest.entries.flatMap(entry => {
    const control = controls.get(entry.textHash)?.accents[entry.accent];
    need(!control || control.state !== 'hold', 'installer_held_review_target');
    const correction = control?.correction;
    if (!correction) {
      need(!('pronunciationCorrectionSha256' in entry) && !('pronunciationCorrectionId' in entry), 'installer_invented_correction');
      return [];
    }
    same(correction.record.originalPhonemes, controls.get(entry.textHash).originalPhonemes, 'installer_original_correction_array');
    need(correction.sha256 === sha(canonical(correction.record)) &&
      entry.pronunciationCorrectionSha256 === correction.sha256 && entry.pronunciationCorrectionId === correction.record.id,
      'installer_whole_correction_identity');
    return [correction.record];
  });
  if (!expected.length) need(review === null && !source.pronunciationReviews, 'installer_unexpected_review_sidecar');
  else {
    need(review?.formatVersion === 1 && review.id === 'sentence-pronunciation-v1' && review.engineVersion === '1.8.0' &&
      review.voicesManifestSha256 === VOICES && Object.keys(review).length === 5, 'installer_review_sidecar_shape');
    same(review.entries, expected, 'installer_complete_review_records');
    need(source.pronunciationReviews?.appliedClipCount === expected.length && source.pronunciationReviews.engineVersion === '1.8.0' &&
      source.pronunciationReviews.expertCertified === false, 'installer_review_count');
  }
  return expected.length;
}

export function checkInstallerMetadata({ request, accepted, descriptor, source, manifest, voices, policy }) {
  need(descriptor.id === request.packId && descriptor.version === request.packId && descriptor.status === 'ready' &&
    manifest.version === request.packId && manifest.schemaVersion === 2 && manifest.status === 'ready' &&
    descriptor.entryCount === manifest.entries.length && descriptor.lemmaCount === request.targets.length,
    'installer_pack_descriptor_scope');
  const counts = { lemmaCount: request.targets.length, entryCount: manifest.entries.length,
    recordedCount: 0, synthesizedCount: manifest.entries.length, failedCount: 0 };
  need(request.targets.length >= 1 && request.targets.length <= 1000 && manifest.entries.length <= 2000 &&
    Object.entries(counts).every(([name, value]) => descriptor[name] === value && manifest.statistics[name] === value),
    'installer_exact_basic_statistics');
  same(source.requestedSentences, request.targets, 'installer_requested_current_targets');
  same(source.sentences, request.targets, 'installer_meaning_bound_sentences');
  same(source.batchApproval, request.batchApproval, 'installer_batch_approval');
  same(accepted.batchApproval, request.batchApproval, 'installer_accepted_batch_approval');
  same(source.engineSource, voices, 'installer_original_voice_attribution_source');
  need(source.reusedMediaReferences.length === 0 && source.baselinePacks.length === 0 &&
    source.meaningPackSha256 === PUBLIC && source.finalPolicySha256 === FINAL,
    'installer_no_unapproved_reuse');
  const targets = new Map(request.targets.map(t => [t.textHash, t]));
  const media = new Map(accepted.media.map(e => [key(e), e]));
  need(targets.size === request.targets.length && media.size === accepted.media.length &&
    manifest.entries.length === media.size && accepted.generatedPairs === media.size, 'installer_unique_accepted_pairs');
  const expected = [];
  for (const entry of manifest.entries) {
    const verified = media.get(key(entry)), target = targets.get(entry.textHash), voice = voices.voices[entry.accent];
    need(verified && target && target.accents.includes(entry.accent) && voice &&
      !policy.byIdentity.has(key(entry)) && entry.cacheKey === verified.cacheKey &&
      entry.originalFileSha256 === verified.originalWavSha256 && Number.isSafeInteger(entry.sizeBytes) &&
      entry.sizeBytes > 0 && entry.sizeBytes <= 2 * MIB, 'installer_only_independently_accepted_pairs');
    expected.push({ text: target.text, textHash: entry.textHash, accent: entry.accent, kind: 'synthesized',
      sourceName: voice.sourceName, sourceUrl: voice.sourceUrl, license: voice.license, attribution: voice.attribution,
      fileKey: 'files/' + verified.fileSha256 + '.mp3', fileSha256: verified.fileSha256, mimeType: 'audio/mpeg' });
  }
  const compared = verifyPinnedSentenceEntries(expected, manifest.entries.map(e => ({ ...e, status: 'ready' })), policy);
  need(compared.eligible === media.size && compared.held === 0, 'installer_all_eligible_entries_compared');
  return compared;
}

function filesIn(directory) {
  const found = new Set();
  for (const name of fs.readdirSync(directory)) {
    const full = path.join(directory, name), st = fs.lstatSync(full);
    need(!st.isSymbolicLink(), 'installer_no_symlink');
    if (st.isDirectory()) {
      need(name === 'files' || name === 'licenses', 'installer_no_other_directory');
      for (const child of fs.readdirSync(full)) {
        const nested = fs.lstatSync(path.join(full, child));
        need(nested.isFile() && !nested.isSymbolicLink(), 'installer_regular_leaf_only');
        found.add(name + '/' + child);
      }
    } else { need(st.isFile(), 'installer_regular_metadata_only'); found.add(name); }
  }
  return found;
}

export function checkInstallerFileSet(directory, manifest, hasReviews) {
  const actual = filesIn(directory), mp3s = new Set(manifest.entries.map(e => e.fileKey));
  for (const name of mp3s) need(/^files\/[a-f0-9]{64}\.mp3$/.test(name), 'installer_only_content_addressed_mp3');
  const metadata = ['manifest.json', 'sources.manifest.json', 'pronunciation-holds.json'];
  if (hasReviews) metadata.push('pronunciation-reviews.json');
  const notices = [...actual].filter(name => /^licenses\/[A-Za-z0-9_.-]+\.(txt|json|md)$/.test(name));
  need(notices.length > 0 && notices.length <= 1000, 'installer_license_notices_required');
  same([...actual].sort(), [...new Set([...metadata, ...notices, ...mp3s])].sort(), 'installer_exact_mp3_only_files');
  return mp3s;
}

export async function verifyInstaller(args) {
  const r = reader(), json = (f, n, digest, size) => JSON.parse(r.read(f, n, digest, size));
  const checkerSourceSha256 = sha(r.read(fileURLToPath(import.meta.url), 128 * 1024));
  for (const [file, digest] of Object.entries(HELPERS)) r.read(path.join(ROOT, 'scripts', file), 256 * 1024, digest);
  const request = json(args.request, 8 * MIB, args['request-sha256']);
  const accepted = json(args.check, 16 * MIB, args['check-sha256']);
  need(request.mode === 'batch' && request.publicRootSha256 === PUBLIC && request.finalPolicySha256 === FINAL &&
    accepted.kind === 'nightstudy-ci-sentence-audio-batch-independent-check-v1' && accepted.state === 'VERIFIED_SELECTED_BATCH_ONLY' &&
    accepted.requestSha256 === args['request-sha256'] && accepted.checkerSourceSha256 === CHECKER &&
    accepted.publicRootSha256 === PUBLIC && accepted.finalPolicySha256 === FINAL &&
    accepted.batchWorkerSha256 === '4be14408ff260feb89e5e58e7740b4b522b9a7f05d22d2b1d8009669610a252a' &&
    accepted.purePilotHelperSha256 === '8d4c07d943331228790aa6d0376b664677180705c0b590d42c6c73b32dcc9057' &&
    Number.isSafeInteger(accepted.generatedPairs) && accepted.generatedPairs >= 1 && accepted.generatedPairs <= 2000 &&
    accepted.completeMp3EofDecodes === accepted.generatedPairs && accepted.originalWavsFullyRead === accepted.generatedPairs &&
    accepted.allCurrentReferencesBound === true && accepted.selectionPairUnionVerified === true &&
    accepted.reviewedFrozenRawCallsVerified === true && accepted.decoderInputProtocol === 'fd' && accepted.seekablePinnedInput === true &&
    accepted.oldUnapprovedCandidateSelection === 'NOT_SELECTED' && accepted.oldUnapprovedCandidates === 89880 &&
    accepted.publicationAuthorized === false, 'installer_actual_independent_batch_acceptance');
  const descriptor = json(args.descriptor, MIB, args['descriptor-sha256']);
  need(/^sentence-audio-v4-(?!0000)[0-9]{4}$/.test(descriptor.id) &&
    path.basename(args.descriptor) === descriptor.id + '.manifest.json' &&
    path.basename(args.archive) === 'nightstudy-' + descriptor.id + '.tar.gz' &&
    descriptor.source.url.endsWith('/' + path.basename(args.archive)) &&
    Number.isSafeInteger(descriptor.source.sizeBytes) && descriptor.source.sizeBytes > 0 &&
    descriptor.source.sizeBytes < 2 * 1024 ** 3 &&
    ['manifestSha256', 'sourceManifestSha256'].every(k => /^[a-f0-9]{64}$/.test(descriptor[k])) &&
    /^[a-f0-9]{64}$/.test(descriptor.source.sha256), 'installer_descriptor_archive_pin');
  await r.hash(args.archive, 2 * 1024 ** 3 - 1, descriptor.source.sha256, descriptor.source.sizeBytes);
  const extracted = path.resolve(args.extracted);
  need(fs.realpathSync(extracted) === extracted && fs.statSync(extracted).isDirectory(), 'installer_real_extracted_directory');
  const manifest = json(path.join(extracted, 'manifest.json'), 16 * MIB, descriptor.manifestSha256);
  const source = json(path.join(extracted, 'sources.manifest.json'), 32 * MIB, descriptor.sourceManifestSha256);
  need(manifest.sourceManifestSha256 === descriptor.sourceManifestSha256 &&
    source.cloudBuildEvidence.requestSha256 === args['request-sha256'] &&
    source.cloudBuildEvidence.independentCheckSha256 === args['check-sha256'] &&
    source.cloudBuildEvidence.generatedManifestSha256 === accepted.generatedManifest.sha256 &&
    source.cloudBuildEvidence.generatedSourcesSha256 === accepted.generatedSources.sha256 &&
    source.cloudBuildEvidence.buildReceiptSha256 === accepted.generationReceipt.sha256,
    'installer_whole_generation_evidence_pins');
  const policyFile = path.resolve(args['policy-manifest']);
  need(path.basename(policyFile) === 'sentence-audio-holds-v1.manifest.json', 'installer_explicit_policy_manifest');
  const policyManifest = json(policyFile, 65536, HOLD_MANIFEST, 375);
  same(policyManifest, { formatVersion: 1, id: 'sentence-audio-holds-v1', fileName: 'sentence-audio-holds-v1.json',
    bytes: 80987, sha256: HOLDS, holdCount: 79, learningSensesManifestFileName: 'learning-senses-collection-v2.manifest.json',
    learningSensesManifestSha256: PUBLIC }, 'installer_exact_global79_manifest');
  const rawPolicy = r.read(path.join(path.dirname(policyFile), policyManifest.fileName), 4 * MIB, HOLDS, 80987);
  same(r.read(path.join(extracted, 'pronunciation-holds.json'), 4 * MIB, HOLDS, 80987), rawPolicy, 'installer_unchanged_global79_sidecar');
  const policy = { ...parseSentenceAudioHoldPolicy(rawPolicy), manifest: policyManifest, manifestSha256: HOLD_MANIFEST };
  need(policy.entries.length === 79, 'installer_global79_count');
  const voices = json(path.join(ROOT, 'data/audio-voices.manifest.json'), 65536, VOICES);
  const base = r.pin(request.portableControls, 64 * MIB);
  need(request.portableControls.sha256 === BASE && base.counts.groups === 3643 && base.counts.corrections === 1757 &&
    base.counts.holds === 79, 'installer_unchanged_frozen_controls');
  const controls = new Map(base.groups.map(g => [g.textHash, g]));
  if (request.batchApproval.supplementalControls) {
    const supplemental = r.pin(request.batchApproval.supplementalControls, 2 * MIB);
    need(supplemental.kind === 'nightstudy-ci-audio-supplemental-controls-v1' && supplemental.baseControlsSha256 === BASE &&
      supplemental.groups.length === 1 && !controls.has(supplemental.groups[0].textHash), 'installer_separate_current_supplement');
    controls.set(supplemental.groups[0].textHash, supplemental.groups[0]);
  }
  const compared = checkInstallerMetadata({ request, accepted, descriptor, source, manifest, voices, policy });
  const reviewRaw = source.pronunciationReviews ? r.read(path.join(extracted, 'pronunciation-reviews.json'), 4 * MIB,
    source.pronunciationReviews.sha256, source.pronunciationReviews.bytes) : null;
  const reviewCount = checkInstallerReviews(source, manifest, reviewRaw ? JSON.parse(reviewRaw) : null, controls);
  const mp3s = checkInstallerFileSet(extracted, manifest, reviewRaw !== null);
  for (const entry of manifest.entries) await r.hash(path.join(extracted, entry.fileKey), 2 * MIB, entry.fileSha256, entry.sizeBytes);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-installer-policy-'));
  let coverage;
  try {
    fs.writeFileSync(path.join(temporary, descriptor.id + '.pronunciation-holds.json'), rawPolicy, { flag: 'wx' });
    if (reviewRaw) fs.writeFileSync(path.join(temporary, descriptor.id + '.pronunciation-reviews.json'), reviewRaw, { flag: 'wx' });
    coverage = verifySentenceAudioPackHolds(policy, source, manifest, temporary, descriptor.id, request.targets);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  for (const [name, count] of Object.entries(coverage)) need(descriptor[name] === count, 'installer_descriptor_coverage');
  r.unchanged();
  return { kind: 'nightstudy-ci-sentence-audio-installer-check-v1', state: 'VERIFIED_EXTRACTED_PACK_ONLY',
    checkerSourceSha256,
    packId: descriptor.id, requestSha256: args['request-sha256'], independentCheckSha256: args['check-sha256'],
    descriptorSha256: args['descriptor-sha256'], archiveSha256: descriptor.source.sha256, archiveBytes: descriptor.source.sizeBytes,
    manifestSha256: descriptor.manifestSha256, sourceManifestSha256: descriptor.sourceManifestSha256,
    helperSourceSha256: HELPERS,
    globalHoldsSha256: HOLDS, globalHoldCount: 79, pronunciationReviewCount: reviewCount, uniqueMp3Files: mp3s.size,
    comparedEntries: compared.eligible, coverage, maturePinnedEntryCheckPassed: true, matureHoldPackCheckPassed: true,
    exactMp3OnlyFileClosure: true, databaseUsed: false, modelsUsed: false, audioDecodedHere: false,
    allLibraryDatabaseAcceptancePassed: false, publicationAuthorized: false };
}

async function main() {
  const names = ['request', 'request-sha256', 'check', 'check-sha256', 'descriptor', 'descriptor-sha256',
    'archive', 'extracted', 'policy-manifest', 'receipt'];
  const { values } = parseArgs({ options: Object.fromEntries(names.map(n => [n, { type: 'string' }])), strict: true });
  need(process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true', 'installer_cloud_linux_only');
  need(names.every(n => typeof values[n] === 'string' && values[n]) &&
    ['request-sha256', 'check-sha256', 'descriptor-sha256'].every(n => /^[a-f0-9]{64}$/.test(values[n])), 'installer_explicit_inputs');
  const receipt = path.resolve(values.receipt);
  need(!fs.existsSync(receipt) && fs.realpathSync(path.dirname(receipt)) === path.dirname(receipt), 'installer_fresh_receipt');
  const result = await verifyInstaller(values);
  fs.writeFileSync(receipt, JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ state: result.state, packId: result.packId, entries: result.comparedEntries, publicationAuthorized: false }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(JSON.stringify({ state: 'INSTALLER_CHECK_FAILED', code: error.message })); process.exitCode = 1; });
