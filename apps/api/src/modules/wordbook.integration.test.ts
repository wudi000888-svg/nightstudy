import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createDatabase } from '../db.js';
import type { AppConfig } from '../config.js';
import { encodeCursor } from './pagination.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('PostgreSQL complete private wordbook pagination and exact ownership', () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('Wordbook integration requires an isolated database ending in _test');
  const db = createDatabase(url),
    runId = randomUUID(),
    prefix = `wordbook-it-${runId}`;
  const users = [`${prefix}-owner`, `${prefix}-other`],
    owner = users[0]!,
    other = users[1]!,
    password = 'Wordbook-integration-2026!';
  const suffix = runId
    .replaceAll('-', '')
    .replace(/[0-9]/g, (digit) => String.fromCharCode(97 + Number(digit)));
  const words = Array.from({ length: 603 }, (_, index) => {
    const ordinal = String(index).padStart(4, '0');
    return {
      id: `${prefix}-word-${ordinal}`,
      userWordId: `${prefix}-saved-${ordinal}`,
      lemma: `wordbook${suffix}${String.fromCharCode(97 + Math.floor(index / 26), 97 + (index % 26))}`,
    };
  });
  const oldest = words[0]!,
    wordIds = words.map((word) => word.id),
    dueAt = new Date('2025-06-02T00:00:00.000Z'),
    learnedAt = new Date('2025-05-01T00:00:00.000Z');
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-wordbook-pg-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<html><body>Wordbook test</body></html>');
  const config: AppConfig = {
    sites: [
      {
        id: 'default',
        title: 'Wordbook integration',
        publicUrl: 'http://wordbook.test',
        basePath: '',
        hosts: ['wordbook.test'],
        databaseUrl: url,
        authSecret: 'wordbook-integration-secret-'.repeat(3),
        bootstrapToken: 'unused-wordbook-integration-bootstrap-'.repeat(3),
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
  const ip = `10.82.${Number.parseInt(runId.slice(0, 2), 16)}.1`;
  const cookies = new Map<string, string>();
  let app: FastifyInstance;
  const request = (route: string, actor: string | null = owner) =>
    app.inject({
      method: 'GET',
      url: `/api/v2${route}`,
      remoteAddress: ip,
      headers: { host: 'wordbook.test', ...(actor ? { cookie: cookies.get(actor) ?? '' } : {}) },
    });

  beforeAll(async () => {
    expect((await db.siteState.findUniqueOrThrow({ where: { id: 'singleton' } })).siteId).toBe(
      'default',
    );
    const passwordHash = await hashPassword(password);
    for (const userId of users)
      await db.user.create({
        data: {
          id: userId,
          name: 'Wordbook integration fixture',
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
    await db.word.createMany({
      data: words.map((word) => ({
        id: word.id,
        lemma: word.lemma,
        normalizedLemma: word.lemma,
        sourceRef: 'Original synthetic pagination fixture',
        contentVersion: 'integration-only',
      })),
    });
    await db.sense.createMany({
      data: words.map((word) => ({
        id: `${word.id}-sense`,
        wordId: word.id,
        pos: 'n.',
        definitionZh: '生词本分页合成测试词条',
      })),
    });
    await db.userWord.createMany({
      data: words.map((word, index) => ({
        id: word.userWordId,
        userId: owner,
        wordId: word.id,
        note: `${prefix}-note-${index}`,
        favorite: index !== 0,
        paused: index === 0,
        // All newer rows share a timestamp so every page needs the secondary ID key.
        updatedAt: new Date(index === 0 ? '2024-01-01T00:00:00Z' : '2024-02-01T00:00:00Z'),
      })),
    });
    await db.studyProgress.create({
      data: {
        id: `${prefix}-progress`,
        userId: owner,
        wordId: oldest.id,
        fsrsJson: { reps: 3, state: 2 },
        dueAt,
        firstLearnedAt: learnedAt,
        revision: 7,
      },
    });
    app = (await buildApp(config, false)).app;
    for (const actor of users) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        remoteAddress: ip,
        headers: { host: 'wordbook.test', 'content-type': 'application/json' },
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
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.word.deleteMany({ where: { id: { in: wordIds } } });
    await db.rateBucket.deleteMany({ where: { key: { contains: ip } } });
    await db.$disconnect();
    fs.rmSync(webRoot, { recursive: true, force: true });
  }, 60000);

  it('defaults to 50 and paginates every saved word once, including older entries beyond the former 500-row cap', async () => {
    const defaultPage = await request('/wordbook');
    expect(defaultPage.statusCode).toBe(200);
    expect(defaultPage.json().items).toHaveLength(50);
    expect(defaultPage.json().page).toMatchObject({ total: 603, hasMore: true });
    const seen: string[] = [],
      seenWordIds: string[] = [],
      seenCursors = new Set<string>();
    let cursor: string | null = null,
      lastItem: Record<string, unknown> | undefined;
    for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
      const response = await request(
        `/wordbook?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(response.statusCode).toBe(200);
      const value = response.json();
      expect(value.page.total).toBe(603);
      expect(value.items.length).toBeLessThanOrEqual(100);
      for (const item of value.items) {
        seen.push(item.id);
        seenWordIds.push(item.wordId);
        expect(item.word.id).toBe(item.wordId);
        expect(item.word.senses[0].definitionZh).toBe('生词本分页合成测试词条');
        lastItem = item;
      }
      if (!value.page.hasMore) {
        expect(value.page.nextCursor).toBeNull();
        break;
      }
      expect(typeof value.page.nextCursor).toBe('string');
      expect(seenCursors.has(value.page.nextCursor)).toBe(false);
      seenCursors.add(value.page.nextCursor);
      cursor = value.page.nextCursor;
    }
    expect(seen).toEqual(
      [...words.slice(1)]
        .reverse()
        .concat(oldest)
        .map((word) => word.userWordId),
    );
    expect(new Set(seen).size).toBe(603);
    expect(new Set(seenWordIds).size).toBe(603);
    expect(seenWordIds.slice(0, 500)).not.toContain(oldest.id);
    expect(lastItem).toMatchObject({
      wordId: oldest.id,
      favorite: false,
      paused: true,
      note: `${prefix}-note-0`,
      progress: {
        wordId: oldest.id,
        revision: 7,
        reps: 3,
        state: 2,
        dueAt: dueAt.toISOString(),
        firstLearnedAt: learnedAt.toISOString(),
      },
    });
  });

  it('returns an empty private collection and rejects another user or site cursor without leaking rows', async () => {
    const empty = await request('/wordbook', other);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({
      items: [],
      page: { total: 0, hasMore: false, nextCursor: null },
    });
    const first = (await request('/wordbook?limit=1')).json();
    const foreign = await request(
      `/wordbook?cursor=${encodeURIComponent(first.page.nextCursor)}`,
      other,
    );
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().code).toBe('invalid_cursor');
    const otherSiteCursor = encodeCursor(
      `wordbook:another-site:${owner}`,
      JSON.stringify({ updatedAt: '2024-02-01T00:00:00.000Z', id: words[602]!.userWordId }),
    );
    const wrongSite = await request(`/wordbook?cursor=${encodeURIComponent(otherSiteCursor)}`);
    expect(wrongSite.statusCode).toBe(400);
    expect(wrongSite.json().code).toBe('invalid_cursor');
    const anonymous = await request('/wordbook', null);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().code).toBe('authentication_required');
  });

  it('strictly validates page size, unknown query fields and composite cursor payloads', async () => {
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=1.5',
      'limit=nope',
      'cursor=',
      `userId=${encodeURIComponent(other)}`,
    ]) {
      const response = await request(`/wordbook?${query}`);
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('invalid_input');
    }
    const cursor = encodeCursor(
      `wordbook:default:${owner}`,
      JSON.stringify({ updatedAt: 'invalid-date', id: oldest.userWordId }),
    );
    for (const value of ['not_base64!', cursor]) {
      const response = await request(`/wordbook?cursor=${encodeURIComponent(value)}`);
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('invalid_cursor');
    }
  });

  it('reads the oldest saved word by exact identity only for its owner, independently of paginated listing', async () => {
    const own = await request(`/wordbook/${oldest.id}`);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual({
      item: {
        id: oldest.userWordId,
        wordId: oldest.id,
        note: `${prefix}-note-0`,
        favorite: false,
        paused: true,
      },
    });
    const foreign = await request(`/wordbook/${oldest.id}`, other);
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json()).toEqual({ item: null });
    const anonymous = await request(`/wordbook/${oldest.id}`, null);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().code).toBe('authentication_required');
  });
});
