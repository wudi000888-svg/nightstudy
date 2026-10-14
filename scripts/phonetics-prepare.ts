import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { readConfig, type SiteConfig } from '../apps/api/src/config.js';
import { phoneticsPacks, parsePhoneticsTsv, sha256, type PhoneticsPack } from './phonetics-lib.js';

async function pinnedFile(filename: string, source: { url: string; sha256: string }) {
  let bytes: Buffer | undefined;
  try {
    bytes = await fs.readFile(filename);
  } catch {
    /* Fetch a missing cache file. */
  }
  if (bytes && sha256(bytes) === source.sha256) return bytes;
  const response = await fetch(source.url, {
    signal: AbortSignal.timeout(45000),
    redirect: 'error',
    credentials: 'omit',
  });
  if (!response.ok || Number(response.headers.get('content-length')) > 16 * 1024 * 1024)
    throw new Error('Pinned phonetics source could not be downloaded');
  if (!response.body) throw new Error('Pinned phonetics source response is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 16 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('Pinned phonetics source exceeds the download limit');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  bytes = Buffer.concat(chunks);
  if (bytes.byteLength > 16 * 1024 * 1024 || sha256(bytes) !== source.sha256)
    throw new Error('Phonetics source SHA-256 does not match the pinned manifest');
  const temporary = `${filename}.part-${randomUUID()}`;
  await fs.writeFile(temporary, bytes);
  await fs.rename(temporary, filename);
  return bytes;
}

async function prepare(pack: PhoneticsPack, directory: string) {
  const root = path.join(directory, pack.id);
  await fs.mkdir(root, { recursive: true });
  const bytes = await pinnedFile(path.join(root, 'source.tsv'), {
    url: pack.sourceUrl,
    sha256: pack.sha256,
  });
  for (const license of pack.licenses) await pinnedFile(path.join(root, license.filename), license);
  await fs.writeFile(
    path.join(root, 'NOTICE.txt'),
    [
      `NightStudy independent phonetics data pack: ${pack.id}`,
      `Original data: open-dict-data/ipa-dict, commit ${pack.version}, by dohliam and contributors.`,
      `Source: ${pack.sourceUrl}`,
      `License: ${pack.license}. Application code MIT does not relicense this data.`,
      pack.locale === 'en-US'
        ? 'US data derives from cmudict-ipa by Lingliang Zhang and Carnegie Mellon CMUdict. Retain all accompanying MIT/BSD notices.'
        : 'UK data derives from ipacards by leoboiko (upstream now melissaboiko), licensed under GPL version 3. Retain source.tsv and accompanying GPL license when redistributing this data.',
      'Source IPA strings and their variants are retained without modification. Transcriptions may contain errors; this pack contains no audio.',
      '',
    ].join('\n'),
  );
  const parsed = parsePhoneticsTsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (parsed.sourceEntryCount !== pack.sourceEntryCount)
    throw new Error('Phonetics source row count does not match the pinned manifest');
  await fs.writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify(
      {
        id: pack.id,
        locale: pack.locale,
        version: pack.version,
        license: pack.license,
        sourceUrl: pack.sourceUrl,
        sha256: pack.sha256,
        sourceEntryCount: parsed.sourceEntryCount,
        normalizedEntryCount: parsed.entries.length,
        licenses: pack.licenses,
        note: 'Separate source dataset; app code MIT does not relicense this data. IPA variants are retained; no audio is included.',
      },
      null,
      2,
    ) + '\n',
  );
  return parsed;
}

async function importPack(
  client: Client,
  pack: PhoneticsPack,
  parsed: ReturnType<typeof parsePhoneticsTsv>,
) {
  if (!['phoneticUs', 'phoneticUk'].includes(pack.column))
    throw new Error('Invalid phonetics target column');
  await client.query(
    'CREATE TEMP TABLE nightstudy_ipa (normalized_lemma TEXT PRIMARY KEY, ipa TEXT NOT NULL) ON COMMIT DROP',
  );
  for (let start = 0; start < parsed.entries.length; start += 2000) {
    await client.query(
      'INSERT INTO nightstudy_ipa SELECT normalized_lemma, ipa FROM jsonb_to_recordset($1::jsonb) AS data(normalized_lemma TEXT, ipa TEXT)',
      [
        JSON.stringify(
          parsed.entries
            .slice(start, start + 2000)
            .map((entry) => ({ normalized_lemma: entry.normalizedLemma, ipa: entry.ipa })),
        ),
      ],
    );
  }
  // column comes only from the fixed manifest enum, never from an HTTP/CLI value.
  const matched = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM "Word" word JOIN nightstudy_ipa ipa ON word."normalizedLemma"=ipa.normalized_lemma`,
  );
  await client.query(
    `UPDATE "Word" AS word SET "${pack.column}" = ipa.ipa,
    "phoneticSource" = CASE WHEN position($1 in word."phoneticSource") > 0 THEN word."phoneticSource"
      ELSE concat_ws(';', nullif(word."phoneticSource", ''), $1) END, "updatedAt" = NOW()
    FROM nightstudy_ipa ipa WHERE word."normalizedLemma" = ipa.normalized_lemma AND word."${pack.column}"=''`,
    [pack.id],
  );
  const matchedWords = matched.rows[0]!.count;
  await client.query(
    `INSERT INTO "ContentPack" ("id","version","status","sourceUrl","sha256","license","entryCount","phoneticCount","definitionZhCount","definitionEnCount","tagCounts","installedAt","updatedAt")
    VALUES ($1,$2,'ready',$3,$4,$5,$6,$6,0,0,$7::jsonb,NOW(),NOW()) ON CONFLICT ("id") DO UPDATE SET
    "version"=EXCLUDED."version","status"=EXCLUDED."status","sourceUrl"=EXCLUDED."sourceUrl",
    "sha256"=EXCLUDED."sha256","license"=EXCLUDED."license",
    "entryCount"=EXCLUDED."entryCount","phoneticCount"=EXCLUDED."phoneticCount",
    "definitionZhCount"=EXCLUDED."definitionZhCount","definitionEnCount"=EXCLUDED."definitionEnCount",
    "tagCounts"="ContentPack"."tagCounts" || EXCLUDED."tagCounts","updatedAt"=NOW()
    WHERE ("ContentPack"."version","ContentPack"."status","ContentPack"."sourceUrl",
      "ContentPack"."sha256","ContentPack"."license","ContentPack"."entryCount",
      "ContentPack"."phoneticCount","ContentPack"."definitionZhCount","ContentPack"."definitionEnCount","ContentPack"."tagCounts")
    IS DISTINCT FROM (EXCLUDED."version",EXCLUDED."status",EXCLUDED."sourceUrl",
      EXCLUDED."sha256",EXCLUDED."license",EXCLUDED."entryCount",EXCLUDED."phoneticCount",
      EXCLUDED."definitionZhCount",EXCLUDED."definitionEnCount","ContentPack"."tagCounts" || EXCLUDED."tagCounts")`,
    [
      pack.id,
      pack.version,
      pack.sourceUrl,
      pack.sha256,
      pack.license,
      matchedWords,
      JSON.stringify({
        kind: 'phonetics',
        locale: pack.locale,
        sourceEntryCount: parsed.sourceEntryCount,
        normalizedEntryCount: parsed.entries.length,
        matchedWordCount: matchedWords,
      }),
    ],
  );
  await client.query('DROP TABLE nightstudy_ipa');
  return matchedWords;
}

type PreparedPhoneticsPack = {
  pack: PhoneticsPack;
  parsed: ReturnType<typeof parsePhoneticsTsv>;
};
type Coverage = { words: number; us: number; uk: number; either: number; legacy: number };

async function importSite(
  site: Pick<SiteConfig, 'id' | 'databaseUrl'>,
  prepared: readonly PreparedPhoneticsPack[],
  coveragePackIds: readonly string[],
) {
  if (
    coveragePackIds.length > 2 ||
    coveragePackIds.some((id) => !/^[A-Za-z0-9_-]{1,160}$/.test(id))
  )
    throw new Error('Invalid phonetics coverage scope');
  const client = new Client({ connectionString: site.databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(89124615)');
    const state = await client.query<{ siteId: string }>(
      'SELECT "siteId" FROM "SiteState" WHERE "id"=\'singleton\'',
    );
    if (state.rows[0]?.siteId !== site.id) throw new Error('phonetics_site_binding_mismatch');
    const matchedPacks = [];
    for (const { pack, parsed } of prepared)
      matchedPacks.push({ id: pack.id, matchedWords: await importPack(client, pack, parsed) });
    const result = await client.query<Coverage>(`SELECT
      COUNT(*)::int AS words, COUNT(*) FILTER (WHERE "phoneticUs" <> '')::int AS us,
      COUNT(*) FILTER (WHERE "phoneticUk" <> '')::int AS uk,
      COUNT(*) FILTER (WHERE "phoneticUs" <> '' OR "phoneticUk" <> '')::int AS either,
      COUNT(*) FILTER (WHERE "phonetic" <> '')::int AS legacy FROM "Word" WHERE "status"='published'`);
    const coverage = result.rows[0]!;
    const updated = await client.query(
      `UPDATE "ContentPack" SET "tagCounts" = "tagCounts" || jsonb_build_object('coverage', $1::jsonb), "updatedAt"=NOW()
       WHERE "id"=ANY($2::text[]) AND status='ready' AND "tagCounts"->>'kind'='phonetics'
         AND "tagCounts"->'coverage' IS DISTINCT FROM $1::jsonb`,
      [JSON.stringify(coverage), coveragePackIds],
    );
    await client.query('COMMIT');
    return { matchedPacks, coverage, coverageUpdatedPacks: updated.rowCount ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

/** SQL phase after fixed files/row counts have been verified; does not download data. */
export async function importPhoneticsSite(
  site: Pick<SiteConfig, 'id' | 'databaseUrl'>,
  prepared: readonly PreparedPhoneticsPack[],
) {
  return importSite(
    site,
    prepared,
    prepared.map(({ pack }) => pack.id),
  );
}

/** Refreshes derived coverage only: does not download, fill IPA, create or reinstall packs. */
export async function refreshPhoneticsCoverage(
  site: Pick<SiteConfig, 'id' | 'databaseUrl'>,
  packIds: readonly string[] = [phoneticsPacks.us.id, phoneticsPacks.uk.id],
) {
  return importSite(site, [], packIds);
}

async function main() {
  const { values } = parseArgs({
    options: {
      site: { type: 'string' },
      locale: { type: 'string', default: 'both' },
      directory: { type: 'string', default: '.local/content/phonetics' },
      'fetch-only': { type: 'boolean', default: false },
      'refresh-coverage-only': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!['both', 'us', 'uk'].includes(values.locale!))
    throw new Error('Use --locale both, us or uk');
  const packs =
    values.locale === 'both'
      ? [phoneticsPacks.us, phoneticsPacks.uk]
      : [phoneticsPacks[values.locale as 'us' | 'uk']];
  if (values['refresh-coverage-only']) {
    if (values['fetch-only']) throw new Error('Coverage refresh does not fetch source files');
    if (existsSync('.env')) process.loadEnvFile('.env');
    const config = readConfig();
    const sites = values.site
      ? config.sites.filter((site) => site.id === values.site)
      : config.sites;
    if (!sites.length) throw new Error('Choose a configured site with --site <id>');
    for (const site of sites) {
      const result = await refreshPhoneticsCoverage(
        site,
        packs.map((pack) => pack.id),
      );
      console.log(
        `${site.id}: refreshed installed IPA coverage ${JSON.stringify(result.coverage)} (${result.coverageUpdatedPacks} changed packs); no source or word data installed`,
      );
    }
    return;
  }
  const prepared = [];
  for (const pack of packs) {
    const parsed = await prepare(pack, path.resolve(values.directory!));
    prepared.push({ pack, parsed });
    console.log(`${pack.id}: verified ${parsed.sourceEntryCount} source entries (${pack.license})`);
  }
  if (values['fetch-only']) return;
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = readConfig();
  const site = values.site
    ? config.sites.find((candidate) => candidate.id === values.site)
    : config.sites.length === 1
      ? config.sites[0]
      : undefined;
  if (!site) throw new Error('Choose one configured site explicitly with --site <id>');
  const result = await importPhoneticsSite(site, prepared);
  for (const pack of result.matchedPacks)
    console.log(`${site.id}/${pack.id}: matched ${pack.matchedWords} existing words`);
  console.log(
    `${site.id}: committed IPA coverage ${JSON.stringify(result.coverage)}; word IDs and review history retained`,
  );
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    // Avoid printing driver errors, SQL or connection strings.
    const name = error instanceof Error ? error.name : 'UnknownError';
    const candidate =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
    console.error('Phonetics preparation failed; no partial transaction was committed', {
      name: /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : 'Error',
      code: /^[A-Za-z0-9_]{1,64}$/.test(candidate) ? candidate : 'UNKNOWN',
    });
    process.exitCode = 1;
  });
