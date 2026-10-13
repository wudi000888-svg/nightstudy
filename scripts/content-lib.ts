import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Client } from 'pg';
import type { SiteConfig } from '../apps/api/src/config.js';

export interface ContentManifest {
  formatVersion: number;
  id: string;
  version: string;
  sourceUrl: string;
  fileName: string;
  bytes: number;
  sha256: string;
  license: string;
  statistics: {
    entryCount: number;
    phoneticCount: number;
    definitionZhCount: number;
    definitionEnCount: number;
    tagCounts: Record<string, number>;
    bookCounts: Record<string, number>;
  };
}
export type ContentGoal = 'daily' | 'high-school' | 'cet4' | 'cet6' | 'ielts';
export interface EcdictRow {
  word: string;
  phonetic: string;
  definition: string;
  translation: string;
  pos: string;
  collins: string;
  oxford: string;
  tag: string;
  bnc: string;
  frq: string;
  exchange: string;
  detail: string;
  audio: string;
}
export interface SourceSense {
  id: string;
  normalizedLemma: string;
  pos: string;
  definitionZh: string;
  definitionEn: string;
  ordinal: number;
}
export interface SourceEntry {
  id: string;
  lemma: string;
  normalizedLemma: string;
  phonetic: string;
  goalTags: ContentGoal[];
  difficulty: number;
  frequencyRank: number;
  focusSenseId: string | null;
  senses: SourceSense[];
}

const goals: ContentGoal[] = ['daily', 'high-school', 'cet4', 'cet6', 'ielts'];
const goalLabels: Record<ContentGoal, string> = {
  daily: '常用英语 · 词频前3000规则',
  'high-school': '高考方向 · ECDICT gk标签',
  cet4: '四级方向 · ECDICT cet4标签',
  cet6: '六级方向 · ECDICT cet6标签',
  ielts: '雅思方向 · ECDICT ielts标签',
};
const columns: (keyof EcdictRow)[] = [
  'word',
  'phonetic',
  'definition',
  'translation',
  'pos',
  'collins',
  'oxford',
  'tag',
  'bnc',
  'frq',
  'exchange',
  'detail',
  'audio',
];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export function loadContentManifest(): ContentManifest {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../data/content-ecdict.manifest.json', import.meta.url), 'utf8'),
  ) as ContentManifest;
  if (manifest.formatVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.sha256))
    throw new Error('unsupported_content_manifest');
  return manifest;
}

export function normalizeContentLemma(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
}
export function stableWordId(normalizedLemma: string): string {
  return sha(normalizedLemma);
}
export function contentSourcePath(manifest = loadContentManifest()): string {
  return path.resolve(process.env.CONTENT_FILE || path.join('.local/content', manifest.fileName));
}

export async function verifyContentSource(
  sourcePath: string,
  manifest: ContentManifest = loadContentManifest(),
): Promise<void> {
  const size = fs.statSync(sourcePath).size;
  if (size !== manifest.bytes) throw new Error('content_source_size_mismatch');
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(sourcePath)) hash.update(chunk);
  if (hash.digest('hex') !== manifest.sha256) throw new Error('content_source_checksum_mismatch');
}

async function downloadHttps(url: string, destination: string, redirects = 0): Promise<void> {
  if (!url.startsWith('https://') || redirects > 5) throw new Error('invalid_content_download_url');
  await new Promise<void>((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'NightStudy-content-installer/1' } },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          downloadHttps(
            new URL(response.headers.location, url).href,
            destination,
            redirects + 1,
          ).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`content_download_http_${response.statusCode}`));
          return;
        }
        void pipeline(response, fs.createWriteStream(destination, { flags: 'wx' })).then(
          resolve,
          reject,
        );
      },
    );
    request.setTimeout(60000, () => request.destroy(new Error('content_download_idle_timeout')));
    request.once('error', reject);
  });
}

export async function fetchContentSource(
  manifest: ContentManifest = loadContentManifest(),
  destination = contentSourcePath(manifest),
): Promise<string> {
  if (fs.existsSync(destination)) {
    await verifyContentSource(destination, manifest);
    return destination;
  }
  if (process.env.CONTENT_FILE) throw new Error('configured_CONTENT_FILE_does_not_exist');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.part`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await downloadHttps(manifest.sourceUrl, temporary);
      await verifyContentSource(temporary, manifest);
      fs.renameSync(temporary, destination);
      return destination;
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  throw new Error('content_download_failed');
}

/** RFC4180 parser, including quoted CR/LF, escaped quotes, and chunk boundaries. */
export async function* parseCsvChunks(chunks: AsyncIterable<string>): AsyncGenerator<string[]> {
  let field = '',
    fields: string[] = [],
    quoted = false,
    afterQuote = false,
    skipLf = false;
  const finishField = () => {
    fields.push(field);
    field = '';
    afterQuote = false;
  };
  for await (const chunk of chunks)
    for (const ch of chunk) {
      if (skipLf) {
        skipLf = false;
        if (ch === '\n') continue;
      }
      if (quoted) {
        if (ch === '"') {
          quoted = false;
          afterQuote = true;
        } else field += ch;
        continue;
      }
      if (afterQuote && ch === '"') {
        field += '"';
        quoted = true;
        afterQuote = false;
        continue;
      }
      if (ch === ',') {
        finishField();
        continue;
      }
      if (ch === '\n' || ch === '\r') {
        finishField();
        if (fields.some((value) => value.length)) yield fields;
        fields = [];
        skipLf = ch === '\r';
        continue;
      }
      if (afterQuote) throw new Error('invalid_csv_after_quoted_field');
      if (ch === '"') {
        if (field.length) throw new Error('invalid_csv_quote');
        quoted = true;
      } else field += ch;
    }
  if (quoted) throw new Error('unterminated_csv_field');
  if (field.length || fields.length || afterQuote) {
    finishField();
    if (fields.some((value) => value.length)) yield fields;
  }
}

export async function* readEcdict(sourcePath: string): AsyncGenerator<EcdictRow> {
  const stream = fs.createReadStream(sourcePath, { encoding: 'utf8' });
  let header: string[] | undefined,
    line = 0;
  for await (const fields of parseCsvChunks(stream)) {
    line++;
    if (!header) {
      header = fields.map((value, index) => (index ? value : value.replace(/^\uFEFF/, '')));
      if (
        header.length !== columns.length ||
        columns.some((column, index) => header?.[index] !== column)
      )
        throw new Error('unsupported_ecdict_columns');
      continue;
    }
    if (fields.length !== columns.length) throw new Error(`invalid_ecdict_column_count_at_${line}`);
    yield Object.fromEntries(
      columns.map((column, index) => [column, fields[index]!]),
    ) as unknown as EcdictRow;
  }
  if (!header) throw new Error('empty_ecdict_source');
}

export function splitDefinitionLines(value: string): string[] {
  return value
    .replace(/\\n/g, '\n')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
export function mapEcdictRow(row: EcdictRow): SourceEntry {
  const normalizedLemma = normalizeContentLemma(row.word);
  if (!normalizedLemma) throw new Error('empty_source_lemma');
  const tags = new Set(row.tag.split(/\s+/).filter(Boolean));
  const positiveRank = (value: string) =>
    /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : 2147483647;
  const frequencyRank = Math.min(positiveRank(row.frq), positiveRank(row.bnc));
  const goalTags: ContentGoal[] = [];
  if (frequencyRank <= 3000) goalTags.push('daily');
  for (const [tag, goal] of [
    ['gk', 'high-school'],
    ['cet4', 'cet4'],
    ['cet6', 'cet6'],
    ['ielts', 'ielts'],
  ] as const)
    if (tags.has(tag)) goalTags.push(goal);
  const senses: SourceSense[] = [];
  for (const [language, value, base] of [
    ['zh', row.translation, -20000],
    ['en', row.definition, -10000],
  ] as const)
    splitDefinitionLines(value).forEach((line, ordinal) => {
      const match =
        /^(n|v|vt|vi|a|adj|adv|prep|conj|pron|int|interj|num|art|aux|det|pl|abbr)\.\s*/i.exec(line);
      const pos = match ? `${match[1]!.toLowerCase()}.` : '';
      const definition = match ? line.slice(match[0].length).trim() : line;
      if (!definition) return;
      senses.push({
        id: `content-ecdict-${sha(`${normalizedLemma}\0${language}\0${pos}\0${line}`)}`,
        normalizedLemma,
        pos,
        definitionZh: language === 'zh' ? definition : '',
        definitionEn: language === 'en' ? definition : '',
        ordinal: base + ordinal,
      });
    });
  return {
    id: stableWordId(normalizedLemma),
    lemma: row.word.trim(),
    normalizedLemma,
    phonetic: row.phonetic.trim(),
    goalTags,
    difficulty:
      frequencyRank <= 1000 ? 1 : frequencyRank <= 3000 ? 2 : frequencyRank <= 10000 ? 3 : 4,
    frequencyRank,
    focusSenseId: senses.find((sense) => sense.definitionZh)?.id ?? null,
    senses,
  };
}

export interface ContentImportResult {
  siteId: string;
  packId: string;
  alreadyInstalled: boolean;
  sourceEntries: number;
  newWords: number;
  updatedDemoWords: number;
  newSenses: number;
  newBooks: number;
}

async function writeBatch(client: Client, entries: SourceEntry[], packId: string) {
  const input = JSON.stringify(entries.map(({ senses: _senses, ...entry }) => entry));
  const inserted = await client.query(
    `
    INSERT INTO "Word" ("id", "lemma", "normalizedLemma", "phonetic", "goalTags", "difficulty", "status", "sourceRef", "contentVersion", "updatedAt")
    SELECT x.id, x.lemma, x."normalizedLemma", x.phonetic, x."goalTags", x.difficulty, 'published', $2, $3, NOW()
    FROM jsonb_to_recordset($1::jsonb) AS x(id text, lemma text, "normalizedLemma" text, phonetic text, "goalTags" text[], difficulty int)
    ON CONFLICT ("normalizedLemma") DO NOTHING`,
    [input, `pack:${packId}`, packId],
  );
  const updated = await client.query(
    `
    UPDATE "Word" w SET "phonetic"=x.phonetic, "goalTags"=x."goalTags", "difficulty"=x.difficulty, "sourceRef"=$2, "contentVersion"=$3, "updatedAt"=NOW()
    FROM jsonb_to_recordset($1::jsonb) AS x("normalizedLemma" text, phonetic text, "goalTags" text[], difficulty int)
    WHERE w."normalizedLemma"=x."normalizedLemma" AND w."contentVersion" LIKE 'demo-%' AND w."sourceRef"='NightStudy original demo'`,
    [input, `pack:${packId}`, packId],
  );
  const senses = await client.query(
    `
    INSERT INTO "Sense" ("id", "wordId", "pos", "definitionZh", "definitionEn", "exampleEn", "exampleZh", "ordinal")
    SELECT s.id, w.id, s.pos, s."definitionZh", s."definitionEn", '', '',
      CASE WHEN w."sourceRef"=$2 THEN s.ordinal ELSE s.ordinal + 40000 END
    FROM jsonb_to_recordset($1::jsonb) AS s(id text, "normalizedLemma" text, pos text, "definitionZh" text, "definitionEn" text, ordinal int)
    JOIN "Word" w ON w."normalizedLemma"=s."normalizedLemma"
    ON CONFLICT ("id") DO NOTHING`,
    [JSON.stringify(entries.flatMap((entry) => entry.senses)), `pack:${packId}`],
  );
  await client.query(
    `
    INSERT INTO content_book_entries ("normalizedLemma", "goalTags", "frequencyRank")
    SELECT x."normalizedLemma", x."goalTags", x."frequencyRank"
    FROM jsonb_to_recordset($1::jsonb) AS x("normalizedLemma" text, "goalTags" text[], "frequencyRank" int, "focusSenseId" text)
    WHERE cardinality(x."goalTags") > 0 AND x."focusSenseId" IS NOT NULL`,
    [input],
  );
  return {
    newWords: inserted.rowCount || 0,
    updatedDemoWords: updated.rowCount || 0,
    newSenses: senses.rowCount || 0,
  };
}

/** One transaction and one per-database/site lock: no partially published installation. */
export async function importContentIntoSite(
  site: Pick<SiteConfig, 'id' | 'databaseUrl'>,
  sourcePath: string,
  manifest: ContentManifest = loadContentManifest(),
  options: { batchSize?: number; onProgress?: (rows: number) => void } = {},
): Promise<ContentImportResult> {
  await verifyContentSource(sourcePath, manifest);
  const batchSize = options.batchSize ?? 1000;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000)
    throw new Error('invalid_content_batch_size');
  const client = new Client({ connectionString: site.databaseUrl, connectionTimeoutMillis: 10000 });
  const result: ContentImportResult = {
    siteId: site.id,
    packId: manifest.id,
    alreadyInstalled: false,
    sourceEntries: 0,
    newWords: 0,
    updatedDemoWords: 0,
    newSenses: 0,
    newBooks: 0,
  };
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('NightStudy content installer'), hashtext($1))`,
      [site.id],
    );
    const state = await client.query<{ siteId: string }>(
      `SELECT "siteId" FROM "SiteState" WHERE "id"='singleton' FOR UPDATE`,
    );
    if (state.rows[0]?.siteId !== site.id)
      throw new Error('content_database_site_binding_mismatch');
    const previous = await client.query<{ status: string; sha256: string }>(
      `SELECT "status", "sha256" FROM "ContentPack" WHERE "id"=$1`,
      [manifest.id],
    );
    if (previous.rows.length) {
      if (previous.rows[0]?.status !== 'ready' || previous.rows[0]?.sha256 !== manifest.sha256)
        throw new Error('conflicting_installed_content_pack');
      result.alreadyInstalled = true;
      result.sourceEntries = manifest.statistics.entryCount;
      await client.query('COMMIT');
      return result;
    }
    await client.query(
      `CREATE TEMP TABLE content_book_entries ("normalizedLemma" text PRIMARY KEY, "goalTags" text[] NOT NULL, "frequencyRank" int NOT NULL) ON COMMIT DROP`,
    );
    let batch: SourceEntry[] = [];
    const counts = { phoneticCount: 0, definitionZhCount: 0, definitionEnCount: 0 };
    const tagCounts: Record<string, number> = {};
    const write = async () => {
      const changed = await writeBatch(client, batch, manifest.id);
      result.newWords += changed.newWords;
      result.updatedDemoWords += changed.updatedDemoWords;
      result.newSenses += changed.newSenses;
      batch = [];
      options.onProgress?.(result.sourceEntries);
    };
    for await (const row of readEcdict(sourcePath)) {
      result.sourceEntries++;
      if (row.phonetic.trim()) counts.phoneticCount++;
      if (row.translation.trim()) counts.definitionZhCount++;
      if (row.definition.trim()) counts.definitionEnCount++;
      for (const tag of row.tag.split(/\s+/).filter(Boolean))
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      batch.push(mapEcdictRow(row));
      if (batch.length >= batchSize) await write();
    }
    if (batch.length) await write();
    if (
      result.sourceEntries !== manifest.statistics.entryCount ||
      Object.entries(counts).some(
        ([key, value]) => value !== manifest.statistics[key as keyof typeof counts],
      )
    )
      throw new Error('source_statistics_mismatch');
    if (
      JSON.stringify(Object.entries(tagCounts).sort()) !==
      JSON.stringify(Object.entries(manifest.statistics.tagCounts).sort())
    )
      throw new Error('source_tag_statistics_mismatch');
    for (const goal of goals) {
      const bookId = `content-${manifest.id}-${goal}`;
      const created = await client.query(
        `INSERT INTO "Book" ("id", "slug", "title", "description", "goal", "status", "version", "updatedAt") VALUES ($1,$1,$2,$3,$4,'published',$5,NOW()) ON CONFLICT ("id") DO NOTHING RETURNING "id"`,
        [
          bookId,
          goalLabels[goal],
          `ECDICT固定基础CSV ${manifest.version}。完整导入上游对应标签/频率规则范围，不是官方考试大纲或CEFR等级；原始释义无例句。`,
          goal,
          manifest.id,
        ],
      );
      if (!created.rowCount) continue;
      result.newBooks++;
      const count = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM content_book_entries WHERE $1=ANY("goalTags")`,
        [goal],
      );
      if (count.rows[0]?.count !== manifest.statistics.bookCounts[goal])
        throw new Error('source_book_statistics_mismatch');
      await client.query(
        `
        INSERT INTO "BookItem" ("id", "bookId", "wordId", "focusSenseId", "ordinal")
        SELECT $1 || ':' || w.id, $1, w.id,
          (SELECT s.id FROM "Sense" s WHERE s."wordId"=w.id AND btrim(s."definitionZh")<>'' ORDER BY s.ordinal,s.id LIMIT 1),
          (row_number() OVER (ORDER BY e."frequencyRank", e."normalizedLemma" COLLATE "C") - 1)::int
        FROM content_book_entries e JOIN "Word" w ON w."normalizedLemma"=e."normalizedLemma" WHERE $2=ANY(e."goalTags")`,
        [bookId, goal],
      );
    }
    await client.query(
      `INSERT INTO "ContentPack" ("id", "version", "status", "sourceUrl", "sha256", "license", "entryCount", "phoneticCount", "definitionZhCount", "definitionEnCount", "tagCounts", "installedAt", "updatedAt") VALUES ($1,$2,'ready',$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW(),NOW())`,
      [
        manifest.id,
        manifest.version,
        manifest.sourceUrl,
        manifest.sha256,
        manifest.license,
        result.sourceEntries,
        counts.phoneticCount,
        counts.definitionZhCount,
        counts.definitionEnCount,
        JSON.stringify(tagCounts),
      ],
    );
    await client.query(`UPDATE "SiteState" SET "contentVersion"=$1 WHERE "id"='singleton'`, [
      manifest.id,
    ]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

export async function importContentIntoSites(
  sites: Pick<SiteConfig, 'id' | 'databaseUrl'>[],
  sourcePath = contentSourcePath(),
): Promise<ContentImportResult[]> {
  const manifest = loadContentManifest();
  await verifyContentSource(sourcePath, manifest);
  const results: ContentImportResult[] = [];
  for (const site of sites)
    results.push(
      await importContentIntoSite(site, sourcePath, manifest, {
        onProgress: (rows) => {
          if (rows % 50000 === 0)
            console.log(
              JSON.stringify({ action: 'content.import.progress', siteId: site.id, rows }),
            );
        },
      }),
    );
  return results;
}

export async function prepareContentSource(sites: Pick<SiteConfig, 'id' | 'databaseUrl'>[]) {
  const sourcePath = await fetchContentSource();
  return importContentIntoSites(sites, sourcePath);
}
