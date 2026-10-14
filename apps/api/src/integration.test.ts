import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from './app.js';
import { createDatabase } from './db.js';
import type { AppConfig } from './config.js';
import { maintenanceTick } from './maintenance.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('PostgreSQL API and isolation', () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('TEST_DATABASE_URL must point to an isolated database ending in _test');
  const prisma = createDatabase(url);
  const token = 'integration-bootstrap-token-'.repeat(2);
  const password = 'Integration-pass-2026!';
  const runId = randomUUID();
  const email = `learner-${runId}@example.test`;
  const otherEmail = `other-${runId}@example.test`;
  const adminEmail = `admin-${runId}@example.test`;
  let app: FastifyInstance;
  let second: FastifyInstance;
  let cookie = '';
  let otherCookie = '';
  let adminCookie = '';
  let userId = '';
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-web-test-'));
  fs.writeFileSync(
    path.join(webRoot, 'index.html'),
    '<html><head></head><body><div id="root"></div></body></html>',
  );
  fs.mkdirSync(path.join(webRoot, 'assets'));
  fs.writeFileSync(path.join(webRoot, 'assets', 'probe.js'), 'console.log("static probe");');
  const config: AppConfig = {
    sites: [
      {
        id: 'default',
        title: 'Integration',
        publicUrl: 'http://alpha.test',
        basePath: '',
        hosts: ['alpha.test'],
        databaseUrl: url,
        authSecret: 'integration-secret-'.repeat(3),
        bootstrapToken: token,
        registrationOpen: true,
      },
    ],
    host: '127.0.0.1',
    port: 5198,
    production: false,
    webRoot,
    trustedProxy: [],
    poolSize: 5,
    maxSites: 20,
  };
  const request = (
    method: 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'DELETE',
    route: string,
    body?: unknown,
    session = cookie,
    instance = app,
    extra: Record<string, string> = {},
  ) =>
    instance.inject({
      method,
      url: route,
      headers: {
        host: 'alpha.test',
        ...(session ? { cookie: session } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...extra,
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  function sessionCookie(headers: Record<string, unknown>) {
    const raw = headers['set-cookie'];
    return (Array.isArray(raw) ? raw : [raw])
      .filter(Boolean)
      .map((c) => String(c).split(';')[0])
      .join('; ');
  }
  async function signIn(loginEmail: string) {
    const response = await request(
      'POST',
      '/api/auth/sign-in/email',
      { email: loginEmail, password },
      '',
    );
    expect(response.statusCode, response.body).toBe(200);
    return sessionCookie(response.headers);
  }

  beforeAll(async () => {
    await prisma.siteState.upsert({
      where: { id: 'singleton' },
      create: { siteId: 'default' },
      update: { initialized: false, initializedAt: null },
    });
    await prisma.rateBucket.deleteMany();
    await prisma.job.deleteMany();
    app = (await buildApp(config, false)).app;
    second = (await buildApp(config, false)).app;
    const init = await request(
      'POST',
      '/setup',
      { token, email: adminEmail, password, name: 'Test admin' },
      '',
    );
    expect(init.statusCode, init.body).toBe(201);
    adminCookie = await signIn(adminEmail);
    for (const loginEmail of [email, otherEmail]) {
      const signup = await request(
        'POST',
        '/api/auth/sign-up/email',
        { email: loginEmail, password, name: 'Test learner', role: 'admin' },
        '',
      );
      expect(signup.statusCode, signup.body).toBe(200);
    }
    cookie = await signIn(email);
    otherCookie = await signIn(otherEmail);
    userId = (await request('GET', '/api/v2/me')).json().user.id;
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await second?.close();
    await prisma.user.deleteMany({ where: { email: { in: [email, otherEmail, adminEmail] } } });
    await prisma.$disconnect();
    fs.rmSync(webRoot, { recursive: true, force: true });
  });
  it('creates an admin exactly once and never accepts a signup role override', async () => {
    expect(
      (
        await request(
          'POST',
          '/setup',
          { token, email: 'again@example.test', password, name: 'Again' },
          '',
        )
      ).statusCode,
    ).toBe(409);
    expect((await request('GET', '/api/v2/me')).json().user.role).toBe('user');
    expect((await request('GET', '/api/v2/admin/overview')).statusCode).toBe(403);
    expect(
      (await request('GET', '/api/v2/admin/overview', undefined, adminCookie)).statusCode,
    ).toBe(200);
  });
  it('rejects unknown hosts, cross origin writes, and missing authentication', async () => {
    for (const host of ['attacker.test@alpha.test', 'alpha.test/path', 'alpha.test#fragment'])
      expect((await request('GET', '/api/v2/site', undefined, '', app, { host })).statusCode).toBe(
        404,
      );
    expect(
      (await request('GET', '/api/v2/site', undefined, '', app, { host: 'evil.test' })).statusCode,
    ).toBe(404);
    expect(
      (
        await request('POST', '/api/v2/study/sessions', { mode: 'learn' }, cookie, app, {
          origin: 'https://evil.test',
        })
      ).statusCode,
    ).toBe(403);
    expect((await request('GET', '/api/v2/study/plan', undefined, '')).statusCode).toBe(401);
  });
  it('bounds registration and authentication profile names before writing users', async () => {
    const oversizedName = '词'.repeat(81);
    expect(
      (
        await request(
          'POST',
          '/api/auth/sign-up/email',
          {
            email: `long-${runId}@example.test`,
            password,
            name: oversizedName,
          },
          '',
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await request('POST', '/api/auth/update-user', { name: oversizedName })).statusCode,
    ).toBe(400);
    expect((await request('GET', '/api/v2/me')).json().user.name).toBe('Test learner');
    expect(await prisma.user.count({ where: { email: `long-${runId}@example.test` } })).toBe(0);
  });
  it('restricts system detection to admins and never accepts an arbitrary update source', async () => {
    expect((await request('GET', '/api/v2/admin/system')).statusCode).toBe(403);
    const response = await request('GET', '/api/v2/admin/system', undefined, adminCookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().instanceId).toBe(
      (await prisma.siteState.findUniqueOrThrow({ where: { id: 'singleton' } })).instanceId,
    );
    expect(response.body).not.toContain(config.sites[0]!.authSecret);
    expect(
      (
        await request(
          'POST',
          '/api/v2/admin/system/check-update',
          { sourceUrl: 'http://127.0.0.1/private' },
          adminCookie,
        )
      ).statusCode,
    ).toBe(400);
  });
  it('serves GET and HEAD SPA pages without masking missing APIs, assets, or writes', async () => {
    const mounted = await buildApp(
      {
        ...config,
        sites: config.sites.map((site) => ({
          ...site,
          publicUrl: 'http://alpha.test/learn',
          basePath: '/learn',
        })),
      },
      false,
    );
    try {
      for (const [basePath, instance] of [
        ['', app],
        ['/learn', mounted.app],
      ] as const) {
        for (const route of ['/', '/lookup']) {
          const get = await request('GET', `${basePath}${route}`, undefined, '', instance);
          const head = await request('HEAD', `${basePath}${route}`, undefined, '', instance);
          expect(get.statusCode, get.body).toBe(200);
          expect(get.headers['content-type']).toBe('text/html; charset=utf-8');
          expect(get.body).toContain(`<base href="${basePath}/">`);
          expect(head.statusCode, head.body).toBe(200);
          expect(head.body).toBe('');
          expect(head.headers['content-type']).toBe(get.headers['content-type']);
          expect(head.headers['content-length']).toBe(get.headers['content-length']);
          expect(head.headers['cache-control']).toBe('no-store');
          expect(head.headers['content-security-policy']).toContain("script-src 'self' 'nonce-");
        }
        const asset = await request('GET', `${basePath}/assets/probe.js`, undefined, '', instance);
        const assetHead = await request(
          'HEAD',
          `${basePath}/assets/probe.js`,
          undefined,
          '',
          instance,
        );
        expect(asset.statusCode, asset.body).toBe(200);
        expect(asset.body).toBe('console.log("static probe");');
        expect(assetHead.statusCode).toBe(200);
        expect(assetHead.body).toBe('');
        expect(assetHead.headers['content-length']).toBe(asset.headers['content-length']);
        for (const route of ['/api/v2/missing-route', '/assets/missing.js']) {
          for (const method of ['GET', 'HEAD'] as const) {
            const missing = await request(method, `${basePath}${route}`, undefined, '', instance);
            expect(missing.statusCode, missing.body).toBe(404);
            expect(missing.headers['content-type']).toBe('application/json; charset=utf-8');
          }
        }
        const post = await request('POST', `${basePath}/lookup`, {}, '', instance);
        expect(post.statusCode, post.body).toBe(404);
        expect(post.json().code).toBe('not_found');
      }
    } finally {
      await mounted.app.close();
    }
  });
  it('returns empty curve without fabricating memory evidence', async () => {
    const response = await request('GET', '/api/v2/memory/curve');
    expect(response.statusCode, response.body).toBe(200);
    const data = response.json();
    expect(data.empty ?? data.curve?.empty).toBe(true);
  });
  it('preserves fixed tasks, rates a word once, and detects a stale competing task', async () => {
    const first = (
      await request('POST', '/api/v2/study/sessions', {
        mode: 'learn',
        bookId: 'demo-book-daily',
        size: 2,
      })
    ).json().session;
    const competing = (
      await request('POST', '/api/v2/study/sessions', {
        mode: 'learn',
        bookId: 'demo-book-cet4',
        size: 1,
      })
    ).json().session;
    expect(first.items).toHaveLength(2);
    expect(first.items[0].word.senses).toBeUndefined();
    expect(
      (await request('GET', `/api/v2/study/sessions/${first.id}`, undefined, otherCookie))
        .statusCode,
    ).toBe(404);
    let session = first;
    const command = (value: unknown) =>
      request('POST', `/api/v2/study/sessions/${first.id}/commands`, value);
    for (let i = 0; i < first.items.length; i++) {
      const item = session.items[session.cursor];
      const revealed = await command({
        commandId: randomUUID(),
        itemId: item.id,
        action: 'reveal',
        expectedSessionRevision: session.revision,
      });
      expect(revealed.statusCode, revealed.body).toBe(200);
      session = revealed.json().session;
      const payload = {
        commandId: randomUUID(),
        itemId: item.id,
        action: 'rate',
        rating: 'good',
        expectedSessionRevision: session.revision,
        expectedProgressRevision: session.items[session.cursor].progressRevision,
      };
      const rated = await command(payload);
      expect(rated.statusCode, rated.body).toBe(200);
      session = rated.json().session;
      const replay = await command(payload);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().duplicate).toBe(true);
      expect(
        await prisma.reviewLog.count({ where: { userId, commandId: payload.commandId } }),
      ).toBe(1);
    }
    expect(session.phase).toBe('practice');
    const fixedIds = first.items.map((x: { id: string }) => x.id);
    expect(session.items.map((x: { id: string }) => x.id)).toEqual(fixedIds);
    for (let i = 0; i < first.items.length; i++) {
      const item = session.items[session.cursor];
      const answer = await command({
        commandId: randomUUID(),
        itemId: item.id,
        action: 'answer',
        answer: item.word.lemma,
        expectedSessionRevision: session.revision,
      });
      expect(answer.statusCode, answer.body).toBe(200);
      session = answer.json().session;
    }
    expect(session.status).toBe('completed');
    expect(await prisma.reviewLog.count({ where: { userId } })).toBe(2);
    const r = await request('POST', `/api/v2/study/sessions/${competing.id}/commands`, {
      commandId: randomUUID(),
      itemId: competing.items[0].id,
      action: 'reveal',
      expectedSessionRevision: competing.revision,
    });
    const current = r.json().session;
    const stale = await request('POST', `/api/v2/study/sessions/${competing.id}/commands`, {
      commandId: randomUUID(),
      itemId: current.items[0].id,
      action: 'rate',
      rating: 'good',
      expectedSessionRevision: current.revision,
      expectedProgressRevision: 0,
    });
    expect(stale.statusCode, stale.body).toBe(409);
  });
  it('imports and exports known claims without writing or erasing FSRS history', async () => {
    const before = await prisma.studyProgress.count({ where: { userId } });
    const preview = await request('POST', '/api/v2/known-words/imports', {
      format: 'text',
      text: 'rain\nRAIN\nwindow\nunmatchedword',
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const value = preview.json().import;
    expect(value.counts).toEqual({ total: 4, matched: 2, duplicate: 1, unknown: 1 });
    expect(
      (await request('POST', `/api/v2/known-words/imports/${value.id}/confirm`, {})).statusCode,
    ).toBe(200);
    expect(
      (await request('POST', `/api/v2/known-words/imports/${value.id}/confirm`, {})).json()
        .alreadyConfirmed,
    ).toBe(true);
    const exported = await request('GET', '/api/v2/known-words/exports?format=json');
    expect(exported.json().rows).toHaveLength(2);
    expect(
      (await request('POST', `/api/v2/known-words/imports/${value.id}/revoke`, {})).statusCode,
    ).toBe(200);
    expect(await prisma.studyProgress.count({ where: { userId } })).toBe(before);
    expect(
      (await request('GET', '/api/v2/known-words/exports?format=json')).json().rows,
    ).toHaveLength(0);
  });
  it('honors an issued group after lowering the daily target and bounds concurrent new groups', async () => {
    const learnedBefore = await prisma.studyProgress.count({
      where: { userId, firstLearnedAt: { not: null } },
    });
    const created = await request('POST', '/api/v2/study/sessions', {
      mode: 'learn',
      bookId: 'demo-book-daily',
      size: 5,
    });
    expect(created.statusCode, created.body).toBe(200);
    let session = created.json().session;
    expect(session.items).toHaveLength(5);
    const fixedIds = session.items.map((item: { id: string }) => item.id);
    let prefs = (await request('GET', '/api/v2/me/settings')).json().settings;
    const lowered = await request('PATCH', '/api/v2/me/settings', {
      dailyNewLimit: learnedBefore + 2,
      expectedRevision: prefs.revision,
    });
    expect(lowered.statusCode, lowered.body).toBe(200);
    expect(
      (await request('POST', '/api/v2/study/sessions', { mode: 'learn', size: 5 })).json().session,
    ).toBeNull();
    while (session.phase === 'recall') {
      const item = session.items[session.cursor];
      const revealed = await request('POST', `/api/v2/study/sessions/${session.id}/commands`, {
        commandId: randomUUID(),
        itemId: item.id,
        action: 'reveal',
        expectedSessionRevision: session.revision,
      });
      expect(revealed.statusCode, revealed.body).toBe(200);
      session = revealed.json().session;
      const rated = await request('POST', `/api/v2/study/sessions/${session.id}/commands`, {
        commandId: randomUUID(),
        itemId: item.id,
        action: 'rate',
        rating: 'good',
        expectedSessionRevision: session.revision,
        expectedProgressRevision: session.items[session.cursor].progressRevision,
      });
      expect(rated.statusCode, rated.body).toBe(200);
      session = rated.json().session;
    }
    expect(session.items.map((item: { id: string }) => item.id)).toEqual(fixedIds);
    while (session.status !== 'completed') {
      const item = session.items[session.cursor];
      const response = await request('POST', `/api/v2/study/sessions/${session.id}/commands`, {
        commandId: randomUUID(),
        itemId: item.id,
        action: 'answer',
        answer: item.word.lemma,
        expectedSessionRevision: session.revision,
      });
      expect(response.statusCode, response.body).toBe(200);
      session = response.json().session;
    }
    const learned = await prisma.studyProgress.count({
      where: { userId, firstLearnedAt: { not: null } },
    });
    expect(learned).toBe(learnedBefore + 5);
    prefs = (await request('GET', '/api/v2/me/settings')).json().settings;
    expect(
      (
        await request('PATCH', '/api/v2/me/settings', {
          dailyNewLimit: learned + 2,
          expectedRevision: prefs.revision,
        })
      ).statusCode,
    ).toBe(200);
    const concurrent = await Promise.all([
      request('POST', '/api/v2/study/sessions', { mode: 'learn', size: 2 }),
      request('POST', '/api/v2/study/sessions', { mode: 'learn', size: 2 }),
    ]);
    concurrent.forEach((response) => expect(response.statusCode, response.body).toBe(200));
    const accepted = concurrent.map((response) => response.json().session).filter(Boolean);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].items).toHaveLength(2);
    prefs = (await request('GET', '/api/v2/me/settings')).json().settings;
    expect(
      (
        await request('PATCH', '/api/v2/me/settings', {
          dailyNewLimit: 20,
          expectedRevision: prefs.revision,
        })
      ).statusCode,
    ).toBe(200);
  });
  it('shares rate buckets across application instances', async () => {
    const minute = Math.floor(Date.now() / 60000);
    const { createHash } = await import('node:crypto');
    const key = createHash('sha256').update(`default:127.0.0.1:api:${minute}`).digest('hex');
    await prisma.rateBucket.upsert({
      where: { key },
      create: { key, count: 599, expiresAt: new Date(Date.now() + 120000) },
      update: { count: 599 },
    });
    expect((await request('GET', '/api/v2/site', undefined, '', app)).statusCode).toBe(200);
    expect((await request('GET', '/api/v2/site', undefined, '', second)).statusCode).toBe(429);
    await prisma.rateBucket.delete({ where: { key } });
  });
  it('uses the verified Render IP header for separate buckets and ignores forwarded host routing', async () => {
    const render = await buildApp(
      { ...config, clientIpProfile: 'render-public', trustedProxy: ['127.0.0.1'] },
      false,
    );
    try {
      expect((await request('GET', '/api/v2/site', undefined, '', render.app)).statusCode).toBe(
        403,
      );
      expect(
        (
          await request('GET', '/api/v2/site', undefined, '', render.app, {
            'cf-connecting-ip': '198.51.100.1, 198.51.100.2',
          })
        ).statusCode,
      ).toBe(403);
      for (const ip of ['198.51.100.1', '198.51.100.2']) {
        const response = await request('GET', '/api/v2/site', undefined, '', render.app, {
          'cf-connecting-ip': ip,
          'x-forwarded-host': 'evil.test',
        });
        expect(response.statusCode, response.body).toBe(200);
        const { createHash } = await import('node:crypto');
        const key = createHash('sha256')
          .update(`default:${ip}:api:${Math.floor(Date.now() / 60000)}`)
          .digest('hex');
        expect(
          (await prisma.rateBucket.findUniqueOrThrow({ where: { key } })).count,
        ).toBeGreaterThan(0);
      }
    } finally {
      await render.app.close();
    }
  });
  it('cleans expired rows with one shared lease and records exhausted retries', async () => {
    const expired = new Date(Date.now() - 120000),
      id = `test-maintenance-${runId}`;
    await prisma.rateBucket.create({ data: { key: id, expiresAt: expired } });
    await prisma.verification.create({
      data: { id, identifier: id, value: 'test', expiresAt: expired },
    });
    await prisma.session.create({ data: { id, token: id, userId, expiresAt: expired } });
    await prisma.job.create({
      data: {
        id,
        type: 'maintenance',
        payload: {},
        status: 'running',
        attempts: 5,
        lockedUntil: expired,
      },
    });
    await expect(maintenanceTick(prisma, 'wrong-site')).rejects.toThrow('binding_mismatch');
    expect(await prisma.rateBucket.findUnique({ where: { key: id } })).not.toBeNull();
    const beforeMinute = Math.floor(Date.now() / 60000);
    await Promise.all([maintenanceTick(prisma, 'default'), maintenanceTick(prisma, 'default')]);
    expect(await prisma.rateBucket.findUnique({ where: { key: id } })).toBeNull();
    expect(await prisma.verification.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.session.findUnique({ where: { id } })).toBeNull();
    expect((await prisma.job.findUniqueOrThrow({ where: { id } })).status).toBe('failed');
    const jobs = await prisma.job.findMany({
      where: {
        id: {
          in: [`maintenance-${beforeMinute}`, `maintenance-${Math.floor(Date.now() / 60000)}`],
        },
      },
    });
    expect(jobs.some((job) => job.status === 'completed')).toBe(true);
    expect(jobs.every((job) => job.attempts === 1)).toBe(true);
    await prisma.job.delete({ where: { id } });
  });
  it('keeps assessment evidence separate and produces a real memory curve', async () => {
    const before = await prisma.reviewLog.count({ where: { userId } });
    const created = await request('POST', '/api/v2/assessments', { goal: 'daily', size: 4 });
    expect(created.statusCode, created.body).toBe(200);
    let assessment = created.json().assessment;
    expect(
      (await request('POST', `/api/v2/assessments/${assessment.id}/finish`, {})).statusCode,
    ).toBe(409);
    while (assessment.currentItemId) {
      const item = assessment.items.find((x: { id: string }) => x.id === assessment.currentItemId);
      expect(item.question.answer).toBeUndefined();
      const answer = item.type === 'spelling' ? 'unknown' : item.question.options[0].id;
      const response = await request('POST', `/api/v2/assessments/${assessment.id}/answers`, {
        commandId: randomUUID(),
        itemId: item.id,
        answer,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().correct).toBeUndefined();
      assessment = response.json().assessment;
    }
    const finished = await request('POST', `/api/v2/assessments/${assessment.id}/finish`, {});
    expect(finished.statusCode, finished.body).toBe(200);
    expect(finished.json().report.confidence).toBe('limited_demo');
    expect(await prisma.reviewLog.count({ where: { userId } })).toBe(before);
    const curve = await request('GET', '/api/v2/memory/curve');
    expect(curve.statusCode, curve.body).toBe(200);
    expect(curve.json().empty ?? curve.json().curve?.empty).toBe(false);
  });
  it('revokes disabled accounts across existing cookies', async () => {
    const other = (await request('GET', '/api/v2/me', undefined, otherCookie)).json().user;
    const disabled = await request(
      'PATCH',
      `/api/v2/admin/users/${other.id}`,
      { disabled: true },
      adminCookie,
    );
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect((await request('GET', '/api/v2/me', undefined, otherCookie)).json().user).toBeNull();
    expect((await request('GET', '/api/v2/study/plan', undefined, otherCookie)).statusCode).toBe(
      401,
    );
  });
  it('reaches words after the first thousand and exports more than ten thousand known words', async () => {
    const fixture = `large-${runId}`;
    const total = 11001;
    const words = Array.from({ length: total }, (_, index) => ({
      id: `${fixture}-${String(index).padStart(5, '0')}`,
      lemma: `largefixture${String(index).padStart(5, '0')}`,
      normalizedLemma: `${fixture}-${String(index).padStart(5, '0')}`,
      goalTags: [] as string[],
      contentVersion: 'integration-fixture',
    }));
    const finalWord = words.at(-1)!;
    const prefs = await prisma.userSettings.findUniqueOrThrow({ where: { userId } });
    try {
      for (let offset = 0; offset < total; offset += 1000)
        await prisma.word.createMany({ data: words.slice(offset, offset + 1000) });
      await prisma.sense.create({
        data: { id: `${fixture}-sense`, wordId: finalWord.id, pos: 'n.', definitionZh: '最后一项' },
      });
      await prisma.book.create({
        data: {
          id: fixture,
          slug: fixture,
          title: 'Large regression fixture',
          description: 'Integration only',
          goal: 'daily',
          version: 'integration-fixture',
        },
      });
      await prisma.knownImport.create({
        data: { id: fixture, userId, status: 'confirmed', rowsJson: [], countsJson: {} },
      });
      for (let offset = 0; offset < total; offset += 1000) {
        const batch = words.slice(offset, offset + 1000);
        await prisma.bookItem.createMany({
          data: batch.map((word, index) => ({
            bookId: fixture,
            wordId: word.id,
            ordinal: offset + index,
          })),
        });
        await prisma.knownClaim.createMany({
          data: batch.map((word) => ({ importId: fixture, userId, wordId: word.id })),
        });
        await prisma.userWord.createMany({
          data: batch
            .filter((word) => word.id !== finalWord.id)
            .map((word) => ({ userId, wordId: word.id, paused: true })),
        });
      }
      await prisma.userSettings.update({ where: { userId }, data: { dailyNewLimit: 100 } });
      const learned = await request('POST', '/api/v2/study/sessions', {
        bookId: fixture,
        mode: 'learn',
        size: 1,
      });
      expect(learned.statusCode, learned.body).toBe(200);
      expect(learned.json().session.items[0].wordId).toBe(finalWord.id);
      const exported = await request('GET', '/api/v2/known-words/exports?format=json');
      expect(exported.statusCode).toBe(200);
      const exportedRows = exported
        .json()
        .rows.filter((row: { wordId: string }) => row.wordId.startsWith(fixture));
      expect(exportedRows).toHaveLength(total);
      expect(exportedRows.some((row: { wordId: string }) => row.wordId === finalWord.id)).toBe(
        true,
      );
      const first = await request('GET', `/api/v2/books/${fixture}?limit=50`);
      expect(first.json().page.total).toBe(total);
      expect(first.json().page.nextCursor).not.toBeNull();
    } finally {
      await prisma.studySession.deleteMany({ where: { userId, bookId: fixture } });
      await prisma.book.deleteMany({ where: { id: fixture } });
      await prisma.knownImport.deleteMany({ where: { id: fixture } });
      await prisma.userWord.deleteMany({ where: { userId, wordId: { startsWith: fixture } } });
      await prisma.word.deleteMany({ where: { id: { startsWith: fixture } } });
      await prisma.userSettings.update({
        where: { userId },
        data: { dailyNewLimit: prefs.dailyNewLimit },
      });
    }
  }, 60000);
  it('mixes a familiar probe into a five-word group and rejects blank assessment meanings', async () => {
    const fixture = `probe-${runId}`;
    const fixtureWords = Array.from({ length: 6 }, (_, i) => `${fixture}-${i}`);
    const prefs = await prisma.userSettings.findUniqueOrThrow({ where: { userId } });
    let assessmentId = '';
    try {
      for (const [i, wordId] of fixtureWords.entries())
        await prisma.word.create({
          data: {
            id: wordId,
            lemma: `probefixture${i}`,
            normalizedLemma: wordId,
            goalTags: [],
            senses: { create: { id: `${wordId}-sense`, pos: 'n.', definitionZh: `夹具含义${i}` } },
          },
        });
      await prisma.book.create({
        data: {
          id: fixture,
          slug: fixture,
          title: 'Familiar probe fixture',
          description: 'Integration only',
          goal: 'daily',
          items: { create: fixtureWords.map((wordId, ordinal) => ({ wordId, ordinal })) },
        },
      });
      await prisma.knownImport.create({
        data: {
          id: fixture,
          userId,
          status: 'confirmed',
          rowsJson: [],
          countsJson: {},
          claims: { create: { userId, wordId: fixtureWords[5]! } },
        },
      });
      await prisma.userSettings.update({ where: { userId }, data: { dailyNewLimit: 100 } });
      const group = await request('POST', '/api/v2/study/sessions', {
        mode: 'learn',
        bookId: fixture,
        size: 5,
      });
      expect(group.statusCode, group.body).toBe(200);
      expect(group.json().session.items).toHaveLength(5);
      expect(
        group
          .json()
          .session.items.filter((item: { wordId: string }) => item.wordId === fixtureWords[5]),
      ).toHaveLength(1);
      const blankId = `${fixture}-blank`;
      await prisma.word.create({
        data: {
          id: blankId,
          lemma: 'blankfixture',
          normalizedLemma: blankId,
          goalTags: ['ielts'],
          senses: { create: { id: `${blankId}-sense`, pos: 'n.', definitionZh: ' \t\n ' } },
        },
      });
      const blankEdit = await request(
        'PATCH',
        `/api/v2/admin/words/${blankId}`,
        { definitionZh: ' \t\n ', senseId: `${blankId}-sense` },
        adminCookie,
      );
      expect(blankEdit.statusCode).toBe(400);
      const assessment = await request('POST', '/api/v2/assessments', { goal: 'ielts', size: 20 });
      expect(assessment.statusCode, assessment.body).toBe(200);
      assessmentId = assessment.json().assessment.id;
      expect(await prisma.assessmentItem.count({ where: { assessmentId, wordId: blankId } })).toBe(
        0,
      );
    } finally {
      if (assessmentId) await prisma.assessment.deleteMany({ where: { id: assessmentId } });
      await prisma.studySession.deleteMany({ where: { userId, bookId: fixture } });
      await prisma.book.deleteMany({ where: { id: fixture } });
      await prisma.knownImport.deleteMany({ where: { id: fixture } });
      await prisma.word.deleteMany({ where: { id: { startsWith: fixture } } });
      await prisma.userSettings.update({
        where: { userId },
        data: { dailyNewLimit: prefs.dailyNewLimit },
      });
    }
  });
  it.skipIf(!process.env.TEST_DATABASE_URL_B)(
    'isolates databases and cookies on domain aliases and a subpath',
    async () => {
      const secondUrl = process.env.TEST_DATABASE_URL_B!;
      if (!new URL(secondUrl).pathname.endsWith('_test'))
        throw new Error('Second test database must end in _test');
      const b = createDatabase(secondUrl);
      await b.siteState.update({ where: { id: 'singleton' }, data: { siteId: 'beta' } });
      const multi = await buildApp(
        {
          ...config,
          sites: [
            ...config.sites,
            {
              ...config.sites[0]!,
              id: 'beta',
              publicUrl: 'http://alpha.test/learn',
              basePath: '/learn',
              hosts: ['alpha.test', 'beta.test'],
              databaseUrl: secondUrl,
              authSecret: 'beta-integration-secret-'.repeat(3),
            },
          ],
        },
        false,
      );
      try {
        const page = await request('GET', '/learn/profile', undefined, cookie, multi.app);
        expect(page.statusCode, page.body).toBe(200);
        expect(page.body).toContain('"basePath":"/learn"');
        expect(page.body).toContain('<base href="/learn/">');
        const site = await request('GET', '/learn/api/v2/site', undefined, '', multi.app, {
          host: 'beta.test',
        });
        expect(site.json().siteId).toBe('beta');
        const me = await request('GET', '/learn/api/v2/me', undefined, cookie, multi.app);
        expect(me.json().user).toBeNull();
        const signup = await request(
          'POST',
          '/learn/api/auth/sign-up/email',
          { name: 'Second site learner', email, password },
          '',
          multi.app,
          { origin: 'http://beta.test', host: 'beta.test' },
        );
        expect(signup.statusCode, signup.body).toBe(200);
        const bCookie = sessionCookie(signup.headers);
        expect(bCookie).toContain('nightstudy-beta');
        const self = await request('GET', '/learn/api/v2/me', undefined, bCookie, multi.app);
        expect(self.json().user.email).toBe(email);
        expect(self.json().user.id).not.toBe(userId);
        expect(
          (await request('GET', '/api/v2/me', undefined, bCookie, multi.app)).json().user,
        ).toBeNull();
        const curve = await request(
          'GET',
          '/learn/api/v2/memory/curve',
          undefined,
          bCookie,
          multi.app,
        );
        expect(curve.json().empty).toBe(true);
      } finally {
        await multi.app.close();
        await b.user.deleteMany({ where: { email } });
        await b.siteState.update({ where: { id: 'singleton' }, data: { siteId: 'default' } });
        await b.$disconnect();
      }
    },
  );
});
