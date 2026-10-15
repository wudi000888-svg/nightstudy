import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DeepSeekSetting } from '@prisma/client';
import { buildApp } from '../app.js';
import { createDatabase } from '../db.js';
import type { AppConfig } from '../config.js';
import {
  DeepSeekProviderError,
  DEEPSEEK_MODELS,
  type DeepSeekRequest,
  type DeepSeekTransport,
} from '../providers/deepseek.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('PostgreSQL assessment AI completion with mock-only upstream', () => {
  if (!databaseUrl) return;
  if (!new URL(databaseUrl).pathname.endsWith('_test'))
    throw new Error('assessment_ai_requires_isolated_test_database');
  const db = createDatabase(databaseUrl);
  const prefix = `assessment-ai-${randomUUID()}`,
    adminId = `${prefix}-admin`,
    learnerId = `${prefix}-learner`,
    otherId = `${prefix}-other`;
  const actors = [adminId, learnerId, otherId],
    password = 'Assessment-only-test-password-2026!',
    fakeKey = 'sk-assessment-synthetic-key-123456';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-assessment-ai-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html>Assessment test</html>');
  const cfg: AppConfig = {
    sites: [
      {
        id: 'default',
        title: 'Assessment fixture',
        publicUrl: 'https://assessment-ai.example',
        basePath: '',
        hosts: ['assessment-ai.example'],
        databaseUrl,
        authSecret: 'assessment-ai-auth-test-secret-'.repeat(3),
        bootstrapToken: 'assessment-unused-bootstrap-'.repeat(3),
        registrationOpen: true,
      },
    ],
    host: '127.0.0.1',
    port: 5198,
    production: false,
    webRoot: root,
    trustedProxy: [],
    poolSize: 5,
    maxSites: 2,
  };
  let app: FastifyInstance,
    replica: FastifyInstance,
    savedSetting: DeepSeekSetting | null = null,
    calls = 0;
  let behavior: 'ok' | 'hold' | 'invalid' | 'timeout' = 'ok';
  let resolveHold: (() => void) | undefined;
  const requests: DeepSeekRequest[] = [];
  const cookies = new Map<string, string>();
  const bucketPrefixes = [
    createHash('sha256')
      .update(JSON.stringify(['deepseek', 'default', 'site', 'default']))
      .digest('hex'),
    ...actors.map((id) =>
      createHash('sha256')
        .update(JSON.stringify(['deepseek', 'default', 'actor', id]))
        .digest('hex'),
    ),
  ];
  const bucketWhere = { OR: bucketPrefixes.map((key) => ({ key: { startsWith: key + ':' } })) };
  let savedBuckets: Awaited<ReturnType<typeof db.rateBucket.findMany>> = [];
  const transport: DeepSeekTransport = async (input) => {
    calls++;
    requests.push(input);
    if (behavior === 'hold')
      await new Promise<void>((resolve) => {
        resolveHold = resolve;
      });
    if (behavior === 'timeout') throw new DeepSeekProviderError(504, 'deepseek_timeout');
    const facts = JSON.parse(input.messages[1]!.content) as {
      questions: { wordIndex: number }[];
      words: { wordId: string }[];
    };
    const ids = [...new Set(facts.questions.map((item) => facts.words[item.wordIndex]!.wordId))];
    return {
      model: input.model,
      content:
        behavior === 'invalid'
          ? JSON.stringify({ secret: fakeKey })
          : JSON.stringify({
              summary: '本次样本中认知较稳，仍需练习拼写。',
              strengths: ['能辨认已测试的常见词义。'],
              weaknesses: ['个别词的拼写仍需巩固。'],
              wordFeedback: ids.map((wordId) => ({
                wordId,
                suggestion: '听音后独立拼写，再结合例句复习。',
              })),
              suggestedPlan: { dailyTotalGoal: 24, groupSize: 5 },
            }),
      usage: { promptTokens: 100, completionTokens: 80, totalTokens: 180 },
    };
  };
  const request = (
    method: 'GET' | 'POST' | 'PUT',
    route: string,
    payload?: unknown,
    actor = learnerId,
    second = false,
  ) =>
    (second ? replica : app).inject({
      method,
      url: '/api/v2' + route,
      remoteAddress: '10.92.77.1',
      headers: {
        host: 'assessment-ai.example',
        ...(cookies.get(actor) ? { cookie: cookies.get(actor)! } : {}),
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  const configure = async (assessmentEnabled: boolean) => {
    const r = await request(
      'PUT',
      '/admin/ai/deepseek',
      {
        enabled: true,
        assessmentEnabled,
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        protocol: 'openai-chat',
        authMode: 'bearer',
        model: DEEPSEEK_MODELS[0],
        apiKey: fakeKey,
      },
      adminId,
    );
    expect(r.statusCode).toBe(200);
    expect(r.json().assessmentEnabled).toBe(assessmentEnabled);
  };
  const currentConsent = async () => {
    const r = await request('GET', '/assessments/capabilities');
    expect(r.statusCode).toBe(200);
    const capabilities = r.json() as {
      aiAvailable: boolean;
      aiConfigurationRevision: string | null;
    };
    expect(capabilities.aiAvailable).toBe(true);
    expect(capabilities.aiConfigurationRevision).toMatch(/^[a-f0-9]{64}$/);
    return {
      useAi: true,
      expectedAiConfigurationRevision: capabilities.aiConfigurationRevision!,
    };
  };
  const completeAnswers = async (rainFixture = false) => {
    let id: string;
    if (rainFixture) {
      // This fixed canonical word makes the server's lemma binding observable;
      // only this actor's synthetic assessment is inserted, then HTTP answers
      // go through the same authoritative grader as sampled real API tasks.
      const word = await db.word.findUniqueOrThrow({ where: { id: 'demo-word-001' } });
      expect(word.lemma).toBe('rain');
      const fixture = await db.assessment.create({
        data: {
          userId: learnerId,
          goal: 'daily',
          blueprintVersion: 'synthetic-rain-fixture',
          seed: JSON.stringify({ population: { '1': 1 }, demo: true, scopeVersion: 'test-only' }),
          items: {
            create: [
              {
                wordId: word.id,
                type: 'spelling',
                stratum: '1',
                ordinal: 0,
                questionJson: { prompt: '请拼写雨', answer: word.lemma },
              },
              {
                wordId: word.id,
                type: 'recognition',
                stratum: '1',
                ordinal: 1,
                questionJson: {
                  prompt: '请选择 rain 的含义',
                  options: [
                    { id: 'rain-correct', text: '雨' },
                    { id: 'rain-wrong', text: '窗户' },
                  ],
                  answer: 'rain-correct',
                },
              },
            ],
          },
        },
      });
      id = fixture.id;
    } else {
      const made = await request('POST', '/assessments', { goal: 'daily', size: 2 });
      expect(made.statusCode).toBe(200);
      id = made.json().assessment.id as string;
    }
    const value = await db.assessment.findUniqueOrThrow({
      where: { id },
      include: { items: { orderBy: { ordinal: 'asc' } } },
    });
    for (const [index, item] of value.items.entries()) {
      const q = item.questionJson as { answer: string };
      const r = await request('POST', `/assessments/${id}/answers`, {
        commandId: randomUUID(),
        itemId: item.id,
        answer: index === 0 ? 'definitely-wrong' : q.answer,
      });
      expect(r.statusCode).toBe(200);
    }
    return id;
  };
  const waitHold = async () => {
    for (let n = 0; n < 100 && !resolveHold; n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resolveHold).toBeTypeOf('function');
  };
  beforeAll(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Live paid network forbidden');
      }),
    );
    savedSetting = await db.deepSeekSetting.findUnique({ where: { id: 'singleton' } });
    savedBuckets = await db.rateBucket.findMany({ where: bucketWhere });
    await db.rateBucket.deleteMany({ where: bucketWhere });
    const passwordHash = await hashPassword(password);
    for (const id of actors)
      await db.user.create({
        data: {
          id,
          email: `${id}@example.test`,
          name: 'Synthetic assessment actor',
          role: id === adminId ? 'admin' : 'user',
          emailVerified: true,
          accounts: {
            create: {
              id: id + '-account',
              accountId: id,
              providerId: 'credential',
              password: passwordHash,
            },
          },
        },
      });
    ({ app } = await buildApp(cfg, false, { deepSeekTransport: transport }));
    ({ app: replica } = await buildApp(cfg, false, { deepSeekTransport: transport }));
    for (const id of actors) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        remoteAddress: '10.92.77.1',
        headers: { host: 'assessment-ai.example', 'content-type': 'application/json' },
        payload: JSON.stringify({ email: `${id}@example.test`, password }),
      });
      expect(r.statusCode).toBe(200);
      const set = r.headers['set-cookie'];
      cookies.set(
        id,
        (Array.isArray(set) ? set : [set])
          .filter(Boolean)
          .map((value) => String(value).split(';')[0])
          .join('; '),
      );
    }
  });
  beforeEach(async () => {
    behavior = 'ok';
    resolveHold = undefined;
    requests.splice(0);
    calls = 0;
    await db.rateBucket.deleteMany({ where: bucketWhere });
    await db.deepSeekRequestLease.deleteMany({ where: { actorId: { in: actors } } });
  });
  afterAll(async () => {
    resolveHold?.();
    await Promise.allSettled([app?.close(), replica?.close()]);
    await db.deepSeekRequestLease.deleteMany({ where: { actorId: { in: actors } } });
    await db.adminAuditLog.deleteMany({ where: { actorId: { in: actors } } });
    await db.user.deleteMany({ where: { id: { in: actors } } });
    await db.deepSeekSetting.deleteMany({ where: { id: 'singleton' } });
    if (savedSetting) await db.deepSeekSetting.create({ data: savedSetting });
    await db.rateBucket.deleteMany({ where: bucketWhere });
    if (savedBuckets.length) await db.rateBucket.createMany({ data: savedBuckets });
    await db.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });
  it('keeps the assessment capability off by default and honors the explicit user opt-out without network calls', async () => {
    await configure(false);
    expect((await request('GET', '/assessments/capabilities')).json()).toEqual({
      aiAvailable: false,
      aiServiceName: 'DeepSeek',
      aiServiceOrigin: 'https://api.deepseek.com',
      aiConfigurationRevision: null,
    });
    const id = await completeAnswers(),
      before = calls;
    const local = await request('POST', `/assessments/${id}/finish`, { useAi: true });
    expect(local.statusCode).toBe(200);
    expect(local.json().report.aiAnalysis).toMatchObject({
      status: 'unavailable',
      reason: 'configuration_changed',
      payload: null,
    });
    expect(calls).toBe(before);
    await configure(true);
    const opted = await completeAnswers();
    const result = await request('POST', `/assessments/${opted}/finish`, { useAi: false });
    expect(result.json().report.aiAnalysis.reason).toBe('not_requested');
    expect(calls).toBe(before);
    const legacyId = await completeAnswers();
    const legacy = await request('POST', `/assessments/${legacyId}/finish`, {});
    expect(legacy.json().report.aiAnalysis).toMatchObject({
      status: 'disabled',
      reason: 'not_requested',
    });
    expect(calls).toBe(before);
  });
  it('adds bounded AI advice from actual answers without replacing objective scores, evidence or FSRS history', async () => {
    await configure(true);
    behavior = 'ok';
    const consent = await currentConsent();
    const id = await completeAnswers(true);
    const r = await request('POST', `/assessments/${id}/finish`, consent);
    expect(r.statusCode).toBe(200);
    const report = r.json().report;
    expect(report.aiAnalysis.status).toBe('available');
    expect(report.aiAnalysis.payload.wordFeedback).toEqual([
      { wordId: 'demo-word-001', lemma: 'rain', suggestion: '听音后独立拼写，再结合例句复习。' },
    ]);
    expect(report.aiAnalysis.payload.suggestedPlan).toEqual({ dailyTotalGoal: 24, groupSize: 5 });
    const stored = await db.assessment.findUniqueOrThrow({ where: { id } });
    expect(stored.reportJson).not.toHaveProperty('aiAnalysis');
    expect(report.accuracy).toEqual((stored.reportJson as Record<string, unknown>).accuracy);
    const profile = await db.masteryProfile.findUniqueOrThrow({
      where: { userId_goal: { userId: learnerId, goal: 'daily' } },
    });
    expect(profile.evidenceJson).not.toHaveProperty('aiAnalysis');
    expect(await db.reviewLog.count({ where: { userId: learnerId } })).toBe(0);
    expect(await db.studyProgress.count({ where: { userId: learnerId } })).toBe(0);
    expect(JSON.stringify(report.aiAnalysis)).not.toContain(fakeKey);
    expect(report.aiAnalysis).not.toHaveProperty('usage');
    expect(report.aiAnalysis).not.toHaveProperty('model');
    const last = requests.at(-1)!;
    expect(last.maxTokens).toBe(1200);
    expect(last.apiKey).toBe(fakeKey);
    expect(last.messages[1]!.content).toContain('definitely-wrong');
    expect(last.messages[1]!.content).not.toContain(learnerId);
    expect(last.messages[1]!.content).not.toContain('@example.test');
    const before = calls;
    expect((await request('POST', `/assessments/${id}/finish`, consent)).statusCode).toBe(200);
    expect((await request('GET', `/assessments/${id}`)).json().report.aiAnalysis.status).toBe(
      'available',
    );
    const fetched = (await request('GET', `/assessments/${id}`)).json();
    expect(fetched.report.aiAnalysis.payload.wordFeedback[0].lemma).toBe('rain');
    expect(calls).toBe(before);
  });
  it('allows only one paid attempt under simultaneous finish requests across two app instances', async () => {
    await configure(true);
    behavior = 'hold';
    resolveHold = undefined;
    const consent = await currentConsent();
    const id = await completeAnswers(),
      before = calls;
    const first = request('POST', `/assessments/${id}/finish`, consent);
    await waitHold();
    const second = await request('POST', `/assessments/${id}/finish`, consent, learnerId, true);
    expect(second.statusCode).toBe(200);
    expect(second.json().report.aiAnalysis.status).toBe('pending');
    expect(calls).toBe(before + 1);
    resolveHold!();
    expect((await first).json().report.aiAnalysis.status).toBe('available');
    behavior = 'ok';
    resolveHold = undefined;
    expect(await db.deepSeekRequestLease.count({ where: { actorId: learnerId } })).toBe(0);
  });
  it('falls back to the completed objective report on timeout or key-bearing invalid model output, without retries', async () => {
    await configure(true);
    const consent = await currentConsent();
    for (const kind of ['timeout', 'invalid'] as const) {
      behavior = kind;
      const id = await completeAnswers(),
        before = calls;
      const r = await request('POST', `/assessments/${id}/finish`, consent);
      expect(r.statusCode).toBe(200);
      expect(r.json().report.aiAnalysis.status).toBe('unavailable');
      expect(r.json().report.aiAnalysis.payload).toBeNull();
      expect(JSON.stringify(r.json())).not.toContain(fakeKey);
      expect((await db.assessment.findUniqueOrThrow({ where: { id } })).status).toBe('completed');
      expect(calls).toBe(before + 1);
      await request('POST', `/assessments/${id}/finish`, consent);
      expect(calls).toBe(before + 1);
    }
    behavior = 'ok';
  });
  it('discards advice when the administrator turns the feature off during the request', async () => {
    await configure(true);
    behavior = 'hold';
    resolveHold = undefined;
    const consent = await currentConsent();
    const id = await completeAnswers();
    const pending = request('POST', `/assessments/${id}/finish`, consent);
    await waitHold();
    await configure(false);
    resolveHold!();
    const r = await pending;
    expect(r.statusCode).toBe(200);
    expect(r.json().report.aiAnalysis).toMatchObject({
      status: 'unavailable',
      reason: 'configuration_changed',
      payload: null,
    });
    behavior = 'ok';
    resolveHold = undefined;
  });
  it('reports an expired durable claim without charging or mutating its objective report during GET', async () => {
    await configure(true);
    const consent = await currentConsent();
    const id = await completeAnswers();
    await request('POST', `/assessments/${id}/finish`, { useAi: false });
    await db.assessment.update({
      where: { id },
      data: {
        aiStatus: 'running',
        aiClaimId: randomUUID(),
        aiStartedAt: new Date(Date.now() - 91000),
        aiCompletedAt: null,
        aiResultJson: { sourceHash: 'internal-only' },
      },
    });
    const before = await db.assessment.findUniqueOrThrow({ where: { id } }),
      count = calls;
    const r = await request('GET', `/assessments/${id}`);
    expect(r.json().report.aiAnalysis).toMatchObject({
      status: 'unavailable',
      reason: 'interrupted',
      payload: null,
    });
    expect(await db.assessment.findUniqueOrThrow({ where: { id } })).toEqual(before);
    await request('POST', `/assessments/${id}/finish`, consent);
    expect(calls).toBe(count);
    expect((await db.assessment.findUniqueOrThrow({ where: { id } })).reportJson).toEqual(
      before.reportJson,
    );
  });
  it('keeps identity and strict finish body guards before any AI claim or request', async () => {
    const id = await completeAnswers(),
      before = calls;
    expect(
      (await request('POST', `/assessments/${id}/finish`, { useAi: true }, otherId)).statusCode,
    ).toBe(404);
    expect((await request('POST', `/assessments/${id}/finish`, { useAi: 'yes' })).statusCode).toBe(
      400,
    );
    expect(
      (await request('GET', '/assessments/capabilities', undefined, 'anonymous')).statusCode,
    ).toBe(401);
    expect(calls).toBe(before);
  });
  it.each(['destination', 'disabled'] as const)(
    'keeps objective scores and makes no request for the previously consented configuration after %s changes',
    async (change) => {
      await configure(true);
      const oldConsent = await currentConsent();
      const id = await completeAnswers(true);
      if (change === 'destination') {
        const updated = await request(
          'PUT',
          '/admin/ai/deepseek',
          {
            provider: 'custom',
            enabled: true,
            assessmentEnabled: true,
            baseUrl: 'https://gateway.example',
            protocol: 'openai-responses',
            authMode: 'bearer',
            model: 'vendor/consent-target',
            apiKey: 'synthetic-new-destination-key-9876',
          },
          adminId,
        );
        expect(updated.statusCode).toBe(200);
        const newConsent = await currentConsent();
        expect(newConsent.expectedAiConfigurationRevision).not.toBe(
          oldConsent.expectedAiConfigurationRevision,
        );
      } else {
        await configure(false);
      }
      const before = calls;
      const result = await request('POST', `/assessments/${id}/finish`, oldConsent);
      expect(result.statusCode).toBe(200);
      expect(result.json().report.aiAnalysis).toMatchObject({
        status: 'unavailable',
        reason: 'configuration_changed',
        payload: null,
      });
      const stored = await db.assessment.findUniqueOrThrow({ where: { id } });
      expect(stored.status).toBe('completed');
      expect(result.json().report.accuracy).toEqual(
        (stored.reportJson as Record<string, unknown>).accuracy,
      );
      expect(stored.reportJson).not.toHaveProperty('aiAnalysis');
      expect(calls).toBe(before);
      expect(await db.deepSeekRequestLease.count({ where: { actorId: learnerId } })).toBe(0);
      expect(await db.reviewLog.count({ where: { userId: learnerId } })).toBe(0);
      expect(await db.studyProgress.count({ where: { userId: learnerId } })).toBe(0);
    },
  );
  it('does not send answers for legacy explicit opt-in without a configuration revision', async () => {
    await configure(true);
    await currentConsent();
    const id = await completeAnswers(true);
    const before = calls;
    const result = await request('POST', `/assessments/${id}/finish`, { useAi: true });
    expect(result.statusCode).toBe(200);
    expect(result.json().report.aiAnalysis).toMatchObject({
      status: 'unavailable',
      reason: 'configuration_changed',
      payload: null,
    });
    const stored = await db.assessment.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('completed');
    expect(result.json().report.accuracy).toEqual(
      (stored.reportJson as Record<string, unknown>).accuracy,
    );
    expect(calls).toBe(before);
  });
  it('sends a matching custom configuration once and never recharges a finished report', async () => {
    const configured = await request(
      'PUT',
      '/admin/ai/deepseek',
      {
        provider: 'custom',
        enabled: true,
        assessmentEnabled: true,
        baseUrl: 'https://gateway.example',
        protocol: 'anthropic-messages',
        authMode: 'x-api-key',
        model: 'vendor/assessment-model',
        apiKey: 'synthetic-custom-assessment-key-8765',
      },
      adminId,
    );
    expect(configured.statusCode).toBe(200);
    behavior = 'ok';
    const consent = await currentConsent();
    expect((await request('GET', '/assessments/capabilities')).json()).toMatchObject({
      aiAvailable: true,
      aiServiceName: 'AI 服务',
      aiServiceOrigin: 'https://gateway.example',
      aiConfigurationRevision: consent.expectedAiConfigurationRevision,
    });
    const id = await completeAnswers(true);
    const before = calls;
    const finished = await request('POST', `/assessments/${id}/finish`, consent);
    expect(finished.statusCode).toBe(200);
    expect(finished.json().report.aiAnalysis.status).toBe('available');
    expect(calls).toBe(before + 1);
    expect(requests.at(-1)).toMatchObject({
      provider: 'custom',
      baseUrl: 'https://gateway.example',
      protocol: 'anthropic-messages',
      authMode: 'x-api-key',
      model: 'vendor/assessment-model',
    });
    const stored = await db.assessment.findUniqueOrThrow({ where: { id } });
    expect(finished.json().report.accuracy).toEqual(
      (stored.reportJson as Record<string, unknown>).accuracy,
    );
    const repeated = await request('POST', `/assessments/${id}/finish`, consent);
    const fetched = await request('GET', `/assessments/${id}`);
    expect(repeated.json().report).toEqual(finished.json().report);
    expect(fetched.json().report).toEqual(finished.json().report);
    expect(calls).toBe(before + 1);
  });
  it('refuses the old report when the learner loses authentication during an in-flight call', async () => {
    await configure(true);
    behavior = 'hold';
    resolveHold = undefined;
    const consent = await currentConsent();
    const id = await completeAnswers();
    const waiting = request('POST', `/assessments/${id}/finish`, consent);
    await waitHold();
    await db.user.update({ where: { id: learnerId }, data: { disabled: true } });
    resolveHold!();
    const result = await waiting;
    expect(result.statusCode).toBe(401);
    expect(result.json()).not.toHaveProperty('report');
    expect((await db.assessment.findUniqueOrThrow({ where: { id } })).aiStatus).toBe('unavailable');
    await db.user.update({ where: { id: learnerId }, data: { disabled: false } });
    behavior = 'ok';
    resolveHold = undefined;
  });
});
