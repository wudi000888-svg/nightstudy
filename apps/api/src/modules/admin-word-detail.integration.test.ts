import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createDatabase } from '../db.js';
import type { AppConfig } from '../config.js';
import { wordInclude } from './shared.js';

const databaseA = process.env.TEST_DATABASE_URL,
  databaseB = process.env.TEST_DATABASE_URL_B;
const suite = databaseA && databaseB ? describe : describe.skip;
suite('PostgreSQL complete raw administrator word details and realm-safe edits', () => {
  if (!databaseA || !databaseB) return;
  if (
    ![databaseA, databaseB].every((url) => new URL(url).pathname.endsWith('_test')) ||
    new URL(databaseA).pathname === new URL(databaseB).pathname
  )
    throw new Error('Admin word details require two distinct isolated _test databases');
  const dbA = createDatabase(databaseA),
    dbB = createDatabase(databaseB),
    nonce = randomUUID(),
    prefix = `admin-word-detail-${nonce}`;
  const publishedId = `${prefix}-published`,
    archivedId = `${prefix}-archived`,
    adminA = `${prefix}-admin-a`,
    learnerA = `${prefix}-learner-a`,
    adminB = `${prefix}-admin-b`,
    learnerB = `${prefix}-learner-b`;
  const password = 'Original-admin-word-detail-test-2026!';
  const cookies = new Map<string, string>(),
    rateKeys = [new Set<string>(), new Set<string>()];
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-admin-word-detail-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<html><body>Synthetic fixture</body></html>');
  const hosts = ['admin-word-detail-a.test', 'admin-word-detail-b.test'],
    mount = ['', '/learn'],
    ips = [
      `10.93.${Number.parseInt(nonce.slice(0, 2), 16)}.1`,
      `10.93.${Number.parseInt(nonce.slice(0, 2), 16)}.2`,
    ];
  let appA: FastifyInstance | undefined, appB: FastifyInstance | undefined;
  const app = (realm = 0) => {
    const current = realm ? appB : appA;
    if (!current) throw new Error('Admin word detail fixture not ready');
    return current;
  };
  const config = (realm = 0): AppConfig => ({
    sites: [
      {
        id: 'default',
        title: 'Synthetic administrator word detail integration',
        publicUrl: `http://${hosts[realm]}${mount[realm]}`,
        basePath: mount[realm]!,
        hosts: [hosts[realm]!],
        databaseUrl: realm ? databaseB : databaseA,
        authSecret: `admin-word-detail-secret-${realm}-`.repeat(3),
        bootstrapToken: 'unused-admin-word-detail-bootstrap-'.repeat(3),
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
  const markRateKeys = (realm: number) => {
    for (const category of ['auth', 'api'])
      rateKeys[realm]!.add(
        createHash('sha256')
          .update(`default:${ips[realm]}:${category}:${Math.floor(Date.now() / 60000)}`)
          .digest('hex'),
      );
  };
  const request = (actor: string | null, route: string, realm = 0, payload?: unknown) => {
    markRateKeys(realm);
    return app(realm).inject({
      method: payload === undefined ? 'GET' : 'PATCH',
      url: `${mount[realm]}/api/v2${route}`,
      remoteAddress: ips[realm]!,
      headers: {
        host: hosts[realm]!,
        origin: `http://${hosts[realm]}`,
        ...(actor ? { cookie: cookies.get(actor) ?? '' } : {}),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  };
  const storedWord = () =>
    dbA.word.findUniqueOrThrow({ where: { id: publishedId }, include: wordInclude });
  const stableJson = (value: unknown) => JSON.stringify(value);
  beforeAll(async () => {
    const [stateA, stateB] = await Promise.all([
      dbA.siteState.findUniqueOrThrow({ where: { id: 'singleton' } }),
      dbB.siteState.findUniqueOrThrow({ where: { id: 'singleton' } }),
    ]);
    expect(stateA.siteId).toBe('default');
    expect(stateB.siteId).toBe('default');
    expect(stateA.instanceId).not.toBe(stateB.instanceId);
    const passwordHash = await hashPassword(password);
    for (const [db, actors] of [
      [dbA, [adminA, learnerA]],
      [dbB, [adminB, learnerB]],
    ] as const)
      for (const actor of actors)
        await db.user.create({
          data: {
            id: actor,
            email: `${actor}@example.test`,
            name: 'Original synthetic editor fixture',
            role: actor === adminA || actor === adminB ? 'admin' : 'user',
            accounts: {
              create: {
                id: `${actor}-account`,
                accountId: actor,
                providerId: 'credential',
                password: passwordHash,
              },
            },
          },
        });
    const heldText = '  原始合成的待核范围义项  ';
    for (const [id, status, count] of [
      [publishedId, 'published', 5],
      [archivedId, 'archived', 2],
    ] as const)
      await dbA.word.create({
        data: {
          id,
          lemma: `${prefix}${status}`,
          normalizedLemma: `${prefix}${status}`,
          status,
          goalTags: [],
          sourceRef: 'NightStudy original synthetic fixture',
          contentVersion: `${prefix}-source-v1`,
          senses: {
            create: Array.from({ length: count }, (_, ordinal) => ({
              id: `${id}-sense-${ordinal}`,
              pos: ordinal === 1 ? 'v.' : 'n.',
              ordinal,
              definitionZh:
                ordinal === 2 ? '' : ordinal === 3 ? heldText : `原始合成中文义项${ordinal}`,
              definitionEn:
                ordinal === 0
                  ? 'An original synthetic paired definition.'
                  : ordinal === 2
                    ? 'A separate original English-only definition.'
                    : '',
              exampleEn: ordinal === 0 ? 'An original fixture sentence remains unchanged.' : '',
              exampleZh: ordinal === 0 ? '原始合成例句保持不变。' : '',
              contentMetadata:
                ordinal === 3
                  ? {
                      lexicalQuality: {
                        excludeFromLearning: true,
                        field: 'definitionZh',
                        sourceTextSha256: createHash('sha256').update(heldText).digest('hex'),
                        reason: 'Synthetic quality exclusion, not real learning content.',
                      },
                    }
                  : {},
            })),
          },
        },
      });
    await dbB.word.create({
      data: {
        id: publishedId,
        lemma: `${prefix}realm-b`,
        normalizedLemma: `${prefix}realm-b`,
        goalTags: [],
        sourceRef: 'NightStudy realm B original synthetic fixture',
        senses: {
          create: {
            id: `${publishedId}-sense-0`,
            pos: 'n.',
            definitionZh: '第二独立数据库的合成义项',
            definitionEn: 'A realm B definition only.',
          },
        },
      },
    });
    ({ app: appA } = await buildApp(config(), false));
    ({ app: appB } = await buildApp(config(1), false));
    for (const [realm, actors] of [
      [0, [adminA, learnerA]],
      [1, [adminB, learnerB]],
    ] as const)
      for (const actor of actors) {
        markRateKeys(realm);
        const login = await app(realm).inject({
          method: 'POST',
          url: `${mount[realm]}/api/auth/sign-in/email`,
          remoteAddress: ips[realm]!,
          headers: {
            host: hosts[realm]!,
            origin: `http://${hosts[realm]}`,
            'content-type': 'application/json',
          },
          payload: JSON.stringify({ email: `${actor}@example.test`, password }),
        });
        expect(login.statusCode).toBe(200);
        const raw = login.headers['set-cookie'];
        cookies.set(
          actor,
          (Array.isArray(raw) ? raw : [raw])
            .filter(Boolean)
            .map((value) => String(value).split(';')[0])
            .join('; '),
        );
      }
  }, 60000);
  afterAll(async () => {
    await Promise.all([appA?.close(), appB?.close()]);
    for (const [db, actors, keys, words] of [
      [dbA, [adminA, learnerA], rateKeys[0]!, [publishedId, archivedId]],
      [dbB, [adminB, learnerB], rateKeys[1]!, [publishedId]],
    ] as const) {
      await db.adminAuditLog.deleteMany({ where: { actorId: { in: [...actors] } } });
      await db.user.deleteMany({ where: { id: { in: [...actors] } } });
      await db.word.deleteMany({ where: { id: { in: [...words] } } });
      await db.rateBucket.deleteMany({ where: { key: { in: [...keys] } } });
      await db.$disconnect();
    }
    fs.rmSync(webRoot, { recursive: true, force: true });
  }, 60000);
  it('loads every raw sense beyond summary limits and preserves held source text without writes', async () => {
    const before = stableJson(await storedWord());
    const summary = await request(
      adminA,
      `/admin/words?q=${encodeURIComponent(`${prefix}published`)}`,
    );
    expect(summary.statusCode).toBe(200);
    expect(summary.json().items[0].senses.length).toBeLessThan(5);
    const result = await request(adminA, `/admin/words/${publishedId}`);
    expect(result.statusCode).toBe(200);
    const raw = await storedWord(),
      dto = result.json().word;
    expect(dto.id).toBe(publishedId);
    expect(dto.senses.map((sense: { id: string }) => sense.id)).toEqual(
      raw.senses.map((sense) => sense.id),
    );
    expect(dto.senses).toHaveLength(5);
    expect(dto.senses[0]).toMatchObject({
      definitionZh: raw.senses[0]!.definitionZh,
      definitionEn: raw.senses[0]!.definitionEn,
    });
    expect(dto.senses[1]).toMatchObject({
      pos: 'v.',
      definitionZh: raw.senses[1]!.definitionZh,
      definitionEn: '',
    });
    expect(dto.senses[3]).toMatchObject({
      definitionZh: raw.senses[3]!.definitionZh,
      contentMetadata: raw.senses[3]!.contentMetadata,
    });
    expect(stableJson(await storedWord())).toBe(before);
  });
  it('loads archived words for editors while the public detail keeps them hidden', async () => {
    const result = await request(adminA, `/admin/words/${archivedId}`);
    expect(result.statusCode).toBe(200);
    expect(result.json().word).toMatchObject({ id: archivedId, status: 'archived' });
    expect(result.json().word.senses).toHaveLength(2);
    const publicDetail = await request(null, `/words/${archivedId}`);
    expect(publicDetail.statusCode).toBe(404);
    expect(publicDetail.json().code).toBe('word_not_found');
  });
  it('requires administrator authentication before exposing existing or missing identities', async () => {
    for (const [actor, status, code] of [
      [null, 401, 'authentication_required'],
      [learnerA, 403, 'admin_required'],
    ] as const)
      for (const id of [publishedId, `${prefix}-missing`]) {
        const response = await request(actor, `/admin/words/${id}`);
        expect(response.statusCode).toBe(status);
        expect(response.json().code).toBe(code);
        expect(response.body).not.toContain('原始合成');
        expect(response.json()).not.toHaveProperty('word');
      }
    const absent = await request(adminA, `/admin/words/${prefix}-missing`);
    expect(absent.statusCode).toBe(404);
    expect(absent.json().code).toBe('word_not_found');
  });
  it('binds details to the authenticated realm, including subpath and same word IDs', async () => {
    const b = await request(adminB, `/admin/words/${publishedId}`, 1);
    expect(b.statusCode).toBe(200);
    expect(b.json().word.senses[0].definitionZh).toBe('第二独立数据库的合成义项');
    expect(
      (await request(adminB, `/admin/words/${archivedId}?siteId=default&userId=${adminA}`, 1))
        .statusCode,
    ).toBe(404);
    expect((await request(adminA, `/admin/words/${publishedId}`, 1)).statusCode).toBe(401);
    expect((await request(learnerB, `/admin/words/${publishedId}`, 1)).statusCode).toBe(403);
    expect((await request(adminA, `/admin/words/${publishedId}`)).json().word.senses).toHaveLength(
      5,
    );
  });
  it('edits the explicitly selected sense into English-only content without changing other sources', async () => {
    const before = await storedWord(),
      second = before.senses[1]!;
    const response = await request(adminA, `/admin/words/${publishedId}`, 0, {
      senseId: second.id,
      expectedContentVersion: before.contentVersion,
      definitionZh: '',
      definitionEn: 'An original site-authored English-only edit.',
    });
    expect(response.statusCode).toBe(200);
    const after = await storedWord();
    expect(after.id).toBe(before.id);
    expect(after.normalizedLemma).toBe(before.normalizedLemma);
    expect(after.contentVersion).not.toBe(before.contentVersion);
    expect(after.senses[1]).toMatchObject({
      id: second.id,
      wordId: publishedId,
      definitionZh: '',
      definitionEn: 'An original site-authored English-only edit.',
      contentMetadata: { definitionEn: { kind: 'site-authored', review: 'source' } },
    });
    expect(after.senses.filter((sense) => sense.id !== second.id)).toEqual(
      before.senses.filter((sense) => sense.id !== second.id),
    );
    const detail = await request(adminA, `/admin/words/${publishedId}`);
    expect(detail.json().word.senses[1]).toMatchObject({
      id: second.id,
      definitionZh: '',
      definitionEn: 'An original site-authored English-only edit.',
    });
  });
  it('rejects clearing both definitions, stale content versions and cross-word sense IDs atomically', async () => {
    const before = await storedWord(),
      beforeJson = stableJson(before);
    const auditBefore = await dbA.adminAuditLog.count({ where: { actorId: adminA } });
    const cases = [
      {
        body: {
          senseId: before.senses[1]!.id,
          expectedContentVersion: before.contentVersion,
          definitionZh: '  ',
          definitionEn: '',
        },
        status: 400,
        code: 'sense_definition_required',
      },
      {
        body: {
          senseId: before.senses[1]!.id,
          expectedContentVersion: `${prefix}-source-v1`,
          definitionEn: 'Rejected stale editor value.',
        },
        status: 409,
        code: 'word_content_changed',
      },
      {
        body: {
          senseId: `${archivedId}-sense-0`,
          expectedContentVersion: before.contentVersion,
          definitionEn: 'Rejected cross-word value.',
        },
        status: 400,
        code: 'sense_not_in_word',
      },
    ];
    for (const item of cases) {
      const response = await request(adminA, `/admin/words/${publishedId}`, 0, item.body);
      expect(response.statusCode).toBe(item.status);
      expect(response.json().code).toBe(item.code);
      expect(stableJson(await storedWord())).toBe(beforeJson);
      expect(await dbA.adminAuditLog.count({ where: { actorId: adminA } })).toBe(auditBefore);
    }
  });
});
