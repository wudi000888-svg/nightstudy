import type { Client } from 'pg';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
// Known automatic catalog versions and IDs, including the independent phrase
// pack whose presentation version differs from its pack ID.
export const automaticBookSql = `b."ownerId" IS NULL AND (
  b.version LIKE 'ecdict-%'
  OR (b.version='exam-books-v1' AND b.id LIKE 'content-exam-books-v1-%')
  OR (b.version='2026-10-14-v1' AND b.id LIKE 'content-phrase-books-v1-%')
)`;
export const lexicalCorrectionSchema = z
  .object({
    id: z.string().regex(/^bilingual-sense-[a-f0-9]{64}$/),
    replacesSenseId: z.string().min(1).max(200),
    sourceDefinitionZhSha256: digest,
    sourceDefinitionEnSha256: digest,
    sourcePos: z.string().max(100),
    definitionZh: z.string().trim().min(1).max(4000),
    definitionEn: z.string().trim().min(1).max(4000),
    pos: z.string().min(1).max(100),
    reason: z.string().min(1).max(2000),
    contentMetadata: z.record(z.string(), z.unknown()),
  })
  .strict();
export type LexicalCorrection = z.infer<typeof lexicalCorrectionSchema>;
const originalExampleAuthorshipSchema = z
  .object({
    kind: z.literal('original-authoring'),
    author: z.literal('NightStudy contributors'),
    license: z.literal('MIT'),
    review: z.literal('pending'),
    sourceTextSha256: digest,
  })
  .passthrough();
export const authoredEnglishExampleSchema = originalExampleAuthorshipSchema.extend({
  language: z.literal('en'),
});
export const authoredExampleTranslationSchema = originalExampleAuthorshipSchema.extend({
  sourceLanguage: z.literal('en'),
});
export const exampleTranslationCorrectionSchema = z
  .object({
    id: z.string().min(1).max(200),
    sourceExampleEnSha256: digest,
    sourceExampleZhSha256: digest,
    exampleEn: z.string().trim().min(1).max(4000).optional(),
    exampleZh: z.string().trim().min(1).max(4000),
    reason: z.string().trim().min(1).max(2000),
    contentMetadata: z
      .object({
        exampleZh: authoredExampleTranslationSchema.extend({
          translatedFrom: z.record(z.string(), z.unknown()),
        }),
        exampleEn: authoredEnglishExampleSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((item, context) => {
    if (Boolean(item.exampleEn) !== Boolean(item.contentMetadata.exampleEn))
      context.addIssue({
        code: 'custom',
        message: 'bilingual_example_correction_english_authorship_mismatch',
      });
    const englishHash = item.exampleEn
      ? createHash('sha256').update(item.exampleEn).digest('hex')
      : item.sourceExampleEnSha256;
    if (item.contentMetadata.exampleZh.sourceTextSha256 !== englishHash)
      context.addIssue({
        code: 'custom',
        path: ['contentMetadata', 'exampleZh', 'sourceTextSha256'],
        message: 'bilingual_example_correction_translation_source_mismatch',
      });
    if (item.exampleEn && item.contentMetadata.exampleEn?.sourceTextSha256 !== englishHash)
      context.addIssue({
        code: 'custom',
        path: ['contentMetadata', 'exampleEn', 'sourceTextSha256'],
        message: 'bilingual_example_correction_english_source_mismatch',
      });
    if (
      item.exampleEn &&
      !isDeepStrictEqual(
        item.contentMetadata.exampleZh.translatedFrom,
        item.contentMetadata.exampleEn,
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['contentMetadata', 'exampleZh', 'translatedFrom'],
        message: 'bilingual_example_correction_translation_chain_mismatch',
      });
  });
export type ExampleTranslationCorrection = z.infer<typeof exampleTranslationCorrectionSchema>;

/** Correct a pinned public example's translation or explicitly paired text. Both exact source
 * texts and their authorship remain authoritative; lock before taking the raw
 * metadata snapshot so an administrator's concurrent change cannot be lost. */
export async function applyExampleTranslationCorrections(
  client: Client,
  corrections: Array<ExampleTranslationCorrection & { wordId: string }>,
  packId: string,
) {
  let exampleTranslations = 0;
  let conflicts = 0;
  for (const item of corrections) {
    const anchor = await client.query<{
      exampleEn: string;
      exampleZh: string;
      contentMetadata: Record<string, unknown>;
    }>(
      `SELECT "exampleEn","exampleZh","contentMetadata" FROM "WordExample"
       WHERE id=$1 AND "wordId"=$2
         AND encode(sha256(convert_to("exampleEn",'UTF8')),'hex')=$3
         AND encode(sha256(convert_to("exampleZh",'UTF8')),'hex')=$4
         AND jsonb_typeof("contentMetadata")='object'
         AND jsonb_typeof("contentMetadata"->'exampleEn')='object'
         AND jsonb_typeof("contentMetadata"->'exampleZh')='object'
         AND jsonb_typeof("contentMetadata"->'exampleEn'->'kind')='string'
         AND jsonb_typeof("contentMetadata"->'exampleZh'->'kind')='string'
         AND length(trim("contentMetadata"->'exampleEn'->>'kind'))>0
         AND length(trim("contentMetadata"->'exampleZh'->>'kind'))>0
         AND COALESCE("contentMetadata"->'exampleEn'->>'kind','')<>'site-authored'
         AND COALESCE("contentMetadata"->'exampleZh'->>'kind','')<>'site-authored'
       FOR UPDATE`,
      [item.id, item.wordId, item.sourceExampleEnSha256, item.sourceExampleZhSha256],
    );
    const original = anchor.rows[0];
    if (!original) {
      conflicts++;
      continue;
    }
    if (
      !isDeepStrictEqual(
        item.contentMetadata.exampleZh.translatedFrom,
        item.exampleEn ? item.contentMetadata.exampleEn : original.contentMetadata.exampleEn,
      )
    ) {
      conflicts++;
      continue;
    }
    const metadata = {
      ...original.contentMetadata,
      ...(item.exampleEn ? { exampleEn: item.contentMetadata.exampleEn } : {}),
      exampleZh: item.contentMetadata.exampleZh,
      packId,
      translationCorrection: {
        originalExampleEn: original.exampleEn,
        originalText: original.exampleZh,
        originalMetadata: original.contentMetadata,
        originalPackId: original.contentMetadata.packId ?? null,
        sourceExampleEnSha256: item.sourceExampleEnSha256,
        sourceExampleZhSha256: item.sourceExampleZhSha256,
        reason: item.reason,
        packId,
      },
    };
    await client.query(
      `UPDATE "WordExample" SET "exampleZh"=$2,"contentMetadata"=$3::jsonb,
       "exampleEn"=CASE WHEN $4::text IS NULL THEN "exampleEn" ELSE $4::text END WHERE id=$1`,
      [item.id, item.exampleZh, JSON.stringify(metadata), item.exampleEn ?? null],
    );
    exampleTranslations++;
  }
  return { exampleTranslations, conflicts };
}

export const defaultBookWithdrawalSchema = z
  .object({
    sourceSenseId: z.string().min(1).max(200),
    sourceDefinitionZhSha256: digest,
    sourceRef: z.string().min(1).max(500),
    contentVersion: z.string().min(1).max(200),
    reason: z.string().min(1).max(2000),
    replacementLemma: z.string().min(1).max(500).optional(),
    evidenceUrls: z.array(z.string().url()).max(10),
  })
  .strict();
export type DefaultBookWithdrawal = z.infer<typeof defaultBookWithdrawalSchema>;

/** Withdraw malformed or unsupported source tokens only from automatic default
 * books. Keep dictionary, personal books, sessions and every learning identity. */
export async function withdrawDefaultBookEntry(
  client: Client,
  wordId: string,
  entry: DefaultBookWithdrawal,
) {
  const anchor = await client.query(
    `SELECT w.id FROM "Word" w JOIN "Sense" s ON s."wordId"=w.id
     WHERE w.id=$1 AND s.id=$2 AND w."sourceRef"=$3 AND w."contentVersion"=$4
       AND encode(sha256(convert_to(s."definitionZh",'UTF8')),'hex')=$5
       AND COALESCE(s."contentMetadata"->'definitionZh'->>'kind','')<>'site-authored'
     FOR UPDATE OF w,s`,
    [
      wordId,
      entry.sourceSenseId,
      entry.sourceRef,
      entry.contentVersion,
      entry.sourceDefinitionZhSha256,
    ],
  );
  if (!anchor.rowCount) return { withdrawnBookItems: 0, conflicts: 1 };
  const result = await client.query(
    `DELETE FROM "BookItem" bi USING "Book" b WHERE b.id=bi."bookId"
     AND ${automaticBookSql} AND bi."wordId"=$1`,
    [wordId],
  );
  return { withdrawnBookItems: result.rowCount ?? 0, conflicts: 0 };
}

/** A correction is a new, separately attributed sense. Keep the exact source
 * sense for administration; only a hash-bound source is retired from learning.
 * Neither canonical Word identity nor any learner history is changed. */
export async function applyLexicalCorrections(
  client: Client,
  corrections: Array<LexicalCorrection & { wordId: string }>,
  packId: string,
) {
  let correctedSenses = 0;
  let conflicts = 0;
  let focusItems = 0;
  for (const item of corrections) {
    const anchor = await client.query<{ ordinal: number }>(
      `SELECT ordinal FROM "Sense" WHERE id=$1 AND "wordId"=$2 AND pos=$3
       AND encode(sha256(convert_to("definitionZh",'UTF8')),'hex')=$4
       AND encode(sha256(convert_to("definitionEn",'UTF8')),'hex')=$5
       AND COALESCE("contentMetadata"->'definitionZh'->>'kind','')<>'site-authored'
       AND COALESCE("contentMetadata"->'definitionEn'->>'kind','')<>'site-authored'
       FOR UPDATE`,
      [
        item.replacesSenseId,
        item.wordId,
        item.sourcePos,
        item.sourceDefinitionZhSha256,
        item.sourceDefinitionEnSha256,
      ],
    );
    if (!anchor.rows.length) {
      conflicts++;
      continue;
    }
    const metadata = {
      ...item.contentMetadata,
      packId,
      lexicalCorrection: {
        replacesSenseId: item.replacesSenseId,
        sourceDefinitionZhSha256: item.sourceDefinitionZhSha256,
        sourceDefinitionEnSha256: item.sourceDefinitionEnSha256,
        sourcePos: item.sourcePos,
        reason: item.reason,
      },
    };
    // An ID collision must abort the entire pack, never retire the source while
    // silently adopting another site's or an administrator's different text.
    const inserted = await client.query(
      `INSERT INTO "Sense"(id,"wordId",pos,"definitionZh","definitionEn",ordinal,"contentMetadata")
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id
       WHERE "Sense"."wordId"=EXCLUDED."wordId" AND "Sense".pos=EXCLUDED.pos
         AND "Sense"."definitionZh"=EXCLUDED."definitionZh"
         AND "Sense"."definitionEn"=EXCLUDED."definitionEn"
         AND "Sense"."contentMetadata"=EXCLUDED."contentMetadata"`,
      [
        item.id,
        item.wordId,
        item.pos,
        item.definitionZh,
        item.definitionEn,
        anchor.rows[0]!.ordinal - 1,
        JSON.stringify(metadata),
      ],
    );
    if (inserted.rowCount !== 1) throw new Error('bilingual_correction_identity_conflict');
    await client.query(
      `UPDATE "Sense" SET "contentMetadata"="contentMetadata" || jsonb_build_object('lexicalQuality',$2::jsonb)
       WHERE id=$1`,
      [
        item.replacesSenseId,
        JSON.stringify({
          excludeFromLearning: true,
          field: 'definitionZh',
          sourceTextSha256: item.sourceDefinitionZhSha256,
          replacementSenseId: item.id,
          reason: item.reason,
          packId,
        }),
      ],
    );
    // Only automatic source-book focus is maintained. Private books, user
    // progress, stored questions and completed reviews retain their identity.
    const focus = await client.query(
      `UPDATE "BookItem" bi SET "focusSenseId"=$2 FROM "Book" b
       WHERE b.id=bi."bookId" AND ${automaticBookSql}
         AND bi."wordId"=$3 AND bi."focusSenseId"=$1`,
      [item.replacesSenseId, item.id, item.wordId],
    );
    focusItems += focus.rowCount ?? 0;
    correctedSenses++;
  }
  return { correctedSenses, conflicts, focusItems };
}

export async function repairHeldDefaultFocus(client: Client, wordIds: string[]) {
  const result = await client.query(
    `WITH choices AS (SELECT bi.id, bi."focusSenseId" AS "oldFocusId", (
       SELECT candidate.id FROM "Sense" candidate WHERE candidate."wordId"=bi."wordId"
         AND length(trim(candidate."definitionZh"))>0
         AND NOT (COALESCE(candidate."contentMetadata"->'lexicalQuality'->>'excludeFromLearning','')='true'
           AND COALESCE(candidate."contentMetadata"->'lexicalQuality'->>'field','') IN ('definitionZh','definitionEn')
           AND COALESCE(candidate."contentMetadata"->'lexicalQuality'->>'sourceTextSha256','')=
             encode(sha256(convert_to(CASE candidate."contentMetadata"->'lexicalQuality'->>'field'
               WHEN 'definitionZh' THEN candidate."definitionZh"
               WHEN 'definitionEn' THEN candidate."definitionEn" ELSE '' END,'UTF8')),'hex'))
       ORDER BY (length(trim(candidate."definitionEn"))>0) DESC,candidate.ordinal,candidate.id LIMIT 1) AS next
     FROM "BookItem" bi JOIN "Book" b ON b.id=bi."bookId"
       JOIN "Sense" old ON old.id=bi."focusSenseId" AND old."wordId"=bi."wordId"
     WHERE b.id=bi."bookId" AND ${automaticBookSql}
       AND bi."wordId"=ANY($1::text[]) AND old.id=bi."focusSenseId" AND old."wordId"=bi."wordId"
       AND old."contentMetadata"->'lexicalQuality'->>'excludeFromLearning'='true'
       AND COALESCE(old."contentMetadata"->'lexicalQuality'->>'field','') IN ('definitionZh','definitionEn')
       AND COALESCE(old."contentMetadata"->'lexicalQuality'->>'sourceTextSha256','')=
         encode(sha256(convert_to(CASE old."contentMetadata"->'lexicalQuality'->>'field'
           WHEN 'definitionZh' THEN old."definitionZh"
           WHEN 'definitionEn' THEN old."definitionEn" ELSE '' END,'UTF8')),'hex'))
     UPDATE "BookItem" bi SET "focusSenseId"=choices.next FROM choices
     WHERE bi.id=choices.id AND bi."focusSenseId"=choices."oldFocusId"
       AND choices.next IS NOT NULL AND bi."focusSenseId" IS DISTINCT FROM choices.next`,
    [wordIds],
  );
  return result.rowCount ?? 0;
}
