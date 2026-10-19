/** Independent fixed-file publication-hold checks; no application build or database import. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, fields) =>
  object(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((key) => Object.hasOwn(value, key));
const integer = (value, minimum, maximum) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
export class SentenceAudioPolicyError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const check = (condition, code) => {
  if (!condition) throw new SentenceAudioPolicyError(code);
};
export const sentenceAudioIdentity = (hash, accent) => hash + '\0' + accent;
export const normalizeSentenceAudioText = (text) =>
  text.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/gu, ' ').trim();
export const emptySentenceAudioPolicy = () => ({
  entries: [],
  byIdentity: new Map(),
  manifest: null,
  manifestSha256: null,
});

function decode(bytes) {
  const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      const start = i;
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') break;
      }
      const scope = stack.at(-1);
      if (scope?.object && scope.key) {
        const key = JSON.parse(text.slice(start, i + 1));
        check(!scope.keys.has(key), 'sentence_audio_policy_duplicate_json_key');
        scope.keys.add(key);
        scope.key = false;
      }
    } else if (text[i] === '{' || text[i] === '[') {
      check(stack.length < 64, 'sentence_audio_policy_json_depth');
      stack.push({ object: text[i] === '{', key: text[i] === '{', keys: new Set() });
    } else if (text[i] === '}' || text[i] === ']') stack.pop();
    else if (text[i] === ',' && stack.at(-1)?.object) stack.at(-1).key = true;
  }
  return value;
}

function fixedFile(directory, name, maximum) {
  check(
    typeof name === 'string' && path.basename(name) === name,
    'sentence_audio_policy_path_invalid',
  );
  const file = path.join(directory, name);
  const stat = fs.lstatSync(file);
  check(
    stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximum,
    'sentence_audio_policy_file_invalid',
  );
  const bytes = fs.readFileSync(file);
  check(bytes.length === stat.size, 'sentence_audio_policy_file_changed');
  return bytes;
}

export function parseSentenceAudioHoldPolicy(bytes) {
  check(bytes.length <= 4 * 1024 * 1024, 'sentence_audio_policy_bytes_limit');
  const value = decode(bytes);
  check(
    keys(value, ['formatVersion', 'id', 'entries']) &&
      value.formatVersion === 1 &&
      value.id === 'sentence-audio-holds-v1' &&
      Array.isArray(value.entries) &&
      value.entries.length <= 5000,
    'sentence_audio_policy_shape',
  );
  const byIdentity = new Map();
  for (const entry of value.entries) {
    check(
      keys(entry, [
        'id',
        'text',
        'textHash',
        'accent',
        'learningSenseId',
        'exampleId',
        'riskCategory',
        'review',
      ]) &&
        typeof entry.text === 'string' &&
        entry.text.length >= 15 &&
        entry.text.length <= 4000 &&
        digest(entry.textHash) &&
        ['US', 'UK'].includes(entry.accent) &&
        typeof entry.learningSenseId === 'string' &&
        /^learning-sense-[a-f0-9]{64}$/.test(entry.learningSenseId) &&
        typeof entry.exampleId === 'string' &&
        /^sense-example-[a-f0-9]{64}$/.test(entry.exampleId) &&
        [
          'wrong-lexeme',
          'insufficient-regional-evidence',
          'insufficient-reading-evidence',
        ].includes(entry.riskCategory),
      'sentence_audio_policy_entry_shape',
    );
    const review = entry.review;
    check(
      keys(review, ['reviewer', 'decision', 'expertCertified', 'reason']) &&
        review.reviewer === 'Codex' &&
        review.decision === 'hold' &&
        review.expertCertified === false &&
        typeof review.reason === 'string' &&
        review.reason.length <= 4000 &&
        review.reason.trim().length >= 15 &&
        !/[\x00-\x1f]/u.test(review.reason),
      'sentence_audio_policy_review',
    );
    const identity = sentenceAudioIdentity(entry.textHash, entry.accent);
    check(
      normalizeSentenceAudioText(entry.text) === entry.text &&
        sha(entry.text) === entry.textHash &&
        entry.id === 'sentence-audio-hold-' + sha(identity) &&
        !byIdentity.has(identity),
      'sentence_audio_policy_identity_invalid',
    );
    byIdentity.set(identity, entry);
  }
  return { entries: value.entries, byIdentity };
}

export function readSentenceAudioPolicy(directory = path.resolve('data')) {
  const names = [
    'sentence-audio-v4.collection.json',
    'sentence-audio-holds-v1.manifest.json',
    'sentence-audio-holds-v1.json',
  ];
  const present = names.map((name) => fs.existsSync(path.join(directory, name)));
  if (present.every((value) => !value)) return emptySentenceAudioPolicy();
  check(present.every(Boolean), 'sentence_audio_policy_installation_incomplete');
  const collection = decode(fixedFile(directory, names[0], 1024 * 1024));
  check(
    object(collection) &&
      collection.id === 'sentence-audio-v4' &&
      collection.pronunciationHoldsManifestFileName === names[1] &&
      digest(collection.pronunciationHoldsManifestSha256) &&
      typeof collection.learningSensesManifestFileName === 'string' &&
      /^learning-senses-collection-[a-z0-9-]+\.manifest\.json$/.test(
        collection.learningSensesManifestFileName,
      ) &&
      digest(collection.learningSensesManifestSha256),
    'sentence_audio_policy_collection_pin',
  );
  const raw = fixedFile(directory, names[1], 1024 * 1024);
  const manifest = decode(raw);
  check(
    keys(manifest, [
      'formatVersion',
      'id',
      'fileName',
      'bytes',
      'sha256',
      'holdCount',
      'learningSensesManifestFileName',
      'learningSensesManifestSha256',
    ]) &&
      manifest.formatVersion === 1 &&
      manifest.id === 'sentence-audio-holds-v1' &&
      manifest.fileName === names[2] &&
      integer(manifest.bytes, 1, 4 * 1024 * 1024) &&
      digest(manifest.sha256) &&
      integer(manifest.holdCount, 0, 5000),
    'sentence_audio_policy_manifest_shape',
  );
  check(
    sha(raw) === collection.pronunciationHoldsManifestSha256 &&
      manifest.learningSensesManifestFileName === collection.learningSensesManifestFileName &&
      manifest.learningSensesManifestSha256 === collection.learningSensesManifestSha256 &&
      sha(fixedFile(directory, manifest.learningSensesManifestFileName, 1024 * 1024)) ===
        manifest.learningSensesManifestSha256,
    'sentence_audio_policy_meaning_pin_mismatch',
  );
  const bytes = fixedFile(directory, manifest.fileName, 4 * 1024 * 1024);
  check(
    bytes.length === manifest.bytes && sha(bytes) === manifest.sha256,
    'sentence_audio_policy_checksum',
  );
  const policy = parseSentenceAudioHoldPolicy(bytes);
  check(policy.entries.length === manifest.holdCount, 'sentence_audio_policy_count_mismatch');
  return { ...policy, manifest, manifestSha256: sha(raw) };
}

function requestedMap(rows) {
  const requested = new Map();
  for (const row of rows) {
    check(
      object(row) &&
        typeof row.text === 'string' &&
        digest(row.textHash) &&
        normalizeSentenceAudioText(row.text) === row.text &&
        sha(row.text) === row.textHash &&
        Array.isArray(row.references) &&
        !requested.has(row.textHash),
      'sentence_audio_requested_identity',
    );
    requested.set(row.textHash, row);
  }
  return requested;
}

export function bindSentenceAudioHoldReferences(policy, requestedRows, requireAll = true) {
  const requested = requestedMap(requestedRows),
    active = new Map();
  for (const entry of policy.entries) {
    const row = requested.get(entry.textHash);
    if (!row) {
      check(!requireAll, 'sentence_audio_hold_scope_missing');
      continue;
    }
    check(
      row.text === entry.text &&
        row.references.some(
          (ref) =>
            ref.learningSenseId === entry.learningSenseId && ref.exampleId === entry.exampleId,
        ),
      'sentence_audio_hold_meaning_mismatch',
    );
    active.set(sentenceAudioIdentity(entry.textHash, entry.accent), entry);
  }
  return active;
}

export function learningSentenceAudioTargets(rows) {
  const targets = new Map();
  for (const word of rows)
    for (const sense of word.senses)
      for (const example of sense.examples) {
        const text = normalizeSentenceAudioText(example.exampleEn),
          textHash = sha(text);
        check(
          example.contentMetadata?.textHash === textHash &&
            example.learningSenseId === sense.id &&
            sense.wordId === word.wordId &&
            example.wordId === word.wordId,
          'sentence_audio_content_reference_invalid',
        );
        const row = targets.get(textHash) ?? { textHash, text, references: [] };
        row.references.push({
          wordId: word.wordId,
          learningSenseId: sense.id,
          exampleId: example.id,
        });
        targets.set(textHash, row);
      }
  return [...targets.values()];
}

export function assertHeldSentenceAudioUnavailable(policy, audioRows) {
  for (const entry of audioRows)
    check(
      !(
        entry.status === 'ready' &&
        policy.byIdentity.has(sentenceAudioIdentity(entry.textHash, entry.accent))
      ),
      'held_sentence_audio_ready',
    );
}

export function verifySentenceAudioPackHolds(
  policy,
  source,
  built,
  cacheRoot,
  packId,
  releaseTargets,
) {
  check(
    /^sentence-audio-v4(?:-(?!0000)[0-9]{4})?$/.test(packId),
    'sentence_audio_hold_pack_identity',
  );
  check(policy.manifest !== null, 'sentence_audio_hold_release_policy_required');
  const pin = source.pronunciationHolds;
  check(
    keys(pin, ['fileName', 'sourceFileName', 'bytes', 'sha256', 'holdCount', 'appliedClipCount']) &&
      pin.fileName === 'pronunciation-holds.json' &&
      pin.sourceFileName === policy.manifest.fileName &&
      pin.bytes === policy.manifest.bytes &&
      pin.sha256 === policy.manifest.sha256 &&
      pin.holdCount === policy.manifest.holdCount &&
      integer(pin.appliedClipCount, 0, 5000),
    'sentence_audio_pack_hold_pin',
  );
  const holdBytes = fixedFile(cacheRoot, packId + '.pronunciation-holds.json', 4 * 1024 * 1024);
  check(
    holdBytes.length === pin.bytes && sha(holdBytes) === pin.sha256,
    'sentence_audio_pack_hold_sidecar_checksum',
  );
  // Parse the actual cached bytes independently, not just the release copy.
  parseSentenceAudioHoldPolicy(holdBytes);
  check(
    Array.isArray(source.requestedSentences) &&
      Array.isArray(source.reusedMediaReferences) &&
      Array.isArray(source.heldMediaReferences) &&
      Array.isArray(built.entries),
    'sentence_audio_pack_hold_scope',
  );
  const requested = requestedMap(source.requestedSentences);
  check(Array.isArray(releaseTargets), 'sentence_audio_release_targets_required');
  const published = requestedMap(releaseTargets);
  for (const [textHash, row] of requested) {
    const actual = published.get(textHash),
      references = new Set();
    check(
      actual?.text === row.text &&
        row.references.length > 0 &&
        row.references.every((ref) => {
          if (!object(ref)) return false;
          const identity = ref.learningSenseId + '\0' + ref.exampleId;
          if (references.has(identity)) return false;
          references.add(identity);
          return actual.references.some(
            (expected) =>
              expected.learningSenseId === ref.learningSenseId &&
              expected.exampleId === ref.exampleId &&
              (!Object.hasOwn(ref, 'wordId') || ref.wordId === expected.wordId),
          );
        }),
      'sentence_audio_pack_release_reference_mismatch',
    );
  }
  const active = bindSentenceAudioHoldReferences(policy, source.requestedSentences, false);
  check(pin.appliedClipCount === active.size, 'sentence_audio_pack_hold_count');
  const declaredHolds = new Set();
  for (const item of source.heldMediaReferences) {
    check(
      keys(item, ['holdId', 'textHash', 'accent', 'learningSenseId', 'exampleId', 'riskCategory']),
      'sentence_audio_pack_hold_reference',
    );
    const identity = sentenceAudioIdentity(item.textHash, item.accent),
      expected = active.get(identity);
    check(
      expected &&
        !declaredHolds.has(identity) &&
        item.holdId === expected.id &&
        ['learningSenseId', 'exampleId', 'riskCategory'].every(
          (key) => item[key] === expected[key],
        ),
      'sentence_audio_pack_hold_reference',
    );
    declaredHolds.add(identity);
  }
  check(declaredHolds.size === active.size, 'sentence_audio_pack_hold_reference');
  const media = new Set(),
    reused = new Map();
  for (const entry of [...built.entries, ...source.reusedMediaReferences]) {
    const identity = sentenceAudioIdentity(entry.textHash, entry.accent);
    check(
      requested.has(entry.textHash) &&
        ['US', 'UK'].includes(entry.accent) &&
        !media.has(identity) &&
        !policy.byIdentity.has(identity),
      'sentence_audio_pack_media_held_or_duplicate',
    );
    if (Object.hasOwn(entry, 'text'))
      check(entry.text === requested.get(entry.textHash).text, 'sentence_audio_pack_media_text');
    media.add(identity);
  }
  for (const entry of source.reusedMediaReferences)
    reused.set(entry.textHash, (reused.get(entry.textHash) ?? 0) + 1);
  for (const [textHash] of requested)
    for (const accent of ['US', 'UK']) {
      const identity = sentenceAudioIdentity(textHash, accent);
      check(
        Number(media.has(identity)) + Number(active.has(identity)) === 1,
        'sentence_audio_pack_hold_coverage_incomplete',
      );
    }
  const heldSentences = new Map();
  for (const entry of active.values())
    heldSentences.set(entry.textHash, (heldSentences.get(entry.textHash) ?? 0) + 1);
  const expectedCoverage = {
    requestedSentenceCount: requested.size,
    requestedClipCount: requested.size * 2,
    generatedClipCount: built.entries.length,
    reusedClipCount: source.reusedMediaReferences.length,
    fullyReusedSentenceCount: [...reused.values()].filter((n) => n === 2).length,
    partiallyReusedSentenceCount: [...reused.values()].filter((n) => n === 1).length,
    heldClipCount: active.size,
    heldSentenceCount: heldSentences.size,
    fullyHeldSentenceCount: [...heldSentences.values()].filter((n) => n === 2).length,
    eligibleClipCount: requested.size * 2 - active.size,
  };
  check(
    object(source.coverage) &&
      object(built.statistics) &&
      Object.entries(expectedCoverage).every(
        ([key, value]) => source.coverage[key] === value && built.statistics[key] === value,
      ),
    'sentence_audio_pack_hold_coverage_mismatch',
  );
  if (source.pronunciationReviews) {
    const review = source.pronunciationReviews;
    check(
      review.fileName === 'pronunciation-reviews.json' &&
        integer(review.bytes, 1, 4 * 1024 * 1024) &&
        digest(review.sha256),
      'sentence_audio_pack_review_pin',
    );
    const bytes = fixedFile(cacheRoot, packId + '.pronunciation-reviews.json', 4 * 1024 * 1024);
    check(
      bytes.length === review.bytes && sha(bytes) === review.sha256,
      'sentence_audio_pack_review_sidecar_checksum',
    );
  }
  return expectedCoverage;
}

export function sentenceAudioPolicySelfTest() {
  let checks = 0;
  const equal = (...args) => {
    assert.deepEqual(...args);
    checks++;
  };
  const rejects = (...args) => {
    assert.throws(...args);
    checks++;
  };
  const text = 'The drawing shows a bifurcate stem.',
    textHash = sha(text);
  const hold = {
    id: 'sentence-audio-hold-' + sha(sentenceAudioIdentity(textHash, 'UK')),
    text,
    textHash,
    accent: 'UK',
    learningSenseId: 'learning-sense-' + 'a'.repeat(64),
    exampleId: 'sense-example-' + 'b'.repeat(64),
    riskCategory: 'insufficient-regional-evidence',
    review: {
      reviewer: 'Codex',
      decision: 'hold',
      expertCertified: false,
      reason:
        'Specific regional POS evidence remains unresolved; not all uncertain clips are proved wrong.',
    },
  };
  const rawPolicy = { formatVersion: 1, id: 'sentence-audio-holds-v1', entries: [hold] };
  const bytes = Buffer.from(JSON.stringify(rawPolicy));
  const parsed = parseSentenceAudioHoldPolicy(bytes);
  equal(parsed.byIdentity.size, 1);
  equal(parsed.byIdentity.has(sentenceAudioIdentity(textHash, 'US')), false);
  equal(
    parseSentenceAudioHoldPolicy(Buffer.from(JSON.stringify({ ...rawPolicy, entries: [] })))
      .entries,
    [],
  );
  for (const change of [
    (value) => value.entries.push(structuredClone(value.entries[0])),
    (value) => (value.entries[0].accent = 'US'),
    (value) => (value.entries[0].textHash = '0'.repeat(64)),
    (value) => (value.entries[0].text = '  ' + text),
    (value) => (value.entries[0].riskCategory = 'all-audio-wrong'),
    (value) => (value.entries[0].review.expertCertified = true),
    (value) => (value.entries[0].review.reason = ' '.repeat(4000) + 'Meaningful reason text'),
    (value) => (value.entries[0].globalLemmaBan = 'bifurcate'),
  ]) {
    const copied = structuredClone(rawPolicy);
    change(copied);
    rejects(
      () => parseSentenceAudioHoldPolicy(Buffer.from(JSON.stringify(copied))),
      /sentence_audio_policy/,
    );
  }
  rejects(
    () => parseSentenceAudioHoldPolicy(Buffer.from('{"formatVersion":1,"formatVersion":1}')),
    /duplicate_json_key/,
  );
  rejects(
    () => parseSentenceAudioHoldPolicy(Buffer.from('{"formatVersion":1,"format\\u0056ersion":1}')),
    /duplicate_json_key/,
  );
  rejects(
    () => parseSentenceAudioHoldPolicy(Buffer.from('['.repeat(65) + '0' + ']'.repeat(65))),
    /json_depth/,
  );
  rejects(() => parseSentenceAudioHoldPolicy(Buffer.from([0xff])), TypeError);
  const requested = [
    {
      text,
      textHash,
      references: [{ learningSenseId: hold.learningSenseId, exampleId: hold.exampleId }],
    },
  ];
  equal(bindSentenceAudioHoldReferences(parsed, requested).size, 1);
  equal(bindSentenceAudioHoldReferences(parsed, [], false).size, 0);
  rejects(() => bindSentenceAudioHoldReferences(parsed, []), /scope_missing/);
  rejects(
    () =>
      bindSentenceAudioHoldReferences(parsed, [
        {
          ...requested[0],
          references: [{ learningSenseId: hold.learningSenseId, exampleId: 'wrong' }],
        },
      ]),
    /meaning_mismatch/,
  );
  assertHeldSentenceAudioUnavailable(parsed, [{ textHash, accent: 'US', status: 'ready' }]);
  checks++;
  assertHeldSentenceAudioUnavailable(parsed, [{ textHash, accent: 'UK', status: 'held' }]);
  checks++;
  rejects(
    () => assertHeldSentenceAudioUnavailable(parsed, [{ textHash, accent: 'UK', status: 'ready' }]),
    /held_sentence_audio_ready/,
  );
  const directory = fs.mkdtempSync(
    path.join(process.env.TMPDIR || os.tmpdir(), 'nightstudy-policy-check-'),
  );
  try {
    equal(readSentenceAudioPolicy(directory).manifest, null);
    fs.writeFileSync(path.join(directory, 'sentence-audio-holds-v1.json'), bytes);
    rejects(() => readSentenceAudioPolicy(directory), /installation_incomplete/);
    const meaningName = 'learning-senses-collection-test.manifest.json',
      meaningBytes = Buffer.from('{}');
    fs.writeFileSync(path.join(directory, meaningName), meaningBytes);
    const manifest = {
      formatVersion: 1,
      id: 'sentence-audio-holds-v1',
      fileName: 'sentence-audio-holds-v1.json',
      bytes: bytes.length,
      sha256: sha(bytes),
      holdCount: 1,
      learningSensesManifestFileName: meaningName,
      learningSensesManifestSha256: sha(meaningBytes),
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const manifestPath = path.join(directory, 'sentence-audio-holds-v1.manifest.json');
    fs.writeFileSync(manifestPath, manifestBytes);
    const collection = {
      id: 'sentence-audio-v4',
      learningSensesManifestFileName: meaningName,
      learningSensesManifestSha256: sha(meaningBytes),
      pronunciationHoldsManifestFileName: path.basename(manifestPath),
      pronunciationHoldsManifestSha256: sha(manifestBytes),
    };
    const collectionPath = path.join(directory, 'sentence-audio-v4.collection.json');
    fs.writeFileSync(collectionPath, JSON.stringify(collection));
    const policy = readSentenceAudioPolicy(directory);
    equal(policy.manifestSha256, sha(manifestBytes));
    equal(policy.entries, [hold]);
    fs.writeFileSync(path.join(directory, meaningName), '{} ');
    rejects(() => readSentenceAudioPolicy(directory), /meaning_pin_mismatch/);
    fs.writeFileSync(path.join(directory, meaningName), meaningBytes);
    const payloadPath = path.join(directory, manifest.fileName);
    fs.renameSync(payloadPath, payloadPath + '.original');
    fs.symlinkSync(payloadPath + '.original', payloadPath);
    rejects(() => readSentenceAudioPolicy(directory), /file_invalid/);
    fs.unlinkSync(payloadPath);
    fs.renameSync(payloadPath + '.original', payloadPath);
    fs.writeFileSync(payloadPath, Buffer.concat([bytes, Buffer.from(' ')]));
    rejects(() => readSentenceAudioPolicy(directory), /checksum/);
    fs.writeFileSync(payloadPath, bytes);
    const packId = 'sentence-audio-v4-0001';
    fs.writeFileSync(path.join(directory, packId + '.pronunciation-holds.json'), bytes);
    const coverage = {
      requestedSentenceCount: 1,
      requestedClipCount: 2,
      generatedClipCount: 1,
      reusedClipCount: 0,
      fullyReusedSentenceCount: 0,
      partiallyReusedSentenceCount: 0,
      heldClipCount: 1,
      heldSentenceCount: 1,
      fullyHeldSentenceCount: 0,
      eligibleClipCount: 1,
    };
    const source = {
      requestedSentences: requested,
      reusedMediaReferences: [],
      pronunciationHolds: {
        fileName: 'pronunciation-holds.json',
        sourceFileName: manifest.fileName,
        bytes: bytes.length,
        sha256: sha(bytes),
        holdCount: 1,
        appliedClipCount: 1,
      },
      heldMediaReferences: [
        {
          holdId: hold.id,
          textHash,
          accent: 'UK',
          learningSenseId: hold.learningSenseId,
          exampleId: hold.exampleId,
          riskCategory: hold.riskCategory,
        },
      ],
      coverage,
    };
    const built = { entries: [{ text, textHash, accent: 'US' }], statistics: coverage };
    equal(
      verifySentenceAudioPackHolds(policy, source, built, directory, packId, requested),
      coverage,
    );
    for (const [change, error] of [
      [(s, b) => b.entries.push({ text, textHash, accent: 'UK' }), /media_held_or_duplicate/],
      [(s) => s.reusedMediaReferences.push({ textHash, accent: 'UK' }), /media_held_or_duplicate/],
      [(s, b) => (b.entries = []), /coverage_incomplete/],
      [(s) => (s.heldMediaReferences = []), /hold_reference/],
      [(s) => (s.pronunciationHolds.appliedClipCount = 0), /hold_count/],
      [(s) => (s.coverage.heldClipCount = 0), /coverage_mismatch/],
      [
        (s) => (s.requestedSentences[0].references[0].exampleId = 'wrong'),
        /release_reference_mismatch/,
      ],
      [
        (s) => (s.requestedSentences[0].references[0].wordId = 'wrong-word'),
        /release_reference_mismatch/,
      ],
    ]) {
      const copiedSource = structuredClone(source),
        copiedBuilt = structuredClone(built);
      change(copiedSource, copiedBuilt);
      rejects(
        () =>
          verifySentenceAudioPackHolds(
            policy,
            copiedSource,
            copiedBuilt,
            directory,
            packId,
            requested,
          ),
        error,
      );
    }
    const reviewBytes = Buffer.from(
      '{"formatVersion":1,"id":"sentence-pronunciation-v1","entries":[]}',
    );
    source.pronunciationReviews = {
      fileName: 'pronunciation-reviews.json',
      bytes: reviewBytes.length,
      sha256: sha(reviewBytes),
    };
    fs.writeFileSync(path.join(directory, packId + '.pronunciation-reviews.json'), reviewBytes);
    equal(
      verifySentenceAudioPackHolds(policy, source, built, directory, packId, requested),
      coverage,
    );
    fs.writeFileSync(path.join(directory, packId + '.pronunciation-reviews.json'), '{}');
    rejects(
      () => verifySentenceAudioPackHolds(policy, source, built, directory, packId, requested),
      /review_sidecar_checksum/,
    );
    delete source.pronunciationReviews;
    fs.writeFileSync(path.join(directory, packId + '.pronunciation-holds.json'), '{}');
    rejects(
      () => verifySentenceAudioPackHolds(policy, source, built, directory, packId, requested),
      /sidecar_checksum/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return { checks, databaseUsed: false, voiceModelsUsed: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--self-test')
    throw new Error('Use --self-test; this checker never modifies a database.');
  console.log(JSON.stringify({ ok: true, ...sentenceAudioPolicySelfTest() }));
}
