import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { createDatabase } from './db.js';
import type { AppConfig } from './config.js';
import { sentenceTextHash } from './audio.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('PostgreSQL pronunciation media and exact dictionary resolution', () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('Audio integration requires an isolated database ending in _test');
  const db = createDatabase(url),
    runId = randomUUID(),
    prefix = `audio-it-${runId}`;
  const letters = runId
    .replaceAll('-', '')
    .replace(/[0-9]/g, (digit) => String.fromCharCode(97 + Number(digit)));
  const ids = [`${prefix}-ready`, `${prefix}-draft`, `${prefix}-failed`, `${prefix}-phrase`];
  const lemmas = [
    `tonetest${letters}`,
    `drafttone${letters}`,
    `failedtone${letters}`,
    `quiet tone ${letters}`,
  ];
  const userId = `${prefix}-learner`,
    email = `${prefix}@example.test`,
    password = 'Audio-integration-2026!';
  const audioPackId = `${prefix}-audio-pack`;
  const sentence = `Original private test sentence ${letters}.`;
  const sentenceHash = sentenceTextHash(sentence);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-audio-pg-'));
  const cache = path.join(directory, 'cache'),
    files = path.join(cache, 'files'),
    webRoot = path.join(directory, 'web');
  fs.mkdirSync(files, { recursive: true });
  fs.mkdirSync(webRoot);
  fs.writeFileSync(
    path.join(webRoot, 'index.html'),
    '<html><body><div id="root"></div></body></html>',
  );
  const oldCache = process.env.AUDIO_CACHE_DIR,
    oldPython = process.env.AUDIO_PYTHON;
  let app: FastifyInstance,
    mounted: FastifyInstance,
    cookie = '';
  const ip = `10.80.${Number.parseInt(runId.slice(0, 2), 16)}.1`;
  const tone = (frequency: number) => {
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
        Math.round(Math.sin((index * 2 * Math.PI * frequency) / 16000) * 1000),
        44 + index * 2,
      );
    return bytes;
  };
  const usBytes = tone(440),
    ukBytes = tone(660);
  const usHash = createHash('sha256').update(usBytes).digest('hex'),
    ukHash = createHash('sha256').update(ukBytes).digest('hex');
  const usKey = `files/${usHash}.wav`,
    ukKey = `files/${ukHash}.wav`;
  const configuration = (basePath = ''): AppConfig => ({
    sites: [
      {
        id: 'default',
        title: 'Audio integration',
        publicUrl: `http://${basePath ? 'audio-mounted.test' : 'audio.test'}${basePath}`,
        basePath,
        hosts: [basePath ? 'audio-mounted.test' : 'audio.test'],
        databaseUrl: url,
        authSecret: `${basePath ? 'mounted' : 'root'}-audio-integration-secret-`.repeat(3),
        bootstrapToken: 'unused-audio-bootstrap-'.repeat(3),
        registrationOpen: true,
      },
    ],
    host: '127.0.0.1',
    port: 5198,
    production: false,
    webRoot,
    trustedProxy: [],
    poolSize: 5,
    maxSites: 2,
  });
  const request = (
    method: 'GET' | 'POST',
    route: string,
    body?: unknown,
    authenticated = false,
    extra: Record<string, string> = {},
    mountedRoute = false,
  ) =>
    (mountedRoute ? mounted : app).inject({
      method,
      url: `${mountedRoute ? '/learn' : ''}/api/v2${route}`,
      remoteAddress: ip,
      headers: {
        host: mountedRoute ? 'audio-mounted.test' : 'audio.test',
        ...(authenticated ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...extra,
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  const media = (accent = 'US', headers: Record<string, string> = {}) =>
    request('GET', `/pronunciation/${ids[0]}/audio/${accent}`, undefined, false, headers);
  const metadata = (
    wordId: string,
    accent: string,
    hash: string,
    key: string,
    status = 'ready',
  ) => ({
    wordId,
    accent,
    status,
    kind: 'synthesized',
    sourceName: 'Synthetic PCM test tone; not English speech',
    sourceUrl: 'https://example.test/nightstudy-audio-fixture',
    license: 'MIT',
    attribution: 'Original synthesized tone for automated tests only',
    fileKey: key,
    fileSha256: hash,
    mimeType: 'audio/wav',
  });
  const restoreEntry = () =>
    db.wordAudio.update({
      where: { wordId_accent: { wordId: ids[0]!, accent: 'US' } },
      data: { status: 'ready', fileKey: usKey, fileSha256: usHash, mimeType: 'audio/wav' },
    });

  beforeAll(async () => {
    process.env.AUDIO_CACHE_DIR = cache;
    delete process.env.AUDIO_PYTHON;
    fs.writeFileSync(path.join(cache, usKey), usBytes);
    fs.writeFileSync(path.join(cache, ukKey), ukBytes);
    expect((await db.siteState.findUniqueOrThrow({ where: { id: 'singleton' } })).siteId).toBe(
      'default',
    );
    await db.user.create({
      data: {
        id: userId,
        name: 'Audio test learner',
        email,
        accounts: {
          create: {
            id: randomUUID(),
            accountId: userId,
            providerId: 'credential',
            password: await hashPassword(password),
          },
        },
      },
    });
    for (let index = 0; index < ids.length; index++)
      await db.word.create({
        data: {
          id: ids[index]!,
          lemma: lemmas[index]!,
          normalizedLemma: lemmas[index]!,
          phoneticUs: '/tɛst/',
          phoneticUk: '/test/',
          phoneticSource: 'Original test fixture',
          goalTags: ['daily'],
          status: index === 1 ? 'draft' : 'published',
          sourceRef: 'Original test fixture',
          contentVersion: 'integration-only',
          senses: {
            create: { id: `${ids[index]}-sense`, pos: 'n.', definitionZh: '合成测试音频词条' },
          },
        },
      });
    await db.wordAudio.createMany({
      data: [
        metadata(ids[0]!, 'US', usHash, usKey),
        metadata(ids[0]!, 'UK', ukHash, ukKey),
        metadata(ids[1]!, 'US', usHash, usKey),
        metadata(ids[2]!, 'US', usHash, usKey, 'failed'),
      ],
    });
    await db.sentenceAudio.createMany({
      data: ['US', 'UK'].map((accent) => ({
        id: `${prefix}-sentence-${accent}`,
        textHash: sentenceHash,
        text: sentence,
        accent,
        kind: 'synthesized',
        status: 'ready',
        sourceName: 'Synthetic test tone; not speech',
        sourceUrl: 'https://example.test/audio-test-fixture',
        license: 'MIT',
        attribution: 'Original test fixture only',
        fileKey: accent === 'US' ? usKey : ukKey,
        fileSha256: accent === 'US' ? usHash : ukHash,
        mimeType: 'audio/wav',
      })),
    });
    app = (await buildApp(configuration(), false)).app;
    mounted = (await buildApp(configuration('/learn'), false)).app;
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      remoteAddress: ip,
      headers: { host: 'audio.test', 'content-type': 'application/json' },
      payload: JSON.stringify({ email, password }),
    });
    expect(login.statusCode).toBe(200);
    const raw = login.headers['set-cookie'];
    cookie = (Array.isArray(raw) ? raw : [raw])
      .filter(Boolean)
      .map((entry) => String(entry).split(';')[0])
      .join('; ');
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await mounted?.close();
    await db.job.deleteMany({
      where: {
        id: { in: ids.flatMap((id) => [`pronunciation:${id}:US`, `pronunciation:${id}:UK`]) },
      },
    });
    await db.rateBucket.deleteMany({ where: { key: { startsWith: `audio:default:${userId}:` } } });
    await db.sentenceAudio.deleteMany({ where: { id: { startsWith: `${prefix}-sentence-` } } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.contentPack.deleteMany({ where: { id: audioPackId } });
    await db.word.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
    if (oldCache === undefined) delete process.env.AUDIO_CACHE_DIR;
    else process.env.AUDIO_CACHE_DIR = oldCache;
    if (oldPython === undefined) delete process.env.AUDIO_PYTHON;
    else process.env.AUDIO_PYTHON = oldPython;
    fs.rmSync(directory, { recursive: true, force: true });
  }, 60000);

  it('returns dual-accent licensed synthesis metadata while omitting cache paths, hashes and private file keys', async () => {
    const response = await request('GET', `/pronunciation/${ids[0]}`);
    expect(response.statusCode).toBe(200);
    const value = response.json().pronunciation;
    expect(value.audio.map((entry: { accent: string }) => entry.accent).sort()).toEqual([
      'UK',
      'US',
    ]);
    expect(
      value.audio.every(
        (entry: { kind: string; sourceName: string; license: string }) =>
          entry.kind === 'synthesized' &&
          entry.sourceName.includes('not English speech') &&
          entry.license === 'MIT',
      ),
    ).toBe(true);
    expect(value.recordedAudioAvailable).toBe(false);
    expect(value).not.toHaveProperty('generationAvailable');
    expect(value).not.toHaveProperty('speech');
    for (const hidden of [cache, usKey, ukKey, usHash, ukHash, 'fileKey', 'fileSha256'])
      expect(response.body).not.toContain(hidden);
  });
  it('does not count audio assets as dictionary entries when a ready audio ContentPack is installed', async () => {
    const before = await request('GET', '/dictionary/stats');
    expect(before.statusCode).toBe(200);
    await db.contentPack.create({
      data: {
        id: audioPackId,
        version: 'test-audio-v1',
        status: 'ready',
        sourceUrl: 'https://example.test/synthetic-audio-fixture',
        sha256: '3'.repeat(64),
        license: 'MIT',
        entryCount: 17596,
        phoneticCount: 0,
        definitionZhCount: 0,
        definitionEnCount: 0,
        tagCounts: { kind: 'audio', lemmaCount: 8798, entryCount: 17596 },
      },
    });
    try {
      const after = await request('GET', '/dictionary/stats');
      expect(after.statusCode).toBe(200);
      expect(after.json().packs.some((pack: { id: string }) => pack.id === audioPackId)).toBe(true);
      expect(after.json().declaredEntryCount).toBe(before.json().declaredEntryCount);
    } finally {
      await db.contentPack.deleteMany({ where: { id: audioPackId } });
    }
  });

  it('keeps held-audio policy metadata visible without adding its targets to dictionary counts', async () => {
    const before = await request('GET', '/dictionary/stats');
    expect(before.statusCode).toBe(200);
    const policyPackId = `${prefix}-publication-policy`,
      dictionaryPackId = `ecdict-${prefix}`;
    try {
      await db.contentPack.create({
        data: {
          id: policyPackId,
          version: 'test-publication-policy-v1',
          status: 'ready',
          sourceUrl: 'https://example.test/audio-policy-fixture',
          sha256: '4'.repeat(64),
          license: 'MIT',
          entryCount: 79,
          phoneticCount: 0,
          definitionZhCount: 0,
          definitionEnCount: 0,
          tagCounts: { kind: 'sentence-audio-publication-policy', heldClipCount: 79 },
        },
      });
      const withPolicy = await request('GET', '/dictionary/stats');
      expect(withPolicy.statusCode).toBe(200);
      expect(withPolicy.json().declaredEntryCount).toBe(before.json().declaredEntryCount);
      expect(
        withPolicy.json().packs.find((pack: { id: string }) => pack.id === policyPackId),
      ).toMatchObject({
        entryCount: 79,
        tagCounts: { kind: 'sentence-audio-publication-policy', heldClipCount: 79 },
      });
      await db.contentPack.create({
        data: {
          id: dictionaryPackId,
          version: 'test-dictionary-v1',
          status: 'ready',
          sourceUrl: 'https://example.test/dictionary-fixture',
          sha256: '5'.repeat(64),
          license: 'MIT',
          entryCount: 7,
          phoneticCount: 0,
          definitionZhCount: 0,
          definitionEnCount: 0,
          tagCounts: { fixture: 7 },
        },
      });
      const withDictionary = await request('GET', '/dictionary/stats');
      expect(withDictionary.statusCode).toBe(200);
      expect(withDictionary.json().installedDictionary).toBe(true);
      expect(withDictionary.json().declaredEntryCount).toBe(before.json().declaredEntryCount + 7);
      expect(
        withDictionary.json().packs.some((pack: { id: string }) => pack.id === policyPackId),
      ).toBe(true);
      expect(
        withDictionary.json().packs.some((pack: { id: string }) => pack.id === dictionaryPackId),
      ).toBe(true);
    } finally {
      await db.contentPack.deleteMany({ where: { id: { in: [policyPackId, dictionaryPackId] } } });
    }
  });

  it('serves verified PCM bytes with a MIME type, revalidated digest ETag and an empty 304 response', async () => {
    const first = await media();
    expect(first.statusCode).toBe(200);
    expect(first.rawPayload).toEqual(usBytes);
    expect(first.headers['content-type']).toContain('audio/wav');
    expect(first.headers.etag).toBe(`"${usHash}"`);
    expect(first.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
    const repeated = await media('US', { 'if-none-match': `"${usHash}"` });
    expect(repeated.statusCode).toBe(304);
    expect(repeated.rawPayload.length).toBe(0);
    expect((await media('UK')).rawPayload).toEqual(ukBytes);
  });

  it('rejects changed bytes and wrong MIME metadata even when the client sends the former valid ETag', async () => {
    const changed = Buffer.from(usBytes);
    changed[44] = changed[44]! ^ 1;
    fs.writeFileSync(path.join(cache, usKey), changed);
    try {
      const response = await media('US', { 'if-none-match': `"${usHash}"` });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe('audio_asset_invalid');
    } finally {
      fs.writeFileSync(path.join(cache, usKey), usBytes);
    }
    await db.wordAudio.update({
      where: { wordId_accent: { wordId: ids[0]!, accent: 'US' } },
      data: { mimeType: 'audio/ogg' },
    });
    try {
      expect((await media()).json().code).toBe('audio_asset_invalid');
    } finally {
      await restoreEntry();
    }
  });

  it('rejects missing, symlinked and traversal assets without exposing outside-private contents', async () => {
    const target = path.join(cache, usKey),
      privateFilename = path.join(directory, 'private.wav');
    fs.writeFileSync(privateFilename, usBytes);
    fs.unlinkSync(target);
    expect((await media()).json().code).toBe('audio_asset_unavailable');
    fs.symlinkSync(privateFilename, target);
    try {
      const response = await media();
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe('audio_asset_unavailable');
    } finally {
      fs.unlinkSync(target);
      fs.writeFileSync(target, usBytes);
    }
    await db.wordAudio.update({
      where: { wordId_accent: { wordId: ids[0]!, accent: 'US' } },
      data: { fileKey: '../private.wav' },
    });
    try {
      const response = await media();
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe('audio_asset_invalid');
      expect(response.body).not.toContain(privateFilename);
    } finally {
      await restoreEntry();
    }
  });

  it('does not publish draft words, failed audio entries or unsupported accent routes', async () => {
    expect((await request('GET', `/pronunciation/${ids[1]}`)).statusCode).toBe(404);
    expect((await request('GET', `/pronunciation/${ids[1]}/audio/US`)).statusCode).toBe(404);
    const failed = await request('GET', `/pronunciation/${ids[2]}`);
    expect(failed.statusCode).toBe(200);
    expect(failed.json().pronunciation.audio).toEqual([]);
    expect((await request('GET', `/pronunciation/${ids[2]}/audio/US`)).statusCode).toBe(404);
    expect((await media('AU')).statusCode).toBe(400);
  });
  it('rejects a symlinked files directory before serving outside-cache audio through HTTP', async () => {
    const saved = path.join(directory, 'original-files'),
      outside = path.join(directory, 'outside-private');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, `${usHash}.wav`), usBytes);
    fs.renameSync(files, saved);
    fs.symlinkSync(outside, files);
    try {
      const response = await media();
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe('audio_asset_unavailable');
    } finally {
      fs.unlinkSync(files);
      fs.renameSync(saved, files);
    }
  });

  it('has no online synthesis route and never starts pronunciation jobs', async () => {
    for (const authenticated of [false, true]) {
      const response = await request('POST', `/pronunciation/${ids[0]}/prepare`, {}, authenticated);
      expect(response.statusCode).toBe(404);
    }
    expect(
      await db.job.count({
        where: { id: { in: [`pronunciation:${ids[0]}:US`, `pronunciation:${ids[0]}:UK`] } },
      }),
    ).toBe(0);
  });

  it('resolves canonical exact words and phrases while keeping prefixes, unproven inflections and drafts unmatched', async () => {
    const exact = await request(
      'GET',
      `/dictionary/resolve?text=${encodeURIComponent(`  ${lemmas[0]!.toUpperCase()}  `)}`,
    );
    expect(exact.statusCode).toBe(200);
    expect(exact.json()).toMatchObject({
      queried: lemmas[0],
      matchedLemma: lemmas[0],
      matchType: 'exact',
      word: { id: ids[0] },
    });
    const prefixQuery = lemmas[0]!.slice(0, -1);
    expect(
      (await request('GET', `/dictionary?q=${prefixQuery}&limit=5`))
        .json()
        .items.some((entry: { id: string }) => entry.id === ids[0]),
    ).toBe(true);
    for (const query of [prefixQuery, `${lemmas[0]}s`, lemmas[1]!]) {
      const result = await request('GET', `/dictionary/resolve?text=${encodeURIComponent(query)}`);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        matchType: 'not-found',
        word: null,
        matchedLemma: null,
      });
    }
    const phrase = await request(
      'GET',
      `/dictionary/resolve?text=${encodeURIComponent(lemmas[3]!.toUpperCase().replaceAll(' ', '   '))}`,
    );
    expect(phrase.json()).toMatchObject({
      queried: lemmas[3],
      matchType: 'exact',
      word: { id: ids[3] },
    });
  });
  it('publishes only prebuilt sentence metadata and returns exact mounted audio bytes with ETag', async () => {
    const detail = await request('GET', `/sentence-audio/${sentenceHash}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ sentence: { textHash: sentenceHash, text: sentence } });
    expect(detail.json().sentence.audio.map((e: { accent: string }) => e.accent)).toEqual([
      'UK',
      'US',
    ]);
    for (const hidden of ['fileKey', 'fileSha256', cache, 'sourceUrl'])
      expect(detail.body).not.toContain(hidden);
    const media = await request(
      'GET',
      `/sentence-audio/${sentenceHash}/audio/US`,
      undefined,
      false,
      {},
      true,
    );
    expect(media.rawPayload).toEqual(usBytes);
    expect(media.headers.etag).toBe(`"${usHash}"`);
    const again = await request(
      'GET',
      `/sentence-audio/${sentenceHash}/audio/US`,
      undefined,
      false,
      { 'if-none-match': `"${usHash}"` },
    );
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload).toHaveLength(0);
  });
  it('leaves missing sentences empty, rejects unknown media and cannot generate arbitrary text', async () => {
    const unknown = sentenceTextHash(`Unavailable ${runId}`);
    expect((await request('GET', `/sentence-audio/${unknown}`)).json()).toEqual({
      sentence: { textHash: unknown, text: null, audio: [] },
    });
    expect((await request('GET', `/sentence-audio/${unknown}/audio/US`)).statusCode).toBe(404);
    expect((await request('GET', `/sentence-audio/${sentenceHash}/audio/AU`)).statusCode).toBe(400);
    expect((await request('GET', '/sentence-audio/not-a-hash')).statusCode).toBe(400);
    expect(
      (await request('POST', `/sentence-audio/${sentenceHash}/prepare`, { text: sentence }, true))
        .statusCode,
    ).toBe(404);
  });
  it('checks sentence bytes before accepting an old ETag and hides failed sentence rows', async () => {
    const changed = Buffer.from(usBytes);
    changed[44] = changed[44]! ^ 1;
    fs.writeFileSync(path.join(cache, usKey), changed);
    try {
      const response = await request(
        'GET',
        `/sentence-audio/${sentenceHash}/audio/US`,
        undefined,
        false,
        { 'if-none-match': `"${usHash}"` },
      );
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe('audio_asset_invalid');
    } finally {
      fs.writeFileSync(path.join(cache, usKey), usBytes);
    }
    await db.sentenceAudio.update({
      where: { textHash_accent: { textHash: sentenceHash, accent: 'US' } },
      data: { status: 'failed' },
    });
    try {
      const response = await request('GET', `/sentence-audio/${sentenceHash}`);
      expect(response.json().sentence.audio.map((e: { accent: string }) => e.accent)).toEqual([
        'UK',
      ]);
      expect((await request('GET', `/sentence-audio/${sentenceHash}/audio/US`)).statusCode).toBe(
        404,
      );
    } finally {
      await db.sentenceAudio.update({
        where: { textHash_accent: { textHash: sentenceHash, accent: 'US' } },
        data: { status: 'ready' },
      });
    }
  });
  it.skipIf(!process.env.TEST_DATABASE_URL_B)(
    'resolves the same sentence hash only within the selected independent site database',
    async () => {
      const secondUrl = process.env.TEST_DATABASE_URL_B!;
      if (!new URL(secondUrl).pathname.endsWith('_test'))
        throw new Error('Sentence secondary realm must end in _test');
      const secondaryDb = createDatabase(secondUrl);
      const conf = configuration();
      conf.sites[0]! = {
        ...conf.sites[0]!,
        databaseUrl: secondUrl,
        hosts: ['sentence-secondary.test'],
        publicUrl: 'http://sentence-secondary.test',
      };
      const other = (await buildApp(conf, false)).app;
      try {
        await secondaryDb.sentenceAudio.create({
          data: {
            id: `${prefix}-sentence-secondary`,
            textHash: sentenceHash,
            text: sentence,
            accent: 'US',
            kind: 'synthesized',
            status: 'ready',
            sourceName: 'Synthetic fixture',
            sourceUrl: 'https://example.test/fixture',
            license: 'MIT',
            attribution: 'Original test tone',
            fileKey: ukKey,
            fileSha256: ukHash,
            mimeType: 'audio/wav',
          },
        });
        const media = await other.inject({
          url: `/api/v2/sentence-audio/${sentenceHash}/audio/US`,
          headers: { host: 'sentence-secondary.test' },
        });
        expect(media.rawPayload).toEqual(ukBytes);
        expect(
          (await request('GET', `/sentence-audio/${sentenceHash}/audio/US`)).rawPayload,
        ).toEqual(usBytes);
      } finally {
        await other.close();
        await secondaryDb.sentenceAudio.deleteMany({
          where: { id: `${prefix}-sentence-secondary` },
        });
        await secondaryDb.$disconnect();
      }
    },
  );

  it('supports a configured base path using the same published audio contract and exact resolver', async () => {
    const detail = await request('GET', `/pronunciation/${ids[0]}`, undefined, false, {}, true);
    expect(detail.statusCode).toBe(200);
    const advertised = detail
      .json()
      .pronunciation.audio.find((entry: { accent: string }) => entry.accent === 'US').url;
    const response = await mounted.inject({
      url: `/learn${advertised}`,
      remoteAddress: ip,
      headers: { host: 'audio-mounted.test' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(usBytes);
    const exact = await request(
      'GET',
      `/dictionary/resolve?text=${lemmas[0]}`,
      undefined,
      false,
      {},
      true,
    );
    expect(exact.statusCode).toBe(200);
    expect(exact.json().matchType).toBe('exact');
  });
});
