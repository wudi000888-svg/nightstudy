import fs from 'node:fs/promises';
import { existsSync, createWriteStream, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { z } from 'zod';
import { readConfig } from '../apps/api/src/config.js';
import {
  audioEntry,
  audioCacheRoot,
  audioPython,
  verifiedAudioBytes,
} from '../apps/api/src/audio.js';

const pinnedSource = z.object({
  url: z.string().url().startsWith('https://'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 ** 3),
});
const packSource = z
  .object({
    id: z.enum(['audio-v1', 'phrase-audio-v1']),
    status: z.literal('ready'),
    source: pinnedSource,
    lemmaCount: z.number().int().positive(),
    entryCount: z.number().int().positive(),
    sourceManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine(
    (source) =>
      source.id === 'audio-v1'
        ? source.lemmaCount === 8798 && source.entryCount === 17596
        : source.lemmaCount === 437 && source.entryCount === 874,
    'audio_scope_mismatch',
  );
const builtPack = z
  .object({
    schemaVersion: z.literal(1),
    version: z.literal('audio-v1'),
    status: z.literal('ready'),
    sourceManifestSha256: z.string(),
    statistics: z
      .object({
        lemmaCount: z.number(),
        entryCount: z.number(),
        recordedCount: z.number(),
        synthesizedCount: z.number(),
        failedCount: z.literal(0),
      })
      .passthrough(),
    entries: z.array(audioEntry).max(20000),
  })
  .passthrough();
async function ensureCacheDirectory(directory: string) {
  const root = audioCacheRoot();
  const relative = path.relative(root, directory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('audio_cache_path_invalid');
  await fs.mkdir(root, { recursive: true });
  let current = root;
  for (const component of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('audio_cache_directory_invalid');
  }
}
async function atomicCacheFile(filename: string, bytes: Buffer) {
  await ensureCacheDirectory(path.dirname(filename));
  const temporary = `${filename}.part-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
async function fileHash(filename: string) {
  const hash = createHash('sha256');
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      new Transform({
        transform(chunk: Buffer, _, cb) {
          hash.update(chunk);
          cb();
        },
      }),
    );
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}
async function pinnedDownload(filename: string, source: z.infer<typeof pinnedSource>) {
  await ensureCacheDirectory(path.dirname(filename));
  const stat = await fs.lstat(filename).catch(() => null);
  if (
    stat?.isFile() &&
    !stat.isSymbolicLink() &&
    stat.size === source.sizeBytes &&
    (await fileHash(filename)) === source.sha256
  )
    return;
  const response = await fetch(source.url, {
    signal: AbortSignal.timeout(300000),
    redirect: 'follow',
    credentials: 'omit',
  });
  if (
    !response.ok ||
    !response.body ||
    !response.url.startsWith('https://') ||
    Number(response.headers.get('content-length')) > source.sizeBytes
  )
    throw new Error('audio_download_failed');
  const temporary = `${filename}.part-${randomUUID()}`,
    hash = createHash('sha256');
  let length = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      new Transform({
        transform(chunk: Buffer, _, cb) {
          length += chunk.length;
          if (length > source.sizeBytes) {
            cb(new Error('audio_download_too_large'));
            return;
          }
          hash.update(chunk);
          cb(null, chunk);
        },
      }),
      createWriteStream(temporary, { flags: 'wx', mode: 0o644 }),
    );
    if (length !== source.sizeBytes || hash.digest('hex') !== source.sha256)
      throw new Error('audio_download_hash_mismatch');
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
export async function installAudioFiles(source: z.infer<typeof packSource>) {
  const root = audioCacheRoot(),
    archive = path.join(root, `downloads/${source.id}.tar.gz`),
    marker = path.join(root, `${source.id}.manifest.json`);
  await ensureCacheDirectory(path.join(root, 'files'));
  await ensureCacheDirectory(path.join(root, 'licenses'));
  let manifest: z.infer<typeof builtPack> | undefined;
  try {
    const handle = await fs.open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 32 * 1024 ** 2) throw new Error('audio_manifest_invalid');
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (createHash('sha256').update(bytes).digest('hex') === source.manifestSha256)
      manifest = builtPack.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    /* Install a missing or invalid pack. */
  }
  if (manifest?.sourceManifestSha256 !== source.sourceManifestSha256) manifest = undefined;
  if (manifest) {
    try {
      if (
        (await fileHash(path.join(root, 'sources.manifest.json'))) !== source.sourceManifestSha256
      )
        throw new Error('audio_sources_hash_mismatch');
      await validateAudioPack(manifest, source);
      return manifest;
    } catch {
      manifest = undefined; /* Recover lost or corrupt media from the pinned archive. */
    }
  }
  if (!manifest) {
    await pinnedDownload(archive, source.source);
    const staging = path.join(root, `.extract-${randomUUID()}`);
    try {
      const extracted = spawnSync(
        audioPython(),
        ['scripts/audio-extract.py', '--archive', archive, '--output', staging],
        { timeout: 300000, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 16384 },
      );
      if (extracted.status !== 0) throw new Error('audio_unpack_failed');
      const bytes = await fs.readFile(path.join(staging, 'manifest.json'));
      if (createHash('sha256').update(bytes).digest('hex') !== source.manifestSha256)
        throw new Error('audio_manifest_hash_mismatch');
      manifest = builtPack.parse(JSON.parse(bytes.toString('utf8')));
      if (manifest.sourceManifestSha256 !== source.sourceManifestSha256)
        throw new Error('audio_source_manifest_mismatch');
      const original = await fs.readFile(path.join(staging, 'sources.manifest.json'));
      if (createHash('sha256').update(original).digest('hex') !== source.sourceManifestSha256)
        throw new Error('audio_sources_hash_mismatch');
      await ensureCacheDirectory(path.join(root, 'files'));
      for (const filename of await fs.readdir(path.join(staging, 'files')))
        await fs.rename(path.join(staging, 'files', filename), path.join(root, 'files', filename));
      await ensureCacheDirectory(path.join(root, 'licenses'));
      for (const filename of await fs.readdir(path.join(staging, 'licenses')))
        await atomicCacheFile(
          path.join(root, 'licenses', filename),
          await fs.readFile(path.join(staging, 'licenses', filename)),
        );
      await atomicCacheFile(path.join(root, 'sources.manifest.json'), original);
      await atomicCacheFile(marker, bytes);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  await validateAudioPack(manifest, source);
  return manifest;
}
export async function validateAudioPack(
  manifest: z.infer<typeof builtPack>,
  source: z.infer<typeof packSource>,
) {
  const unique = new Set<string>(),
    lemmas = new Set<string>();
  let recorded = 0;
  for (let start = 0; start < manifest.entries.length; start += 8) {
    await Promise.all(
      manifest.entries.slice(start, start + 8).map(async (entry) => {
        const key = `${entry.lemma}:${entry.accent}`;
        if (unique.has(key)) throw new Error('audio_pack_duplicate');
        unique.add(key);
        lemmas.add(entry.lemma);
        if (entry.kind === 'recorded') recorded++;
        await verifiedAudioBytes(entry);
      }),
    );
  }
  if (
    unique.size !== source.entryCount ||
    lemmas.size !== source.lemmaCount ||
    recorded !== (source.id === 'audio-v1' ? 3 : 0) ||
    manifest.statistics.lemmaCount !== source.lemmaCount ||
    manifest.statistics.entryCount !== source.entryCount ||
    manifest.statistics.recordedCount !== recorded ||
    manifest.statistics.synthesizedCount !== source.entryCount - recorded
  )
    throw new Error('audio_pack_counts_mismatch');
}
export async function importAudioSite(
  site: ReturnType<typeof readConfig>['sites'][number],
  manifest: z.infer<typeof builtPack>,
  source: z.infer<typeof packSource>,
) {
  const client = new Client({ connectionString: site.databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(89124616)');
    const realm = await client.query<{ siteId: string }>(
      'SELECT "siteId" FROM "SiteState" WHERE "id"=\'singleton\'',
    );
    if (realm.rows[0]?.siteId !== site.id) throw new Error('audio_site_binding_mismatch');
    await client.query(
      'CREATE TEMP TABLE audio_import (lemma TEXT, accent TEXT, kind TEXT, source_name TEXT, source_url TEXT, license TEXT, attribution TEXT, file_key TEXT, sha TEXT, mime TEXT, ipa TEXT, ipa_source TEXT) ON COMMIT DROP',
    );
    for (let start = 0; start < manifest.entries.length; start += 1000)
      await client.query(
        'INSERT INTO audio_import SELECT * FROM jsonb_to_recordset($1::jsonb) AS d(lemma TEXT, accent TEXT, kind TEXT, source_name TEXT, source_url TEXT, license TEXT, attribution TEXT, file_key TEXT, sha TEXT, mime TEXT, ipa TEXT, ipa_source TEXT)',
        [
          JSON.stringify(
            manifest.entries.slice(start, start + 1000).map((e) => ({
              lemma: e.lemma,
              accent: e.accent,
              kind: e.kind,
              source_name: e.sourceName,
              source_url: e.sourceUrl,
              license: e.license,
              attribution: e.attribution,
              file_key: e.fileKey,
              sha: e.fileSha256,
              mime: e.mimeType,
              ipa: e.phonetic ?? '',
              ipa_source: e.phoneticSource ?? '',
            })),
          ),
        ],
      );
    const matched = await client.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM audio_import a JOIN "Word" w ON w."normalizedLemma"=a.lemma',
    );
    if (matched.rows[0]?.count !== source.entryCount)
      throw new Error('audio_dictionary_incomplete');
    for (const accent of ['US', 'UK'] as const) {
      const column = accent === 'US' ? 'phoneticUs' : 'phoneticUk';
      await client.query(
        `UPDATE "Word" w SET "${column}"=a.ipa, "phoneticSource"=concat_ws(';',NULLIF(w."phoneticSource",''),a.ipa_source),"updatedAt"=NOW() FROM audio_import a WHERE a.accent=$1 AND w."normalizedLemma"=a.lemma AND w."${column}"='' AND a.ipa<>''`,
        [accent],
      );
    }
    await client.query(
      `INSERT INTO "WordAudio" (id,"wordId",accent,kind,status,"sourceName","sourceUrl",license,attribution,"fileKey","fileSha256","mimeType","createdAt","updatedAt") SELECT 'wa_'||md5(w.id||a.accent),w.id,a.accent,a.kind,'ready',a.source_name,a.source_url,a.license,a.attribution,a.file_key,a.sha,a.mime,NOW(),NOW() FROM audio_import a JOIN "Word" w ON w."normalizedLemma"=a.lemma ON CONFLICT ("wordId",accent) ${source.id === 'phrase-audio-v1' ? 'DO NOTHING' : 'DO UPDATE SET kind=EXCLUDED.kind,status=\'ready\',"sourceName"=EXCLUDED."sourceName","sourceUrl"=EXCLUDED."sourceUrl",license=EXCLUDED.license,attribution=EXCLUDED.attribution,"fileKey"=EXCLUDED."fileKey","fileSha256"=EXCLUDED."fileSha256","mimeType"=EXCLUDED."mimeType","updatedAt"=NOW() WHERE ("WordAudio".kind,"WordAudio".status,"WordAudio"."sourceName","WordAudio"."sourceUrl","WordAudio".license,"WordAudio".attribution,"WordAudio"."fileKey","WordAudio"."fileSha256","WordAudio"."mimeType") IS DISTINCT FROM (EXCLUDED.kind,EXCLUDED.status,EXCLUDED."sourceName",EXCLUDED."sourceUrl",EXCLUDED.license,EXCLUDED.attribution,EXCLUDED."fileKey",EXCLUDED."fileSha256",EXCLUDED."mimeType")'}`,
    );
    await client.query(
      `INSERT INTO "ContentPack" (id,version,status,"sourceUrl",sha256,license,"entryCount","phoneticCount","definitionZhCount","definitionEnCount","tagCounts","installedAt","updatedAt") VALUES ($1,$1,'ready',$2,$3,'Per-entry MIT/CC-BY-SA-3.0/CC-BY-3.0-US',$4,0,0,0,$5::jsonb,NOW(),NOW()) ON CONFLICT (id) DO UPDATE SET status='ready',"sourceUrl"=EXCLUDED."sourceUrl",sha256=EXCLUDED.sha256,"entryCount"=EXCLUDED."entryCount","tagCounts"=EXCLUDED."tagCounts","updatedAt"=NOW() WHERE ("ContentPack".status,"ContentPack"."sourceUrl","ContentPack".sha256,"ContentPack"."entryCount","ContentPack"."tagCounts") IS DISTINCT FROM (EXCLUDED.status,EXCLUDED."sourceUrl",EXCLUDED.sha256,EXCLUDED."entryCount",EXCLUDED."tagCounts")`,
      [
        source.id,
        source.source.url,
        source.source.sha256,
        source.entryCount,
        JSON.stringify({
          kind: 'audio',
          ...manifest.statistics,
          note: 'Synthesized entries are explicitly labeled; not expert-certified.',
        }),
      ],
    );
    await client.query('COMMIT');
    console.log(JSON.stringify({ action: 'audio.ready', siteId: site.id, ...manifest.statistics }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const profile =
    process.env.AUDIO_PACK || (process.env.CONTENT_PACK === 'demo' ? 'none' : 'standard');
  if (profile === 'none') {
    console.log(JSON.stringify({ action: 'audio.skipped', profile }));
    return;
  }
  if (profile !== 'standard') throw new Error('invalid_audio_profile');
  const root = audioCacheRoot();
  await ensureCacheDirectory(root);
  // Unique staging paths and atomic renames make cache writes restartable.
  // Per-site database imports have a PostgreSQL advisory lock.
  {
    const source = packSource.parse(
      JSON.parse(await fs.readFile('data/audio-pack.manifest.json', 'utf8')),
    );
    const voices = JSON.parse(await fs.readFile('data/audio-voices.manifest.json', 'utf8')) as {
      voices: Record<
        string,
        {
          model: z.infer<typeof pinnedSource> & { fileName: string };
          config: z.infer<typeof pinnedSource> & { fileName: string };
        }
      >;
    };
    for (const accent of ['US', 'UK'])
      for (const item of [voices.voices[accent]!.model, voices.voices[accent]!.config]) {
        if (!/^[A-Za-z0-9_.-]+$/.test(item.fileName))
          throw new Error('audio_model_filename_invalid');
        await pinnedDownload(path.join(root, 'models', item.fileName), pinnedSource.parse(item));
      }
    const manifest = await installAudioFiles(source);
    for (const site of readConfig().sites) await importAudioSite(site, manifest, source);
    if (process.env.CONTENT_PACK !== 'demo') {
      const phrases = packSource.parse(
        JSON.parse(await fs.readFile('data/phrase-audio.manifest.json', 'utf8')),
      );
      const phraseManifest = await installAudioFiles(phrases);
      for (const site of readConfig().sites) await importAudioSite(site, phraseManifest, phrases);
    }
  }
}
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(
      'Audio installation failed; check the pinned pack, disk space and source availability. No partial database transaction was committed.',
    );
    process.exitCode = 1;
  });
