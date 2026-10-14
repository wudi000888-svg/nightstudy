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
import { json, freshCard, wordDto, wordInclude, learningDayWindow } from './shared.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('PostgreSQL persisted total-word plans, task lifecycle and real FSRS state', () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('Task tests require an isolated _test database');
  const db = createDatabase(url),
    prefix = `tasks-it-${randomUUID()}`;
  const suffix = prefix
    .replaceAll('-', '')
    .replace(/[0-9]/g, (value) => String.fromCharCode(97 + Number(value)));
  const ids = Array.from({ length: 6 }, (_, index) => `${prefix}-word-${index}`);
  const users: string[] = [];
  const books: string[] = [];
  const cookies = new Map<string, string>();
  const password = 'Task-integration-2026!';
  const ip = `10.84.${Number.parseInt(prefix.slice(-2), 16) || 1}.1`;
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-tasks-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<html><body>Task integration</body></html>');
  const config: AppConfig = {
    sites: [
      {
        id: 'default',
        title: 'Task integration',
        publicUrl: 'http://tasks.test',
        basePath: '',
        hosts: ['tasks.test'],
        databaseUrl: url,
        authSecret: 'task-integration-secret-'.repeat(3),
        bootstrapToken: 'unused-task-bootstrap-'.repeat(3),
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
    actor: string | null,
    method: 'GET' | 'POST' | 'PATCH',
    route: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v2${route}`,
      remoteAddress: ip,
      headers: {
        host: 'tasks.test',
        ...(actor ? { cookie: cookies.get(actor) ?? '' } : {}),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  async function actor(total = 3, size = 2) {
    const userId = `${prefix}-user-${users.length}`,
      bookId = `${prefix}-book-${users.length}`;
    users.push(userId);
    books.push(bookId);
    await db.user.create({
      data: {
        id: userId,
        name: 'Task integration fixture',
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
        ownerId: userId,
        title: bookId,
        description: 'Original synthetic learning task test fixture',
        goal: 'daily',
        version: 'integration-only',
        items: { create: ids.map((wordId, ordinal) => ({ wordId, ordinal })) },
      },
    });
    await db.userSettings.create({
      data: {
        userId,
        currentBookId: bookId,
        dailyTotalGoal: total,
        dailyNewLimit: total,
        groupSize: size,
        timeZone: 'Asia/Shanghai',
      },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      remoteAddress: ip,
      headers: { host: 'tasks.test', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: `${userId}@example.test`, password }),
    });
    expect(login.statusCode).toBe(200);
    const raw = login.headers['set-cookie'];
    cookies.set(
      userId,
      (Array.isArray(raw) ? raw : [raw])
        .filter(Boolean)
        .map((value) => String(value).split(';')[0])
        .join('; '),
    );
    return { userId, bookId };
  }
  async function issue(userId: string, extra: Record<string, unknown> = {}) {
    const response = await request(userId, 'POST', '/study/sessions', {
      mode: 'daily',
      commandId: randomUUID(),
      ...extra,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function command(
    userId: string,
    session: any,
    action: string,
    extra: Record<string, unknown> = {},
  ) {
    const item = session.items[session.cursor];
    const response = await request(userId, 'POST', `/study/sessions/${session.id}/commands`, {
      commandId: randomUUID(),
      itemId: item.id,
      action,
      expectedSessionRevision: session.revision,
      ...(action === 'rate'
        ? { rating: 'easy', expectedProgressRevision: item.progressRevision }
        : {}),
      ...extra,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function finish(userId: string, session: any, firstRating = 'easy') {
    let current = session,
      ratingIndex = 0,
      last: any;
    while (current.phase === 'recall') {
      current = (await command(userId, current, 'reveal')).session;
      last = await command(userId, current, 'rate', {
        rating: ratingIndex++ === 0 ? firstRating : 'easy',
      });
      current = last.session;
    }
    while (current.phase === 'practice')
      current = (
        await command(userId, current, 'answer', {
          answer: current.items[current.cursor].word.lemma,
        })
      ).session;
    return { session: current, lastRating: last };
  }
  async function progress(userId: string, index: number, dueAt: Date) {
    const first = new Date(Date.now() - 2 * 86400000);
    await db.studyProgress.create({
      data: {
        userId,
        wordId: ids[index]!,
        fsrsJson: json({
          ...freshCard(first),
          state: 2,
          stability: 2,
          difficulty: 5,
          reps: 2,
          last_review: first,
          due: dueAt,
        }),
        dueAt,
        firstLearnedAt: first,
        lastReviewAt: first,
        revision: 1,
      },
    });
  }
  beforeAll(async () => {
    expect((await db.siteState.findUniqueOrThrow({ where: { id: 'singleton' } })).siteId).toBe(
      'default',
    );
    passwordHash = await hashPassword(password);
    await db.word.createMany({
      data: ids.map((id, index) => ({
        id,
        lemma: `task${suffix}${String.fromCharCode(97 + index)}`,
        normalizedLemma: `task${suffix}${String.fromCharCode(97 + index)}`,
        phoneticUs: '/tæsk/',
        phoneticUk: '/tɑːsk/',
        sourceRef: 'Original synthetic task test fixture',
        contentVersion: 'integration-only',
        goalTags: ['daily'],
      })),
    });
    await db.sense.createMany({
      data: ids.map((id) => ({
        id: `${id}-sense`,
        wordId: id,
        pos: 'n.',
        definitionZh: '任务回归合成词条',
      })),
    });
    app = (await buildApp(config, false)).app;
  }, 60000);
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await app?.close();
    await db.studySession.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.word.deleteMany({ where: { id: { in: ids } } });
    await db.rateBucket.deleteMany({ where: { key: { contains: ip } } });
    await db.$disconnect();
    fs.rmSync(webRoot, { recursive: true, force: true });
  }, 60000);

  it('initializes one settings row and plan when a new user concurrently reads settings, statistics and the daily plan', async () => {
    const { userId } = await actor();
    await db.userSettings.delete({ where: { userId } });
    expect(await db.dailyPlan.count({ where: { userId } })).toBe(0);
    const paths = [
      '/me/settings',
      '/study/plan',
      '/stats',
      '/me/settings',
      '/study/plan',
      '/stats',
      '/study/plan',
      '/me/settings',
    ];
    const responses = await Promise.all(paths.map((route) => request(userId, 'GET', route)));
    responses.forEach((response) => expect(response.statusCode, response.body).toBe(200));
    const settings = await db.userSettings.findMany({ where: { userId } });
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({
      userId,
      dailyTotalGoal: 20,
      dailyNewLimit: 20,
      revision: 0,
    });
    const plans = await db.dailyPlan.findMany({ where: { userId } });
    expect(plans).toHaveLength(1);
    for (const [index, response] of responses.entries()) {
      const value = response.json();
      if (paths[index] === '/stats') continue;
      expect(value.settings).toMatchObject({ userId, revision: 0, dailyTotalGoal: 20 });
      if (paths[index] === '/study/plan') expect(value.plan.id).toBe(plans[0]!.id);
    }
  });
  it('atomically confirms a plan, repeats a command and issues the same primary group across devices', async () => {
    const { userId, bookId } = await actor();
    const preview = await request(
      userId,
      'GET',
      `/study/plan/preview?bookId=${bookId}&dailyTotalGoal=3&groupSize=2`,
    );
    expect(preview.statusCode).toBe(200);
    expect(await db.dailyPlan.count({ where: { userId } })).toBe(0);
    const body = {
      bookId,
      dailyTotalGoal: 3,
      groupSize: 2,
      expectedRevision: preview.json().settingsRevision,
      commandId: randomUUID(),
    };
    const results = await Promise.all([
      request(userId, 'POST', '/study/plan/confirm', body),
      request(userId, 'POST', '/study/plan/confirm', body),
    ]);
    expect(results.map((value) => value.statusCode)).toEqual([200, 200]);
    expect(results[0]!.json().plan.id).toBe(results[1]!.json().plan.id);
    expect(results.map((value) => value.json().duplicate).sort()).toEqual([false, true]);
    const changedReplay = await request(userId, 'POST', '/study/plan/confirm', {
      ...body,
      dailyTotalGoal: 4,
    });
    expect(changedReplay.statusCode).toBe(409);
    expect(changedReplay.json().code).toBe('idempotency_conflict');
    const staleConfirmation = await request(userId, 'POST', '/study/plan/confirm', {
      ...body,
      commandId: randomUUID(),
    });
    expect(staleConfirmation.statusCode).toBe(409);
    expect(staleConfirmation.json().code).toBe('settings_conflict');
    const groups = await Promise.all([issue(userId), issue(userId)]);
    expect(groups[0].session.id).toBe(groups[1].session.id);
    expect(await db.studySession.count({ where: { userId } })).toBe(1);
    expect(groups[0].session.items).toHaveLength(2);
    expect(groups[0].plan.assignedUnique).toBe(2);
  });
  it('reserves later-today reviews before new words and issues due review before the remaining new slot', async () => {
    const { userId } = await actor();
    const now = new Date(),
      window = learningDayWindow(now, 'Asia/Shanghai');
    await progress(userId, 0, new Date(window.startsAt.getTime() - 60000));
    await progress(userId, 1, new Date((now.getTime() + window.endsAt.getTime()) / 2));
    const plan = (await request(userId, 'GET', '/study/plan')).json().plan;
    expect(plan).toMatchObject({
      dailyTotalGoal: 3,
      plannedReview: 2,
      newRemaining: 1,
      dueNowCount: 1,
    });
    const created = await issue(userId);
    expect(created.session.items.map((item: any) => item.wordId)).toEqual([ids[0], ids[2]]);
    expect(created.session.items.map((item: any) => item.bucket)).toEqual(['review', 'new']);
    expect(created.plan.newRemaining).toBe(0);
    expect(created.plan.assignedUnique).toBe(2);
  });
  it('shows unplanned overdue pressure beyond the total goal without changing any due dates', async () => {
    const { userId } = await actor(2);
    const start = learningDayWindow(new Date(), 'Asia/Shanghai').startsAt;
    for (let index = 0; index < 6; index++)
      await progress(userId, index, new Date(start.getTime() - (index + 1) * 3600000));
    const before = await db.studyProgress.findMany({
      where: { userId },
      orderBy: { wordId: 'asc' },
      select: { wordId: true, dueAt: true },
    });
    const plan = (await request(userId, 'GET', '/study/plan')).json().plan;
    expect(plan).toMatchObject({
      plannedReview: 2,
      plannedNew: 0,
      overdueCount: 6,
      unplannedOverdueCount: 4,
    });
    const issued = await issue(userId);
    expect(issued.session.items.map((item: any) => item.wordId)).toEqual([ids[5], ids[4]]);
    const after = await db.studyProgress.findMany({
      where: { userId },
      orderBy: { wordId: 'asc' },
      select: { wordId: true, dueAt: true },
    });
    expect(after).toEqual(before);
    const forecast = await request(userId, 'GET', '/study/forecast');
    expect(forecast.json().days).toHaveLength(7);
    expect(forecast.json().days[0].overdueCarry).toBe(6);
    expect(forecast.json().assumption).toBe('current_due_dates_no_future_reviews');
  });
  it('preserves an issued group after lowering the total goal and records only one unique word on real short-term repetitions', async () => {
    const { userId } = await actor(2, 2);
    const created = await issue(userId);
    expect((await request(userId, 'PATCH', '/me/settings', { dailyTotalGoal: 1 })).statusCode).toBe(
      200,
    );
    const finished = await finish(userId, created.session);
    expect(finished.session.status).toBe('completed');
    const plan = (await request(userId, 'GET', '/study/plan')).json().plan;
    expect(plan).toMatchObject({ dailyTotalGoal: 1, completedUnique: 2, newRemaining: 0 });
    expect((await issue(userId)).session).toBeNull();
    const history = await request(userId, 'GET', '/study/tasks?status=completed');
    expect(history.json().page.total).toBe(1);
    expect(history.json().items[0]).toMatchObject({ id: created.session.id, status: 'completed' });
  });
  it('uses the actual FSRS Again due date and a second accepted rating without consuming another daily word', async () => {
    const { userId } = await actor(1, 1);
    const created = await issue(userId);
    expect(created.session.items[0].bucket).toBe('new');
    const first = await finish(userId, created.session, 'again');
    const due = new Date(first.lastRating.progress.dueAt);
    expect(due.getTime()).toBeGreaterThan(Date.now());
    expect(due.getTime() - Date.now()).toBeLessThan(120000);
    expect((await issue(userId)).session).toBeNull();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(due.getTime() + 1000));
    const next = await issue(userId);
    expect(next.session.items[0].wordId).toBe(created.session.items[0].wordId);
    expect(next.session.items[0].progressRevision).toBe(1);
    expect(next.session.items[0].bucket).toBe('review');
    await finish(userId, next.session);
    const plan = (await request(userId, 'GET', '/study/plan')).json().plan;
    expect(plan).toMatchObject({ completedUnique: 1, completedNew: 1, completedReview: 0 });
    expect(await db.reviewLog.count({ where: { userId } })).toBe(2);
    expect(await db.reviewLog.count({ where: { userId, wasNew: false } })).toBe(1);
    expect(await db.dailyPlanWord.count({ where: { planId: plan.id } })).toBe(1);
  });
  it('counts a previously revealed new word as new when its first rating arrives after 04:00 without a prior plan read', async () => {
    const { userId } = await actor(1, 1);
    const created = await issue(userId);
    const revealed = await command(userId, created.session, 'reveal');
    expect(revealed.session.items[0]).toMatchObject({
      revealed: true,
      rated: false,
      bucket: 'new',
    });
    const oldPlanId = created.plan.id;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(new Date(created.plan.endsAt).getTime() + 1000));
    const rated = await command(userId, revealed.session, 'rate', {
      rating: 'good',
      expectedProgressRevision: 0,
    });
    expect(rated.plan.id).not.toBe(oldPlanId);
    expect(rated.plan).toMatchObject({ completedUnique: 1, completedNew: 1, completedReview: 0 });
    const log = await db.reviewLog.findFirstOrThrow({ where: { userId } });
    expect(log).toMatchObject({ wasNew: true, planId: rated.plan.id });
    expect(await db.reviewLog.count({ where: { userId } })).toBe(1);
    const dayWord = await db.dailyPlanWord.findUniqueOrThrow({
      where: { planId_wordId: { planId: rated.plan.id, wordId: created.session.items[0].wordId } },
    });
    expect(dayWord).toMatchObject({ bucket: 'new', firstRatedAt: new Date() });
  });
  it('offers explicit extra reviews beyond the primary goal and paginates durable task history with user-bound cursors', async () => {
    const { userId } = await actor(1, 1),
      other = await actor();
    const start = learningDayWindow(new Date(), 'Asia/Shanghai').startsAt;
    for (let index = 0; index < 3; index++)
      await progress(userId, index, new Date(start.getTime() - (index + 1) * 3600000));
    const primary = await issue(userId);
    const paused = await request(userId, 'POST', `/study/tasks/${primary.session.id}/state`, {
      action: 'pause',
      commandId: randomUUID(),
      expectedSessionRevision: primary.session.revision,
    });
    expect(paused.statusCode).toBe(200);
    const extra = await issue(userId, { mode: 'extra-review', size: 2 });
    expect(extra.session).toMatchObject({ mode: 'extra-review', taskKind: 'extra-review' });
    expect(extra.session.items.map((item: any) => item.wordId)).toEqual([ids[1], ids[0]]);
    await finish(userId, extra.session);
    const resumed = await request(userId, 'POST', `/study/tasks/${primary.session.id}/state`, {
      action: 'resume',
      commandId: randomUUID(),
      expectedSessionRevision: paused.json().session.revision,
    });
    expect(resumed.statusCode).toBe(200);
    await finish(userId, resumed.json().session);
    const plan = (await request(userId, 'GET', '/study/plan')).json().plan;
    expect(plan).toMatchObject({ dailyTotalGoal: 1, completedUnique: 3, completedReview: 3 });
    expect(await db.reviewLog.count({ where: { userId, wasNew: false } })).toBe(3);
    const first = await request(userId, 'GET', '/study/tasks?status=completed&limit=1');
    expect(first.json().page).toMatchObject({ total: 2, hasMore: true });
    const cursor = encodeURIComponent(first.json().page.nextCursor);
    const second = await request(
      userId,
      'GET',
      `/study/tasks?status=completed&limit=1&cursor=${cursor}`,
    );
    expect(second.json().page).toMatchObject({ total: 2, hasMore: false, nextCursor: null });
    expect(
      new Set([...first.json().items, ...second.json().items].map((item: any) => item.id)).size,
    ).toBe(2);
    expect(
      (await request(other.userId, 'GET', `/study/tasks?status=completed&limit=1&cursor=${cursor}`))
        .statusCode,
    ).toBe(400);
  });
  it('pauses and resumes the same manifest, rejects stale state and keeps independent task deferral without changing FSRS', async () => {
    const { userId } = await actor();
    const created = await issue(userId),
      session = created.session;
    const paused = await request(userId, 'POST', `/study/tasks/${session.id}/state`, {
      action: 'pause',
      commandId: randomUUID(),
      expectedSessionRevision: session.revision,
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().session.status).toBe('paused');
    const stale = await request(userId, 'POST', `/study/tasks/${session.id}/state`, {
      action: 'resume',
      commandId: randomUUID(),
      expectedSessionRevision: session.revision,
    });
    expect(stale.statusCode).toBe(409);
    const until = new Date(Date.now() + 3600000).toISOString();
    const deferred = await request(userId, 'POST', `/study/tasks/${session.id}/state`, {
      action: 'defer',
      commandId: randomUUID(),
      expectedSessionRevision: paused.json().session.revision,
      deferUntil: until,
    });
    expect(deferred.statusCode).toBe(200);
    expect(deferred.json().session.deferredUntil).toBe(until);
    expect(
      (await request(userId, 'GET', `/study/sessions/${session.id}`)).json().session.deferredUntil,
    ).toBe(until);
    const resumed = await request(userId, 'POST', `/study/tasks/${session.id}/state`, {
      action: 'resume',
      commandId: randomUUID(),
      expectedSessionRevision: deferred.json().session.revision,
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().session.items.map((item: any) => item.id)).toEqual(
      session.items.map((item: any) => item.id),
    );
    expect(resumed.json().session.deferredUntil).toBeNull();
    expect(await db.studyProgress.count({ where: { userId } })).toBe(0);
  });
  it('does not charge yesterday’s already-rated spelling-only group against today’s unique budget', async () => {
    const { userId, bookId } = await actor();
    const window = learningDayWindow(new Date(), 'Asia/Shanghai');
    await progress(userId, 0, new Date(window.endsAt.getTime() + 86400000));
    const word = await db.word.findUniqueOrThrow({ where: { id: ids[0]! }, include: wordInclude });
    const session = await db.studySession.create({
      data: {
        userId,
        bookId,
        mode: 'learn',
        phase: 'practice',
        step: 'exercise',
        createdAt: new Date(window.startsAt.getTime() - 60000),
        items: {
          create: {
            wordId: word.id,
            rated: true,
            revealed: true,
            contentSnapshot: json(wordDto(word)),
            questionJson: { answer: word.lemma, prompt: '合成测试', explanation: '合成测试' },
            ordinal: 0,
          },
        },
      },
      include: { items: true },
    });
    const plan = (await request(userId, 'GET', '/study/plan')).json().plan;
    expect(plan).toMatchObject({
      completedUnique: 0,
      assignedUnique: 0,
      newRemaining: 3,
      pendingSpellingCount: 1,
    });
    const view = (await request(userId, 'GET', `/study/sessions/${session.id}`)).json().session;
    await command(userId, view, 'answer', { answer: word.lemma });
    const after = (await request(userId, 'GET', '/study/plan')).json().plan;
    expect(after).toMatchObject({ completedUnique: 0, assignedUnique: 0, newRemaining: 3 });
    expect((await issue(userId)).session.items).toHaveLength(2);
  });
  it('preserves the active timezone snapshot until the next learning day and prevents foreign plan/task access', async () => {
    const { userId, bookId } = await actor(),
      other = await actor();
    const created = await issue(userId);
    const original = created.plan;
    const changed = await request(userId, 'PATCH', '/me/settings', {
      timeZone: 'America/New_York',
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().settings).toMatchObject({
      timeZone: 'Asia/Shanghai',
      pendingTimeZone: 'America/New_York',
      timeZoneEffectiveAt: original.endsAt,
    });
    expect((await request(userId, 'GET', '/study/plan')).json().plan.timeZone).toBe(
      'Asia/Shanghai',
    );
    expect(
      (await request(other.userId, 'GET', `/study/sessions/${created.session.id}`)).statusCode,
    ).toBe(404);
    expect(
      (await request(other.userId, 'GET', `/study/plan/preview?bookId=${bookId}`)).statusCode,
    ).toBe(404);
    expect((await request(null, 'GET', '/study/tasks')).statusCode).toBe(401);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(new Date(original.endsAt).getTime() + 1000));
    const preview = await request(userId, 'GET', `/study/plan/preview?bookId=${bookId}`);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview).toMatchObject({
      timeZone: 'America/New_York',
      pendingTimeZone: null,
    });
    const persisted = await db.userSettings.findUniqueOrThrow({ where: { userId } });
    expect(persisted.pendingTimeZone).toBe('America/New_York');
    expect(preview.json().settingsRevision).toBe(persisted.revision + 1);
    const confirmed = await request(userId, 'POST', '/study/plan/confirm', {
      bookId,
      dailyTotalGoal: 3,
      groupSize: 2,
      timeZone: 'America/New_York',
      expectedRevision: preview.json().settingsRevision,
      commandId: randomUUID(),
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const next = (await request(userId, 'GET', '/study/plan')).json();
    expect(next.settings).toMatchObject({ timeZone: 'America/New_York', pendingTimeZone: null });
    expect(next.plan.id).not.toBe(original.id);
    expect(next.plan.timeZone).toBe('America/New_York');
    expect(new Date(next.plan.startsAt).getTime()).toBeGreaterThanOrEqual(
      new Date(original.endsAt).getTime(),
    );
  });
  it('does not issue new words through the explicit legacy review endpoint', async () => {
    const { userId } = await actor();
    const response = await issue(userId, { mode: 'review' });
    expect(response.session).toBeNull();
    expect(response.reason).toBe('nothing_due');
    expect(await db.studyProgress.count({ where: { userId } })).toBe(0);
  });
});
