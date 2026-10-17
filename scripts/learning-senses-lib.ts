import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Client } from 'pg';
import { z } from 'zod';
import type { SiteConfig } from '../apps/api/src/config.js';
import {
  learningSenseBindingHash,
  learningSenseCanonical,
  learningSenseSourceMatches,
  learningSenseTextHash as hash,
} from '../apps/api/src/modules/learning-sense-integrity.js';
import { normalizeContentLemma } from './content-lib.js';
import { reviewedSenseDisplayLemma } from '../apps/api/src/modules/learning-sense-view.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(200);
const metadata = z.record(z.string(), z.unknown());
const text = z.string().min(1).max(4000);
export const LEARNING_SENSE_MAX_BYTES = 64 * 1024 * 1024;
export const LEARNING_SENSE_MAX_WORDS = 1000;
export const LEARNING_SENSE_COLLECTION_MAX_BYTES = 512 * 1024 * 1024;
export const learningSensePartsOfSpeech = [
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
  'part.',
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
] as const;
const licenseNoticeSchema = z
  .object({
    fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/),
    bytes: z
      .number()
      .int()
      .positive()
      .max(128 * 1024),
    sha256: digest,
  })
  .strict();
const publicLicenses = [
  'MIT',
  'WordNet-3.0',
  'LicenseRef-Chinese-Open-WordNet',
  'CC-BY-2.0-FR',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
] as const;
const fieldSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('original-authoring'),
      license: z.literal('MIT'),
      author: z.string().trim().min(1).max(500),
      textSha256: digest,
    })
    .strict(),
  z
    .object({
      kind: z.enum(['corpus', 'translation']),
      license: z.enum(publicLicenses),
      author: z.string().trim().min(1).max(500),
      attribution: z.string().trim().min(10).max(4000),
      sourceName: z.string().trim().min(1).max(500),
      sourceUrl: z
        .string()
        .url()
        .startsWith('https://')
        .refine((value) => {
          const parsed = new URL(value);
          return !parsed.username && !parsed.password;
        }),
      sourceText: text,
      sourceTextSha256: digest,
      sourceSnapshotSha256: digest,
      licenseNoticeSha256: digest,
      textSha256: digest,
    })
    .strict(),
]);
const bindingSchema = z
  .object({
    id: identity,
    wordId: identity,
    learningSenseId: identity,
    sourceSenseId: identity,
    relation: z.enum(['exact', 'narrower', 'corrected-from']),
    sourcePosSha256: digest,
    sourceDefinitionZhSha256: digest,
    sourceDefinitionEnSha256: digest,
    contentMetadata: metadata,
  })
  .strict();
const sourceAdditionPinSchema = z
  .object({
    fileName: z.string().regex(/^learning-sense-sources-[a-z0-9.-]+\.jsonl\.gz$/),
    bytes: z.number().int().positive().max(LEARNING_SENSE_MAX_BYTES),
    sha256: digest,
    jsonlSha256: digest,
    rowCount: z.number().int().positive().max(1000),
  })
  .strict();
const sourceAdditionSchema = z
  .object({
    id: identity,
    wordId: identity,
    normalizedLemma: z.string().min(1).max(500),
    pos: z.enum(learningSensePartsOfSpeech),
    definitionZh: text,
    definitionEn: text,
    exampleEn: z.literal(''),
    exampleZh: z.literal(''),
    ordinal: z.number().int().min(1000000).max(2147483647),
    contentMetadata: z
      .object({
        kind: z.literal('original-authoring'),
        evidenceKind: z.literal('codex-original-source-addition'),
        author: z.literal('NightStudy contributors'),
        license: z.literal('MIT'),
        authoringMethod: z.literal('Direct Codex bilingual writing'),
        review: z.literal('codex-reviewed'),
        expertCertified: z.literal(false),
        sourceAdditionVersion: z.literal('codex-original-source-v1'),
        semanticKey: z.string().regex(/^[a-z0-9-]+$/),
        definitionZhSha256: digest,
        definitionEnSha256: digest,
        editorialReview: z
          .object({
            decision: z.literal('publish'),
            reviewer: z.literal('Codex'),
            expertCertified: z.literal(false),
            semanticRationale: z.string().min(15).max(4000),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type LearningSenseSourceAddition = z.infer<typeof sourceAdditionSchema>;
const exampleSchema = z
  .object({
    id: identity,
    wordId: identity,
    learningSenseId: identity,
    contextLabel: z.string().trim().min(1).max(200),
    exampleEn: text,
    exampleZh: text,
    ordinal: z.number().int(),
    status: z.literal('published'),
    contentVersion: identity,
    contentMetadata: metadata,
  })
  .strict();
const senseSchema = z
  .object({
    id: identity,
    wordId: identity,
    pos: z.enum(learningSensePartsOfSpeech),
    definitionZh: text,
    definitionEn: text,
    ordinal: z.number().int(),
    status: z.literal('published'),
    contentVersion: identity,
    bindingHash: digest,
    contentMetadata: metadata,
    sourceBindings: z.array(bindingSchema).min(1).max(100),
    examples: z.array(exampleSchema).min(2).max(100),
  })
  .strict();
const rowSchema = z
  .object({
    wordId: identity,
    normalizedLemma: z.string().min(1).max(500),
    senses: z.array(senseSchema).min(1).max(200),
  })
  .strict();
const manifestSchema = z
  .object({
    formatVersion: z.literal(1),
    id: z.string().regex(/^learning-senses-[a-z0-9-]+$/),
    version: identity,
    fileName: z.string().regex(/^[a-z0-9.-]+\.jsonl\.gz$/),
    bytes: z.number().int().positive().max(LEARNING_SENSE_MAX_BYTES),
    sha256: digest,
    jsonlSha256: digest,
    sourceExportSha256: digest,
    bilingualOverlaySha256: digest,
    draftsSha256: digest,
    sourceUrl: z.string().url(),
    license: z.enum(['MIT', 'mixed']),
    licenseNotices: z.array(licenseNoticeSchema).max(100).optional(),
    sourceAdditions: sourceAdditionPinSchema.optional(),
    wordCount: z.number().int().positive().max(LEARNING_SENSE_MAX_WORDS),
    senseCount: z.number().int().positive(),
    exampleCount: z.number().int().positive(),
    scope: text,
    editorialReview: z.literal('codex-reviewed'),
    semanticQualityCertified: z.literal(false),
    activeBookWords: z.number().int().positive(),
    wordsWithCuratedMeanings: z.number().int().positive(),
    wordsAwaitingAtomicReview: z.number().int().nonnegative(),
    totalRemainingAtomicMeaningCount: z.null(),
    wordLevelCandidateCount: z.number().int().nonnegative(),
    exhaustiveBookCoverage: z.literal(false),
  })
  .strict();
export type LearningSensesManifest = z.infer<typeof manifestSchema>;
export type LearningSensesRow = z.infer<typeof rowSchema>;
const collectionSchema = z
  .object({
    formatVersion: z.literal(2),
    kind: z.literal('learning-senses-collection'),
    id: z.string().regex(/^learning-senses-collection-[a-z0-9-]+$/),
    version: identity,
    sourceExportSha256: digest,
    bilingualOverlaySha256: digest,
    requiredWordCount: z.number().int().positive().max(100000),
    requiredWordsSha256: digest,
    wordCount: z.number().int().positive().max(100000),
    senseCount: z.number().int().positive(),
    exampleCount: z.number().int().positive(),
    editorialReview: z.literal('codex-reviewed'),
    semanticQualityCertified: z.literal(false),
    exhaustiveBookCoverage: z.literal(false),
    shards: z
      .array(
        z
          .object({
            manifestFileName: z.string().regex(/^learning-senses-[a-z0-9.-]+\.manifest\.json$/),
            bytes: z
              .number()
              .int()
              .positive()
              .max(1024 * 1024),
            sha256: digest,
            id: z.string().regex(/^learning-senses-[a-z0-9-]+$/),
            wordCount: z.number().int().positive().max(LEARNING_SENSE_MAX_WORDS),
            senseCount: z.number().int().positive(),
            exampleCount: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();
export type LearningSensesCollection = z.infer<typeof collectionSchema>;
export type LearningSensesLeaf = {
  manifest: LearningSensesManifest;
  rows: LearningSensesRow[];
  sourceRows?: LearningSenseSourceAddition[];
};
export type LearningSensesBundle = {
  kind: 'leaf' | 'collection';
  collection?: LearningSensesCollection;
  bundles: LearningSensesLeaf[];
  rows: LearningSensesRow[];
};

function readPinnedFile(filename: string, maximum: number) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum)
    throw new Error('learning_senses_unsafe_or_oversized_file');
  return fs.readFileSync(filename);
}

function equalRows(a: LearningSensesRow[], b: LearningSensesRow[]) {
  // Compare one word at a time rather than allocating a second complete collection JSON string.
  return (
    a.length === b.length &&
    a.every(
      (row, index) =>
        row === b[index] || learningSenseCanonical(row) === learningSenseCanonical(b[index]),
    )
  );
}

export function learningSensesWordUnionHash(
  rows: Pick<LearningSensesRow, 'wordId' | 'normalizedLemma'>[],
) {
  return hash(
    learningSenseCanonical(
      rows
        .map(({ wordId, normalizedLemma }) => ({ wordId, normalizedLemma }))
        .sort((a, b) =>
          a.wordId < b.wordId
            ? -1
            : a.wordId > b.wordId
              ? 1
              : a.normalizedLemma < b.normalizedLemma
                ? -1
                : a.normalizedLemma > b.normalizedLemma
                  ? 1
                  : 0,
        ),
    ),
  );
}

/** Validate the complete pinned collection before any database connection or installation. */
export function validateLearningSensesBundle(bundle: LearningSensesBundle) {
  if (bundle.kind === 'leaf') {
    if (bundle.collection || bundle.bundles.length !== 1)
      throw new Error('learning_senses_invalid_leaf_bundle');
    const leaf = bundle.bundles[0]!;
    validateLearningSensesRows(leaf.rows, leaf.manifest);
    validateLearningSourceAdditions(leaf.sourceRows ?? [], leaf.rows, leaf.manifest);
    if (!equalRows(bundle.rows, leaf.rows)) throw new Error('learning_senses_bundle_rows_mismatch');
    return bundle;
  }
  const collection = collectionSchema.parse(bundle.collection);
  validateCollectionPins(collection);
  if (bundle.bundles.length !== collection.shards.length)
    throw new Error('learning_senses_missing_shard');
  const words = new Set<string>(),
    lemmas = new Set<string>(),
    ids = new Set<string>();
  const manifests = new Set<string>(),
    packIds = new Set<string>();
  let senses = 0,
    examples = 0;
  const rows: LearningSensesRow[] = [];
  for (const [index, leaf] of bundle.bundles.entries()) {
    const pin = collection.shards[index]!;
    const manifest = manifestSchema.parse(leaf.manifest);
    if (manifests.has(pin.manifestFileName) || packIds.has(pin.id))
      throw new Error('learning_senses_duplicate_shard');
    manifests.add(pin.manifestFileName);
    packIds.add(pin.id);
    if (
      pin.id !== manifest.id ||
      pin.wordCount !== manifest.wordCount ||
      pin.senseCount !== manifest.senseCount ||
      pin.exampleCount !== manifest.exampleCount ||
      manifest.sourceExportSha256 !== collection.sourceExportSha256 ||
      manifest.bilingualOverlaySha256 !== collection.bilingualOverlaySha256
    )
      throw new Error('learning_senses_shard_pin_mismatch');
    validateLearningSensesRows(leaf.rows, manifest);
    for (const source of validateLearningSourceAdditions(
      leaf.sourceRows ?? [],
      leaf.rows,
      manifest,
    )) {
      if (ids.has(source.id)) throw new Error('learning_senses_global_duplicate_identity');
      ids.add(source.id);
    }
    for (const row of leaf.rows) {
      if (words.has(row.wordId) || lemmas.has(row.normalizedLemma))
        throw new Error('learning_senses_word_crosses_shards');
      words.add(row.wordId);
      lemmas.add(row.normalizedLemma);
      rows.push(row);
      for (const sense of row.senses) {
        senses++;
        examples += sense.examples.length;
        for (const record of [sense, ...sense.sourceBindings, ...sense.examples]) {
          if (ids.has(record.id)) throw new Error('learning_senses_global_duplicate_identity');
          ids.add(record.id);
        }
      }
    }
  }
  if (
    rows.length !== collection.wordCount ||
    rows.length !== collection.requiredWordCount ||
    senses !== collection.senseCount ||
    examples !== collection.exampleCount ||
    learningSensesWordUnionHash(rows) !== collection.requiredWordsSha256
  )
    throw new Error('learning_senses_collection_union_mismatch');
  if (!equalRows(bundle.rows, rows)) throw new Error('learning_senses_bundle_rows_mismatch');
  return bundle;
}

export function loadLearningSensesBundle(manifestPath: string | URL): LearningSensesBundle {
  const filename =
    manifestPath instanceof URL ? fileURLToPath(manifestPath) : path.resolve(manifestPath);
  const raw = readPinnedFile(filename, 1024 * 1024);
  const input = JSON.parse(raw.toString('utf8'));
  if (input.formatVersion === 1) {
    const leaf = loadLearningSensesFiles(filename);
    return validateLearningSensesBundle({ kind: 'leaf', bundles: [leaf], rows: leaf.rows });
  }
  const collection = collectionSchema.parse(input);
  validateCollectionPins(collection);
  const budget = { remaining: LEARNING_SENSE_COLLECTION_MAX_BYTES };
  const bundles = collection.shards.map((pin) => {
    const shardFilename = path.join(path.dirname(filename), pin.manifestFileName);
    const bytes = readPinnedFile(shardFilename, 1024 * 1024);
    if (bytes.length !== pin.bytes || bufferHash(bytes) !== pin.sha256)
      throw new Error('learning_senses_shard_manifest_checksum');
    return loadLearningSensesFiles(shardFilename, budget);
  });
  return validateLearningSensesBundle({
    kind: 'collection',
    collection,
    bundles,
    rows: bundles.flatMap((b) => b.rows),
  });
}

function validateCollectionPins(collection: LearningSensesCollection) {
  if (
    collection.wordCount !== collection.requiredWordCount ||
    collection.shards.reduce((n, s) => n + s.wordCount, 0) !== collection.wordCount ||
    collection.shards.reduce((n, s) => n + s.senseCount, 0) !== collection.senseCount ||
    collection.shards.reduce((n, s) => n + s.exampleCount, 0) !== collection.exampleCount
  )
    throw new Error('learning_senses_collection_pin_totals_mismatch');
  if (
    new Set(collection.shards.map((s) => s.id)).size !== collection.shards.length ||
    new Set(collection.shards.map((s) => s.manifestFileName)).size !== collection.shards.length
  )
    throw new Error('learning_senses_duplicate_shard');
}

export function loadLearningSensesManifest(
  path: string | URL = new URL('../data/learning-senses-v1.manifest.json', import.meta.url),
) {
  const filename = path instanceof URL ? fileURLToPath(path) : path;
  return manifestSchema.parse(JSON.parse(readPinnedFile(filename, 1024 * 1024).toString('utf8')));
}

export function loadLearningSensesFiles(
  manifestPath: string | URL = new URL('../data/learning-senses-v1.manifest.json', import.meta.url),
  budget?: { remaining: number },
) {
  const filename =
    manifestPath instanceof URL ? fileURLToPath(manifestPath) : path.resolve(manifestPath);
  const manifest = loadLearningSensesManifest(filename);
  const bytes = readPinnedFile(
    path.join(path.dirname(filename), manifest.fileName),
    LEARNING_SENSE_MAX_BYTES,
  );
  for (const notice of manifest.licenseNotices ?? []) {
    const noticeBytes = readPinnedFile(
      path.join(path.dirname(filename), notice.fileName),
      128 * 1024,
    );
    if (noticeBytes.length !== notice.bytes || bufferHash(noticeBytes) !== notice.sha256)
      throw new Error('learning_senses_license_notice_checksum');
  }
  const leafBudget = { remaining: LEARNING_SENSE_MAX_BYTES };
  const rows = readLearningSensesRows(bytes, manifest, leafBudget);
  if (budget && (budget.remaining -= LEARNING_SENSE_MAX_BYTES - leafBudget.remaining) < 0)
    throw new Error('learning_senses_collection_decoded_limit');
  let sourceRows: LearningSenseSourceAddition[] | undefined;
  if (manifest.sourceAdditions) {
    const pin = manifest.sourceAdditions;
    const packed = readPinnedFile(
      path.join(path.dirname(filename), pin.fileName),
      LEARNING_SENSE_MAX_BYTES,
    );
    if (packed.length !== pin.bytes || bufferHash(packed) !== pin.sha256)
      throw new Error('learning_senses_source_additions_checksum');
    if (leafBudget.remaining <= 0 || (budget && budget.remaining <= 0))
      throw new Error('learning_senses_source_additions_decoded_limit');
    const decoded = gunzipSync(packed, {
      maxOutputLength: Math.min(
        leafBudget.remaining,
        budget?.remaining ?? LEARNING_SENSE_MAX_BYTES,
      ),
    });
    if (budget) budget.remaining -= decoded.length;
    if (bufferHash(decoded) !== pin.jsonlSha256)
      throw new Error('learning_senses_source_additions_jsonl_checksum');
    sourceRows = new TextDecoder('utf-8', { fatal: true })
      .decode(decoded)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  validateLearningSourceAdditions(sourceRows ?? [], rows, manifest);
  return { manifest, rows, ...(sourceRows ? { sourceRows } : {}) };
}

/** Original Codex-authored source rows are explicit evidence of authorship, never external verification. */
export function validateLearningSourceAdditions(
  input: unknown,
  rows: LearningSensesRow[],
  manifest: LearningSensesManifest,
) {
  const additions = z.array(sourceAdditionSchema).max(1000).parse(input);
  if ((manifest.sourceAdditions?.rowCount ?? 0) !== additions.length)
    throw new Error('learning_senses_source_additions_count');
  const words = new Map(rows.map((row) => [row.wordId, row.normalizedLemma]));
  const sources = new Map<string, LearningSenseSourceAddition>();
  const used = new Set<string>();
  for (const source of additions) {
    const meta = source.contentMetadata;
    if (
      source.id !== 'learning-source-' + hash(source.wordId + '\0' + meta.semanticKey) ||
      sources.has(source.id) ||
      normalizeContentLemma(source.normalizedLemma) !== source.normalizedLemma ||
      words.get(source.wordId) !== source.normalizedLemma ||
      source.ordinal !== 1000000 + parseInt(hash(meta.semanticKey).slice(0, 7), 16) ||
      !/[\u4e00-\u9fff]/u.test(source.definitionZh) ||
      !/[a-z]/iu.test(source.definitionEn) ||
      /[\u4e00-\u9fff]/u.test(source.definitionEn) ||
      meta.definitionZhSha256 !== hash(source.definitionZh) ||
      meta.definitionEnSha256 !== hash(source.definitionEn)
    )
      throw new Error('learning_senses_invalid_original_source_addition');
    sources.set(source.id, source);
  }
  for (const row of rows)
    for (const sense of row.senses)
      for (const binding of sense.sourceBindings) {
        const source = sources.get(binding.sourceSenseId);
        if (source) {
          if (!learningSenseSourceMatches(binding, source))
            throw new Error('learning_senses_source_addition_binding_drift');
          used.add(source.id);
        } else if (binding.sourceSenseId.startsWith('learning-source-'))
          throw new Error('learning_senses_missing_original_source_addition');
      }
  if (used.size !== sources.size)
    throw new Error('learning_senses_unbound_original_source_addition');
  return additions;
}

function validateFieldSources(
  meta: Record<string, unknown>,
  fields: Record<string, string>,
  manifest: LearningSensesManifest,
) {
  if (meta.kind === 'original-authoring') {
    if (meta.license !== 'MIT' || meta.fieldSources !== undefined)
      throw new Error('learning_senses_invalid_original_license');
    return;
  }
  if (
    meta.kind !== 'reviewed-public-content' ||
    meta.license !== 'mixed' ||
    manifest.license !== 'mixed'
  )
    throw new Error('learning_senses_missing_public_provenance');
  const sources = z.record(z.string(), fieldSourceSchema).parse(meta.fieldSources);
  if (Object.keys(sources).sort().join(',') !== Object.keys(fields).sort().join(','))
    throw new Error('learning_senses_missing_field_provenance');
  const notices = new Set((manifest.licenseNotices ?? []).map((n) => n.sha256));
  let publicFields = 0;
  for (const [field, source] of Object.entries(sources)) {
    if (source.textSha256 !== hash(fields[field]!))
      throw new Error('learning_senses_public_text_changed');
    if (source.kind === 'original-authoring') continue;
    publicFields++;
    if (
      !notices.has(source.licenseNoticeSha256) ||
      hash(source.sourceText) !== source.sourceTextSha256 ||
      (source.kind === 'corpus' && source.sourceText !== fields[field])
    )
      throw new Error('learning_senses_public_source_or_notice_mismatch');
  }
  if (!publicFields) throw new Error('learning_senses_public_provenance_without_public_field');
}

export function validateLearningSensesRows(
  input: unknown,
  manifest: LearningSensesManifest,
): LearningSensesRow[] {
  manifest = manifestSchema.parse(manifest);
  const notices = manifest.licenseNotices ?? [];
  if (
    new Set(notices.map((n) => n.fileName)).size !== notices.length ||
    new Set(notices.map((n) => n.sha256)).size !== notices.length
  )
    throw new Error('learning_senses_duplicate_license_notice');
  const rows = z.array(rowSchema).parse(input);
  const ids = new Set<string>();
  const lemmas = new Set<string>();
  const wordIds = new Set<string>();
  let senses = 0;
  let examples = 0;
  const reserve = (id: string) => {
    if (ids.has(id)) throw new Error('learning_senses_duplicate_identity');
    ids.add(id);
  };
  for (const row of rows) {
    if (
      normalizeContentLemma(row.normalizedLemma) !== row.normalizedLemma ||
      lemmas.has(row.normalizedLemma) ||
      wordIds.has(row.wordId)
    )
      throw new Error('learning_senses_duplicate_or_unnormalized_word');
    lemmas.add(row.normalizedLemma);
    wordIds.add(row.wordId);
    const sentenceHashes = new Set<string>();
    for (const sense of row.senses) {
      reserve(sense.id);
      senses++;
      if (
        sense.wordId !== row.wordId ||
        sense.contentVersion !== manifest.version ||
        !/[\u4e00-\u9fff]/u.test(sense.definitionZh) ||
        !/[a-z]/iu.test(sense.definitionEn) ||
        /[\u4e00-\u9fff]/u.test(sense.definitionEn)
      )
        throw new Error('learning_senses_invalid_meaning_identity');
      if (sense.bindingHash !== learningSenseBindingHash(sense))
        throw new Error('learning_senses_binding_hash_mismatch');
      if (
        sense.contentMetadata.orthography !== undefined &&
        !reviewedSenseDisplayLemma(sense, row.normalizedLemma)
      )
        throw new Error('learning_senses_invalid_reviewed_orthography');
      const review = sense.contentMetadata.editorialReview as Record<string, unknown> | undefined;
      if (
        sense.contentMetadata.review !== 'codex-reviewed' ||
        sense.contentMetadata.expertCertified !== false ||
        review?.reviewer !== 'Codex' ||
        review?.decision !== 'publish' ||
        review?.expertCertified !== false ||
        typeof review?.semanticRationale !== 'string' ||
        review.semanticRationale.length < 15
      )
        throw new Error('learning_senses_missing_semantic_review');
      validateFieldSources(
        sense.contentMetadata,
        { definitionZh: sense.definitionZh, definitionEn: sense.definitionEn },
        manifest,
      );
      const sourceIds = new Set<string>();
      for (const binding of sense.sourceBindings) {
        reserve(binding.id);
        if (
          binding.wordId !== row.wordId ||
          binding.learningSenseId !== sense.id ||
          sourceIds.has(binding.sourceSenseId)
        )
          throw new Error('learning_senses_cross_word_or_duplicate_binding');
        sourceIds.add(binding.sourceSenseId);
        if (
          typeof binding.contentMetadata.reason !== 'string' ||
          binding.contentMetadata.reason.length < 10
        )
          throw new Error('learning_senses_missing_binding_review');
      }
      const contexts = new Set<string>();
      const ordinals = new Set<number>();
      for (const example of sense.examples) {
        reserve(example.id);
        examples++;
        if (
          example.wordId !== row.wordId ||
          example.learningSenseId !== sense.id ||
          example.contentVersion !== manifest.version ||
          ordinals.has(example.ordinal)
        )
          throw new Error('learning_senses_cross_word_or_duplicate_example');
        ordinals.add(example.ordinal);
        contexts.add(example.contextLabel);
        const meta = example.contentMetadata;
        const surface = meta.targetSurface as Record<string, unknown> | undefined;
        if (
          meta.review !== 'codex-reviewed' ||
          meta.expertCertified !== false ||
          typeof meta.semanticRationale !== 'string' ||
          meta.semanticRationale.length < 15 ||
          meta.exampleEnSha256 !== hash(example.exampleEn) ||
          meta.exampleZhSha256 !== hash(example.exampleZh)
        )
          throw new Error('learning_senses_missing_example_review');
        validateFieldSources(
          meta,
          { exampleEn: example.exampleEn, exampleZh: example.exampleZh },
          manifest,
        );
        if (!/[\u4e00-\u9fff]/u.test(example.exampleZh) || !/[a-z]/iu.test(example.exampleEn))
          throw new Error('learning_senses_invalid_example_pair');
        if (
          surface?.lemma !== row.normalizedLemma ||
          typeof surface.form !== 'string' ||
          surface.review !== 'codex-reviewed' ||
          ![
            'exact',
            'inflected-form',
            'pronoun-slot',
            'object-insertion',
            'punctuation-variant',
          ].includes(String(surface.kind)) ||
          (surface.kind === 'exact' && surface.form !== row.normalizedLemma)
        )
          throw new Error('learning_senses_unreviewed_surface');
        if (
          surface.kind === 'punctuation-variant' &&
          (!/^[A-Za-z]+(?:\.[A-Za-z]+)*\.?$/u.test(surface.form) ||
            !/^[A-Za-z]+(?:\.[A-Za-z]+)*\.?$/u.test(row.normalizedLemma) ||
            surface.form.toLowerCase() === row.normalizedLemma.toLowerCase() ||
            surface.form.replaceAll('.', '').toLowerCase() !==
              row.normalizedLemma.replaceAll('.', '').toLowerCase())
        )
          throw new Error('learning_senses_invalid_punctuation_variant');
        const escaped = surface.form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (
          !new RegExp(`(?<![\\p{L}\\p{M}])${escaped}(?![\\p{L}\\p{M}])`, 'iu').test(
            example.exampleEn,
          )
        )
          throw new Error('learning_senses_target_absent');
        const textHash = hash(
          example.exampleEn
            .normalize('NFKC')
            .replace(/[‘’]/g, "'")
            .replace(/[“”]/g, '"')
            .replace(/\s+/gu, ' ')
            .trim(),
        );
        if (meta.textHash !== textHash || sentenceHashes.has(textHash))
          throw new Error('learning_senses_duplicate_or_changed_sentence');
        sentenceHashes.add(textHash);
      }
      if (contexts.size < 2) throw new Error('learning_senses_two_contexts_required');
    }
  }
  if (
    rows.length !== manifest.wordCount ||
    senses !== manifest.senseCount ||
    examples !== manifest.exampleCount ||
    manifest.wordsWithCuratedMeanings !== rows.length ||
    manifest.wordsAwaitingAtomicReview + rows.length !== manifest.activeBookWords
  )
    throw new Error('learning_senses_count_mismatch');
  return rows;
}

export function readLearningSensesRows(
  bytes: Buffer,
  manifest: LearningSensesManifest,
  budget?: { remaining: number },
): LearningSensesRow[] {
  if (bytes.length !== manifest.bytes || bufferHash(bytes) !== manifest.sha256)
    throw new Error('learning_senses_pack_checksum_mismatch');
  const decoded = gunzipSync(bytes, { maxOutputLength: LEARNING_SENSE_MAX_BYTES });
  if (budget && (budget.remaining -= decoded.length) < 0)
    throw new Error('learning_senses_collection_decoded_limit');
  if (bufferHash(decoded) !== manifest.jsonlSha256)
    throw new Error('learning_senses_jsonl_checksum_mismatch');
  const input = new TextDecoder('utf-8', { fatal: true })
    .decode(decoded)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return validateLearningSensesRows(input, manifest);
}

const bufferHash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

async function importLearningSensesRowsInTransaction(
  site: Pick<SiteConfig, 'id' | 'databaseUrl'>,
  input: LearningSensesRow[],
  manifest: LearningSensesManifest,
  client: Client,
  sourceRows: LearningSenseSourceAddition[] = [],
) {
  const rows = validateLearningSensesRows(input, manifest);
  const additions = validateLearningSourceAdditions(sourceRows, rows, manifest);
  const result = {
    siteId: site.id,
    packId: manifest.id,
    alreadyInstalled: false,
    words: rows.length,
    insertedSenses: 0,
    insertedBindings: 0,
    insertedExamples: 0,
    insertedSourceSenses: 0,
  };
  const same = (actual: Record<string, unknown>, expected: Record<string, unknown>) =>
    Object.keys(expected).every(
      (key) => learningSenseCanonical(actual[key]) === learningSenseCanonical(expected[key]),
    );
  async function insertExact(
    table: 'Sense' | 'LearningSense' | 'SenseSourceBinding' | 'WordExample',
    records: Record<string, unknown>[],
    replay: boolean,
  ) {
    const columns = {
      Sense: {
        id: 'TEXT',
        wordId: 'TEXT',
        pos: 'TEXT',
        definitionZh: 'TEXT',
        definitionEn: 'TEXT',
        exampleEn: 'TEXT',
        exampleZh: 'TEXT',
        ordinal: 'INT',
        contentMetadata: 'JSONB',
      },
      LearningSense: {
        id: 'TEXT',
        wordId: 'TEXT',
        pos: 'TEXT',
        definitionZh: 'TEXT',
        definitionEn: 'TEXT',
        ordinal: 'INT',
        status: 'TEXT',
        contentVersion: 'TEXT',
        bindingHash: 'TEXT',
        contentMetadata: 'JSONB',
      },
      SenseSourceBinding: {
        id: 'TEXT',
        wordId: 'TEXT',
        learningSenseId: 'TEXT',
        sourceSenseId: 'TEXT',
        relation: 'TEXT',
        sourcePosSha256: 'TEXT',
        sourceDefinitionZhSha256: 'TEXT',
        sourceDefinitionEnSha256: 'TEXT',
        contentMetadata: 'JSONB',
      },
      WordExample: {
        id: 'TEXT',
        wordId: 'TEXT',
        learningSenseId: 'TEXT',
        contextLabel: 'TEXT',
        exampleEn: 'TEXT',
        exampleZh: 'TEXT',
        ordinal: 'INT',
        status: 'TEXT',
        contentVersion: 'TEXT',
        contentMetadata: 'JSONB',
      },
    }[table];
    const keys = Object.keys(columns);
    let inserted = 0;
    for (let start = 0; start < records.length; start += 1000) {
      const chunk = records.slice(start, start + 1000);
      const previous = await client.query(
        `SELECT * FROM "${table}" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`,
        [chunk.map((data) => data.id)],
      );
      const existing = new Map(previous.rows.map((row) => [row.id, row]));
      const pending = [];
      for (const data of chunk) {
        const row = existing.get(data.id);
        if (row) {
          if (!same(row, data)) throw new Error('learning_senses_installed_row_drift:' + table);
        } else {
          if (replay) throw new Error('learning_senses_installed_row_missing:' + table);
          pending.push(data);
        }
      }
      if (pending.length) {
        await client.query(
          `INSERT INTO "${table}" (${keys.map((key) => '"' + key + '"').join(',')}) SELECT * FROM jsonb_to_recordset($1::jsonb) AS d(${Object.entries(
            columns,
          )
            .map(([key, type]) => '"' + key + '" ' + type)
            .join(',')})`,
          [JSON.stringify(pending)],
        );
        inserted += pending.length;
      }
    }
    return inserted;
  }
  const previous = await client.query(`SELECT * FROM "ContentPack" WHERE id=$1 FOR UPDATE`, [
    manifest.id,
  ]);
  const expectedTags = {
    kind: 'learning-senses',
    scope: manifest.scope,
    learningSenses: manifest.senseCount,
    contextExamples: manifest.exampleCount,
    editorialReview: manifest.editorialReview,
    semanticQualityCertified: false,
    exhaustiveBookCoverage: false,
  };
  if (
    previous.rows.length &&
    (!same(previous.rows[0], {
      sha256: manifest.sha256,
      status: 'ready',
      version: manifest.version,
      sourceUrl: manifest.sourceUrl,
      license: manifest.license,
      entryCount: manifest.wordCount,
      phoneticCount: 0,
      definitionZhCount: manifest.senseCount,
      definitionEnCount: manifest.senseCount,
    }) ||
      !previous.rows[0].tagCounts ||
      !same(previous.rows[0].tagCounts, expectedTags))
  )
    throw new Error('learning_senses_conflicting_installed_pack');
  if (
    previous.rows.length &&
    manifest.sourceAdditions &&
    (previous.rows[0].tagCounts?.sourceAdditionsSha256 !== manifest.sourceAdditions.sha256 ||
      previous.rows[0].tagCounts?.sourceAdditionCount !== additions.length)
  )
    throw new Error('learning_senses_conflicting_source_additions_pin');
  const replay = previous.rows.length > 0;
  result.alreadyInstalled = replay;
  const wordRows = await client.query(
    `SELECT id,"normalizedLemma",status FROM "Word" WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`,
    [rows.map((row) => row.wordId)],
  );
  const words = new Map(wordRows.rows.map((word) => [word.id, word.normalizedLemma]));
  const activeWords = new Set(
    wordRows.rows.filter((word) => word.status === 'published').map((word) => word.id),
  );
  for (const source of additions)
    if (words.get(source.wordId) !== source.normalizedLemma || !activeWords.has(source.wordId))
      throw new Error('learning_senses_original_source_word_not_active');
  result.insertedSourceSenses = await insertExact(
    'Sense',
    additions.map(({ normalizedLemma, ...record }) => record),
    replay,
  );
  const senses = rows.flatMap((row) => row.senses);
  const sourceIds = [
    ...new Set(
      senses.flatMap((sense) => sense.sourceBindings.map((binding) => binding.sourceSenseId)),
    ),
  ];
  const sources = new Map<string, Record<string, unknown>>();
  // Bounded reads lock each source against concurrent edits until the whole collection commits.
  for (let start = 0; start < sourceIds.length; start += 1000) {
    const sourceRows = await client.query(
      `SELECT id,"wordId",pos,"definitionZh","definitionEn" FROM "Sense" WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`,
      [sourceIds.slice(start, start + 1000)],
    );
    for (const source of sourceRows.rows) sources.set(source.id, source);
  }
  for (const row of rows) {
    if (words.get(row.wordId) !== row.normalizedLemma)
      throw new Error('learning_senses_missing_or_changed_word');
    for (const sense of row.senses) {
      for (const binding of sense.sourceBindings) {
        const source = sources.get(binding.sourceSenseId);
        if (
          !source ||
          !learningSenseSourceMatches(
            binding,
            source as Parameters<typeof learningSenseSourceMatches>[1],
          )
        )
          throw new Error('learning_senses_source_drift');
      }
    }
  }
  result.insertedSenses = await insertExact(
    'LearningSense',
    senses.map(({ sourceBindings, examples, ...record }) => record),
    replay,
  );
  result.insertedBindings = await insertExact(
    'SenseSourceBinding',
    senses.flatMap((sense) => sense.sourceBindings),
    replay,
  );
  result.insertedExamples = await insertExact(
    'WordExample',
    senses.flatMap((sense) => sense.examples),
    replay,
  );
  if (!replay)
    await client.query(
      `INSERT INTO "ContentPack" (id,version,status,"sourceUrl",sha256,license,"entryCount","phoneticCount","definitionZhCount","definitionEnCount","tagCounts","updatedAt") VALUES($1,$2,'ready',$3,$4,$5,$6,0,$7,$7,$8::jsonb,NOW())`,
      [
        manifest.id,
        manifest.version,
        manifest.sourceUrl,
        manifest.sha256,
        manifest.license,
        manifest.wordCount,
        manifest.senseCount,
        JSON.stringify({
          ...expectedTags,
          ...(manifest.sourceAdditions
            ? {
                sourceAdditionsSha256: manifest.sourceAdditions.sha256,
                sourceAdditionCount: additions.length,
              }
            : {}),
        }),
      ],
    );
  return result;
}

async function withLearningSensesTransaction<T>(
  site: Pick<SiteConfig, 'id' | 'databaseUrl'>,
  apply: (client: Client) => Promise<T>,
) {
  const client = new Client({ connectionString: site.databaseUrl, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('NightStudy atomic senses'),hashtext($1))`,
      [site.id],
    );
    const state = await client.query(
      `SELECT "siteId" FROM "SiteState" WHERE id='singleton' FOR UPDATE`,
    );
    if (state.rows[0]?.siteId !== site.id)
      throw new Error('learning_senses_database_site_binding_mismatch');
    const result = await apply(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

/** Strict insert-only transaction. Replay rechecks source and every installed row. */
export async function importLearningSensesRows(
  site: Pick<SiteConfig, 'id' | 'databaseUrl'>,
  input: LearningSensesRow[],
  manifest: LearningSensesManifest,
  sourceRows: LearningSenseSourceAddition[] = [],
) {
  validateLearningSensesRows(input, manifest);
  validateLearningSourceAdditions(sourceRows, input, manifest);
  return withLearningSensesTransaction(site, (client) =>
    importLearningSensesRowsInTransaction(site, input, manifest, client, sourceRows),
  );
}

/** Every pinned shard is prevalidated and committed together; a late failure rolls all new rows back. */
export async function importLearningSensesBundle(
  site: Pick<SiteConfig, 'id' | 'databaseUrl'>,
  input: LearningSensesBundle,
) {
  const bundle = validateLearningSensesBundle(input);
  return withLearningSensesTransaction(site, async (client) => {
    const results = [];
    for (const leaf of bundle.bundles)
      results.push(
        await importLearningSensesRowsInTransaction(
          site,
          leaf.rows,
          leaf.manifest,
          client,
          leaf.sourceRows,
        ),
      );
    return {
      siteId: site.id,
      collectionId: bundle.collection?.id ?? null,
      alreadyInstalled: results.every((result) => result.alreadyInstalled),
      bundles: results,
    };
  });
}
