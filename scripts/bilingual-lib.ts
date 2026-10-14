import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import type { SiteConfig } from '../apps/api/src/config.js';
import { normalizeContentLemma } from './content-lib.js';

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
            contentMetadata: metadataSchema,
          })
          .strict(),
      )
      .max(10),
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
}
export function loadBilingualManifest(): BilingualManifest {
  const value = JSON.parse(
    fs.readFileSync(new URL('../data/bilingual-pack.manifest.json', import.meta.url), 'utf8'),
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
  for (const row of rows) {
    if (
      normalizeContentLemma(row.normalizedLemma) !== row.normalizedLemma ||
      lemmas.has(row.normalizedLemma)
    )
      throw new Error('bilingual_duplicate_or_unnormalized_word');
    lemmas.add(row.normalizedLemma);
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
    for (const example of row.examples) {
      const escaped = row.normalizedLemma.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (
        !new RegExp(`(?<![\\p{L}\\p{M}])${escaped}(?![\\p{L}\\p{M}])`, 'iu').test(example.exampleEn)
      )
        throw new Error('bilingual_example_missing_exact_word');
      if (!example.contentMetadata.exampleEn || !example.contentMetadata.exampleZh)
        throw new Error('bilingual_example_missing_provenance');
    }
  }
  return rows;
}

export async function importBilingualRows(
  site: Pick<SiteConfig, 'id' | 'databaseUrl'>,
  rows: BilingualRow[],
  manifest: BilingualManifest,
) {
  const client = new Client({ connectionString: site.databaseUrl, connectionTimeoutMillis: 10000 });
  await client.connect();
  const result = {
    siteId: site.id,
    packId: manifest.id,
    alreadyInstalled: false,
    matchedWords: 0,
    translatedFields: 0,
    examples: 0,
    conflicts: 0,
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
    const previous = await client.query(`SELECT status,sha256 FROM "ContentPack" WHERE id=$1`, [
      manifest.id,
    ]);
    if (previous.rows.length) {
      if (previous.rows[0].status !== 'ready' || previous.rows[0].sha256 !== manifest.sha256)
        throw new Error('bilingual_conflicting_installed_pack');
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
            AND encode(sha256(convert_to(s."${sourceField}",'UTF8')),'hex')=x.metadata->>'sourceTextSha256'`,
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
          ],
        );
        result.translatedFields += updated.rowCount ?? 0;
        result.conflicts += selected.length - (updated.rowCount ?? 0);
      }
      const examples = batch
        .flatMap((row) =>
          row.examples.map((example, ordinal) => ({
            id: `bilingual-example-${hash(row.normalizedLemma + '\0' + example.exampleEn)}`,
            wordId: byLemma.get(row.normalizedLemma),
            ...example,
            ordinal,
            contentMetadata: { ...example.contentMetadata, packId: manifest.id },
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
      }
    }
    if (result.matchedWords !== rows.length)
      throw new Error('bilingual_pack_words_missing_from_site');
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
       WHERE b."ownerId" IS NULL AND b.status='published' AND b.version LIKE 'ecdict-%'
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
          conflicts: result.conflicts,
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
