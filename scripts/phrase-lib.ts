import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Client } from 'pg';
import { z } from 'zod';
import type { SiteConfig } from '../apps/api/src/config.js';
import { normalizeContentLemma } from './content-lib.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const metadata = z.record(z.string(), z.unknown());
const text = z.string().min(1).max(4000);
const rowSchema = z
  .object({
    normalizedLemma: z.string().min(3).max(200),
    book: z.enum(['cet4-phrases', 'cet6-phrases']),
    sourceWordId: z.string().min(1).max(200),
    sourceFocusSenseId: z.string().min(1).max(200),
    sourceFocusTextSha256: digest,
    focusSenseId: z.string().min(1).max(200),
    senses: z
      .array(
        z
          .object({
            id: text,
            sourceText: text,
            sourceTextSha256: digest,
            definitionEn: text,
            contentMetadata: metadata,
          })
          .strict(),
      )
      .max(20),
    qualityWarnings: z
      .array(
        z
          .object({
            senseId: text,
            field: z.literal('definitionZh'),
            sourceTextSha256: digest,
            code: text,
            message: text,
            excludeFromLearning: z.boolean(),
          })
          .strict(),
      )
      .max(20),
    curatedFocus: z
      .object({
        id: text,
        pos: z.string().max(100),
        definitionZh: text,
        definitionEn: text,
        ordinal: z.literal(-1),
        contentMetadata: metadata,
      })
      .strict()
      .optional(),
    examples: z
      .array(z.object({ exampleEn: text, exampleZh: text, contentMetadata: metadata }).strict())
      .length(1),
    collocationTokens: z.array(z.string().regex(/^[a-z]+(?:['-][a-z]+)*$/)).max(4),
  })
  .strict();
export type PhraseRow = z.infer<typeof rowSchema>;
export const phraseBookLabels = {
  'cet4-phrases': '四级 · 常用词组',
  'cet6-phrases': '六级 · 进阶词组',
} as const;
export const phraseBookDescription = '在常见阅读与交流场景中，学习词组、搭配和例句。';
export function legacyPhraseBookDescription(corpusCount: number) {
  return `NightStudy独立编选的常用词组，供四级/六级方向练习参考；不是官方完整考试大纲。中文原释义来自固定版ECDICT，英文对照及多数例句为Codex辅助原创，待校对；本书${corpusCount}条真实Tatoeba双语例句保留双方来源归因。`;
}
export interface PhraseManifest {
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
  kind: 'phrase-books';
  bookCounts: { 'cet4-phrases': number; 'cet6-phrases': number };
  tagCounts: Record<string, number>;
  statistics: Record<string, number>;
}
export const PHRASE_STOPWORDS = new Set(
  'a an the and or but if as at by for from in into of on onto out over per than that this these those to up upon with without about across after along around away back down through under until all any each every few more most much no not one other same some such both either neither i me my mine we us our ours you your yours he him his she her hers it its they them their theirs who whom whose which what where when why how be been being is are was were am can could may might must shall should will would do does did have has had'.split(
    ' ',
  ),
);
export function phraseTokens(lemma: string) {
  return [...new Set(lemma.split(' ').filter((token) => !PHRASE_STOPWORDS.has(token)))].slice(0, 4);
}
export function loadPhraseManifest(
  file = new URL('../data/phrase-books.manifest.json', import.meta.url),
): PhraseManifest {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as PhraseManifest;
  if (
    manifest.formatVersion !== 1 ||
    manifest.id !== 'phrase-books-v1' ||
    manifest.kind !== 'phrase-books' ||
    !/^[\w.-]+\.jsonl\.gz$/.test(manifest.fileName) ||
    !digest.safeParse(manifest.sha256).success ||
    !digest.safeParse(manifest.jsonlSha256).success ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes < 1 ||
    manifest.wordCount !== 437 ||
    manifest.bookCounts?.['cet4-phrases'] !== 236 ||
    manifest.bookCounts?.['cet6-phrases'] !== 201 ||
    manifest.tagCounts?.['phrase-books'] !== 437
  )
    throw new Error('invalid_phrase_manifest');
  return manifest;
}
function sourceObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('phrase_missing_provenance');
  return value as Record<string, unknown>;
}
export function readPhraseRows(bytes: Buffer, manifest: PhraseManifest): PhraseRow[] {
  if (bytes.length !== manifest.bytes || hash(bytes) !== manifest.sha256)
    throw new Error('phrase_pack_checksum_mismatch');
  const decoded = gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 });
  if (hash(decoded) !== manifest.jsonlSha256) throw new Error('phrase_jsonl_checksum_mismatch');
  const rows = new TextDecoder('utf-8', { fatal: true })
    .decode(decoded)
    .split('\n')
    .filter(Boolean)
    .map((line) => rowSchema.parse(JSON.parse(line)));
  if (rows.length !== manifest.wordCount) throw new Error('phrase_word_count_mismatch');
  const lemmas = new Set<string>();
  const bookCounts = { 'cet4-phrases': 0, 'cet6-phrases': 0 };
  for (const row of rows) {
    if (
      row.normalizedLemma !== normalizeContentLemma(row.normalizedLemma) ||
      lemmas.has(row.normalizedLemma) ||
      !/^[a-z]+(?:['-][a-z]+)*(?: [a-z]+(?:['-][a-z]+)*){1,5}$/.test(row.normalizedLemma)
    )
      throw new Error('invalid_or_duplicate_phrase');
    lemmas.add(row.normalizedLemma);
    bookCounts[row.book]++;
    if (JSON.stringify(phraseTokens(row.normalizedLemma)) !== JSON.stringify(row.collocationTokens))
      throw new Error('phrase_invalid_collocation_tokens');
    const seen = new Set<string>();
    for (const sense of row.senses) {
      const m = sourceObject(sense.contentMetadata.definitionEn);
      if (
        seen.has(sense.id) ||
        hash(sense.sourceText) !== sense.sourceTextSha256 ||
        m.kind !== 'original-authoring' ||
        m.review !== 'pending' ||
        m.license !== 'MIT' ||
        m.sourceLanguage !== 'zh' ||
        m.sourceTextSha256 !== sense.sourceTextSha256 ||
        m.sourceSenseId !== sense.id ||
        m.model
      )
        throw new Error('phrase_source_identity_or_authoring_invalid');
      seen.add(sense.id);
    }
    for (const warning of row.qualityWarnings)
      if (seen.has(warning.senseId) && warning.excludeFromLearning)
        throw new Error('phrase_excluded_source_translated');
    if (row.curatedFocus) {
      if (
        row.focusSenseId !== row.curatedFocus.id ||
        !row.qualityWarnings.some(
          (w) => w.senseId === row.sourceFocusSenseId && w.excludeFromLearning,
        )
      )
        throw new Error('phrase_curated_focus_not_bound');
      for (const field of ['definitionEn', 'definitionZh']) {
        const m = sourceObject(row.curatedFocus.contentMetadata[field]);
        if (
          m.kind !== 'original-authoring' ||
          m.license !== 'MIT' ||
          m.review !== 'pending' ||
          m.model ||
          m.sourceSenseId !== row.sourceFocusSenseId ||
          m.sourceTextSha256 !== row.sourceFocusTextSha256 ||
          !m.correctionReason ||
          m.sourceRelation !== 'correction-reference-not-literal-translation'
        )
          throw new Error('phrase_curated_focus_provenance_invalid');
      }
    } else if (
      row.focusSenseId !== row.sourceFocusSenseId ||
      !row.senses.some((s) => s.id === row.focusSenseId)
    )
      throw new Error('phrase_focus_missing_bilingual_patch');
    for (const example of row.examples) {
      const escaped = row.normalizedLemma.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (
        !new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escaped}(?![\\p{L}\\p{M}\\p{N}_])`, 'iu').test(
          example.exampleEn,
        )
      )
        throw new Error('phrase_example_missing_exact_phrase');
      for (const field of ['exampleEn', 'exampleZh'] as const) {
        const m = sourceObject(example.contentMetadata[field]);
        if (m.review !== 'pending' || m.model)
          throw new Error('phrase_example_review_or_source_invalid');
        if (m.kind === 'generated') {
          if (m.license !== 'MIT' || m.author !== 'NightStudy contributors' || !m.authoringMethod)
            throw new Error('phrase_original_example_attribution_invalid');
        } else if (m.kind === 'corpus') {
          if (
            m.license !== 'CC-BY-2.0-FR' ||
            m.sourceName !== 'Tatoeba' ||
            !m.sourceOwner ||
            !Number.isSafeInteger(m.sourceSentenceId) ||
            m.sourceUrl !== `https://tatoeba.org/en/sentences/show/${m.sourceSentenceId}` ||
            !m.directLinkedSentenceId ||
            m.sourceTextSha256 !== hash(example[field]) ||
            m.adaptation !== false
          )
            throw new Error('phrase_corpus_attribution_invalid');
        } else throw new Error('phrase_unknown_example_source');
      }
    }
  }
  if (
    bookCounts['cet4-phrases'] !== manifest.bookCounts['cet4-phrases'] ||
    bookCounts['cet6-phrases'] !== manifest.bookCounts['cet6-phrases']
  )
    throw new Error('phrase_book_count_mismatch');
  return rows;
}
export async function importPhraseRows(
  site: Pick<SiteConfig, 'id' | 'databaseUrl'>,
  rows: PhraseRow[],
  manifest: PhraseManifest,
  options: { dryRun?: boolean } = {},
) {
  if (
    manifest.id.startsWith('phrase-books-fixture') &&
    !decodeURIComponent(new URL(site.databaseUrl).pathname).endsWith('_test')
  )
    throw new Error('phrase_fixture_requires_disposable_test_database');
  const client = new Client({ connectionString: site.databaseUrl, connectionTimeoutMillis: 10000 });
  const result = {
    siteId: site.id,
    packId: manifest.id,
    alreadyInstalled: false,
    dryRun: !!options.dryRun,
    matchedWords: 0,
    translatedSourceSenses: 0,
    newCuratedFocusSenses: 0,
    newExamples: 0,
    newBooks: 0,
    collocations: 0,
    conflicts: [] as { normalizedLemma: string; code: string; senseId?: string }[],
  };
  await client.connect();
  try {
    await client.query(
      options.dryRun ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN',
    );
    if (!options.dryRun)
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('NightStudy phrase installer'),hashtext($1))`,
        [site.id],
      );
    const state = await client.query(
      `SELECT "siteId" FROM "SiteState" WHERE id='singleton'${options.dryRun ? '' : ' FOR UPDATE'}`,
    );
    if (state.rows[0]?.siteId !== site.id) throw new Error('phrase_database_site_binding_mismatch');
    const installed = await client.query(`SELECT status,sha256 FROM "ContentPack" WHERE id=$1`, [
      manifest.id,
    ]);
    if (installed.rows.length) {
      if (installed.rows[0].status !== 'ready' || installed.rows[0].sha256 !== manifest.sha256)
        throw new Error('conflicting_installed_phrase_pack');
      result.alreadyInstalled = true;
      await client.query('COMMIT');
      return result;
    }
    const resolved: { row: PhraseRow; wordId: string; protectedSenses: Set<string> }[] = [];
    // Preflight every existing identity and source before any data mutation.
    for (const row of rows) {
      const word = await client.query(
        `SELECT id FROM "Word" WHERE "normalizedLemma"=$1 AND status='published'`,
        [row.normalizedLemma],
      );
      if (word.rows[0]?.id !== row.sourceWordId)
        throw new Error('phrase_canonical_word_identity_mismatch');
      const old = await client.query(
        `SELECT id,"definitionZh","definitionEn","contentMetadata" FROM "Sense" WHERE "wordId"=$1${options.dryRun ? '' : ' FOR UPDATE'}`,
        [word.rows[0].id],
      );
      const senses = new Map<string, Record<string, unknown>>(old.rows.map((s) => [s.id, s]));
      const primary = senses.get(row.sourceFocusSenseId);
      if (!primary || hash(primary.definitionZh as string) !== row.sourceFocusTextSha256)
        throw new Error('phrase_primary_source_changed');
      for (const patch of row.senses) {
        const original = senses.get(patch.id);
        if (
          !original ||
          original.definitionZh !== patch.sourceText ||
          hash(original.definitionZh as string) !== patch.sourceTextSha256
        )
          throw new Error('phrase_patch_source_changed_or_cross_word');
        if (original.definitionEn !== '')
          result.conflicts.push({
            normalizedLemma: row.normalizedLemma,
            code: 'existing_english_preserved',
            senseId: patch.id,
          });
      }
      for (const warning of row.qualityWarnings) {
        const original = senses.get(warning.senseId);
        if (!original || hash(original.definitionZh as string) !== warning.sourceTextSha256)
          throw new Error('phrase_quality_warning_source_changed');
        if (original.definitionEn !== '' && warning.excludeFromLearning)
          result.conflicts.push({
            normalizedLemma: row.normalizedLemma,
            code: 'existing_bilingual_source_quality_requires_review',
            senseId: warning.senseId,
          });
      }
      if (row.curatedFocus) {
        const previous = senses.get(row.curatedFocus.id);
        if (
          previous &&
          (previous.definitionZh !== row.curatedFocus.definitionZh ||
            previous.definitionEn !== row.curatedFocus.definitionEn)
        )
          throw new Error('phrase_curated_focus_conflict');
      }
      resolved.push({
        row,
        wordId: word.rows[0].id,
        protectedSenses: new Set(old.rows.filter((s) => s.definitionEn !== '').map((s) => s.id)),
      });
      result.matchedWords++;
    }
    if (options.dryRun) {
      await client.query('COMMIT');
      return result;
    }
    for (const { row, wordId, protectedSenses } of resolved) {
      for (const patch of row.senses) {
        const changed = await client.query(
          `UPDATE "Sense" SET "definitionEn"=$2,"contentMetadata"="contentMetadata"||$3::jsonb WHERE id=$1 AND "wordId"=$4 AND "definitionZh"=$5 AND "definitionEn"=''`,
          [
            patch.id,
            patch.definitionEn,
            JSON.stringify(patch.contentMetadata),
            wordId,
            patch.sourceText,
          ],
        );
        result.translatedSourceSenses += changed.rowCount || 0;
      }
      const warningGroups = new Map<string, PhraseRow['qualityWarnings']>();
      for (const warning of row.qualityWarnings)
        warningGroups.set(warning.senseId, [
          ...(warningGroups.get(warning.senseId) || []),
          warning,
        ]);
      for (const [senseId, warnings] of warningGroups) {
        if (protectedSenses.has(senseId)) continue;
        const first = warnings[0]!;
        const value = {
          excludeFromLearning: warnings.some((warning) => warning.excludeFromLearning),
          field: first.field,
          sourceTextSha256: first.sourceTextSha256,
          reason: warnings.map((warning) => warning.message).join('\n'),
          code: first.code,
          review: 'pending',
          author: 'NightStudy contributors',
        };
        const changed = await client.query(
          `UPDATE "Sense" SET "contentMetadata"="contentMetadata"||$2::jsonb WHERE id=$1 AND "wordId"=$3 AND NOT ("contentMetadata" ? 'lexicalQuality')`,
          [senseId, JSON.stringify({ lexicalQuality: value }), wordId],
        );
        if (!changed.rowCount)
          result.conflicts.push({
            normalizedLemma: row.normalizedLemma,
            code: 'existing_source_quality_decision_preserved',
            senseId,
          });
      }
      if (row.curatedFocus) {
        const focus = row.curatedFocus;
        const inserted = await client.query(
          `INSERT INTO "Sense" (id,"wordId",pos,"definitionZh","definitionEn","exampleEn","exampleZh",ordinal,"contentMetadata") VALUES($1,$2,$3,$4,$5,'','',$6,$7::jsonb) ON CONFLICT(id) DO NOTHING`,
          [
            focus.id,
            wordId,
            focus.pos,
            focus.definitionZh,
            focus.definitionEn,
            focus.ordinal,
            JSON.stringify(focus.contentMetadata),
          ],
        );
        result.newCuratedFocusSenses += inserted.rowCount || 0;
      }
      for (const example of row.examples) {
        const id =
          'phrase-example-' + hash(wordId + '\0' + example.exampleEn + '\0' + example.exampleZh);
        const inserted = await client.query(
          `INSERT INTO "WordExample" (id,"wordId","exampleEn","exampleZh","contentMetadata",ordinal) VALUES($1,$2,$3,$4,$5::jsonb,-1) ON CONFLICT(id) DO NOTHING`,
          [
            id,
            wordId,
            example.exampleEn,
            example.exampleZh,
            JSON.stringify(example.contentMetadata),
          ],
        );
        result.newExamples += inserted.rowCount || 0;
      }
    }
    for (const goal of ['cet4-phrases', 'cet6-phrases'] as const) {
      const title = phraseBookLabels[goal];
      const id = 'content-' + manifest.id + '-' + goal;
      const existing = await client.query(`SELECT "ownerId",kind FROM "Book" WHERE id=$1`, [id]);
      if (
        existing.rows.length &&
        (existing.rows[0].ownerId !== null || existing.rows[0].kind !== 'phrases')
      )
        throw new Error('phrase_book_identity_conflict');
      if (existing.rows.length) {
        result.conflicts.push({ normalizedLemma: goal, code: 'existing_book_and_items_preserved' });
        continue;
      }
      await client.query(
        `INSERT INTO "Book" (id,slug,title,description,goal,kind,status,version,"ownerId","updatedAt") VALUES($1,$2,$3,$4,$5,'phrases','published',$6,NULL,NOW())`,
        [
          id,
          manifest.id === 'phrase-books-v1' ? goal : `${manifest.id}-${goal}`,
          title,
          phraseBookDescription,
          goal.startsWith('cet4') ? 'cet4' : 'cet6',
          manifest.version,
        ],
      );
      result.newBooks++;
      let ordinal = 0;
      for (const { row, wordId } of resolved.filter((x) => x.row.book === goal)) {
        await client.query(
          `INSERT INTO "BookItem" (id,"bookId","wordId","focusSenseId",ordinal) VALUES($1,$2,$3,$4,$5)`,
          ['phrase-item-' + hash(id + '\0' + wordId), id, wordId, row.focusSenseId, ordinal++],
        );
      }
    }
    const perHead = new Map<string, number>();
    for (const { row, wordId: phraseId } of resolved)
      for (const token of row.collocationTokens) {
        const head = await client.query(
          `SELECT id FROM "Word" WHERE "normalizedLemma"=$1 AND status='published'`,
          [token],
        );
        if (!head.rows[0] || head.rows[0].id === phraseId) continue;
        const wordId = head.rows[0].id as string;
        const count = perHead.get(wordId) || 0;
        if (count >= 24) continue;
        const inserted = await client.query(
          `INSERT INTO "WordCollocation" ("wordId","phraseId",ordinal) VALUES($1,$2,$3) ON CONFLICT("wordId","phraseId") DO NOTHING`,
          [wordId, phraseId, count],
        );
        result.collocations += inserted.rowCount || 0;
        perHead.set(wordId, count + 1);
      }
    await client.query(
      `INSERT INTO "ContentPack" (id,version,status,"sourceUrl",sha256,license,"entryCount","phoneticCount","definitionZhCount","definitionEnCount","tagCounts","installedAt","updatedAt") VALUES($1,$2,'ready',$3,$4,$5,$6,0,$6,$6,$7::jsonb,NOW(),NOW())`,
      [
        manifest.id,
        manifest.version,
        manifest.sourceUrl,
        manifest.sha256,
        manifest.license,
        rows.length,
        JSON.stringify({ kind: manifest.kind, ...manifest.tagCounts }),
      ],
    );
    // Supplemental packs do not replace SiteState's core content version or any user's settings.
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
