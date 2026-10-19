import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { installAudioFiles, releaseInstalledAudioArchive } from './audio-prepare.js';

type PackSource = Parameters<typeof installAudioFiles>[0];
type PreparedManifest = Awaited<ReturnType<typeof installAudioFiles>>;

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function rejectNetwork() {
  return vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected_network'));
}

function pcmTone() {
  const bytes = Buffer.alloc(44 + 256);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(256, 40);
  for (let index = 0; index < 128; index++)
    bytes.writeInt16LE(
      Math.round(Math.sin((index * 2 * Math.PI * 440) / 16000) * 1000),
      44 + index * 2,
    );
  return bytes;
}

describe('pinned audio archive installation and filesystem cache recovery', () => {
  let directory: string,
    fixtureDirectory: string,
    archive: string,
    python: string,
    cache: string,
    source: PackSource;
  let originalCache: string | undefined, originalPython: string | undefined, originalRetain: string | undefined;
  let network: ReturnType<typeof rejectNetwork>;
  const tone = pcmTone(),
    toneHash = sha256(tone),
    fileKey = `files/${toneHash}.wav`,
    sources = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        description: 'Original synthetic PCM installer test fixture; not human speech',
      }),
    );

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-audio-cache-test-'));
    fixtureDirectory = path.join(directory, 'fixture');
    archive = path.join(directory, 'fixture.tar.gz');
    python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    }).trim();
    fs.mkdirSync(path.join(fixtureDirectory, 'files'), { recursive: true });
    fs.mkdirSync(path.join(fixtureDirectory, 'licenses'));
    fs.writeFileSync(path.join(fixtureDirectory, fileKey), tone);
    fs.writeFileSync(path.join(fixtureDirectory, 'sources.manifest.json'), sources);
    fs.writeFileSync(
      path.join(fixtureDirectory, 'licenses/original-test-license.txt'),
      'Original synthetic test tone and metadata; MIT. This is not speech.\n',
    );
    // The fixed production cardinalities exercise the real loader schema. All entries
    // reuse one 300-byte PCM tone; the first three kinds are simulated metadata only,
    // not a claim that this fixture contains recorded speech or a production pack.
    const entries: PreparedManifest['entries'] = Array.from({ length: 8798 }, (_, index) => {
      const suffix = String.fromCharCode(
        97 + Math.floor(index / 676),
        97 + (Math.floor(index / 26) % 26),
        97 + (index % 26),
      );
      return (['US', 'UK'] as const).map((accent, accentIndex) => ({
        lemma: `fixture${suffix}`,
        accent,
        kind: index * 2 + accentIndex < 3 ? ('recorded' as const) : ('synthesized' as const),
        sourceName: 'Simulated installer metadata; synthetic PCM tone, not speech',
        sourceUrl: 'https://example.test/synthetic-installer-fixture',
        license: 'MIT',
        attribution: 'Original automated test tone; recorded kind is simulated metadata only',
        fileKey,
        fileSha256: toneHash,
        mimeType: 'audio/wav' as const,
      }));
    }).flat();
    const manifest: PreparedManifest = {
      schemaVersion: 1,
      version: 'audio-v1',
      status: 'ready',
      sourceManifestSha256: sha256(sources),
      statistics: {
        lemmaCount: 8798,
        entryCount: 17596,
        recordedCount: 3,
        synthesizedCount: 17593,
        failedCount: 0,
      },
      entries,
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(path.join(fixtureDirectory, 'manifest.json'), manifestBytes);
    execFileSync(
      python,
      [
        '-c',
        [
          'import pathlib, sys, tarfile',
          'root = pathlib.Path(sys.argv[1])',
          'with tarfile.open(sys.argv[2], "w:gz", format=tarfile.PAX_FORMAT) as archive:',
          '    for item in sorted(root.rglob("*")):',
          '        if item.is_file():',
          '            archive.add(item, arcname=item.relative_to(root).as_posix(), recursive=False)',
        ].join('\n'),
        fixtureDirectory,
        archive,
      ],
      { timeout: 30000, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const archiveBytes = fs.readFileSync(archive);
    source = {
      id: 'audio-v1',
      status: 'ready',
      source: {
        url: 'https://example.test/never-requested-synthetic-audio-v1.tar.gz',
        sha256: sha256(archiveBytes),
        sizeBytes: archiveBytes.length,
      },
      lemmaCount: 8798,
      entryCount: 17596,
      sourceManifestSha256: sha256(sources),
      manifestSha256: sha256(manifestBytes),
    };
  }, 60000);

  beforeEach(() => {
    originalCache = process.env.AUDIO_CACHE_DIR;
    originalPython = process.env.AUDIO_PYTHON;
    originalRetain = process.env.AUDIO_RETAIN_ARCHIVES;
    cache = fs.mkdtempSync(path.join(directory, 'cache-'));
    fs.mkdirSync(path.join(cache, 'downloads'));
    fs.copyFileSync(archive, path.join(cache, 'downloads/audio-v1.tar.gz'));
    process.env.AUDIO_CACHE_DIR = cache;
    process.env.AUDIO_PYTHON = python;
    delete process.env.AUDIO_RETAIN_ARCHIVES;
    network = rejectNetwork();
  });

  afterEach(() => {
    try {
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
      if (originalCache === undefined) delete process.env.AUDIO_CACHE_DIR;
      else process.env.AUDIO_CACHE_DIR = originalCache;
      if (originalPython === undefined) delete process.env.AUDIO_PYTHON;
      else process.env.AUDIO_PYTHON = originalPython;
      if (originalRetain === undefined) delete process.env.AUDIO_RETAIN_ARCHIVES;
      else process.env.AUDIO_RETAIN_ARCHIVES = originalRetain;
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('installs a pinned cached archive and restores missing and corrupt media despite a valid manifest marker', async () => {
    // Offline repairs intentionally retain the verified compressed input.
    process.env.AUDIO_RETAIN_ARCHIVES = 'true';
    const installed = await installAudioFiles(source);
    expect(installed.statistics).toMatchObject({
      lemmaCount: 8798,
      entryCount: 17596,
      recordedCount: 3,
      synthesizedCount: 17593,
    });
    expect(installed.entries).toHaveLength(17596);
    expect(fs.readdirSync(path.join(cache, 'files'))).toEqual([`${toneHash}.wav`]);
    const media = path.join(cache, fileKey),
      marker = path.join(cache, 'audio-v1.manifest.json');
    expect(fs.readFileSync(media)).toEqual(tone);
    expect(sha256(fs.readFileSync(marker))).toBe(source.manifestSha256);

    fs.unlinkSync(media);
    await installAudioFiles(source);
    expect(fs.readFileSync(media)).toEqual(tone);
    const corrupt = Buffer.from(tone);
    corrupt[44] = corrupt[44]! ^ 1;
    fs.writeFileSync(media, corrupt);
    await installAudioFiles(source);
    expect(sha256(fs.readFileSync(media))).toBe(toneHash);
    expect(fs.readFileSync(path.join(cache, 'audio-v1.sources.manifest.json'))).toEqual(sources);
    expect(fs.readdirSync(cache).some((item) => item.startsWith('.extract-'))).toBe(false);
  }, 120000);

  it('rejects a licenses directory symlink without modifying private files', async () => {
    const privateDirectory = fs.mkdtempSync(path.join(directory, 'private-license-')),
      sentinel = path.join(privateDirectory, 'original-test-license.txt'),
      secretBytes = Buffer.from('private license sentinel; never overwrite');
    fs.writeFileSync(sentinel, secretBytes);
    fs.symlinkSync(privateDirectory, path.join(cache, 'licenses'));
    await expect(installAudioFiles(source)).rejects.toThrow('audio_cache_directory_invalid');
    expect(fs.readFileSync(sentinel)).toEqual(secretBytes);
    expect(fs.lstatSync(path.join(cache, 'licenses')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(cache, 'audio-v1.manifest.json'))).toBe(false);
    expect(fs.existsSync(path.join(cache, 'downloads/audio-v1.tar.gz'))).toBe(true);
  });

  it('atomically replaces a sources manifest leaf symlink while preserving its private target', async () => {
    const privateDirectory = fs.mkdtempSync(path.join(directory, 'private-source-')),
      sentinel = path.join(privateDirectory, 'private.json'),
      secretBytes = Buffer.from('private source sentinel; never overwrite'),
      destination = path.join(cache, 'audio-v1.sources.manifest.json');
    fs.writeFileSync(sentinel, secretBytes);
    fs.symlinkSync(sentinel, destination);
    await installAudioFiles(source);
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(destination)).toEqual(sources);
    expect(fs.readFileSync(sentinel)).toEqual(secretBytes);
    expect(sha256(fs.readFileSync(path.join(cache, 'audio-v1.manifest.json')))).toBe(
      source.manifestSha256,
    );
  }, 120000);

  it('releases a validated cold archive and never treats warm cleanup failure as repair', async () => {
    const installed = await installAudioFiles(source);
    const cachedArchive = path.join(cache, 'downloads/audio-v1.tar.gz');
    expect(installed.entries).toHaveLength(17596);
    expect(fs.existsSync(cachedArchive)).toBe(false);
    fs.copyFileSync(archive, cachedArchive);
    const marker = path.join(cache, 'audio-v1.manifest.json');
    const markerInode = fs.statSync(marker).ino;
    const removal = vi.spyOn(fsp, 'unlink').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    try {
      await expect(installAudioFiles(source)).rejects.toThrow('audio_archive_cleanup_failed');
      expect(fs.statSync(marker).ino).toBe(markerInode);
      expect(fs.existsSync(cachedArchive)).toBe(true);
      expect(fs.readFileSync(path.join(cache, fileKey))).toEqual(tone);
      expect(removal).toHaveBeenCalledTimes(1);
    } finally { removal.mockRestore(); }
    await installAudioFiles(source);
    expect(fs.existsSync(cachedArchive)).toBe(false);
  }, 120000);
});

describe('verified archive release uses only the current immutable cache leaf', () => {
  const archiveBytes = Buffer.from('Original tiny archive-cache fixture; no audio or real archive.');
  const source: Parameters<typeof releaseInstalledAudioArchive>[0] = {
    id: 'sentence-audio-v4-0101',
    source: { url: 'https://example.test/not-downloaded.tar.gz', sha256: sha256(archiveBytes), sizeBytes: archiveBytes.length },
  };
  let directory: string, archive: string, other: string;
  let originalCache: string | undefined, originalRetain: string | undefined;
  let network: ReturnType<typeof rejectNetwork>;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-archive-release-test-'));
    fs.mkdirSync(path.join(directory, 'downloads'));
    archive = path.join(directory, 'downloads', source.id + '.tar.gz');
    other = path.join(directory, 'downloads/sentence-audio-v4-0102.tar.gz');
    fs.writeFileSync(archive, archiveBytes); fs.writeFileSync(other, 'another package');
    for (const name of ['files', 'licenses']) fs.mkdirSync(path.join(directory, name));
    fs.writeFileSync(path.join(directory, 'files/ready.mp3'), 'installed media sentinel');
    fs.writeFileSync(path.join(directory, 'licenses/NOTICE.txt'), 'retained license sentinel');
    fs.writeFileSync(path.join(directory, source.id + '.manifest.json'), 'retained marker sentinel');
    fs.writeFileSync(path.join(directory, source.id + '.sources.manifest.json'), 'retained source sentinel');
    originalCache = process.env.AUDIO_CACHE_DIR; originalRetain = process.env.AUDIO_RETAIN_ARCHIVES;
    process.env.AUDIO_CACHE_DIR = directory; delete process.env.AUDIO_RETAIN_ARCHIVES;
    network = rejectNetwork();
  });
  afterEach(() => {
    try { expect(network).not.toHaveBeenCalled(); }
    finally {
      network.mockRestore();
      if (originalCache === undefined) delete process.env.AUDIO_CACHE_DIR; else process.env.AUDIO_CACHE_DIR = originalCache;
      if (originalRetain === undefined) delete process.env.AUDIO_RETAIN_ARCHIVES; else process.env.AUDIO_RETAIN_ARCHIVES = originalRetain;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('deletes only this verified compressed archive by default and is absent-file idempotent', async () => {
    await releaseInstalledAudioArchive(source); await releaseInstalledAudioArchive(source);
    expect(fs.existsSync(archive)).toBe(false); expect(fs.readFileSync(other, 'utf8')).toBe('another package');
    expect(fs.readFileSync(path.join(directory, 'files/ready.mp3'), 'utf8')).toBe('installed media sentinel');
    expect(fs.readFileSync(path.join(directory, 'licenses/NOTICE.txt'), 'utf8')).toBe('retained license sentinel');
    expect(fs.readFileSync(path.join(directory, source.id + '.manifest.json'), 'utf8')).toBe('retained marker sentinel');
    expect(fs.readFileSync(path.join(directory, source.id + '.sources.manifest.json'), 'utf8')).toBe('retained source sentinel');
  });

  it('retains a cache explicitly for offline maintenance', async () => {
    process.env.AUDIO_RETAIN_ARCHIVES = 'true';
    await releaseInstalledAudioArchive(source); expect(fs.readFileSync(archive)).toEqual(archiveBytes);
  });

  it('rejects an invalid retention flag without deleting its archive', async () => {
    process.env.AUDIO_RETAIN_ARCHIVES = 'yes';
    await expect(releaseInstalledAudioArchive(source)).rejects.toThrow('invalid_audio_retain_archives');
    expect(fs.readFileSync(archive)).toEqual(archiveBytes);
  });

  it('retains same-size wrong bytes rather than deleting a filename match', async () => {
    const wrong = Buffer.from(archiveBytes); wrong[0] = wrong[0]! ^ 1; fs.writeFileSync(archive, wrong);
    await expect(releaseInstalledAudioArchive(source)).rejects.toThrow('audio_archive_cleanup_failed');
    expect(fs.readFileSync(archive)).toEqual(wrong);
  });

  it('does not follow a compressed archive symlink', async () => {
    const target = path.join(directory, 'private.tar.gz'); fs.renameSync(archive, target); fs.symlinkSync(target, archive);
    await expect(releaseInstalledAudioArchive(source)).rejects.toThrow('audio_archive_cleanup_failed');
    expect(fs.lstatSync(archive).isSymbolicLink()).toBe(true); expect(fs.readFileSync(target)).toEqual(archiveBytes);
  });

  it('does not follow a downloads directory symlink', async () => {
    const target = path.join(directory, 'private-downloads'); fs.renameSync(path.dirname(archive), target); fs.symlinkSync(target, path.dirname(archive));
    await expect(releaseInstalledAudioArchive(source)).rejects.toThrow('audio_archive_cleanup_failed');
    expect(fs.readFileSync(path.join(target, path.basename(archive)))).toEqual(archiveBytes);
  });
});
