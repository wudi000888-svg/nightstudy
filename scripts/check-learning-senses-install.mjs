import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import {
  readSentenceAudioPolicy,
  emptySentenceAudioPolicy,
  learningSentenceAudioTargets,
  bindSentenceAudioHoldReferences,
  sentenceAudioIdentity,
  SentenceAudioPolicyError,
} from './check-sentence-audio-policy.mjs';

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) =>
  Array.isArray(value)
    ? '[' + value.map(canonical).join(',') + ']'
    : value !== null && typeof value === 'object'
      ? '{' +
        Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
          .join(',') +
        '}'
      : JSON.stringify(value);
const normalizeAudioText = (value) =>
  value.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/gu, ' ').trim();
class VerificationError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}
const check = (condition, code, details = {}) => {
  if (!condition) throw new VerificationError(code, details);
};
const bindingFields = [
  'sourceSenseId',
  'relation',
  'sourcePosSha256',
  'sourceDefinitionZhSha256',
  'sourceDefinitionEnSha256',
];
function meaningHash(sense) {
  const value = Object.fromEntries(
    ['id', 'wordId', 'pos', 'definitionZh', 'definitionEn', 'contentVersion'].map((key) => [
      key,
      sense[key],
    ]),
  );
  value.sourceBindings = [...sense.sourceBindings]
    .sort((a, b) =>
      a.sourceSenseId < b.sourceSenseId ? -1 : a.sourceSenseId > b.sourceSenseId ? 1 : 0,
    )
    .map((binding) => Object.fromEntries(bindingFields.map((key) => [key, binding[key]])));
  return sha(canonical(value));
}

export function readLearningSensesBundle(
  manifestPath = fs.existsSync(
    new URL('../data/learning-senses-collection-v2.manifest.json', import.meta.url),
  )
    ? new URL('../data/learning-senses-collection-v2.manifest.json', import.meta.url)
    : new URL('../data/learning-senses-v1.manifest.json', import.meta.url),
  budget = { remaining: 512 * 1024 * 1024 },
) {
  const filename =
    manifestPath instanceof URL ? fileURLToPath(manifestPath) : path.resolve(manifestPath);
  const manifestBytes = pinnedFile(filename, 1024 * 1024);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.formatVersion === 2) {
    check(
      manifest.kind === 'learning-senses-collection' &&
        /^learning-senses-collection-[a-z0-9-]+$/.test(manifest.id) &&
        Number.isSafeInteger(manifest.requiredWordCount) &&
        manifest.requiredWordCount > 0 &&
        manifest.requiredWordCount <= 100000 &&
        manifest.requiredWordCount === manifest.wordCount &&
        /^[a-f0-9]{64}$/.test(manifest.requiredWordsSha256) &&
        manifest.editorialReview === 'codex-reviewed' &&
        manifest.semanticQualityCertified === false &&
        manifest.exhaustiveBookCoverage === false &&
        Array.isArray(manifest.shards) &&
        manifest.shards.length > 0 &&
        manifest.shards.length <= 1000,
      'invalid_learning_senses_collection',
    );
    for (const field of ['wordCount', 'senseCount', 'exampleCount'])
      check(
        manifest.shards.reduce((n, pin) => n + pin[field], 0) === manifest[field],
        'learning_senses_collection_pin_totals',
      );
    const ids = new Set(),
      files = new Set(),
      identities = new Set(),
      wordIds = new Set(),
      lemmas = new Set();
    const bundles = manifest.shards.map((pin) => {
      check(
        /^learning-senses-[a-z0-9.-]+\.manifest\.json$/.test(pin.manifestFileName) &&
          !ids.has(pin.id) &&
          !files.has(pin.manifestFileName),
        'learning_senses_collection_shard_identity',
      );
      ids.add(pin.id);
      files.add(pin.manifestFileName);
      const shardPath = path.join(path.dirname(filename), pin.manifestFileName);
      const bytes = pinnedFile(shardPath, 1024 * 1024);
      check(
        bytes.length === pin.bytes && sha(bytes) === pin.sha256,
        'learning_senses_collection_shard_checksum',
      );
      const shardManifest = JSON.parse(bytes.toString('utf8'));
      check(shardManifest.formatVersion === 1, 'learning_senses_nested_collection');
      const bundle = readLearningSensesBundle(shardPath, budget);
      check(
        ['id', 'wordCount', 'senseCount', 'exampleCount'].every(
          (field) => bundle.manifest[field] === pin[field],
        ) &&
          bundle.manifest.sourceExportSha256 === manifest.sourceExportSha256 &&
          bundle.manifest.bilingualOverlaySha256 === manifest.bilingualOverlaySha256,
        'learning_senses_collection_shard_scope',
      );
      for (const source of bundle.sourceRows || []) {
        check(!identities.has(source.id), 'learning_senses_collection_record_overlap');
        identities.add(source.id);
      }
      for (const row of bundle.rows) {
        check(
          !wordIds.has(row.wordId) && !lemmas.has(row.normalizedLemma),
          'learning_senses_collection_word_overlap',
        );
        wordIds.add(row.wordId);
        lemmas.add(row.normalizedLemma);
        for (const sense of row.senses)
          for (const record of [sense, ...sense.sourceBindings, ...sense.examples]) {
            check(!identities.has(record.id), 'learning_senses_collection_record_overlap');
            identities.add(record.id);
          }
      }
      return bundle;
    });
    const rows = bundles.flatMap((bundle) => bundle.rows);
    const union = rows
      .map(({ wordId, normalizedLemma }) => ({ wordId, normalizedLemma }))
      .sort((a, b) => (a.wordId < b.wordId ? -1 : a.wordId > b.wordId ? 1 : 0));
    check(
      rows.length === manifest.requiredWordCount &&
        sha(canonical(union)) === manifest.requiredWordsSha256,
      'learning_senses_collection_required_union',
    );
    return { manifest, rows, bundles };
  }
  check(
    manifest.formatVersion === 1 &&
      /^learning-senses-[a-z0-9-]+$/.test(manifest.id) &&
      /^[a-z0-9.-]+\.jsonl\.gz$/.test(manifest.fileName) &&
      Number.isSafeInteger(manifest.wordCount) &&
      manifest.wordCount > 0 &&
      manifest.wordCount <= 1000 &&
      Number.isSafeInteger(manifest.bytes) &&
      manifest.bytes > 0 &&
      manifest.bytes <= 64 * 1024 * 1024,
    'invalid_learning_senses_manifest',
  );
  const bytes = pinnedFile(path.join(path.dirname(filename), manifest.fileName), 64 * 1024 * 1024);
  check(
    bytes.length === manifest.bytes && sha(bytes) === manifest.sha256,
    'learning_senses_pack_checksum',
  );
  check(budget.remaining > 0, 'learning_senses_collection_decoded_budget');
  const decoded = gunzipSync(bytes, {
    maxOutputLength: Math.min(64 * 1024 * 1024, budget.remaining),
  });
  budget.remaining -= decoded.length;
  check(sha(decoded) === manifest.jsonlSha256, 'learning_senses_decoded_checksum');
  const rows = new TextDecoder('utf-8', { fatal: true })
    .decode(decoded)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  check(
    rows.length === manifest.wordCount &&
      rows.flatMap((row) => row.senses).length === manifest.senseCount &&
      rows.flatMap((row) => row.senses.flatMap((sense) => sense.examples)).length ===
        manifest.exampleCount,
    'learning_senses_pack_counts',
  );
  let sourceRows = [];
  if (manifest.sourceAdditions) {
    const pin = manifest.sourceAdditions;
    check(
      /^learning-sense-sources-[a-z0-9.-]+\.jsonl\.gz$/.test(pin.fileName) &&
        Number.isSafeInteger(pin.rowCount) &&
        pin.rowCount > 0 &&
        pin.rowCount <= 1000 &&
        Number.isSafeInteger(pin.bytes) &&
        pin.bytes > 0 &&
        pin.bytes <= 64 * 1024 * 1024,
      'learning_senses_source_addition_pin',
    );
    const bytes = pinnedFile(path.join(path.dirname(filename), pin.fileName), 64 * 1024 * 1024);
    check(
      bytes.length === pin.bytes && sha(bytes) === pin.sha256,
      'learning_senses_source_addition_checksum',
    );
    check(
      budget.remaining > 0 && decoded.length < 64 * 1024 * 1024,
      'learning_senses_collection_decoded_budget',
    );
    const raw = gunzipSync(bytes, {
      maxOutputLength: Math.min(64 * 1024 * 1024 - decoded.length, budget.remaining),
    });
    budget.remaining -= raw.length;
    check(sha(raw) === pin.jsonlSha256, 'learning_senses_source_addition_decoded_checksum');
    sourceRows = new TextDecoder('utf-8', { fatal: true })
      .decode(raw)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  verifyOriginalSourceAdditions(sourceRows, rows, manifest.sourceAdditions);
  return { manifest, rows, ...(sourceRows.length ? { sourceRows } : {}) };
}

const sourcePos = new Set([
  'n.',
  'v.',
  'vt.',
  'vi.',
  'adj.',
  'adv.',
  'prep.',
  'pron.',
  'det.',
  'art.',
  'conj.',
  'interj.',
  'num.',
  'aux.',
  'modal v.',
  'abbr.',
  'phr. v.',
  'n. phr.',
  'prep. phr.',
  'adv. phr.',
  'adj. phr.',
  'conj. phr.',
  'pron. phr.',
  'det. phr.',
  'modal phr.',
  'idiom',
]);
export function verifyOriginalSourceAdditions(sourceRows, rows, pin) {
  check(
    Array.isArray(sourceRows) &&
      sourceRows.length === (pin?.rowCount || 0) &&
      sourceRows.length <= 1000,
    'learning_senses_source_addition_count',
  );
  const words = new Map(rows.map((row) => [row.wordId, row.normalizedLemma])),
    sources = new Map(),
    used = new Set();
  for (const source of sourceRows) {
    check(
      Object.keys(source).sort().join(',') ===
        [
          'id',
          'wordId',
          'normalizedLemma',
          'pos',
          'definitionZh',
          'definitionEn',
          'exampleEn',
          'exampleZh',
          'ordinal',
          'contentMetadata',
        ]
          .sort()
          .join(','),
      'learning_senses_source_addition_fields',
    );
    const meta = source.contentMetadata,
      review = meta?.editorialReview;
    check(
      typeof meta?.semanticKey === 'string' &&
        /^[a-z0-9-]+$/.test(meta.semanticKey) &&
        source.id === 'learning-source-' + sha(source.wordId + '\0' + meta.semanticKey) &&
        !sources.has(source.id) &&
        words.get(source.wordId) === source.normalizedLemma &&
        sourcePos.has(source.pos) &&
        source.ordinal === 1000000 + parseInt(sha(meta.semanticKey).slice(0, 7), 16) &&
        typeof source.definitionZh === 'string' &&
        source.definitionZh.length <= 4000 &&
        /[\u4e00-\u9fff]/u.test(source.definitionZh) &&
        typeof source.definitionEn === 'string' &&
        source.definitionEn.length <= 4000 &&
        /[A-Za-z]/u.test(source.definitionEn) &&
        !/[\u4e00-\u9fff]/u.test(source.definitionEn) &&
        source.exampleEn === '' &&
        source.exampleZh === '',
      'learning_senses_source_addition_identity',
    );
    check(
      review?.decision === 'publish' &&
        review.reviewer === 'Codex' &&
        review.expertCertified === false &&
        typeof review.semanticRationale === 'string' &&
        review.semanticRationale.length >= 15 &&
        review.semanticRationale.length <= 4000 &&
        Object.keys(review).sort().join(',') ===
          ['decision', 'reviewer', 'expertCertified', 'semanticRationale'].sort().join(','),
      'learning_senses_source_addition_review',
    );
    check(
      isDeepStrictEqual(meta, {
        kind: 'original-authoring',
        evidenceKind: 'codex-original-source-addition',
        author: 'NightStudy contributors',
        license: 'MIT',
        authoringMethod: 'Direct Codex bilingual writing',
        review: 'codex-reviewed',
        expertCertified: false,
        sourceAdditionVersion: 'codex-original-source-v1',
        semanticKey: meta.semanticKey,
        definitionZhSha256: sha(source.definitionZh),
        definitionEnSha256: sha(source.definitionEn),
        editorialReview: review,
      }),
      'learning_senses_source_addition_authorship',
    );
    sources.set(source.id, source);
  }
  for (const row of rows)
    for (const sense of row.senses)
      for (const binding of sense.sourceBindings) {
        const source = sources.get(binding.sourceSenseId);
        if (source) {
          check(
            source.wordId === binding.wordId &&
              binding.wordId === row.wordId &&
              sha(source.pos) === binding.sourcePosSha256 &&
              sha(source.definitionZh) === binding.sourceDefinitionZhSha256 &&
              sha(source.definitionEn) === binding.sourceDefinitionEnSha256,
            'learning_senses_source_addition_binding',
          );
          used.add(source.id);
        } else
          check(
            !binding.sourceSenseId.startsWith('learning-source-'),
            'learning_senses_source_addition_missing',
          );
      }
  check(used.size === sources.size, 'learning_senses_source_addition_unbound');
  return sourceRows;
}

const additionsOf = (bundle) =>
  (bundle.bundles || [bundle]).flatMap((leaf) => leaf.sourceRows || []);

function pinnedFile(filename, maximum) {
  const stat = fs.lstatSync(filename);
  check(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum,
    'learning_senses_unsafe_or_oversized_file',
  );
  return fs.readFileSync(filename);
}

function exactRecord(actual, expected, code) {
  check(
    actual && Object.keys(expected).every((key) => isDeepStrictEqual(actual[key], expected[key])),
    code,
    { id: expected.id },
  );
}

/** Independent read-side verification of actual database rows, not an install dry run. */
export function verifyLearningSenses(data, bundle, baseline = null) {
  const { manifest, rows } = bundle;
  check(data.siteId && data.siteId === data.expectedSiteId, 'learning_senses_realm_mismatch');
  for (const leaf of bundle.bundles || [bundle]) {
    const manifest = leaf.manifest;
    const pack = bundle.bundles ? data.packs?.find((pack) => pack.id === manifest.id) : data.pack;
    check(
      pack?.status === 'ready' &&
        pack.sha256 === manifest.sha256 &&
        pack.version === manifest.version &&
        pack.entryCount === manifest.wordCount &&
        pack.definitionZhCount === manifest.senseCount &&
        pack.definitionEnCount === manifest.senseCount,
      'learning_senses_installed_pin',
    );
    check(
      pack.tagCounts?.kind === 'learning-senses' &&
        pack.tagCounts.learningSenses === manifest.senseCount &&
        pack.tagCounts.contextExamples === manifest.exampleCount &&
        pack.tagCounts.exhaustiveBookCoverage === false,
      'learning_senses_installed_scope',
    );
    verifyOriginalSourceAdditions(leaf.sourceRows || [], leaf.rows, manifest.sourceAdditions);
    if (manifest.sourceAdditions)
      check(
        pack.tagCounts.sourceAdditionsSha256 === manifest.sourceAdditions.sha256 &&
          pack.tagCounts.sourceAdditionCount === leaf.sourceRows.length,
        'learning_senses_installed_source_addition_pin',
      );
  }
  const words = new Map(data.words.map((word) => [word.id, word]));
  const raw = new Map(data.rawSenses.map((sense) => [sense.id, sense]));
  for (const source of additionsOf(bundle)) {
    const { normalizedLemma, ...record } = source;
    exactRecord(raw.get(source.id), record, 'learning_senses_original_source_addition_changed');
  }
  const meanings = new Map(data.learningSenses.map((sense) => [sense.id, sense]));
  const bindings = new Map(data.bindings.map((binding) => [binding.id, binding]));
  const bindingsByMeaning = new Map();
  for (const binding of data.bindings) {
    const values = bindingsByMeaning.get(binding.learningSenseId) || [];
    values.push(binding);
    bindingsByMeaning.set(binding.learningSenseId, values);
  }
  const examples = new Map(data.examples.map((example) => [example.id, example]));
  check(
    words.size === rows.length &&
      meanings.size === manifest.senseCount &&
      examples.size === manifest.exampleCount &&
      bindings.size ===
        rows.reduce(
          (count, row) =>
            count + row.senses.reduce((n, sense) => n + sense.sourceBindings.length, 0),
          0,
        ),
    'learning_senses_installed_counts',
  );
  let sourceBindings = 0;
  for (const row of rows) {
    check(
      words.get(row.wordId)?.normalizedLemma === row.normalizedLemma,
      'learning_senses_word_identity',
      { wordId: row.wordId },
    );
    const sentenceHashes = new Set();
    for (const expected of row.senses) {
      const {
        sourceBindings: expectedBindings,
        examples: expectedExamples,
        ...expectedRecord
      } = expected;
      const meaning = meanings.get(expected.id);
      exactRecord(meaning, expectedRecord, 'learning_senses_meaning_changed');
      check(
        meaning.wordId === row.wordId && meaning.status === 'published',
        'learning_senses_meaning_cross_word',
      );
      const actualBindings = bindingsByMeaning.get(meaning.id) || [];
      check(
        actualBindings.length === expectedBindings.length &&
          meaning.bindingHash === meaningHash({ ...meaning, sourceBindings: actualBindings }),
        'learning_senses_binding_hash',
      );
      for (const expectedBinding of expectedBindings) {
        const binding = bindings.get(expectedBinding.id);
        exactRecord(binding, expectedBinding, 'learning_senses_binding_changed');
        const source = raw.get(binding.sourceSenseId);
        check(
          binding.learningSenseId === meaning.id &&
            binding.wordId === row.wordId &&
            source?.wordId === row.wordId,
          'learning_senses_cross_word_source',
        );
        check(
          sha(source.pos) === binding.sourcePosSha256 &&
            sha(source.definitionZh) === binding.sourceDefinitionZhSha256 &&
            sha(source.definitionEn) === binding.sourceDefinitionEnSha256,
          'learning_senses_source_byte_drift',
          { sourceSenseId: binding.sourceSenseId },
        );
        sourceBindings++;
      }
      const contexts = new Set();
      for (const expectedExample of expectedExamples) {
        const example = examples.get(expectedExample.id);
        exactRecord(example, expectedExample, 'learning_senses_example_changed');
        check(
          example.wordId === row.wordId &&
            example.learningSenseId === meaning.id &&
            example.status === 'published',
          'learning_senses_cross_word_example',
        );
        const meta = example.contentMetadata;
        const surface = meta?.targetSurface;
        check(
          meta?.exampleEnSha256 === sha(example.exampleEn) &&
            meta?.exampleZhSha256 === sha(example.exampleZh) &&
            meta?.textHash === sha(normalizeAudioText(example.exampleEn)),
          'learning_senses_example_text_hash',
        );
        check(
          surface?.lemma === row.normalizedLemma &&
            surface?.review === 'codex-reviewed' &&
            typeof surface?.form === 'string',
          'learning_senses_target_surface_identity',
        );
        const escaped = surface.form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        check(
          new RegExp(`(?<![\\p{L}\\p{M}])${escaped}(?![\\p{L}\\p{M}])`, 'iu').test(
            example.exampleEn,
          ),
          'learning_senses_target_surface_absent',
        );
        check(!sentenceHashes.has(meta.textHash), 'learning_senses_sentence_reused_for_word');
        sentenceHashes.add(meta.textHash);
        contexts.add(example.contextLabel);
      }
      check(contexts.size >= 2, 'learning_senses_two_contexts');
    }
  }
  if (baseline) {
    check(
      baseline.formatVersion === 1 &&
        baseline.siteId === data.siteId &&
        baseline.instanceId === data.instanceId,
      'learning_senses_baseline_realm',
    );
    const expectedNewIds = new Set(additionsOf(bundle).map((source) => source.id));
    const allowedNewIds = new Set(baseline.allowedNewSourceIds || []);
    check(
      allowedNewIds.size === (baseline.allowedNewSourceIds || []).length &&
        [...allowedNewIds].every((id) => expectedNewIds.has(id)),
      'learning_senses_baseline_unpinned_source_exclusion',
    );
    const current = sourceSnapshot({
      ...data,
      rawSenses: data.rawSenses.filter((source) => !allowedNewIds.has(source.id)),
    });
    check(
      isDeepStrictEqual(current.words, baseline.words) &&
        isDeepStrictEqual(current.rawSenses, baseline.rawSenses),
      'learning_senses_original_source_identity_changed',
    );
  }
  return {
    words: rows.length,
    learningSenses: manifest.senseCount,
    sourceBindings,
    bilingualContextExamples: manifest.exampleCount,
    contextsPerSenseMinimum: 2,
    exhaustiveBookCoverage: false,
    expertCertified: false,
    originalSourceBaselineChecked: Boolean(baseline),
  };
}

export function sourceSnapshot(data, expectedNewSources = []) {
  const present = new Set(data.rawSenses.map((source) => source.id));
  const allowedNewSourceIds = expectedNewSources
    .filter((source) => !present.has(source.id))
    .map((source) => source.id)
    .sort();
  return {
    formatVersion: 1,
    siteId: data.siteId,
    instanceId: data.instanceId,
    ...(allowedNewSourceIds.length ? { allowedNewSourceIds } : {}),
    words: data.words
      .map((word) =>
        Object.fromEntries(
          ['id', 'lemma', 'normalizedLemma', 'sourceRef', 'contentVersion', 'status'].map((key) => [
            key,
            word[key],
          ]),
        ),
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    rawSenses: data.rawSenses
      .map((sense) => ({
        id: sense.id,
        wordId: sense.wordId,
        pos: sense.pos,
        ordinal: sense.ordinal,
        contentMetadataSha256: sha(canonical(sense.contentMetadata ?? {})),
        fieldHashes: Object.fromEntries(
          ['definitionZh', 'definitionEn', 'exampleZh', 'exampleEn'].map((field) => [
            field,
            sha(sense[field]),
          ]),
        ),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

export async function verifyLearningSentenceAudio(
  rows,
  audioRows,
  audioRoot,
  policy = emptySentenceAudioPolicy(),
) {
  const held = bindSentenceAudioHoldReferences(policy, learningSentenceAudioTargets(rows));
  const targets = new Map(
    rows
      .flatMap((row) => row.senses.flatMap((sense) => sense.examples))
      .map((example) => [example.contentMetadata.textHash, normalizeAudioText(example.exampleEn)]),
  );
  const installed = new Map(
    audioRows.map((entry) => [entry.textHash + '\0' + entry.accent, entry]),
  );
  const missing = [];
  const verifiedFiles = new Set();
  const problems = [];
  let readyTargets = 0,
    heldTargets = 0;
  for (const [textHash, text] of targets)
    for (const accent of ['US', 'UK']) {
      const entry = installed.get(textHash + '\0' + accent);
      if (held.has(sentenceAudioIdentity(textHash, accent))) {
        if (entry?.status === 'ready')
          problems.push({ textHash, accent, error: 'held_sentence_audio_ready' });
        else heldTargets++;
        continue;
      }
      if (!entry || entry.status !== 'ready') {
        missing.push({ textHash, accent });
        continue;
      }
      if (
        normalizeAudioText(entry.text) !== text ||
        sha(normalizeAudioText(entry.text)) !== textHash ||
        !['recorded', 'synthesized'].includes(entry.kind)
      ) {
        problems.push({ textHash, accent, error: 'sentence_audio_identity' });
        continue;
      }
      if (
        !['sourceName', 'sourceUrl', 'license', 'attribution'].every(
          (field) => typeof entry[field] === 'string' && entry[field].trim(),
        ) ||
        !['audio/mpeg', 'audio/wav', 'audio/ogg'].includes(entry.mimeType)
      ) {
        problems.push({ textHash, accent, error: 'sentence_audio_attribution_or_type' });
        continue;
      }
      if (
        !/^[a-z0-9][a-z0-9/_\-.]*\.(?:mp3|wav|ogg)$/i.test(entry.fileKey) ||
        entry.fileKey.split('/').includes('..') ||
        !/^[a-f0-9]{64}$/.test(entry.fileSha256)
      ) {
        problems.push({ textHash, accent, error: 'sentence_audio_path_or_digest' });
        continue;
      }
      try {
        const root = fs.realpathSync(audioRoot);
        const filename = fs.realpathSync(path.join(root, entry.fileKey));
        const relative = path.relative(root, filename);
        if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
          throw new Error('unsafe_path');
        const stat = fs.statSync(filename);
        if (!stat.isFile() || stat.size < 44 || stat.size > 16 * 1024 * 1024)
          throw new Error('invalid_size');
        const fileIdentity = filename + '\0' + entry.fileSha256;
        if (!verifiedFiles.has(fileIdentity)) {
          const digest = crypto.createHash('sha256');
          for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
          if (digest.digest('hex') !== entry.fileSha256) throw new Error('invalid_digest');
          verifiedFiles.add(fileIdentity);
        }
        readyTargets++;
      } catch {
        problems.push({ textHash, accent, error: 'sentence_audio_file_integrity' });
      }
    }
  return {
    checked: true,
    sentences: targets.size,
    targets: targets.size * 2,
    readyTargets,
    heldTargets,
    accountedTargets: readyTargets + heldTargets,
    missingCount: missing.length,
    integrityProblemCount: problems.length,
    verifiedFiles: verifiedFiles.size,
    missing: missing.slice(0, 30),
    problems: problems.slice(0, 30),
  };
}

async function selfTest() {
  const bundle = readLearningSensesBundle(
    new URL('../data/learning-senses-v1.manifest.json', import.meta.url),
  );
  const { rows, manifest } = bundle;
  const data = {
    expectedSiteId: 'fixture',
    siteId: 'fixture',
    instanceId: 'original-fixture',
    pack: {
      id: manifest.id,
      status: 'ready',
      sha256: manifest.sha256,
      version: manifest.version,
      entryCount: manifest.wordCount,
      definitionZhCount: manifest.senseCount,
      definitionEnCount: manifest.senseCount,
      tagCounts: {
        kind: 'learning-senses',
        learningSenses: manifest.senseCount,
        contextExamples: manifest.exampleCount,
        exhaustiveBookCoverage: false,
      },
    },
    words: rows.map((row) => ({
      id: row.wordId,
      lemma: row.normalizedLemma,
      normalizedLemma: row.normalizedLemma,
      sourceRef: 'synthetic',
      contentVersion: 'synthetic',
      status: 'published',
    })),
    rawSenses: [],
    learningSenses: rows.flatMap((row) =>
      row.senses.map(({ sourceBindings, examples, ...sense }) => sense),
    ),
    bindings: rows.flatMap((row) => row.senses.flatMap((sense) => sense.sourceBindings)),
    examples: rows.flatMap((row) => row.senses.flatMap((sense) => sense.examples)),
  };
  // Source identities need their real source bytes. For this independent checker
  // self-test, explicit source fixtures replace only those hash fields and the
  // derived meaning digest in both the expected bundle and the synthetic DB.
  const sourceIds = new Set();
  for (const binding of data.bindings) {
    if (!sourceIds.has(binding.sourceSenseId)) {
      data.rawSenses.push({
        id: binding.sourceSenseId,
        wordId: binding.wordId,
        pos: 'n.',
        definitionZh: '合成源',
        definitionEn: 'Synthetic source.',
        exampleZh: '',
        exampleEn: '',
        ordinal: 0,
      });
      sourceIds.add(binding.sourceSenseId);
    }
    binding.sourcePosSha256 = sha('n.');
    binding.sourceDefinitionZhSha256 = sha('合成源');
    binding.sourceDefinitionEnSha256 = sha('Synthetic source.');
  }
  for (const row of rows) for (const sense of row.senses) sense.bindingHash = meaningHash(sense);
  for (const sense of data.learningSenses)
    sense.bindingHash = rows
      .flatMap((row) => row.senses)
      .find((item) => item.id === sense.id).bindingHash;
  const baseline = sourceSnapshot(data);
  assert.equal(verifyLearningSenses(data, bundle, baseline).learningSenses, manifest.senseCount);
  const collectionDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nightstudy-sense-collection-'),
  );
  try {
    const leafFile = new URL('../data/learning-senses-v1.manifest.json', import.meta.url);
    const leafBytes = fs.readFileSync(leafFile);
    const leafName = 'learning-senses-v1.manifest.json';
    fs.writeFileSync(path.join(collectionDirectory, leafName), leafBytes);
    fs.copyFileSync(
      new URL('../data/' + manifest.fileName, import.meta.url),
      path.join(collectionDirectory, manifest.fileName),
    );
    const collection = {
      formatVersion: 2,
      kind: 'learning-senses-collection',
      id: 'learning-senses-collection-test',
      version: 'test',
      sourceExportSha256: manifest.sourceExportSha256,
      bilingualOverlaySha256: manifest.bilingualOverlaySha256,
      requiredWordCount: rows.length,
      wordCount: rows.length,
      senseCount: manifest.senseCount,
      exampleCount: manifest.exampleCount,
      editorialReview: 'codex-reviewed',
      semanticQualityCertified: false,
      exhaustiveBookCoverage: false,
      requiredWordsSha256: sha(
        canonical(
          rows
            .map(({ wordId, normalizedLemma }) => ({ wordId, normalizedLemma }))
            .sort((a, b) => (a.wordId < b.wordId ? -1 : 1)),
        ),
      ),
      shards: [
        {
          id: manifest.id,
          manifestFileName: leafName,
          bytes: leafBytes.length,
          sha256: sha(leafBytes),
          wordCount: manifest.wordCount,
          senseCount: manifest.senseCount,
          exampleCount: manifest.exampleCount,
        },
      ],
    };
    const collectionFile = path.join(collectionDirectory, 'collection.json');
    const write = () => fs.writeFileSync(collectionFile, JSON.stringify(collection));
    write();
    const all = readLearningSensesBundle(collectionFile);
    // The read-side pin test uses real bytes; DB assertions retain the explicit synthetic source fixture above.
    const fixtureCollection = { ...all, rows };
    assert.equal(
      verifyLearningSenses({ ...data, packs: [data.pack] }, fixtureCollection, baseline).words,
      rows.length,
    );
    assert.throws(() => verifyLearningSenses({ ...data, packs: [] }, all), /installed_pin/);
    collection.requiredWordsSha256 = '0'.repeat(64);
    write();
    assert.throws(() => readLearningSensesBundle(collectionFile), /required_union/);
    collection.shards[0].sha256 = '0'.repeat(64);
    write();
    assert.throws(() => readLearningSensesBundle(collectionFile), /shard_checksum/);
    collection.shards[0].manifestFileName = '../learning-senses-v1.manifest.json';
    write();
    assert.throws(() => readLearningSensesBundle(collectionFile), /shard_identity/);
    assert.throws(() => readLearningSensesBundle(leafFile, { remaining: 1 }));
  } finally {
    fs.rmSync(collectionDirectory, { recursive: true, force: true });
  }
  let changed = structuredClone(data);
  changed.rawSenses[0].pos = 'v.';
  assert.throws(() => verifyLearningSenses(changed, bundle), /source_byte_drift/);
  changed = structuredClone(data);
  changed.bindings[0].wordId = 'another-word';
  assert.throws(() => verifyLearningSenses(changed, bundle), /binding_changed|cross_word/);
  changed = structuredClone(data);
  changed.examples[0].exampleZh += '改';
  assert.throws(() => verifyLearningSenses(changed, bundle), /example_changed/);
  changed = structuredClone(data);
  changed.words[0].lemma += '-changed';
  assert.throws(() => verifyLearningSenses(changed, bundle, baseline), /source_identity_changed/);
  changed = structuredClone(data);
  changed.siteId = 'wrong-realm';
  assert.throws(() => verifyLearningSenses(changed, bundle), /realm_mismatch/);
  const scratch = fs.mkdtempSync(
    path.join(process.env.TMPDIR || os.tmpdir(), 'nightstudy-meaning-check-'),
  );
  try {
    const selected = [{ ...rows[0], senses: [rows[0].senses[0]] }];
    let audio = await verifyLearningSentenceAudio(selected, [], scratch);
    assert.equal(audio.missingCount, 4);
    assert.equal(audio.readyTargets, 0);
    const payload = Buffer.alloc(128, 7);
    fs.writeFileSync(path.join(scratch, 'valid.mp3'), payload);
    const audioRows = selected[0].senses[0].examples.flatMap((example) =>
      ['US', 'UK'].map((accent) => ({
        textHash: example.contentMetadata.textHash,
        text: example.exampleEn,
        accent,
        status: 'ready',
        kind: 'synthesized',
        fileKey: 'valid.mp3',
        fileSha256: sha(payload),
        mimeType: 'audio/mpeg',
        sourceName: 'Synthetic verification fixture',
        sourceUrl: 'https://example.invalid/synthetic-fixture',
        license: 'MIT',
        attribution: 'Original synthetic fixture; no real speech recording.',
      })),
    );
    audio = await verifyLearningSentenceAudio(selected, audioRows, scratch);
    assert.equal(audio.readyTargets, 4);
    assert.equal(audio.verifiedFiles, 1);
    const firstExample = selected[0].senses[0].examples[0];
    const hold = {
      textHash: firstExample.contentMetadata.textHash,
      accent: 'UK',
      text: normalizeAudioText(firstExample.exampleEn),
      learningSenseId: selected[0].senses[0].id,
      exampleId: firstExample.id,
    };
    const policy = {
      entries: [hold],
      byIdentity: new Map([[sentenceAudioIdentity(hold.textHash, 'UK'), hold]]),
    };
    const unavailable = audioRows.map((row) =>
      row.textHash === hold.textHash && row.accent === 'UK' ? { ...row, status: 'held' } : row,
    );
    audio = await verifyLearningSentenceAudio(selected, unavailable, scratch, policy);
    assert.equal(audio.readyTargets, 3);
    assert.equal(audio.heldTargets, 1);
    assert.equal(audio.accountedTargets, 4);
    assert.equal(audio.missingCount, 0);
    assert.equal(audio.integrityProblemCount, 0);
    audio = await verifyLearningSentenceAudio(selected, audioRows, scratch, policy);
    assert.equal(audio.integrityProblemCount, 1);
    assert.equal(audio.heldTargets, 0);
    assert.equal(audio.problems[0].error, 'held_sentence_audio_ready');
    audio = await verifyLearningSentenceAudio(
      selected,
      unavailable.filter((row) => !(row.textHash === hold.textHash && row.accent === 'US')),
      scratch,
      policy,
    );
    assert.equal(audio.heldTargets, 1);
    assert.equal(audio.missingCount, 1);
    await assert.rejects(
      verifyLearningSentenceAudio(selected, unavailable, scratch, {
        entries: [{ ...hold, exampleId: 'wrong-example' }],
        byIdentity: policy.byIdentity,
      }),
      /meaning_mismatch/,
    );
    await assert.rejects(
      verifyLearningSentenceAudio(selected, unavailable, scratch, {
        entries: [{ ...hold, textHash: '0'.repeat(64) }],
        byIdentity: policy.byIdentity,
      }),
      /scope_missing/,
    );
    fs.writeFileSync(path.join(scratch, 'corrupt.mp3'), Buffer.alloc(128, 8));
    audioRows[1].fileKey = 'corrupt.mp3';
    audio = await verifyLearningSentenceAudio(selected, audioRows, scratch);
    assert.equal(audio.integrityProblemCount, 1);
    audioRows[1].fileKey = 'valid.mp3';
    audioRows[1].license = '';
    audio = await verifyLearningSentenceAudio(selected, audioRows, scratch);
    assert.equal(audio.integrityProblemCount, 1);
    assert.equal(audio.readyTargets, 3);
    audioRows[1].fileKey = '../outside.mp3';
    audio = await verifyLearningSentenceAudio(selected, audioRows, scratch);
    assert.equal(audio.integrityProblemCount, 1);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  assert.throws(() => verificationSites({}, {}), /explicit_database_selection_required/);
  assert.deepEqual(
    verificationSites(
      { 'single-site': 'default' },
      { DATABASE_URL: 'postgresql://fixture.invalid/explicit' },
    ),
    [{ id: 'default', databaseUrl: 'postgresql://fixture.invalid/explicit', test: false }],
  );
  assert.throws(
    () => verificationSites({ 'single-site': 'default', 'test-database-env': 'FIXTURE_DB' }, {}),
    /choose_one_database_selection_mode/,
  );
  assert.throws(
    () => verificationSites({ 'single-site': 'default', 'sites-file': 'fixture.json' }, {}),
    /choose_one_database_selection_mode/,
  );
  assert.throws(
    () => verificationSites({ 'single-site': 'another' }, {}),
    /single_site_must_be_default/,
  );
  assert.throws(
    () => verificationSites({ 'single-site': 'default' }, {}),
    /single_site_database_url_missing/,
  );
  return {
    checks: 35,
    realPackWords: manifest.wordCount,
    realPackMeanings: manifest.senseCount,
    realPackExamples: manifest.exampleCount,
  };
}

export function verificationSites(values, environment = process.env) {
  const explicitMode = values['single-site'] || values['test-database-env'] || values['sites-file'];
  const filename = values['sites-file'] || (!explicitMode ? environment.SITES_FILE : undefined);
  const modes = [
    Boolean(values['single-site']),
    Boolean(values['test-database-env']),
    Boolean(filename),
  ].filter(Boolean).length;
  check(modes > 0, 'explicit_database_selection_required');
  check(modes === 1, 'choose_one_database_selection_mode');
  if (values['single-site']) {
    check(
      values['single-site'] === 'default' && (!values.site || values.site === 'default'),
      'single_site_must_be_default',
    );
    check(environment.DATABASE_URL, 'single_site_database_url_missing');
    return [{ id: 'default', databaseUrl: environment.DATABASE_URL, test: false }];
  }
  if (values['test-database-env']) {
    check(/^[A-Z][A-Z0-9_]*$/.test(values['test-database-env']), 'invalid_test_database_env_name');
    const databaseUrl = environment[values['test-database-env']];
    check(
      databaseUrl && new URL(databaseUrl).pathname.endsWith('_test'),
      'test_database_name_required',
    );
    return [{ id: values.site || null, databaseUrl, test: true }];
  }
  const configured = JSON.parse(fs.readFileSync(filename, 'utf8'));
  check(
    Array.isArray(configured) && configured.length > 0 && configured.length <= 100,
    'invalid_sites_file',
  );
  const sites = configured
    .filter((site) => !values.site || site.id === values.site)
    .map((site) => {
      check(
        typeof site.id === 'string' &&
          /^[a-z0-9][a-z0-9-]{0,47}$/.test(site.id) &&
          /^[A-Z][A-Z0-9_]*$/.test(site.databaseUrlEnv),
        'invalid_site_database_binding',
      );
      const databaseUrl = environment[site.databaseUrlEnv];
      check(databaseUrl, 'site_database_env_missing');
      return { id: site.id, databaseUrl, test: false };
    });
  check(sites.length > 0, 'no_matching_sites');
  return sites;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'self-test': { type: 'boolean' },
      'single-site': { type: 'string' },
      'test-database-env': { type: 'string' },
      'sites-file': { type: 'string' },
      site: { type: 'string' },
      manifest: { type: 'string' },
      snapshot: { type: 'string' },
      baseline: { type: 'string' },
      audio: { type: 'boolean' },
      'audio-root': { type: 'string' },
    },
    strict: true,
  });
  if (values['self-test']) {
    console.log(JSON.stringify({ ok: true, mode: 'self-test', ...(await selfTest()) }));
    return;
  }
  check(
    !(values.snapshot && (values.baseline || values.audio)),
    'snapshot_verification_flags_are_exclusive',
  );
  const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
  const policy = values.audio ? readSentenceAudioPolicy(dataDirectory) : emptySentenceAudioPolicy();
  const manifestFile =
    values.manifest ||
    (policy.manifest
      ? path.join(dataDirectory, policy.manifest.learningSensesManifestFileName)
      : undefined);
  if (values.audio && policy.manifest)
    check(
      sha(pinnedFile(manifestFile, 1024 * 1024)) === policy.manifest.learningSensesManifestSha256,
      'sentence_audio_policy_verification_manifest_mismatch',
    );
  const bundle = readLearningSensesBundle(manifestFile);
  if (values.audio)
    bindSentenceAudioHoldReferences(policy, learningSentenceAudioTargets(bundle.rows));
  const sites = verificationSites(values);
  const { Client } = await import('pg');
  const baseline = values.baseline ? JSON.parse(fs.readFileSync(values.baseline, 'utf8')) : null;
  if (baseline)
    check(
      baseline.formatVersion === 1 && baseline.sites && typeof baseline.sites === 'object',
      'learning_senses_invalid_baseline',
    );
  const snapshots = { formatVersion: 1, sites: {} };
  const summaries = [];
  for (const site of sites) {
    const client = new Client({
      connectionString: site.databaseUrl,
      connectionTimeoutMillis: 10000,
    });
    await client.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='30s'");
      const state = (
        await client.query(`SELECT "siteId","instanceId" FROM "SiteState" WHERE id='singleton'`)
      ).rows[0];
      check(
        state && ((site.test && !site.id) || state.siteId === site.id),
        'learning_senses_realm_mismatch',
      );
      const wordIds = bundle.rows.map((row) => row.wordId);
      const meaningIds = bundle.rows.flatMap((row) => row.senses.map((sense) => sense.id));
      const data = {
        siteId: state.siteId,
        expectedSiteId: site.id || state.siteId,
        instanceId: state.instanceId,
        pack: (await client.query(`SELECT * FROM "ContentPack" WHERE id=$1`, [bundle.manifest.id]))
          .rows[0],
        packs: bundle.bundles
          ? (
              await client.query(`SELECT * FROM "ContentPack" WHERE id=ANY($1::text[])`, [
                bundle.bundles.map((leaf) => leaf.manifest.id),
              ])
            ).rows
          : undefined,
        words: (
          await client.query(
            `SELECT id,lemma,"normalizedLemma","sourceRef","contentVersion",status FROM "Word" WHERE id=ANY($1::text[])`,
            [wordIds],
          )
        ).rows,
        rawSenses: (
          await client.query(
            `SELECT id,"wordId",pos,"definitionZh","definitionEn","exampleZh","exampleEn",ordinal,"contentMetadata" FROM "Sense" WHERE "wordId"=ANY($1::text[])`,
            [wordIds],
          )
        ).rows,
        learningSenses: (
          await client.query(`SELECT * FROM "LearningSense" WHERE id=ANY($1::text[])`, [meaningIds])
        ).rows,
        bindings: (
          await client.query(
            `SELECT * FROM "SenseSourceBinding" WHERE "learningSenseId"=ANY($1::text[])`,
            [meaningIds],
          )
        ).rows,
        examples: (
          await client.query(
            `SELECT * FROM "WordExample" WHERE "learningSenseId"=ANY($1::text[])`,
            [meaningIds],
          )
        ).rows,
      };
      if (values.snapshot) {
        check(
          data.words.length === bundle.manifest.wordCount,
          'learning_senses_snapshot_scope_incomplete',
        );
        const sourceById = new Map(data.rawSenses.map((sense) => [sense.id, sense]));
        const newById = new Map(additionsOf(bundle).map((source) => [source.id, source]));
        for (const row of bundle.rows)
          for (const sense of row.senses)
            for (const binding of sense.sourceBindings) {
              const raw =
                sourceById.get(binding.sourceSenseId) ?? newById.get(binding.sourceSenseId);
              check(
                raw?.wordId === row.wordId &&
                  sha(raw.pos) === binding.sourcePosSha256 &&
                  sha(raw.definitionZh) === binding.sourceDefinitionZhSha256 &&
                  sha(raw.definitionEn) === binding.sourceDefinitionEnSha256,
                'learning_senses_snapshot_source_drift',
              );
            }
        for (const source of additionsOf(bundle))
          if (sourceById.has(source.id)) {
            const { normalizedLemma, ...record } = source;
            exactRecord(
              sourceById.get(source.id),
              record,
              'learning_senses_snapshot_new_source_changed',
            );
          }
        snapshots.sites[state.siteId] = sourceSnapshot(data, additionsOf(bundle));
        summaries.push({
          siteId: state.siteId,
          snapshotWords: data.words.length,
          snapshotSourceSenses: data.rawSenses.length,
        });
      } else {
        if (baseline) check(baseline.sites[state.siteId], 'learning_senses_baseline_site_missing');
        const summary = verifyLearningSenses(data, bundle, baseline?.sites?.[state.siteId]);
        let audio = { checked: false, missingCount: null };
        if (values.audio) {
          const hashes = bundle.rows.flatMap((row) =>
            row.senses.flatMap((sense) => sense.examples.map((e) => e.contentMetadata.textHash)),
          );
          const audioRows = (
            await client.query(`SELECT * FROM "SentenceAudio" WHERE "textHash"=ANY($1::text[])`, [
              hashes,
            ])
          ).rows;
          audio = await verifyLearningSentenceAudio(
            bundle.rows,
            audioRows,
            values['audio-root'] || process.env.AUDIO_CACHE_DIR || '.local/audio',
            policy,
          );
          if (audio.missingCount || audio.integrityProblemCount) process.exitCode = 1;
        }
        summaries.push({ siteId: state.siteId, ...summary, audio });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
  }
  if (values.snapshot)
    fs.writeFileSync(values.snapshot, JSON.stringify(snapshots, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  console.log(
    JSON.stringify({
      ok: !process.exitCode,
      mode: values.snapshot ? 'source-snapshot' : 'verify',
      sites: summaries,
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          error instanceof VerificationError || error instanceof SentenceAudioPolicyError
            ? error.code
            : 'verification_runtime_failure',
        details: error instanceof VerificationError ? error.details : {},
      }),
    );
    process.exitCode = 1;
  });
}
