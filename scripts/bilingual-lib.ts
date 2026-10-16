import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import type { SiteConfig } from '../apps/api/src/config.js';
import { normalizeContentLemma } from './content-lib.js';
import {
  applyExampleTranslationCorrections,
  applyLexicalCorrections,
  automaticBookSql,
  authoredEnglishExampleSchema,
  authoredExampleTranslationSchema,
  defaultBookWithdrawalSchema,
  exampleTranslationCorrectionSchema,
  lexicalCorrectionSchema,
  repairHeldDefaultFocus,
  withdrawDefaultBookEntry,
} from './lexical-polish-lib.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const metadataSchema = z.record(z.string(), z.unknown());
const rowSchema = z
  .object({
    normalizedLemma: z.string().min(1).max(500),
    senses: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            definitionZh: z.string().trim().min(1).max(4000).optional(),
            definitionEn: z.string().trim().min(1).max(4000).optional(),
            exampleZh: z.string().trim().min(1).max(4000).optional(),
            exampleEn: z.string().trim().min(1).max(4000).optional(),
            pos: z.string().trim().min(1).max(100).optional(),
            sourceDefinitionZhSha256: digest.optional(),
            contentMetadata: metadataSchema,
          })
          .strict(),
      )
      .max(200),
    examples: z
      .array(
        z
          .object({
            exampleEn: z.string().trim().min(1).max(4000),
            exampleZh: z.string().trim().min(1).max(4000),
            // Curated pronoun slots/inflections have explicit, reviewed surface
            // identity. The compiler reviews these; no loose runtime stemmer.
            targetSurface: z
              .object({
                lemma: z.string().min(1).max(500),
                form: z.string().min(1).max(500),
                kind: z.enum(['inflected-form', 'pronoun-slot', 'object-insertion']),
                review: z.literal('codex-reviewed'),
              })
              .strict()
              .optional(),
            contentMetadata: metadataSchema,
          })
          .strict(),
      )
      .max(10),
    corrections: z.array(lexicalCorrectionSchema).max(10).optional(),
    exampleCorrections: z.array(exampleTranslationCorrectionSchema).max(20).optional(),
    defaultBookWithdrawal: defaultBookWithdrawalSchema.optional(),
    warnings: z
      .array(
        z
          .object({
            code: z.string().min(1).max(80),
            message: z.string().min(1).max(1000),
            senseId: z.string().min(1).max(200),
            sourceTextSha256: digest,
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();
export type BilingualRow = z.infer<typeof rowSchema>;
export interface BilingualManifest {
  formatVersion: 1;
  id: string;
  version: string;
  fileName: string;
  bytes: number;
  sha256: string;
  jsonlSha256: string;
  sourceUrl: string;
  license: string;
  wordCount: number;
  scope: string;
  publishable?: boolean;
}
export function loadBilingualManifest(
  filename:
    'bilingual-pack.manifest.json' | 'bilingual-v2.manifest.json' = 'bilingual-pack.manifest.json',
): BilingualManifest {
  const value = JSON.parse(
    fs.readFileSync(new URL('../data/' + filename, import.meta.url), 'utf8'),
  ) as BilingualManifest;
  if (
    value.formatVersion !== 1 ||
    !/^[a-z0-9-]+$/.test(value.id) ||
    !/^[\w.-]+\.jsonl\.gz$/.test(value.fileName) ||
    !digest.safeParse(value.sha256).success ||
    !digest.safeParse(value.jsonlSha256).success ||
    !Number.isSafeInteger(value.wordCount) ||
    value.wordCount < 1
  )
    throw new Error('invalid_bilingual_manifest');
  if (
    filename === 'bilingual-v2.manifest.json' &&
    (value.id !== 'bilingual-v2' || value.publishable !== true)
  )
    throw new Error('bilingual_authoring_not_complete');
  return value;
}
export function readBilingualRows(bytes: Buffer, manifest: BilingualManifest): BilingualRow[] {
  if (bytes.length !== manifest.bytes || hash(bytes) !== manifest.sha256)
    throw new Error('bilingual_pack_checksum_mismatch');
  const decoded = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
  if (hash(decoded) !== manifest.jsonlSha256) throw new Error('bilingual_jsonl_checksum_mismatch');
  const rows = new TextDecoder('utf-8', { fatal: true })
    .decode(decoded)
    .split('\n')
    .filter(Boolean)
    .map((line) => rowSchema.parse(JSON.parse(line)));
  if (rows.length !== manifest.wordCount) throw new Error('bilingual_word_count_mismatch');
  const lemmas = new Set<string>();
  const correctedExampleIds = new Set<string>();
  for (const row of rows) {
    if (
      normalizeContentLemma(row.normalizedLemma) !== row.normalizedLemma ||
      lemmas.has(row.normalizedLemma)
    )
      throw new Error('bilingual_duplicate_or_unnormalized_word');
    lemmas.add(row.normalizedLemma);
    if (
      row.defaultBookWithdrawal &&
      (row.senses.length ||
        row.examples.length ||
        row.corrections?.length ||
        row.exampleCorrections?.length)
    )
      throw new Error('bilingual_withdrawal_must_preserve_source');
    for (const correction of row.exampleCorrections ?? []) {
      if (correctedExampleIds.has(correction.id))
        throw new Error('bilingual_duplicate_example_correction');
      correctedExampleIds.add(correction.id);
    }
    for (const sense of row.senses) {
      if (Boolean(sense.pos) !== Boolean(sense.sourceDefinitionZhSha256))
        throw new Error('bilingual_missing_pos_source_identity');
      if (
        sense.pos &&
        (!sense.contentMetadata.pos || typeof sense.contentMetadata.pos !== 'object')
      )
        throw new Error('bilingual_missing_pos_provenance');
    }
    for (const sense of row.senses)
      for (const field of ['definitionZh', 'definitionEn', 'exampleZh', 'exampleEn'] as const)
        if (sense[field]) {
          const source = sense.contentMetadata[field];
          if (
            !source ||
            typeof source !== 'object' ||
            Array.isArray(source) ||
            !digest.safeParse((source as Record<string, unknown>).sourceTextSha256).success
          )
            throw new Error('bilingual_missing_translation_identity');
        }
    for (const correction of row.corrections ?? []) {
      if (row.senses.some((sense) => sense.id === correction.replacesSenseId))
        throw new Error('bilingual_correction_anchor_also_patched');
      for (const field of ['definitionZh', 'definitionEn'] as const) {
        const metadata = correction.contentMetadata[field] as Record<string, unknown> | undefined;
        if (
          !metadata ||
          metadata.kind !== 'original-authoring' ||
          metadata.license !== 'MIT' ||
          metadata.author !== 'NightStudy contributors' ||
          metadata.review !== 'pending'
        )
          throw new Error('bilingual_correction_missing_authorship');
      }
    }
    for (const example of row.examples) {
      const surface = example.targetSurface;
      if (
        surface &&
        (surface.lemma !== row.normalizedLemma || surface.form === row.normalizedLemma)
      )
        throw new Error('bilingual_invalid_example_surface_identity');
      const escaped = (surface?.form ?? row.normalizedLemma).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (
        !new RegExp(`(?<![\\p{L}\\p{M}])${escaped}(?![\\p{L}\\p{M}])`, 'iu').test(example.exampleEn)
      )
        throw new Error('bilingual_example_missing_exact_word');
      for (const field of ['exampleEn', 'exampleZh'] as const) {
        const metadata = example.contentMetadata[field];
        if (
          !metadata ||
          typeof metadata !== 'object' ||
          Array.isArray(metadata) ||
          typeof (metadata as Record<string, unknown>).kind !== 'string' ||
          !String((metadata as Record<string, unknown>).kind).trim()
        )
          throw new Error('bilingual_example_missing_provenance');
        if ((metadata as Record<string, unknown>).kind === 'original-authoring') {
          const schema =
            field === 'exampleEn' ? authoredEnglishExampleSchema : authoredExampleTranslationSchema;
          const parsed = schema.safeParse(metadata);
          if (!parsed.success || parsed.data.sourceTextSha256 !== hash(example.exampleEn))
            throw new Error('bilingual_example_authorship_source_mismatch');
        }
      }
    }
  }
  return rows;
}

export async function importBilingualRows(
  site: Pick<SiteConfig, 'id' | 'databaseUrl'>,
  rows: BilingualRow[],
  manifest: BilingualManifest,
  options: { strict?: boolean } = {},
) {
  const strict = options.strict ?? manifest.id === 'bilingual-v2';
  const client = new Client({ connectionString: site.databaseUrl, connectionTimeoutMillis: 10000 });
  await client.connect();
  const result = {
    siteId: site.id,
    packId: manifest.id,
    alreadyInstalled: false,
    matchedWords: 0,
    translatedFields: 0,
    examples: 0,
    exampleTranslations: 0,
    conflicts: 0,
    posFields: 0,
    correctedSenses: 0,
    focusItems: 0,
    withdrawnBookItems: 0,
  };
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('NightStudy bilingual installer'),hashtext($1))`,
      [site.id],
    );
    const state = await client.query(
      `SELECT "siteId" FROM "SiteState" WHERE id='singleton' FOR UPDATE`,
    );
    if (state.rows[0]?.siteId !== site.id)
      throw new Error('bilingual_database_site_binding_mismatch');
    const previous = await client.query(
      `SELECT status,sha256,"tagCounts" FROM "ContentPack" WHERE id=$1`,
      [manifest.id],
    );
    if (previous.rows.length) {
      if (previous.rows[0].status !== 'ready' || previous.rows[0].sha256 !== manifest.sha256)
        throw new Error('bilingual_conflicting_installed_pack');
      if (strict && Number(previous.rows[0].tagCounts?.conflicts ?? 0) > 0)
        throw new Error('bilingual_installed_pack_has_conflicts');
      result.alreadyInstalled = true;
      await client.query('COMMIT');
      return result;
    }
    for (let start = 0; start < rows.length; start += 250) {
      const batch = rows.slice(start, start + 250);
      const words = await client.query<{ id: string; normalizedLemma: string }>(
        // A site's canonical word can be unpublished by an administrator. Fill
        // only hash-matched missing content without restoring its visibility.
        `SELECT id,"normalizedLemma" FROM "Word" WHERE "normalizedLemma"=ANY($1::text[])`,
        [batch.map((row) => row.normalizedLemma)],
      );
      const byLemma = new Map(words.rows.map((word) => [word.normalizedLemma, word.id]));
      result.matchedWords += byLemma.size;
      const warningRows = batch
        .flatMap((row) =>
          (row.warnings ?? []).map((warning) => ({
            ...warning,
            wordId: byLemma.get(row.normalizedLemma),
          })),
        )
        .filter((warning) => warning.wordId);
      const warnings = new Map<
        string,
        {
          senseId: string;
          wordId: string;
          sourceTextSha256: string;
          values: Array<{
            code: string;
            message: string;
            senseId: string;
            sourceTextSha256: string;
          }>;
        }
      >();
      for (const warning of warningRows) {
        const key = JSON.stringify([warning.senseId, warning.wordId, warning.sourceTextSha256]);
        let group = warnings.get(key);
        if (!group) {
          group = {
            senseId: warning.senseId,
            wordId: warning.wordId!,
            sourceTextSha256: warning.sourceTextSha256,
            values: [],
          };
          warnings.set(key, group);
        }
        if (
          !group.values.some(
            (value) => value.code === warning.code && value.message === warning.message,
          )
        )
          group.values.push({
            code: warning.code,
            message: warning.message,
            senseId: warning.senseId,
            sourceTextSha256: warning.sourceTextSha256,
          });
      }
      for (const warning of warnings.values())
        await client.query(
          `UPDATE "Sense" s SET "contentMetadata"=s."contentMetadata" || jsonb_build_object('lexicalWarnings',$4::jsonb)
        WHERE s.id=$1 AND s."wordId"=$2 AND encode(sha256(convert_to(s."definitionZh",'UTF8')),'hex')=$3`,
          [
            warning.senseId,
            warning.wordId,
            warning.sourceTextSha256,
            JSON.stringify(warning.values),
          ],
        );
      // Only fill empty fields when the exact original-language text still matches.
      // No ordinal/POS matching and no Word ID, BookItem, user state or question writes.
      const patches = batch
        .flatMap((row) =>
          row.senses.map((sense) => ({ ...sense, wordId: byLemma.get(row.normalizedLemma) })),
        )
        .filter((sense) => sense.wordId);
      for (const field of ['definitionZh', 'definitionEn', 'exampleZh', 'exampleEn'] as const) {
        const sourceField = field.endsWith('Zh')
          ? field.replace(/Zh$/, 'En')
          : field.replace(/En$/, 'Zh');
        const selected = patches.filter((sense) => sense[field]);
        if (!selected.length) continue;
        const updated = await client.query(
          `UPDATE "Sense" s SET "${field}"=x.value,
          "contentMetadata"=s."contentMetadata" || jsonb_build_object($2::text,x.metadata) || jsonb_build_object('packId',$3::text)
          FROM jsonb_to_recordset($1::jsonb) AS x(id text,"wordId" text,value text,metadata jsonb)
          WHERE s.id=x.id AND s."wordId"=x."wordId" AND s."${field}"=''
            AND encode(sha256(convert_to(s."${sourceField}",'UTF8')),'hex')=x.metadata->>'sourceTextSha256'
            AND COALESCE(s."contentMetadata"->$2::text->>'kind','')<>'site-authored'
            AND COALESCE(s."contentMetadata"->$4::text->>'kind','')<>'site-authored'`,
          [
            JSON.stringify(
              selected.map((sense) => ({
                id: sense.id,
                wordId: sense.wordId,
                value: sense[field],
                metadata: sense.contentMetadata[field],
              })),
            ),
            field,
            manifest.id,
            sourceField,
          ],
        );
        result.translatedFields += updated.rowCount ?? 0;
        result.conflicts += selected.length - (updated.rowCount ?? 0);
      }
      const positions = patches.filter((sense) => sense.pos);
      if (positions.length) {
        const updated = await client.query(
          `UPDATE "Sense" s SET pos=x.pos,"contentMetadata"=s."contentMetadata" ||
             jsonb_build_object('pos',x.metadata,'packId',$2::text)
           FROM jsonb_to_recordset($1::jsonb) x(id text,"wordId" text,pos text,sha text,metadata jsonb)
           WHERE s.id=x.id AND s."wordId"=x."wordId" AND s.pos=''
             AND encode(sha256(convert_to(s."definitionZh",'UTF8')),'hex')=x.sha
             AND COALESCE(s."contentMetadata"->'definitionZh'->>'kind','')<>'site-authored'
             AND COALESCE(s."contentMetadata"->'definitionEn'->>'kind','')<>'site-authored'
             AND COALESCE(s."contentMetadata"->'pos'->>'kind','')<>'site-authored'`,
          [
            JSON.stringify(
              positions.map((sense) => ({
                id: sense.id,
                wordId: sense.wordId,
                pos: sense.pos,
                sha: sense.sourceDefinitionZhSha256,
                metadata: sense.contentMetadata.pos,
              })),
            ),
            manifest.id,
          ],
        );
        result.posFields += updated.rowCount ?? 0;
        result.conflicts += positions.length - (updated.rowCount ?? 0);
      }
      const edits = await applyLexicalCorrections(
        client,
        batch.flatMap((row) =>
          byLemma.has(row.normalizedLemma)
            ? (row.corrections ?? []).map((item) => ({
                ...item,
                wordId: byLemma.get(row.normalizedLemma)!,
              }))
            : [],
        ),
        manifest.id,
      );
      result.correctedSenses += edits.correctedSenses;
      result.conflicts += edits.conflicts;
      result.focusItems += edits.focusItems;
      const exampleEdits = await applyExampleTranslationCorrections(
        client,
        batch.flatMap((row) =>
          byLemma.has(row.normalizedLemma)
            ? (row.exampleCorrections ?? []).map((item) => ({
                ...item,
                wordId: byLemma.get(row.normalizedLemma)!,
              }))
            : [],
        ),
        manifest.id,
      );
      result.exampleTranslations += exampleEdits.exampleTranslations;
      result.conflicts += exampleEdits.conflicts;
      for (const row of batch)
        if (row.defaultBookWithdrawal && byLemma.has(row.normalizedLemma)) {
          const withdrawn = await withdrawDefaultBookEntry(
            client,
            byLemma.get(row.normalizedLemma)!,
            row.defaultBookWithdrawal,
          );
          result.withdrawnBookItems += withdrawn.withdrawnBookItems;
          result.conflicts += withdrawn.conflicts;
        }
      const examples = batch
        .flatMap((row) =>
          row.examples.map((example, ordinal) => ({
            id: `bilingual-example-${hash(row.normalizedLemma + '\0' + example.exampleEn)}`,
            wordId: byLemma.get(row.normalizedLemma),
            ...example,
            ordinal,
            contentMetadata: {
              ...example.contentMetadata,
              packId: manifest.id,
              ...(example.targetSurface ? { targetSurface: example.targetSurface } : {}),
            },
          })),
        )
        .filter((example) => example.wordId);
      if (examples.length) {
        const inserted = await client.query(
          `INSERT INTO "WordExample" (id,"wordId","exampleEn","exampleZh","contentMetadata",ordinal)
          SELECT id,"wordId","exampleEn","exampleZh","contentMetadata",ordinal FROM jsonb_to_recordset($1::jsonb)
          AS x(id text,"wordId" text,"exampleEn" text,"exampleZh" text,"contentMetadata" jsonb,ordinal int)
          ON CONFLICT(id) DO NOTHING`,
          [JSON.stringify(examples)],
        );
        result.examples += inserted.rowCount ?? 0;
        if (strict && inserted.rowCount !== examples.length)
          throw new Error('bilingual_example_identity_conflict');
      }
      if (manifest.id === 'bilingual-v2')
        result.focusItems += await repairHeldDefaultFocus(client, [...byLemma.values()]);
    }
    if (result.matchedWords !== rows.length)
      throw new Error('bilingual_pack_words_missing_from_site');
    // A strict package is one atomic content change. Never seal a partial,
    // conflicted installation as ready and make its next attempt a no-op.
    if (strict && result.conflicts > 0) throw new Error('bilingual_strict_source_conflict');
    const coverage = await client.query<{
      zh: number;
      en: number;
      paired: number;
      exampleWords: number;
      primaryPairedWords: number;
    }>(
      `SELECT
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Sense" s WHERE s."wordId"=w.id AND s."definitionZh"<>''))::int AS zh,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Sense" s WHERE s."wordId"=w.id AND s."definitionEn"<>''))::int AS en,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Sense" s WHERE s."wordId"=w.id AND s."definitionZh"<>'' AND s."definitionEn"<>''))::int AS paired,
       count(*) FILTER (WHERE COALESCE((SELECT s."definitionEn"<>'' FROM "Sense" s WHERE s."wordId"=w.id AND s."definitionZh"<>'' ORDER BY s.ordinal,s.id LIMIT 1),false))::int AS "primaryPairedWords",
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "WordExample" e WHERE e."wordId"=w.id AND e."exampleEn"<>'' AND e."exampleZh"<>''))::int AS "exampleWords"
       FROM "Word" w WHERE w."normalizedLemma"=ANY($1::text[])`,
      [rows.map((row) => row.normalizedLemma)],
    );
    const focusCoverage = await client.query<{
      sourceBookItems: number;
      pairedFocusItems: number;
      sourceBookWords: number;
      pairedFocusWords: number;
    }>(
      `SELECT count(*)::int AS "sourceBookItems",
       count(*) FILTER (WHERE length(trim(s."definitionZh"))>0 AND length(trim(s."definitionEn"))>0)::int AS "pairedFocusItems",
       count(DISTINCT bi."wordId")::int AS "sourceBookWords",
       count(DISTINCT bi."wordId") FILTER (WHERE length(trim(s."definitionZh"))>0 AND length(trim(s."definitionEn"))>0)::int AS "pairedFocusWords"
       FROM "BookItem" bi JOIN "Book" b ON b.id=bi."bookId"
       JOIN "Word" w ON w.id=bi."wordId" AND w.status='published'
       LEFT JOIN "Sense" s ON s.id=bi."focusSenseId" AND s."wordId"=bi."wordId"
       WHERE ${automaticBookSql} AND b.status='published'
         AND w."normalizedLemma"=ANY($1::text[])`,
      [rows.map((row) => row.normalizedLemma)],
    );
    await client.query(
      `INSERT INTO "ContentPack" (id,version,status,"sourceUrl",sha256,license,"entryCount","phoneticCount","definitionZhCount","definitionEnCount","tagCounts","installedAt","updatedAt")
      VALUES($1,$2,'ready',$3,$4,$5,$6,0,$7,$8,$9::jsonb,NOW(),NOW())`,
      [
        manifest.id,
        manifest.version,
        manifest.sourceUrl,
        manifest.sha256,
        manifest.license,
        result.matchedWords,
        coverage.rows[0]!.zh,
        coverage.rows[0]!.en,
        JSON.stringify({
          kind: 'bilingual',
          scope: manifest.scope,
          translatedFields: result.translatedFields,
          examples: result.examples,
          exampleTranslations: result.exampleTranslations,
          conflicts: result.conflicts,
          posFields: result.posFields,
          correctedSenses: result.correctedSenses,
          focusItems: result.focusItems,
          withdrawnBookItems: result.withdrawnBookItems,
          review: 'pending',
          pairedDefinitionWords: coverage.rows[0]!.paired,
          primaryPairedDefinitionWords: coverage.rows[0]!.primaryPairedWords,
          bilingualExampleWords: coverage.rows[0]!.exampleWords,
          expectedScopeWordCount: manifest.wordCount,
          ...focusCoverage.rows[0],
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
