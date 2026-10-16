import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createDatabase } from '../db.js';
import type { AppConfig } from '../config.js';
import { bookTemplateHeader } from './custom-book-parser.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
function pcmTone(frequency = 440) {
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
}
suite('PostgreSQL private wordbooks, validated imports and user isolation', () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('Custom book integration requires an isolated database ending in _test');
  const db = createDatabase(url);
  const runId = randomUUID(),
    prefix = `custom-it-${runId}`;
  const suffix = runId
    .replaceAll('-', '')
    .replace(/[0-9]/g, (value) => String.fromCharCode(97 + Number(value)));
  const userA = `${prefix}-a`,
    userB = `${prefix}-b`,
    administrator = `${prefix}-admin`;
  const actors = [userA, userB, administrator];
  const password = 'Custom-import-integration-2026!';
  const wordIds = Array.from({ length: 5 }, (_, index) => `${prefix}-word-${index}`);
  const lemmas = ['meridian', 'moonbeam', 'daylight', 'starfield', 'clearwater'].map(
    (word) => word + suffix,
  );
  const unknown = `undiscovered${suffix}`;
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-custom-import-'));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-custom-audio-')),
    oldCache = process.env.AUDIO_CACHE_DIR,
    tone = pcmTone(),
    toneHash = createHash('sha256').update(tone).digest('hex'),
    toneKey = `files/${toneHash}.wav`,
    toneFilename = path.join(cache, toneKey);
  const audioFile = { fileKey: toneKey, fileSha256: toneHash, mimeType: 'audio/wav' };
  fs.writeFileSync(
    path.join(webRoot, 'index.html'),
    '<html><body><div id="root"></div></body></html>',
  );
  const config: AppConfig = {
    sites: [
      {
        id: 'default',
        title: 'Custom integration',
        publicUrl: 'http://private-books.test',
        basePath: '',
        hosts: ['private-books.test'],
        databaseUrl: url,
        authSecret: 'custom-integration-secret-'.repeat(3),
        bootstrapToken: 'unused-integration-bootstrap-'.repeat(3),
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
  };
  let app: FastifyInstance;
  const cookies = new Map<string, string>();
  let previewId = '',
    bookId = '',
    sessionId = '',
    initialPublicBookCount = 0;
  const clientIp = `10.79.${Number.parseInt(runId.slice(0, 2), 16)}.1`;
  function request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    route: string,
    body?: unknown,
    actor: string | null = userA,
  ) {
    return app.inject({
      method,
      url: `/api/v2${route}`,
      remoteAddress: clientIp,
      headers: {
        host: 'private-books.test',
        ...(actor ? { cookie: cookies.get(actor) ?? '' } : {}),
        ...(['POST', 'PATCH', 'DELETE'].includes(method)
          ? { 'content-type': 'application/json' }
          : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  }
  async function upload(lines: string[], title = prefix) {
    const response = await request('POST', '/custom-books/imports', {
      title,
      goal: 'daily',
      filename: 'standard.txt',
      format: 'txt',
      contentBase64: Buffer.from([bookTemplateHeader, ...lines].join('\n')).toString('base64'),
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }
  beforeAll(async () => {
    process.env.AUDIO_CACHE_DIR = cache;
    fs.mkdirSync(path.join(cache, 'files'));
    fs.writeFileSync(toneFilename, tone);
    const state = await db.siteState.findUniqueOrThrow({ where: { id: 'singleton' } });
    expect(state.siteId).toBe('default');
    const hash = await hashPassword(password);
    for (const actor of actors)
      await db.user.create({
        data: {
          id: actor,
          name: prefix,
          email: `${actor}@example.test`,
          role: actor === administrator ? 'admin' : 'user',
          accounts: {
            create: {
              id: randomUUID(),
              accountId: actor,
              providerId: 'credential',
              password: hash,
            },
          },
        },
      });
    for (let index = 0; index < wordIds.length; index++) {
      await db.word.create({
        data: {
          id: wordIds[index]!,
          lemma: lemmas[index]!,
          normalizedLemma: lemmas[index]!,
          phoneticUs: index === 2 ? '' : '/ˈtɛst/',
          phoneticUk: '/ˈtest/',
          phoneticSource: 'integration-only',
          sourceRef: 'NightStudy synthetic test fixture',
          contentVersion: 'integration-only',
          goalTags: ['daily'],
          senses: {
            create: {
              id: `${wordIds[index]}-sense`,
              pos: 'n.',
              definitionZh: index === 3 ? '   ' : '合成测试词条',
              ordinal: 0,
            },
          },
        },
      });
      for (const accent of ['US', 'UK'])
        if (!(index === 1 && accent === 'UK'))
          await db.wordAudio.create({
            data: {
              wordId: wordIds[index]!,
              accent,
              kind: 'synthesized',
              status: 'ready',
              sourceName: 'Synthetic PCM integration test tone; not speech',
              sourceUrl: 'https://example.test/fixture',
              license: 'MIT',
              attribution: 'Original automated test tone; not recorded human speech',
              ...audioFile,
            },
          });
    }
    app = (await buildApp(config, false)).app;
    for (const actor of actors) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        remoteAddress: clientIp,
        headers: { host: 'private-books.test', 'content-type': 'application/json' },
        payload: JSON.stringify({ email: `${actor}@example.test`, password }),
      });
      expect(response.statusCode).toBe(200);
      const raw = response.headers['set-cookie'];
      cookies.set(
        actor,
        (Array.isArray(raw) ? raw : [raw])
          .filter(Boolean)
          .map((entry) => String(entry).split(';')[0])
          .join('; '),
      );
    }
    initialPublicBookCount = (
      await request('GET', '/admin/overview', undefined, administrator)
    ).json().books;
  }, 60000);
  afterAll(async () => {
    try {
      await app?.close();
      await db.studySession.deleteMany({ where: { userId: { in: actors } } });
      await db.book.deleteMany({ where: { ownerId: { in: actors } } });
      await db.user.deleteMany({ where: { id: { in: actors } } });
      await db.word.deleteMany({ where: { id: { in: wordIds } } });
      await db.$disconnect();
    } finally {
      if (oldCache === undefined) delete process.env.AUDIO_CACHE_DIR;
      else process.env.AUDIO_CACHE_DIR = oldCache;
      fs.rmSync(webRoot, { recursive: true, force: true });
      fs.rmSync(cache, { recursive: true, force: true });
    }
  }, 60000);

  it('previews every standard row with accurate missing-data reasons and bounded failure exports', async () => {
    const response = await upload([
      lemmas[0]!,
      lemmas[0]!.toUpperCase(),
      lemmas[1]!,
      lemmas[2]!,
      lemmas[3]!,
      unknown,
      '42. not a word',
    ]);
    previewId = response.import.id;
    expect(response.import.counts).toEqual({
      totalRows: 7,
      ready: 1,
      failed: 5,
      duplicates: 1,
      missingPronunciation: 2,
      notFound: 1,
      missingDefinition: 1,
    });
    expect(response.items[0].wordId).toBe(wordIds[0]);
    expect(response.items[2].reasons.map((reason: { code: string }) => reason.code)).toEqual([
      'missing_audio_uk',
    ]);
    expect(response.items[3].reasons.map((reason: { code: string }) => reason.code)).toEqual([
      'missing_phonetic_us',
    ]);
    const page = await request('GET', `/custom-books/imports/${previewId}?status=failed&limit=2`);
    expect(page.statusCode).toBe(200);
    expect(page.json().page).toMatchObject({ total: 5, hasMore: true });
    const next = await request(
      'GET',
      `/custom-books/imports/${previewId}?status=failed&limit=2&cursor=${encodeURIComponent(page.json().page.nextCursor)}`,
    );
    expect(next.json().items[0].lineNumber).toBeGreaterThan(page.json().items[1].lineNumber);
    const failures = await request('GET', `/custom-books/imports/${previewId}/failures?format=tsv`);
    expect(failures.statusCode).toBe(200);
    expect(failures.body).toContain('missing_audio_uk');
    expect(failures.body).toContain('not_found');
    expect(failures.body).toContain(unknown);
    expect(failures.headers['content-disposition']).toContain('attachment');
  });

  it('atomically confirms only qualified unique words, using durable repeated-command receipts', async () => {
    const commandId = randomUUID();
    const results = await Promise.all([
      request('POST', `/custom-books/imports/${previewId}/confirm`, { commandId }),
      request('POST', `/custom-books/imports/${previewId}/confirm`, { commandId }),
    ]);
    expect(results.map((value) => value.statusCode)).toEqual([200, 200]);
    const first = results[0]!.json(),
      second = results[1]!.json();
    expect(first.book.id).toBe(second.book.id);
    expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
    bookId = first.book.id;
    expect(first).toMatchObject({
      addedCount: 1,
      skippedCount: 6,
      book: { visibility: 'private', ownedByMe: true },
    });
    expect(await db.bookItem.count({ where: { bookId } })).toBe(1);
    expect(await db.commandReceipt.count({ where: { userId: userA, commandId } })).toBe(1);
    const anotherCommand = randomUUID();
    expect(
      (
        await request('POST', `/custom-books/imports/${previewId}/confirm`, {
          commandId: anotherCommand,
        })
      ).json().duplicate,
    ).toBe(true);
    const other = await upload([lemmas[0]!], `${prefix}-second`);
    const conflict = await request('POST', `/custom-books/imports/${other.import.id}/confirm`, {
      commandId: anotherCommand,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('idempotency_conflict');
  });

  it('denies every private-book and import route to another user, anonymous callers and public-content administrators', async () => {
    expect(
      (await request('GET', '/books', undefined, userA))
        .json()
        .items.some((book: { id: string }) => book.id === bookId),
    ).toBe(true);
    for (const actor of [userB, administrator, null]) {
      expect(
        (await request('GET', '/books', undefined, actor))
          .json()
          .items.some((book: { id: string }) => book.id === bookId),
      ).toBe(false);
      expect((await request('GET', `/books/${bookId}`, undefined, actor)).statusCode).toBe(404);
    }
    for (const route of [
      `/custom-books/imports/${previewId}`,
      `/custom-books/imports/${previewId}/failures`,
      `/memory/curve?bookId=${bookId}`,
    ])
      expect((await request('GET', route, undefined, userB)).statusCode).toBe(404);
    expect((await request('POST', `/books/${bookId}/select`, {}, userB)).statusCode).toBe(404);
    expect(
      (await request('PATCH', '/me/settings', { currentBookId: bookId }, userB)).statusCode,
    ).toBe(404);
    expect(
      (await request('POST', '/study/sessions', { mode: 'learn', bookId, size: 1 }, userB))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          'POST',
          `/custom-books/imports/${previewId}/confirm`,
          { commandId: randomUUID() },
          userB,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await request('PATCH', `/custom-books/${bookId}`, { title: 'not mine' }, userB)).statusCode,
    ).toBe(404);
    expect((await request('DELETE', `/custom-books/${bookId}`, {}, userB)).statusCode).toBe(404);
    expect(
      (await request('GET', '/admin/books', undefined, administrator))
        .json()
        .items.some((book: { id: string }) => book.id === bookId),
    ).toBe(false);
    expect(
      (await request('PATCH', `/admin/books/${bookId}`, { title: 'not public' }, administrator))
        .statusCode,
    ).toBe(404);
    expect((await request('GET', '/admin/overview', undefined, administrator)).json().books).toBe(
      initialPublicBookCount,
    );
    expect((await request('GET', '/custom-books', undefined, userB)).json().items).toEqual([]);
    const published = await request('GET', `/books/${bookId}`);
    expect(published.statusCode).toBe(200);
    expect(published.json().items[0].id).toBe(wordIds[0]);
    const owned = await request('GET', '/custom-books');
    expect(owned.statusCode).toBe(200);
    expect(owned.json().items.find((book: { id: string }) => book.id === bookId)).toMatchObject({
      wordCount: 1,
      learnedCount: 0,
      coveredCount: 0,
      claimedKnownCount: 0,
      visibility: 'private',
      ownedByMe: true,
    });
  });

  it('selects the owner book for a fixed learning session and retains its progress and snapshot after archiving', async () => {
    expect((await request('POST', `/books/${bookId}/select`, {})).statusCode).toBe(200);
    expect((await request('GET', '/study/plan')).json().plan.bookId).toBe(bookId);
    const created = await request('POST', '/study/sessions', { mode: 'learn', bookId, size: 1 });
    expect(created.statusCode).toBe(200);
    sessionId = created.json().session.id;
    const archived = await request('DELETE', `/custom-books/${bookId}`, {});
    expect(archived.statusCode).toBe(200);
    expect(archived.json().progressRetained).toBe(true);
    expect((await request('GET', '/study/plan')).json().plan.bookId).toBeNull();
    expect((await request('GET', `/books/${bookId}`)).statusCode).toBe(404);
    const session = (await request('GET', `/study/sessions/${sessionId}`)).json().session;
    const item = session.items[0];
    const revealed = await request('POST', `/study/sessions/${sessionId}/commands`, {
      commandId: randomUUID(),
      itemId: item.id,
      action: 'reveal',
      expectedSessionRevision: session.revision,
    });
    expect(revealed.statusCode).toBe(200);
    const rated = await request('POST', `/study/sessions/${sessionId}/commands`, {
      commandId: randomUUID(),
      itemId: item.id,
      action: 'rate',
      rating: 'good',
      expectedSessionRevision: revealed.json().session.revision,
      expectedProgressRevision: item.progressRevision,
    });
    expect(rated.statusCode).toBe(200);
    expect(rated.json().progress.revision).toBe(1);
    expect(await db.studyProgress.count({ where: { userId: userA, wordId: wordIds[0] } })).toBe(1);
  });

  it('rechecks real readiness at confirmation, preserves new failures and never creates an empty book', async () => {
    const response = await upload([lemmas[0]!], `${prefix}-changed-readiness`);
    await db.wordAudio.update({
      where: { wordId_accent: { wordId: wordIds[0]!, accent: 'UK' } },
      data: { status: 'failed' },
    });
    try {
      const countBefore = await db.book.count({ where: { ownerId: userA } });
      const result = await request('POST', `/custom-books/imports/${response.import.id}/confirm`, {
        commandId: randomUUID(),
      });
      expect(result.statusCode).toBe(409);
      expect(result.json().code).toBe('custom_import_no_ready_words');
      const current = await request('GET', `/custom-books/imports/${response.import.id}`);
      expect(
        current.json().items[0].reasons.map((reason: { code: string }) => reason.code),
      ).toEqual(['missing_audio_uk']);
      expect(current.json().import.status).toBe('preview');
      expect(await db.book.count({ where: { ownerId: userA } })).toBe(countBefore);
    } finally {
      await db.wordAudio.update({
        where: { wordId_accent: { wordId: wordIds[0]!, accent: 'UK' } },
        data: { status: 'ready' },
      });
    }
  });

  it('rejects newly withdrawn heteronym pronunciation at preview and confirmation without deleting existing assets', async () => {
    const preview = await upload([lemmas[0]!], `${prefix}-withdrawn-pronunciation`);
    const id = `${prefix}-withdrawn-meaning`;
    const beforeAudio = await db.wordAudio.findMany({
      where: { wordId: wordIds[0]! },
      orderBy: { accent: 'asc' },
    });
    const beforeBookCount = await db.book.count({ where: { ownerId: userA } });
    await db.learningSense.create({
      data: {
        id,
        wordId: wordIds[0]!,
        pos: 'n.',
        definitionZh: '合成测试义项',
        definitionEn: 'A synthetic policy fixture.',
        status: 'held',
        contentVersion: 'test-only',
        bindingHash: 'a'.repeat(64),
        contentMetadata: {
          pronunciation: {
            wordAudioCompatible: false,
            reason: 'Original test fixture: pronunciation withdrawn after preview.',
          },
        },
      },
    });
    try {
      const failed = await upload([lemmas[0]!], `${prefix}-withdrawn-after`);
      expect(failed.items[0]).toMatchObject({
        status: 'failed',
        readiness: { phoneticUs: false, phoneticUk: false, audioUs: false, audioUk: false },
      });
      const confirmed = await request(
        'POST',
        `/custom-books/imports/${preview.import.id}/confirm`,
        { commandId: randomUUID() },
      );
      expect(confirmed.statusCode).toBe(409);
      expect(confirmed.json().code).toBe('custom_import_no_ready_words');
      expect(await db.book.count({ where: { ownerId: userA } })).toBe(beforeBookCount);
      expect(
        await db.wordAudio.findMany({ where: { wordId: wordIds[0]! }, orderBy: { accent: 'asc' } }),
      ).toEqual(beforeAudio);
    } finally {
      await db.learningSense.delete({ where: { id } });
    }
  });

  it('enforces authenticated uploads, route-specific size limits, strict templates and preview expiry', async () => {
    expect((await request('POST', '/custom-books/imports', {}, null)).statusCode).toBe(401);
    const malformed = await request('POST', '/custom-books/imports', {
      title: prefix,
      goal: 'daily',
      filename: 'words.txt',
      format: 'txt',
      contentBase64: Buffer.from('wrong header\nrain').toString('base64'),
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe('import_template_header_missing');
    const oversized = await request('POST', '/custom-books/imports', {
      title: prefix,
      goal: 'daily',
      filename: 'words.txt',
      format: 'txt',
      contentBase64: Buffer.alloc(256 * 1024 + 1).toString('base64'),
    });
    expect(oversized.statusCode).toBe(413);
    const response = await upload([lemmas[0]!], `${prefix}-expired`);
    await db.customBookImport.update({
      where: { id: response.import.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      (
        await request('POST', `/custom-books/imports/${response.import.id}/confirm`, {
          commandId: randomUUID(),
        })
      ).statusCode,
    ).toBe(410);
  });
  it('confirms a 1001-word book across bounded SQL insertion chunks without truncating or duplicating items', async () => {
    const entries = Array.from({ length: 1001 }, (_, index) => ({
      id: `${prefix}-bulk-${index}`,
      lemma: `bulk${suffix}${String.fromCharCode(97 + Math.floor(index / 676), 97 + (Math.floor(index / 26) % 26), 97 + (index % 26))}`,
    }));
    wordIds.push(...entries.map((entry) => entry.id));
    await db.word.createMany({
      data: entries.map((entry) => ({
        id: entry.id,
        lemma: entry.lemma,
        normalizedLemma: entry.lemma,
        phoneticUs: '/tɛst/',
        phoneticUk: '/test/',
        goalTags: ['daily'],
        sourceRef: 'NightStudy synthetic test fixture',
        contentVersion: 'integration-only',
      })),
    });
    await db.sense.createMany({
      data: entries.map((entry) => ({
        id: `${entry.id}-sense`,
        wordId: entry.id,
        pos: 'n.',
        definitionZh: '批量合成测试词条',
      })),
    });
    const audio = entries.flatMap((entry) =>
      ['US', 'UK'].map((accent) => ({
        wordId: entry.id,
        accent,
        kind: 'synthesized',
        status: 'ready',
        sourceName: 'Synthetic PCM integration test tone; not speech',
        sourceUrl: 'https://example.test/fixture',
        license: 'MIT',
        attribution: 'Original automated test tone; not recorded human speech',
        ...audioFile,
      })),
    );
    for (let offset = 0; offset < audio.length; offset += 1000)
      await db.wordAudio.createMany({ data: audio.slice(offset, offset + 1000) });
    const originalOpen = fsPromises.open;
    let mediaReads = 0;
    const spy = vi.spyOn(fsPromises, 'open').mockImplementation((...args) => {
      if (args[0] === toneFilename) mediaReads++;
      return originalOpen(...args);
    });
    let id: string;
    try {
      const preview = await upload(
        entries.map((entry) => entry.lemma),
        `${prefix}-large`,
      );
      expect(preview.import.counts.ready).toBe(1001);
      expect(preview.page.hasMore).toBe(true);
      expect(mediaReads).toBe(1);
      const result = await request('POST', `/custom-books/imports/${preview.import.id}/confirm`, {
        commandId: randomUUID(),
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().addedCount).toBe(1001);
      expect(mediaReads).toBe(2);
      id = result.json().book.id;
    } finally {
      spy.mockRestore();
    }
    const items = await db.bookItem.findMany({
      where: { bookId: id },
      orderBy: { ordinal: 'asc' },
      select: { wordId: true, ordinal: true },
    });
    expect(items).toHaveLength(1001);
    expect(new Set(items.map((item) => item.wordId)).size).toBe(1001);
    expect(items[1000]?.ordinal).toBe(1000);
  });

  it('classifies missing files, corrupt hashes and mismatched codecs as per-row pronunciation failures', async () => {
    const extraTone = pcmTone(660),
      extraHash = createHash('sha256').update(extraTone).digest('hex'),
      extraKey = `files/${extraHash}.wav`,
      extraFilename = path.join(cache, extraKey);
    const cases = [
      {
        accent: 'US',
        missing: true,
        fileKey: extraKey,
        fileSha256: extraHash,
        mimeType: 'audio/wav',
      },
      {
        accent: 'UK',
        missing: false,
        fileKey: extraKey,
        fileSha256: extraHash,
        mimeType: 'audio/wav',
      },
      { accent: 'US', missing: false, ...audioFile, mimeType: 'audio/ogg' },
    ];
    for (const entry of cases) {
      const { accent, missing, ...metadata } = entry;
      if (metadata.fileKey === extraKey) {
        fs.rmSync(extraFilename, { force: true });
        if (!missing) {
          const corrupt = Buffer.from(extraTone);
          corrupt[44] = corrupt[44]! ^ 1;
          fs.writeFileSync(extraFilename, corrupt);
        }
      }
      await db.wordAudio.update({
        where: { wordId_accent: { wordId: wordIds[0]!, accent } },
        data: metadata,
      });
      try {
        const preview = await upload(
          [lemmas[0]!],
          `${prefix}-invalid-${accent}-${metadata.mimeType}`,
        );
        expect(preview.import.counts).toMatchObject({
          ready: 0,
          failed: 1,
          missingPronunciation: 1,
        });
        expect(preview.items[0].status).toBe('failed');
        expect(preview.items[0].reasons.map((reason: { code: string }) => reason.code)).toEqual([
          `missing_audio_${accent.toLowerCase()}`,
        ]);
        expect(
          (
            await db.wordAudio.findUniqueOrThrow({
              where: { wordId_accent: { wordId: wordIds[0]!, accent } },
            })
          ).status,
        ).toBe('ready');
        expect((await db.word.findUniqueOrThrow({ where: { id: wordIds[0]! } })).status).toBe(
          'published',
        );
      } finally {
        await db.wordAudio.update({
          where: { wordId_accent: { wordId: wordIds[0]!, accent } },
          data: audioFile,
        });
      }
    }
  });

  it('rechecks missing media after a ready preview and persists the failure without creating an empty book', async () => {
    const extraTone = pcmTone(770),
      hash = createHash('sha256').update(extraTone).digest('hex'),
      key = `files/${hash}.wav`,
      filename = path.join(cache, key);
    fs.writeFileSync(filename, extraTone);
    await db.wordAudio.update({
      where: { wordId_accent: { wordId: wordIds[0]!, accent: 'US' } },
      data: { fileKey: key, fileSha256: hash, mimeType: 'audio/wav' },
    });
    try {
      const preview = await upload([lemmas[0]!], `${prefix}-lost-after-preview`);
      expect(preview.import.counts.ready).toBe(1);
      fs.unlinkSync(filename);
      const booksBefore = await db.book.count({ where: { ownerId: userA } });
      const result = await request('POST', `/custom-books/imports/${preview.import.id}/confirm`, {
        commandId: randomUUID(),
      });
      expect(result.statusCode).toBe(409);
      expect(result.json().code).toBe('custom_import_no_ready_words');
      const refreshed = (await request('GET', `/custom-books/imports/${preview.import.id}`)).json();
      expect(refreshed.import).toMatchObject({
        status: 'preview',
        counts: { ready: 0, failed: 1 },
      });
      expect(refreshed.items[0].reasons.map((reason: { code: string }) => reason.code)).toEqual([
        'missing_audio_us',
      ]);
      expect(await db.book.count({ where: { ownerId: userA } })).toBe(booksBefore);
    } finally {
      await db.wordAudio.update({
        where: { wordId_accent: { wordId: wordIds[0]!, accent: 'US' } },
        data: audioFile,
      });
    }
  });

  it('excludes a corrupt file at confirmation while committing other qualified words and retaining canonical identities', async () => {
    const extraTone = pcmTone(880),
      hash = createHash('sha256').update(extraTone).digest('hex'),
      key = `files/${hash}.wav`,
      filename = path.join(cache, key);
    fs.writeFileSync(filename, extraTone);
    await db.wordAudio.update({
      where: { wordId_accent: { wordId: wordIds[0]!, accent: 'UK' } },
      data: { fileKey: key, fileSha256: hash, mimeType: 'audio/wav' },
    });
    try {
      const preview = await upload([lemmas[0]!, lemmas[4]!], `${prefix}-corrupt-after-preview`);
      expect(preview.import.counts.ready).toBe(2);
      const corrupt = Buffer.from(extraTone);
      corrupt[44] = corrupt[44]! ^ 1;
      fs.writeFileSync(filename, corrupt);
      const result = await request('POST', `/custom-books/imports/${preview.import.id}/confirm`, {
        commandId: randomUUID(),
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ addedCount: 1, skippedCount: 1 });
      const items = await db.bookItem.findMany({ where: { bookId: result.json().book.id } });
      expect(items.map((item) => item.wordId)).toEqual([wordIds[4]]);
      const refreshed = (await request('GET', `/custom-books/imports/${preview.import.id}`)).json();
      expect(refreshed.import).toMatchObject({
        status: 'confirmed',
        counts: { ready: 1, failed: 1 },
      });
      expect(refreshed.items[0].reasons.map((reason: { code: string }) => reason.code)).toEqual([
        'missing_audio_uk',
      ]);
      expect((await db.word.findUniqueOrThrow({ where: { id: wordIds[0]! } })).status).toBe(
        'published',
      );
    } finally {
      await db.wordAudio.update({
        where: { wordId_accent: { wordId: wordIds[0]!, accent: 'UK' } },
        data: audioFile,
      });
    }
  });

  it('admits only two simultaneous readiness checks, rejects the third with retryable 429 and releases the leases', async () => {
    const originalOpen = fsPromises.open;
    let reads = 0,
      release!: () => void,
      started!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      twoReads = new Promise<void>((resolve) => {
        started = resolve;
      });
    const spy = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      if (args[0] === toneFilename && reads < 2) {
        reads++;
        if (reads === 2) started();
        await gate;
      }
      return originalOpen(...args);
    });
    const pending = [
      upload([lemmas[4]!], `${prefix}-busy-a`),
      upload([lemmas[4]!], `${prefix}-busy-b`),
    ];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        twoReads,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('readiness fixture did not reach two live checks')),
            5000,
          );
        }),
      ]);
      const third = await request('POST', '/custom-books/imports', {
        title: `${prefix}-busy-c`,
        goal: 'daily',
        filename: 'standard.txt',
        format: 'txt',
        contentBase64: Buffer.from(`${bookTemplateHeader}\n${lemmas[4]}\n`).toString('base64'),
      });
      expect(third.statusCode).toBe(429);
      expect(third.json().code).toBe('book_import_busy');
    } finally {
      if (timer) clearTimeout(timer);
      release();
      try {
        await Promise.all(pending);
      } finally {
        spy.mockRestore();
      }
    }
    expect((await upload([lemmas[4]!], `${prefix}-after-busy`)).import.counts.ready).toBe(1);
  });
});
