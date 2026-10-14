import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createDatabase } from '../db.js';
import type { AppConfig } from '../config.js';
import { freshCard, json, wordDto, wordInclude } from './shared.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('PostgreSQL private collections driven only by accepted FSRS ratings', () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('Collections require an isolated _test database');
  const db = createDatabase(url),
    runId = randomUUID(),
    prefix = `collections-it-${runId}`;
  const wordId = `${prefix}-word`,
    wordIds = [wordId, `${prefix}-word-extra-a`, `${prefix}-word-extra-b`],
    users: string[] = [],
    cookies = new Map<string, string>();
  const lemma = `collection${runId.replaceAll('-', '').replace(/[0-9]/g, (n) => String.fromCharCode(97 + Number(n)))}`;
  const password = 'Collections-integration-2026!',
    ip = `10.87.${parseInt(runId.slice(0, 2), 16)}.1`;
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-collections-'));
  fs.writeFileSync(
    path.join(webRoot, 'index.html'),
    '<html><body>Collections fixture</body></html>',
  );
  const config: AppConfig = {
    sites: [
      {
        id: 'default',
        title: 'Collections fixture',
        publicUrl: 'http://collections.test',
        basePath: '',
        hosts: ['collections.test'],
        databaseUrl: url,
        authSecret: 'collections-test-secret-'.repeat(3),
        bootstrapToken: 'unused-collections-bootstrap-'.repeat(3),
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
  let app: FastifyInstance, passwordHash: string;
  const request = (
    userId: string | null,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    route: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v2${route}`,
      remoteAddress: ip,
      headers: {
        host: 'collections.test',
        ...(userId ? { cookie: cookies.get(userId) ?? '' } : {}),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  async function login(userId: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      remoteAddress: ip,
      headers: { host: 'collections.test', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: `${userId}@example.test`, password }),
    });
    expect(response.statusCode, response.body).toBe(200);
    const raw = response.headers['set-cookie'];
    cookies.set(
      userId,
      (Array.isArray(raw) ? raw : [raw])
        .filter(Boolean)
        .map((value) => String(value).split(';')[0])
        .join('; '),
    );
  }
  async function actor() {
    const userId = `${prefix}-user-${users.length}`,
      bookId = `${userId}-book`;
    users.push(userId);
    await db.user.create({
      data: {
        id: userId,
        name: 'Original synthetic collections fixture',
        email: `${userId}@example.test`,
        accounts: {
          create: {
            id: randomUUID(),
            accountId: userId,
            providerId: 'credential',
            password: passwordHash,
          },
        },
      },
    });
    await db.book.create({
      data: {
        id: bookId,
        slug: bookId,
        title: 'Synthetic private collection book',
        description: 'No real personal data',
        goal: 'daily',
        ownerId: userId,
        items: { create: { wordId, ordinal: 0 } },
      },
    });
    await db.userSettings.create({
      data: {
        userId,
        currentBookId: bookId,
        dailyTotalGoal: 1,
        dailyNewLimit: 1,
        groupSize: 1,
        timeZone: 'Asia/Shanghai',
      },
    });
    await login(userId);
    return userId;
  }
  async function rateIssued(userId: string, session: any, rating = 'easy') {
    const item = session.items[0];
    const reveal = await request(userId, 'POST', `/study/sessions/${session.id}/commands`, {
      commandId: randomUUID(),
      itemId: item.id,
      action: 'reveal',
      expectedSessionRevision: session.revision,
    });
    expect(reveal.statusCode, reveal.body).toBe(200);
    session = reveal.json().session;
    const payload = {
      commandId: randomUUID(),
      itemId: item.id,
      action: 'rate',
      rating,
      expectedSessionRevision: session.revision,
      expectedProgressRevision: session.items[0].progressRevision,
    };
    const route = `/study/sessions/${session.id}/commands`;
    const response = await request(userId, 'POST', route, payload);
    expect(response.statusCode, response.body).toBe(200);
    return { body: response.json(), route, payload };
  }
  async function cycle(userId: string, rating = 'easy') {
    const create = await request(userId, 'POST', '/study/sessions', {
      mode: 'daily',
      commandId: randomUUID(),
      size: 1,
    });
    expect(create.statusCode, create.body).toBe(200);
    const session = create.json().session;
    expect(session?.items[0]?.wordId).toBe(wordId);
    const rated = await rateIssued(userId, session, rating);
    const current = rated.body.session;
    const answer = await request(userId, 'POST', rated.route, {
      commandId: randomUUID(),
      itemId: current.items[0].id,
      action: 'answer',
      answer: lemma,
      expectedSessionRevision: current.revision,
    });
    expect(answer.statusCode, answer.body).toBe(200);
    return rated;
  }
  async function nextDue(userId: string) {
    const progress = await db.studyProgress.findUniqueOrThrow({
      where: { userId_wordId: { userId, wordId } },
    });
    vi.setSystemTime(new Date(progress.dueAt.getTime() + 60000));
    await login(userId);
  }
  async function through(userId: string, reviews: number) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T04:00:00Z'));
    await login(userId);
    await cycle(userId);
    let last: any;
    for (let n = 0; n < reviews; n++) {
      await nextDue(userId);
      last = await cycle(userId);
    }
    return last;
  }
  async function manual(userId: string) {
    const preview = await request(userId, 'POST', '/known-words/imports', {
      format: 'text',
      text: lemma,
    });
    expect(preview.statusCode).toBe(200);
    const id = preview.json().import.id;
    expect(
      (await request(userId, 'POST', `/known-words/imports/${id}/confirm`, {})).statusCode,
    ).toBe(200);
    return id;
  }
  beforeAll(async () => {
    expect((await db.siteState.findUniqueOrThrow({ where: { id: 'singleton' } })).siteId).toBe(
      'default',
    );
    passwordHash = await hashPassword(password);
    for (const [index, id] of wordIds.entries())
      await db.word.create({
        data: {
          id,
          lemma: index ? `${lemma}${index === 1 ? 'a' : 'b'}` : lemma,
          normalizedLemma: index ? `${lemma}${index === 1 ? 'a' : 'b'}` : lemma,
          goalTags: ['daily'],
          sourceRef: 'Original synthetic collections fixture',
          contentVersion: 'integration-only',
          senses: { create: { id: `${id}-sense`, pos: 'n.', definitionZh: '原创合成回归词条' } },
        },
      });
    app = (await buildApp(config, false)).app;
  }, 60000);
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    vi.useRealTimers();
    await app?.close();
    await db.studySession.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.word.deleteMany({ where: { id: { in: wordIds } } });
    await db.rateBucket.deleteMany({ where: { key: { contains: ip } } });
    await db.$disconnect();
    fs.rmSync(webRoot, { recursive: true, force: true });
  }, 60000);
  it('accepts a saved word only once under concurrency and preserves its note/time; graduation reads do not mutate membership', async () => {
    const owner = await actor(),
      other = await actor();
    const first = await request(owner, 'POST', '/wordbook', { wordId, note: 'keep this note' });
    expect(first.json()).toMatchObject({ added: true, alreadySaved: false });
    const original = await db.userWord.findUniqueOrThrow({
      where: { userId_wordId: { userId: owner, wordId } },
    });
    const duplicates = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(owner, 'POST', '/wordbook', { wordId, note: 'must not overwrite' }),
      ),
    );
    for (const response of duplicates) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        added: false,
        alreadySaved: true,
        item: { note: 'keep this note' },
      });
    }
    const saved = await db.userWord.findUniqueOrThrow({
      where: { userId_wordId: { userId: owner, wordId } },
    });
    expect(saved.updatedAt).toEqual(original.updatedAt);
    expect(await db.userWord.count({ where: { userId: owner, wordId } })).toBe(1);
    expect((await request(other, 'GET', `/wordbook/${wordId}`)).json().item).toBeNull();
    await db.userWord.update({
      where: { id: saved.id },
      data: { graduatedAt: new Date(), paused: true },
    });
    const before = await db.userWord.findUniqueOrThrow({ where: { id: saved.id } });
    expect((await request(owner, 'GET', '/wordbook')).json().page.total).toBe(0);
    expect((await request(owner, 'GET', `/wordbook/${wordId}`)).json()).toMatchObject({
      item: null,
      collection: { inWordbook: false },
    });
    expect(await db.userWord.findUniqueOrThrow({ where: { id: saved.id } })).toEqual(before);
    const readd = await request(owner, 'POST', '/wordbook', { wordId });
    expect(readd.json()).toMatchObject({
      added: true,
      item: { id: saved.id, note: 'keep this note', paused: true, graduatedAt: null },
    });
  });
  it('graduates after three real distinct review days, adds automatic known after five, and replay/practice cannot create evidence', async () => {
    const owner = await actor(),
      other = await actor();
    await request(owner, 'POST', '/wordbook', { wordId, note: 'retained after graduation' });
    const three = await through(owner, 3);
    expect(three.body.collection).toEqual({
      inWordbook: false,
      known: null,
      transition: 'graduated',
    });
    expect(await db.reviewLog.count({ where: { userId: owner, wordId } })).toBe(4);
    expect(await db.autoKnownWord.count({ where: { userId: owner } })).toBe(0);
    for (let n = 0; n < 2; n++) {
      await nextDue(owner);
      await cycle(owner);
    }
    await login(other); // The synthetic future review dates also expire the other account's old cookie.
    expect((await request(owner, 'GET', '/known-words')).json()).toMatchObject({
      page: { total: 1 },
      items: [{ wordId, origin: 'automatic' }],
    });
    expect((await request(other, 'GET', '/known-words')).json()).toMatchObject({
      page: { total: 0 },
      items: [],
    });
    const exports = (await request(owner, 'GET', '/known-words/exports?format=json')).json().rows;
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ wordId, source: 'fsrs_reviews', origin: 'automatic' });
    const count = await db.reviewLog.count({ where: { userId: owner, wordId } });
    const repeats = await Promise.all(
      Array.from({ length: 4 }, () => request(owner, 'POST', three.route, three.payload)),
    );
    for (const repeat of repeats)
      expect(repeat.json()).toMatchObject({
        duplicate: true,
        collection: { known: 'automatic', transition: null },
      });
    expect(await db.reviewLog.count({ where: { userId: owner, wordId } })).toBe(count);
    expect((await request(owner, 'GET', '/stats')).json()).toMatchObject({
      knownClaimCount: 1,
      knownAutomaticCount: 1,
      knownManualCount: 0,
    });
    const cursor = (await request(owner, 'GET', '/known-words?limit=1')).json().page.nextCursor;
    expect(cursor).toBeNull();
    const foreign = Buffer.from(
      JSON.stringify({ version: 1, scope: `known-words:default:${owner}`, after: wordId }),
    ).toString('base64url');
    expect((await request(other, 'GET', `/known-words?cursor=${foreign}`)).statusCode).toBe(400);
    expect((await request(null, 'GET', '/known-words')).statusCode).toBe(401);
  }, 60000);
  it('Again restores a graduated-only row and resets evidence without removing history or private books', async () => {
    const owner = await actor();
    await request(owner, 'POST', '/wordbook', { wordId, note: 'restore my note' });
    await through(owner, 3);
    await nextDue(owner);
    const again = await cycle(owner, 'again');
    expect(again.body.collection).toEqual({
      inWordbook: true,
      known: null,
      transition: 'restored',
    });
    expect((await request(owner, 'GET', `/wordbook/${wordId}`)).json().item.note).toBe(
      'restore my note',
    );
    expect(await db.book.count({ where: { ownerId: owner } })).toBe(1);
    expect(await db.reviewLog.count({ where: { userId: owner, wordId } })).toBe(5);
    await nextDue(owner);
    const once = await cycle(owner, 'easy');
    expect(once.body.collection.inWordbook).toBe(true);
    expect(await db.userWord.count({ where: { userId: owner, graduatedAt: null } })).toBe(1);
  }, 60000);
  it('withdraws automatic known on Again, recreates a deleted saved row, and retains independent manual known claims', async () => {
    const owner = await actor();
    await request(owner, 'POST', '/wordbook', { wordId });
    await through(owner, 5);
    const importId = await manual(owner);
    expect((await request(owner, 'GET', '/known-words')).json().items[0].origin).toBe('manual');
    await request(owner, 'DELETE', `/wordbook/${wordId}`);
    await nextDue(owner);
    const again = await cycle(owner, 'again');
    expect(again.body.collection).toEqual({
      inWordbook: true,
      known: 'manual',
      transition: 'auto-known-withdrawn',
    });
    expect(
      (
        await db.autoKnownWord.findUniqueOrThrow({
          where: { userId_wordId: { userId: owner, wordId } },
        })
      ).revokedAt,
    ).not.toBeNull();
    expect((await db.knownImport.findUniqueOrThrow({ where: { id: importId } })).status).toBe(
      'confirmed',
    );
    const exported = (await request(owner, 'GET', '/known-words/exports?format=json')).json().rows;
    expect(exported).toHaveLength(1);
    expect(exported[0].source).toBe('user_claim');
    expect((await request(owner, 'GET', '/stats')).json()).toMatchObject({
      knownClaimCount: 1,
      knownAutomaticCount: 0,
      knownManualCount: 1,
    });
  }, 60000);
  it('counts accepted ratings on either side of the persisted 04:00 boundary rather than repeated same-day ratings', async () => {
    const owner = await actor();
    await request(owner, 'POST', '/wordbook', { wordId });
    const at = new Date('2026-10-20T19:58:00Z');
    await db.studyProgress.create({
      data: {
        userId: owner,
        wordId,
        fsrsJson: json({
          ...freshCard(at),
          state: 2,
          stability: 100,
          difficulty: 5,
          reps: 2,
          last_review: at,
          due: at,
        }),
        dueAt: at,
        lastReviewAt: at,
        firstLearnedAt: at,
        revision: 1,
      },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    async function syntheticIssued(at: Date) {
      vi.setSystemTime(at);
      await login(owner);
      const word = await db.word.findUniqueOrThrow({ where: { id: wordId }, include: wordInclude });
      const progress = await db.studyProgress.findUniqueOrThrow({
        where: { userId_wordId: { userId: owner, wordId } },
      });
      const session = await db.studySession.create({
        data: {
          userId: owner,
          mode: 'review',
          taskKind: 'legacy',
          items: {
            create: {
              wordId,
              ordinal: 0,
              progressRevision: progress.revision,
              contentSnapshot: json(wordDto(word)),
              questionJson: json({ answer: lemma, prompt: 'Original synthetic spelling prompt' }),
            },
          },
        },
      });
      const view = (await request(owner, 'GET', `/study/sessions/${session.id}`)).json().session;
      return rateIssued(owner, view, 'good');
    }
    for (const stamp of ['2026-10-20T19:58:00Z', '2026-10-20T19:59:00Z', '2026-10-20T20:01:00Z'])
      expect((await syntheticIssued(new Date(stamp))).body.collection.inWordbook).toBe(true);
    const final = await syntheticIssued(new Date('2026-10-21T20:01:00Z'));
    expect(final.body.collection.transition).toBe('graduated');
    expect(await db.reviewLog.count({ where: { userId: owner, wordId } })).toBe(4);
  }, 60000);
  it('keeps a prior manual known source independent instead of overwriting it with automatic membership', async () => {
    const owner = await actor(),
      importId = await manual(owner);
    await request(owner, 'POST', '/wordbook', { wordId });
    const last = await through(owner, 5);
    expect(last.body.collection).toMatchObject({ inWordbook: false, known: 'manual' });
    expect(await db.autoKnownWord.count({ where: { userId: owner, wordId } })).toBe(0);
    expect((await db.knownImport.findUniqueOrThrow({ where: { id: importId } })).status).toBe(
      'confirmed',
    );
  }, 60000);
  it('paginates distinct manual known words completely and rejects another account cursor', async () => {
    const owner = await actor(),
      other = await actor();
    const preview = await request(owner, 'POST', '/known-words/imports', {
      format: 'text',
      text: [lemma, `${lemma}a`, `${lemma}b`].join('\n'),
    });
    expect(preview.json().import.counts.matched).toBe(3);
    expect(
      (await request(owner, 'POST', `/known-words/imports/${preview.json().import.id}/confirm`, {}))
        .statusCode,
    ).toBe(200);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const response = await request(
        owner,
        'GET',
        `/known-words?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.page.total).toBe(3);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].origin).toBe('manual');
      seen.push(body.items[0].wordId);
      cursor = body.page.nextCursor;
      if (page === 0)
        expect(
          (await request(other, 'GET', `/known-words?cursor=${encodeURIComponent(cursor!)}`))
            .statusCode,
        ).toBe(400);
    }
    expect(cursor).toBeNull();
    expect(new Set(seen)).toEqual(new Set(wordIds));
    expect((await request(other, 'GET', '/known-words')).json().page.total).toBe(0);
  });
  it('returns coherent known pages while an authenticated user concurrently revokes its manual source', async () => {
    const owner = await actor(),
      importId = await manual(owner);
    const responses = await Promise.all([
      ...Array.from({ length: 8 }, () => request(owner, 'GET', '/known-words')),
      request(owner, 'POST', `/known-words/imports/${importId}/revoke`, {}),
      ...Array.from({ length: 8 }, () => request(owner, 'GET', '/known-words')),
    ]);
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      if (!body.page) continue;
      expect(body.page.total).toBe(body.items.length);
      for (const item of body.items) {
        expect(item.origin).toBe('manual');
        expect(typeof item.knownAt).toBe('string');
      }
    }
    expect((await request(owner, 'GET', '/known-words')).json()).toMatchObject({
      items: [],
      page: { total: 0 },
    });
  });
});
