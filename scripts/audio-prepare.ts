import fs from 'node:fs/promises';
import { existsSync, createWriteStream, constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { z } from 'zod';
import { readSentenceAudioCollection, sentenceAudioPackId } from './audio-collection.js';
import {
  loadSentenceAudioPolicy,
  parseSentenceAudioHoldPolicy,
  sentenceAudioIdentity,
  type SentenceAudioPolicy,
} from '../apps/api/src/sentence-audio-policy.js';
import { readConfig } from '../apps/api/src/config.js';
import {
  audioEntry,
  audioCacheRoot,
  audioPython,
  verifiedAudioBytes,
  sentenceTextHash,
  normalizeSentenceText,
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
    id: z.union([
      z.enum([
        'audio-v1',
        'phrase-audio-v1',
        'recorded-audio-v2',
        'word-audio-v2',
        'sentence-audio-v1',
        'sentence-audio-v2',
        'sentence-audio-v3',
      ]),
      sentenceAudioPackId,
    ]),
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
        : source.id === 'phrase-audio-v1'
          ? source.lemmaCount === 437 && source.entryCount === 874
          : source.lemmaCount <= 100000 && source.entryCount <= 200000,
    'audio_scope_mismatch',
  );
const builtPack = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    version: z.union([
      z.enum([
        'audio-v1',
        'recorded-audio-v2',
        'word-audio-v2',
        'sentence-audio-v1',
        'sentence-audio-v2',
        'sentence-audio-v3',
      ]),
      sentenceAudioPackId,
    ]),
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
    entries: z
      .array(
        audioEntry.extend({
          lemma: z.string().min(1).max(3000),
          textHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          text: z.string().min(1).max(3000).optional(),
        }),
      )
      .max(200000),
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

/** Call only after full pack/media/sidecar validation; never trust a cache name alone. */
export async function releaseInstalledAudioArchive(
  source: Pick<z.infer<typeof packSource>, 'id' | 'source'>,
) {
  const retain = process.env.AUDIO_RETAIN_ARCHIVES ?? 'false';
  if (!['true', 'false'].includes(retain)) throw new Error('invalid_audio_retain_archives');
  if (retain === 'true') return;
  if (!/^[a-z0-9-]+$/.test(source.id)) throw new Error('audio_archive_cleanup_source_invalid');
  const directory = path.join(audioCacheRoot(), 'downloads');
  const archive = path.join(directory, `${source.id}.tar.gz`);
  const identity = (value: BigIntStats) =>
    `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
  try {
    const folder = await fs.lstat(directory, { bigint: true });
    if (!folder.isDirectory() || folder.isSymbolicLink())
      throw new Error('audio_archive_cleanup_directory_invalid');
    const before = await fs.lstat(archive, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size !== BigInt(source.source.sizeBytes)
    )
      throw new Error('audio_archive_cleanup_file_invalid');
    const checksum = await fileHash(archive);
    const after = await fs.lstat(archive, { bigint: true });
    const currentFolder = await fs.lstat(directory, { bigint: true });
    if (
      checksum !== source.source.sha256 ||
      identity(before) !== identity(after) ||
      !currentFolder.isDirectory() ||
      currentFolder.isSymbolicLink() ||
      folder.dev !== currentFolder.dev ||
      folder.ino !== currentFolder.ino
    )
      throw new Error('audio_archive_cleanup_unverified');
    await fs.unlink(archive);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('audio_archive_cleanup_failed', { cause: error });
  }
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
async function smallAudioMetadata(filename: string, limit: number) {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('audio_review_file_invalid');
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw new Error('audio_review_file_changed');
    return bytes;
  } finally {
    await handle.close();
  }
}
const reviewFilePin = z
  .object({
    fileName: z.string(),
    bytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .passthrough();

/** Verify exact publication sidecars before caching or trusting an installed marker. */
export async function validateAudioPublicationSidecars(
  source: z.infer<typeof packSource>,
  manifest: z.infer<typeof builtPack>,
  sourceMetadata: unknown,
  readSidecar: (name: string) => Promise<Buffer>,
  policy = loadSentenceAudioPolicy(),
) {
  const metadata = z
    .object({
      pronunciationReviews: reviewFilePin.optional(),
      pronunciationHolds: reviewFilePin
        .extend({
          holdCount: z.number().int().nonnegative().max(5000),
          appliedClipCount: z.number().int().nonnegative(),
        })
        .optional(),
    })
    .passthrough()
    .parse(sourceMetadata);
  const files: { name: string; bytes: Buffer }[] = [];
  for (const [field, name] of [
    ['pronunciationReviews', 'pronunciation-reviews.json'],
    ['pronunciationHolds', 'pronunciation-holds.json'],
  ] as const) {
    const pin = metadata[field];
    if (!pin) continue;
    if (pin.fileName !== name) throw new Error('audio_review_sidecar_path_invalid');
    const bytes = await readSidecar(name);
    if (
      bytes.length !== pin.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== pin.sha256
    )
      throw new Error('audio_review_sidecar_checksum');
    files.push({ name, bytes });
    if (field === 'pronunciationHolds') {
      const held = parseSentenceAudioHoldPolicy(bytes);
      if (
        !policy.manifest ||
        pin.sha256 !== policy.manifest.sha256 ||
        held.entries.length !== metadata.pronunciationHolds!.holdCount
      )
        throw new Error('audio_publication_policy_not_installed');
      const rows = z
        .array(
          z
            .object({
              textHash: z.string().regex(/^[a-f0-9]{64}$/),
              text: z.string(),
              references: z.array(
                z.object({ learningSenseId: z.string(), exampleId: z.string() }).passthrough(),
              ),
            })
            .passthrough(),
        )
        .parse(metadata.requestedSentences);
      const byHash = new Map(rows.map((row) => [row.textHash, row]));
      if (
        byHash.size !== rows.length ||
        rows.some(
          (row) =>
            normalizeSentenceText(row.text) !== row.text ||
            sentenceTextHash(row.text) !== row.textHash,
        )
      )
        throw new Error('audio_publication_requested_scope_invalid');
      const applicable = new Map(
        held.entries
          .filter((entry) => byHash.has(entry.textHash))
          .map((entry) => [sentenceAudioIdentity(entry.textHash, entry.accent), entry]),
      );
      for (const entry of applicable.values()) {
        const row = byHash.get(entry.textHash)!;
        if (
          row.text !== entry.text ||
          !row.references.some(
            (ref) =>
              ref.learningSenseId === entry.learningSenseId && ref.exampleId === entry.exampleId,
          )
        )
          throw new Error('audio_publication_hold_reference_mismatch');
      }
      const references = z
        .array(
          z
            .object({
              holdId: z.string(),
              textHash: z.string(),
              accent: z.enum(['US', 'UK']),
              learningSenseId: z.string(),
              exampleId: z.string(),
              riskCategory: z.string(),
            })
            .strict(),
        )
        .parse(metadata.heldMediaReferences);
      const referenceKeys = new Set<string>();
      for (const reference of references) {
        const identity = sentenceAudioIdentity(reference.textHash, reference.accent);
        const entry = applicable.get(identity);
        if (
          !entry ||
          referenceKeys.has(identity) ||
          reference.holdId !== entry.id ||
          reference.learningSenseId !== entry.learningSenseId ||
          reference.exampleId !== entry.exampleId ||
          reference.riskCategory !== entry.riskCategory
        )
          throw new Error('audio_publication_hold_reference_mismatch');
        referenceKeys.add(identity);
      }
      const reused = z
        .array(z.object({ textHash: z.string(), accent: z.enum(['US', 'UK']) }).passthrough())
        .parse(metadata.reusedMediaReferences);
      const eligible = new Set(
        rows
          .flatMap((row) =>
            ['US', 'UK'].map((accent) => sentenceAudioIdentity(row.textHash, accent)),
          )
          .filter((identity) => !applicable.has(identity)),
      );
      const readyKeys = new Set<string>();
      for (const entry of [...manifest.entries, ...reused]) {
        const identity = sentenceAudioIdentity(entry.textHash!, entry.accent);
        if (!eligible.has(identity) || readyKeys.has(identity))
          throw new Error('audio_publication_held_or_duplicate_media');
        readyKeys.add(identity);
      }
      const coverage = z
        .object({
          requestedSentenceCount: z.number().int().nonnegative(),
          requestedClipCount: z.number().int().nonnegative(),
          reusedClipCount: z.number().int().nonnegative(),
          generatedClipCount: z.number().int().nonnegative(),
          fullyReusedSentenceCount: z.number().int().nonnegative(),
          partiallyReusedSentenceCount: z.number().int().nonnegative(),
          heldClipCount: z.number().int().nonnegative(),
          eligibleClipCount: z.number().int().nonnegative(),
          heldSentenceCount: z.number().int().nonnegative(),
          fullyHeldSentenceCount: z.number().int().nonnegative(),
        })
        .passthrough()
        .parse(metadata.coverage);
      const heldHashes = new Set([...applicable.values()].map((entry) => entry.textHash));
      const reusedCounts = new Map<string, number>();
      for (const entry of reused)
        reusedCounts.set(entry.textHash, (reusedCounts.get(entry.textHash) ?? 0) + 1);
      const fullyHeld = rows.filter((row) =>
        ['US', 'UK'].every((accent) => applicable.has(sentenceAudioIdentity(row.textHash, accent))),
      ).length;
      if (
        referenceKeys.size !== applicable.size ||
        metadata.pronunciationHolds!.appliedClipCount !== applicable.size ||
        readyKeys.size !== eligible.size ||
        coverage.requestedSentenceCount !== rows.length ||
        coverage.requestedClipCount !== rows.length * 2 ||
        coverage.generatedClipCount !== manifest.entries.length ||
        coverage.reusedClipCount !== reused.length ||
        coverage.fullyReusedSentenceCount !==
          [...reusedCounts.values()].filter((count) => count === 2).length ||
        coverage.partiallyReusedSentenceCount !==
          [...reusedCounts.values()].filter((count) => count === 1).length ||
        coverage.heldClipCount !== applicable.size ||
        coverage.eligibleClipCount !== eligible.size ||
        coverage.heldSentenceCount !== heldHashes.size ||
        coverage.fullyHeldSentenceCount !== fullyHeld
      )
        throw new Error('audio_publication_coverage_mismatch');
    }
  }
  if (source.id.startsWith('sentence-audio-v4') && policy.manifest && !metadata.pronunciationHolds)
    throw new Error('audio_publication_policy_missing_from_pack');
  return files;
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
      if (!stat.isFile() || stat.size > 128 * 1024 ** 2) throw new Error('audio_manifest_invalid');
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
        (await fileHash(path.join(root, `${source.id}.sources.manifest.json`))) !==
        source.sourceManifestSha256
      )
        throw new Error('audio_sources_hash_mismatch');
      await validateAudioPack(manifest, source);
      const metadata = JSON.parse(
        (
          await smallAudioMetadata(
            path.join(root, `${source.id}.sources.manifest.json`),
            32 * 1024 * 1024,
          )
        ).toString('utf8'),
      );
      await validateAudioPublicationSidecars(source, manifest, metadata, (name) =>
        smallAudioMetadata(path.join(root, `${source.id}.${name}`), 4 * 1024 * 1024),
      );
    } catch {
      manifest = undefined; /* Recover lost or corrupt media from the pinned archive. */
    }
    // Cleanup errors are not a reason to download or repair validated media.
    if (manifest) {
      await releaseInstalledAudioArchive(source);
      return manifest;
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
      const sidecars = await validateAudioPublicationSidecars(
        source,
        manifest,
        JSON.parse(original.toString('utf8')),
        (name) => smallAudioMetadata(path.join(staging, name), 4 * 1024 * 1024),
      );
      await ensureCacheDirectory(path.join(root, 'files'));
      for (const filename of await fs.readdir(path.join(staging, 'files')))
        await fs.rename(path.join(staging, 'files', filename), path.join(root, 'files', filename));
      await ensureCacheDirectory(path.join(root, 'licenses'));
      for (const filename of await fs.readdir(path.join(staging, 'licenses')))
        await atomicCacheFile(
          path.join(root, 'licenses', filename),
          await fs.readFile(path.join(staging, 'licenses', filename)),
        );
      await atomicCacheFile(path.join(root, `${source.id}.sources.manifest.json`), original);
      for (const sidecar of sidecars)
        await atomicCacheFile(path.join(root, `${source.id}.${sidecar.name}`), sidecar.bytes);
      await atomicCacheFile(marker, bytes);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  await validateAudioPack(manifest, source);
  await releaseInstalledAudioArchive(source);
  return manifest;
}
export async function validateAudioPack(
  manifest: z.infer<typeof builtPack>,
  source: z.infer<typeof packSource>,
) {
  if (source.id.startsWith('sentence-audio-') && manifest.version !== source.id)
    throw new Error('sentence_audio_pack_version_mismatch');
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
    (source.id === 'audio-v1' && recorded !== 3) ||
    (source.id === 'phrase-audio-v1' && recorded !== 0) ||
    (source.id === 'recorded-audio-v2' && recorded !== source.entryCount) ||
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
      `INSERT INTO "WordAudio" (id,"wordId",accent,kind,status,"sourceName","sourceUrl",license,attribution,"fileKey","fileSha256","mimeType","createdAt","updatedAt") SELECT 'wa_'||md5(w.id||a.accent),w.id,a.accent,a.kind,'ready',a.source_name,a.source_url,a.license,a.attribution,a.file_key,a.sha,a.mime,NOW(),NOW() FROM audio_import a JOIN "Word" w ON w."normalizedLemma"=a.lemma ON CONFLICT ("wordId",accent) ${source.id === 'phrase-audio-v1' ? 'DO NOTHING' : 'DO UPDATE SET kind=EXCLUDED.kind,status=\'ready\',"sourceName"=EXCLUDED."sourceName","sourceUrl"=EXCLUDED."sourceUrl",license=EXCLUDED.license,attribution=EXCLUDED.attribution,"fileKey"=EXCLUDED."fileKey","fileSha256"=EXCLUDED."fileSha256","mimeType"=EXCLUDED."mimeType","updatedAt"=NOW() WHERE (EXCLUDED.kind=\'recorded\' OR "WordAudio".kind<>\'recorded\') AND ("WordAudio".kind,"WordAudio".status,"WordAudio"."sourceName","WordAudio"."sourceUrl","WordAudio".license,"WordAudio".attribution,"WordAudio"."fileKey","WordAudio"."fileSha256","WordAudio"."mimeType") IS DISTINCT FROM (EXCLUDED.kind,EXCLUDED.status,EXCLUDED."sourceName",EXCLUDED."sourceUrl",EXCLUDED.license,EXCLUDED.attribution,EXCLUDED."fileKey",EXCLUDED."fileSha256",EXCLUDED."mimeType")'}`,
    );
    await client.query(
      `INSERT INTO "ContentPack" (id,version,status,"sourceUrl",sha256,license,"entryCount","phoneticCount","definitionZhCount","definitionEnCount","tagCounts","installedAt","updatedAt") VALUES ($1,$1,'ready',$2,$3,'Per-entry licenses; see sources.manifest.json',$4,0,0,0,$5::jsonb,NOW(),NOW()) ON CONFLICT (id) DO UPDATE SET status='ready',"sourceUrl"=EXCLUDED."sourceUrl",sha256=EXCLUDED.sha256,"entryCount"=EXCLUDED."entryCount","tagCounts"=EXCLUDED."tagCounts","updatedAt"=NOW() WHERE ("ContentPack".status,"ContentPack"."sourceUrl","ContentPack".sha256,"ContentPack"."entryCount","ContentPack"."tagCounts") IS DISTINCT FROM (EXCLUDED.status,EXCLUDED."sourceUrl",EXCLUDED.sha256,EXCLUDED."entryCount",EXCLUDED."tagCounts")`,
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
export async function applySentenceAudioPolicy(client: Client, policy: SentenceAudioPolicy) {
  if (!policy.manifest || !policy.manifestSha256) return;
  if (policy.entries.length) {
    const ids = [...new Set(policy.entries.map((entry) => entry.exampleId))];
    const bound = await client.query<{
      id: string;
      learningSenseId: string;
      exampleEn: string;
      exampleStatus: string;
      senseStatus: string;
    }>(
      `SELECT e.id,e."learningSenseId",e."exampleEn",e.status AS "exampleStatus",s.status AS "senseStatus"
       FROM "WordExample" e JOIN "LearningSense" s ON s.id=e."learningSenseId"
       AND s."wordId"=e."wordId" AND s."contentVersion"=e."contentVersion"
       WHERE e.id=ANY($1::text[])`,
      [ids],
    );
    const byId = new Map(bound.rows.map((row) => [row.id, row]));
    if (
      byId.size !== ids.length ||
      policy.entries.some((entry) => {
        const row = byId.get(entry.exampleId);
        return (
          !row ||
          row.learningSenseId !== entry.learningSenseId ||
          row.exampleStatus !== 'published' ||
          row.senseStatus !== 'published' ||
          normalizeSentenceText(row.exampleEn) !== entry.text ||
          sentenceTextHash(row.exampleEn) !== entry.textHash
        );
      })
    )
      throw new Error('sentence_audio_policy_database_binding_mismatch');
    await client.query(
      `UPDATE "SentenceAudio" a SET status='missing',"updatedAt"=NOW()
       FROM jsonb_to_recordset($1::jsonb) AS h("textHash" TEXT,accent TEXT)
       WHERE a."textHash"=h."textHash" AND a.accent=h.accent AND a.status IS DISTINCT FROM 'missing'`,
      [JSON.stringify(policy.entries.map(({ textHash, accent }) => ({ textHash, accent })))],
    );
  }
  await client.query(
    `INSERT INTO "ContentPack" (id,version,status,"sourceUrl",sha256,license,"entryCount","phoneticCount","definitionZhCount","definitionEnCount","tagCounts","installedAt","updatedAt")
     VALUES ('sentence-audio-holds-v1','sentence-audio-holds-v1','ready',$1,$2,'MIT',$3,0,0,0,$4::jsonb,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET status='ready',"sourceUrl"=EXCLUDED."sourceUrl",sha256=EXCLUDED.sha256,"entryCount"=EXCLUDED."entryCount","tagCounts"=EXCLUDED."tagCounts","updatedAt"=NOW()
     WHERE ("ContentPack".status,"ContentPack"."sourceUrl","ContentPack".sha256,"ContentPack"."entryCount","ContentPack"."tagCounts")
     IS DISTINCT FROM (EXCLUDED.status,EXCLUDED."sourceUrl",EXCLUDED.sha256,EXCLUDED."entryCount",EXCLUDED."tagCounts")`,
    [
      'https://github.com/wudi000888-svg/nightstudy',
      policy.manifestSha256,
      policy.entries.length,
      JSON.stringify({
        kind: 'sentence-audio-publication-policy',
        payloadSha256: policy.manifest.sha256,
        learningSensesManifestSha256: policy.manifest.learningSensesManifestSha256,
        heldClipCount: policy.entries.length,
      }),
    ],
  );
}

export async function importSentenceAudioSite(
  site: ReturnType<typeof readConfig>['sites'][number],
  manifest: z.infer<typeof builtPack>,
  source: z.infer<typeof packSource>,
  policy = loadSentenceAudioPolicy(),
) {
  for (const entry of manifest.entries)
    if (!entry.text || !entry.textHash || sentenceTextHash(entry.text) !== entry.textHash)
      throw new Error('sentence_audio_text_binding_mismatch');
  const eligible = manifest.entries.filter(
    (entry) => !policy.byIdentity.has(sentenceAudioIdentity(entry.textHash!, entry.accent)),
  );
  const client = new Client({ connectionString: site.databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(89124616)');
    const realm = await client.query<{ siteId: string }>(
      'SELECT "siteId" FROM "SiteState" WHERE "id"=\'singleton\'',
    );
    if (realm.rows[0]?.siteId !== site.id) throw new Error('audio_site_binding_mismatch');
    await applySentenceAudioPolicy(client, policy);
    for (let start = 0; start < eligible.length; start += 1000)
      await client.query(
        `INSERT INTO "SentenceAudio" (id,"textHash",text,accent,kind,status,"sourceName","sourceUrl",license,attribution,"fileKey","fileSha256","mimeType","createdAt","updatedAt")
         SELECT 'sa_'||md5(d."textHash"||d.accent),d."textHash",d.text,d.accent,d.kind,'ready',d."sourceName",d."sourceUrl",d.license,d.attribution,d."fileKey",d."fileSha256",d."mimeType",NOW(),NOW()
         FROM jsonb_to_recordset($1::jsonb) AS d("textHash" TEXT,text TEXT,accent TEXT,kind TEXT,"sourceName" TEXT,"sourceUrl" TEXT,license TEXT,attribution TEXT,"fileKey" TEXT,"fileSha256" TEXT,"mimeType" TEXT)
         ON CONFLICT ("textHash",accent) DO UPDATE SET kind=EXCLUDED.kind,status='ready',"sourceName"=EXCLUDED."sourceName","sourceUrl"=EXCLUDED."sourceUrl",license=EXCLUDED.license,attribution=EXCLUDED.attribution,"fileKey"=EXCLUDED."fileKey","fileSha256"=EXCLUDED."fileSha256","mimeType"=EXCLUDED."mimeType","updatedAt"=NOW()
         WHERE (EXCLUDED.kind='recorded' OR "SentenceAudio".kind<>'recorded') AND ("SentenceAudio".kind,"SentenceAudio".status,"SentenceAudio"."sourceName","SentenceAudio"."sourceUrl","SentenceAudio".license,"SentenceAudio".attribution,"SentenceAudio"."fileKey","SentenceAudio"."fileSha256","SentenceAudio"."mimeType") IS DISTINCT FROM (EXCLUDED.kind,EXCLUDED.status,EXCLUDED."sourceName",EXCLUDED."sourceUrl",EXCLUDED.license,EXCLUDED.attribution,EXCLUDED."fileKey",EXCLUDED."fileSha256",EXCLUDED."mimeType")`,
        [JSON.stringify(eligible.slice(start, start + 1000))],
      );
    await client.query(
      `INSERT INTO "ContentPack" (id,version,status,"sourceUrl",sha256,license,"entryCount","phoneticCount","definitionZhCount","definitionEnCount","tagCounts","installedAt","updatedAt") VALUES ($1,$1,'ready',$2,$3,'Per-entry MIT/CC-BY-2.0-FR/CC-BY-4.0',$4,0,0,0,$5::jsonb,NOW(),NOW()) ON CONFLICT (id) DO UPDATE SET status='ready',"sourceUrl"=EXCLUDED."sourceUrl",sha256=EXCLUDED.sha256,"entryCount"=EXCLUDED."entryCount","tagCounts"=EXCLUDED."tagCounts","updatedAt"=NOW() WHERE ("ContentPack".status,"ContentPack"."sourceUrl","ContentPack".sha256,"ContentPack"."entryCount","ContentPack"."tagCounts") IS DISTINCT FROM (EXCLUDED.status,EXCLUDED."sourceUrl",EXCLUDED.sha256,EXCLUDED."entryCount",EXCLUDED."tagCounts")`,
      [
        source.id,
        source.source.url,
        source.source.sha256,
        source.entryCount,
        JSON.stringify({
          kind: 'audio',
          unit: 'sentence',
          ...manifest.statistics,
          ...(policy.manifestSha256
            ? {
                installedReadyEntries: eligible.length,
                heldByPublicationPolicy: manifest.entries.length - eligible.length,
                pronunciationHoldsManifestSha256: policy.manifestSha256,
              }
            : {}),
        }),
      ],
    );
    await client.query('COMMIT');
    console.log(
      JSON.stringify({ action: 'sentence-audio.ready', siteId: site.id, ...manifest.statistics }),
    );
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
  const pronunciationPolicy = loadSentenceAudioPolicy();
  const root = audioCacheRoot();
  await ensureCacheDirectory(root);
  // Preserve the consolidated words and original sentences, then add the static sentence delta.
  // Neither installation downloads a voice model or invokes a speech engine.
  const sources: unknown[] = [];
  for (const filename of [
    'word-audio-v2.manifest.json',
    'sentence-audio.manifest.json',
    'sentence-audio-v2.manifest.json',
    'sentence-audio-v3.manifest.json',
  ]) {
    sources.push(JSON.parse(await fs.readFile(path.join('data', filename), 'utf8')));
  }
  const collectionFile = path.join('data', 'sentence-audio-v4.collection.json');
  if (existsSync(collectionFile))
    sources.push(...(await readSentenceAudioCollection(collectionFile)).pins);
  // Validate every pin before downloading or changing any site.
  const parsedSources = sources.map((source) => packSource.parse(source));
  for (const source of parsedSources) {
    const manifest = await installAudioFiles(source);
    for (const site of readConfig().sites) {
      if (source.id.startsWith('sentence-audio-'))
        await importSentenceAudioSite(site, manifest, source, pronunciationPolicy);
      else await importAudioSite(site, manifest, source);
    }
  }
}
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error && error.message === 'audio_archive_cleanup_failed'
        ? 'Audio files passed validation, but compressed archive cleanup failed. Installed files and the archive are retained; check cache permissions or explicitly set AUDIO_RETAIN_ARCHIVES=true.'
        : 'Audio installation failed; check the pinned pack, disk space and source availability. No partial database transaction was committed.',
    );
    process.exitCode = 1;
  });
