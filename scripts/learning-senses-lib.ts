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

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(200);
const metadata = z.record(z.string(), z.unknown());
const text = z.string().min(1).max(4000);
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
    pos: z.enum([
      'n.',
      'v.',
      'vt.',
      'vi.',
      'adj.',
      'adv.',
      'phr. v.',
      'prep. phr.',
      'adv. phr.',
      'idiom',
    ]),
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
    bytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
    sha256: digest,
    jsonlSha256: digest,
    sourceExportSha256: digest,
    bilingualOverlaySha256: digest,
    draftsSha256: digest,
    sourceUrl: z.string().url(),
    license: z.literal('MIT'),
    wordCount: z.number().int().positive(),
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

export function loadLearningSensesManifest(
  path: string | URL = new URL('../data/learning-senses-v1.manifest.json', import.meta.url),
) {
  return manifestSchema.parse(JSON.parse(fs.readFileSync(path, 'utf8')));
}

export function loadLearningSensesFiles(
  manifestPath: string | URL = new URL('../data/learning-senses-v1.manifest.json', import.meta.url),
) {
  const filename =
    manifestPath instanceof URL ? fileURLToPath(manifestPath) : path.resolve(manifestPath);
  const manifest = loadLearningSensesManifest(filename);
  const bytes = fs.readFileSync(path.join(path.dirname(filename), manifest.fileName));
  return { manifest, rows: readLearningSensesRows(bytes, manifest) };
}

export function validateLearningSensesRows(
  input: unknown,
  manifest: LearningSensesManifest,
): LearningSensesRow[] {
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
      const review = sense.contentMetadata.editorialReview as Record<string, unknown> | undefined;
      if (
        sense.contentMetadata.kind !== 'original-authoring' ||
        sense.contentMetadata.license !== 'MIT' ||
        sense.contentMetadata.review !== 'codex-reviewed' ||
        sense.contentMetadata.expertCertified !== false ||
        review?.reviewer !== 'Codex' ||
        review?.decision !== 'publish' ||
        review?.expertCertified !== false ||
        typeof review?.semanticRationale !== 'string' ||
        review.semanticRationale.length < 15
      )
        throw new Error('learning_senses_missing_semantic_review');
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
          meta.kind !== 'original-authoring' ||
          meta.license !== 'MIT' ||
          meta.review !== 'codex-reviewed' ||
          meta.expertCertified !== false ||
          typeof meta.semanticRationale !== 'string' ||
          meta.semanticRationale.length < 15 ||
          meta.exampleEnSha256 !== hash(example.exampleEn) ||
          meta.exampleZhSha256 !== hash(example.exampleZh)
        )
          throw new Error('learning_senses_missing_example_review');
        if (!/[\u4e00-\u9fff]/u.test(example.exampleZh) || !/[a-z]/iu.test(example.exampleEn))
          throw new Error('learning_senses_invalid_example_pair');
        if (
          surface?.lemma !== row.normalizedLemma ||
          typeof surface.form !== 'string' ||
          surface.review !== 'codex-reviewed' ||
          !['exact', 'inflected-form', 'pronoun-slot', 'object-insertion'].includes(
            String(surface.kind),
          ) ||
          (surface.kind === 'exact' && surface.form !== row.normalizedLemma)
        )
          throw new Error('learning_senses_unreviewed_surface');
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
): LearningSensesRow[] {
  if (bytes.length !== manifest.bytes || bufferHash(bytes) !== manifest.sha256)
    throw new Error('learning_senses_pack_checksum_mismatch');
  const decoded = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
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

/** Strict insert-only transaction. Replay rechecks source and every installed row. */
export async function importLearningSensesRows(
  site: Pick<SiteConfig, 'id' | 'databaseUrl'>,
  input: LearningSensesRow[],
  manifest: LearningSensesManifest,
) {
  const rows = validateLearningSensesRows(input, manifest);
  const client = new Client({ connectionString: site.databaseUrl, connectionTimeoutMillis: 10000 });
  await client.connect();
  const result = {
    siteId: site.id,
    packId: manifest.id,
    alreadyInstalled: false,
    words: rows.length,
    insertedSenses: 0,
    insertedBindings: 0,
    insertedExamples: 0,
  };
  const same = (actual: Record<string, unknown>, expected: Record<string, unknown>) =>
    Object.keys(expected).every(
      (key) => learningSenseCanonical(actual[key]) === learningSenseCanonical(expected[key]),
    );
  async function insertExact(
    table: 'LearningSense' | 'SenseSourceBinding' | 'WordExample',
    data: Record<string, unknown>,
    replay: boolean,
  ) {
    const previous = await client.query(`SELECT * FROM "${table}" WHERE id=$1 FOR UPDATE`, [
      data.id,
    ]);
    if (previous.rows.length) {
      if (!same(previous.rows[0], data))
        throw new Error('learning_senses_installed_row_drift:' + table);
      return false;
    }
    if (replay) throw new Error('learning_senses_installed_row_missing:' + table);
    const keys = Object.keys(data);
    await client.query(
      `INSERT INTO "${table}" (${keys.map((key) => '"' + key + '"').join(',')}) VALUES (${keys.map((_, index) => '$' + (index + 1)).join(',')})`,
      keys.map((key) => (key === 'contentMetadata' ? JSON.stringify(data[key]) : data[key])),
    );
    return true;
  }
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
    const previous = await client.query(`SELECT * FROM "ContentPack" WHERE id=$1 FOR UPDATE`, [
      manifest.id,
    ]);
    if (
      previous.rows.length &&
      (previous.rows[0].sha256 !== manifest.sha256 ||
        previous.rows[0].status !== 'ready' ||
        previous.rows[0].version !== manifest.version)
    )
      throw new Error('learning_senses_conflicting_installed_pack');
    const replay = previous.rows.length > 0;
    result.alreadyInstalled = replay;
    for (const row of rows) {
      const word = await client.query(
        `SELECT id,"normalizedLemma" FROM "Word" WHERE id=$1 FOR SHARE`,
        [row.wordId],
      );
      if (word.rows[0]?.normalizedLemma !== row.normalizedLemma)
        throw new Error('learning_senses_missing_or_changed_word');
      for (const sense of row.senses) {
        // Lock each raw source against a concurrent administrator edit. Same-word
        // foreign keys remain the final database-level constraint.
        for (const binding of sense.sourceBindings) {
          const source = await client.query(
            `SELECT id,"wordId",pos,"definitionZh","definitionEn" FROM "Sense" WHERE id=$1 FOR SHARE`,
            [binding.sourceSenseId],
          );
          if (!source.rows[0] || !learningSenseSourceMatches(binding, source.rows[0]))
            throw new Error('learning_senses_source_drift');
        }
        const { sourceBindings, examples, ...record } = sense;
        if (await insertExact('LearningSense', record, replay)) result.insertedSenses++;
        for (const binding of sourceBindings)
          if (await insertExact('SenseSourceBinding', binding, replay)) result.insertedBindings++;
        for (const example of examples)
          if (await insertExact('WordExample', example, replay)) result.insertedExamples++;
      }
    }
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
            kind: 'learning-senses',
            scope: manifest.scope,
            learningSenses: manifest.senseCount,
            contextExamples: manifest.exampleCount,
            editorialReview: manifest.editorialReview,
            semanticQualityCertified: false,
            exhaustiveBookCoverage: false,
          }),
        ],
      );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
