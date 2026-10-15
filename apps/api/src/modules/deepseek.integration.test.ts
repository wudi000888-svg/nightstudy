import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createHash, hkdfSync, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { hashPassword } from 'better-auth/crypto';
import type { FastifyInstance } from 'fastify';
import type { DeepSeekSetting, RateBucket } from '@prisma/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { buildApp } from '../app.js';
import { createDatabase } from '../db.js';
import type { AppConfig } from '../config.js';
import {
  DeepSeekProviderError,
  type DeepSeekRequest,
  type DeepSeekResult,
  type DeepSeekTransport,
} from '../providers/deepseek.js';
import { decryptDeepSeekKey } from './deepseek-crypto.js';
import {
  requestCompatibleAi,
  type CompatibleAiHttpRequest,
  type CompatibleAiRequest,
} from '../providers/compatible-ai.js';

const databaseA = process.env.TEST_DATABASE_URL,
  databaseB = process.env.TEST_DATABASE_URL_B;
const suite = databaseA && databaseB ? describe : describe.skip;
suite('DeepSeek real PostgreSQL/authentication and mock-only upstream', () => {
  if (!databaseA || !databaseB) return;
  if (
    ![databaseA, databaseB].every((value) => new URL(value).pathname.endsWith('_test')) ||
    new URL(databaseA).pathname === new URL(databaseB).pathname
  )
    throw new Error('DeepSeek integration tests require two different isolated _test databases');
  const dbA = createDatabase(databaseA),
    dbB = createDatabase(databaseB);
  const prefix = `deepseek-it-${randomUUID()}`;
  const adminA = `${prefix}-admin-a`,
    adminA2 = `${prefix}-admin-a2`,
    adminA3 = `${prefix}-admin-a3`,
    learner = `${prefix}-learner`,
    adminB = `${prefix}-admin-b`;
  const actorIds = [adminA, adminA2, adminA3, learner, adminB];
  const password = 'DeepSeek-test-password-2026!';
  const fakeKeyA = 'sk-deepseek-synthetic-test-key-a-1234',
    fakeKeyB = 'sk-deepseek-synthetic-test-key-b-9876';
  const authSecretA = 'deepseek-test-auth-secret-a-'.repeat(3),
    authSecretB = 'deepseek-test-auth-secret-b-'.repeat(3);
  const wordId = `${prefix}-word`,
    senseId = `${prefix}-sense`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-deepseek-test-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html><body>DeepSeek integration</body></html>');
  let appA: FastifyInstance, replica: FastifyInstance, appB: FastifyInstance;
  const cookies = new Map<string, string>();
  let savedA: DeepSeekSetting | null = null,
    savedB: DeepSeekSetting | null = null;
  let savedBucketsA: RateBucket[] = [],
    savedBucketsB: RateBucket[] = [];
  let instanceA = '',
    instanceB = '';
  let saved = false,
    callCount = 0;
  let behavior: 'ok' | 'hold' | 'auth-failed' | 'bad-schema' | 'key-leak' = 'ok';
  const pending: Array<() => void> = [];
  const seenRequests: DeepSeekRequest[] = [];
  const wireRequests: Array<{
    url: string;
    headers: NonNullable<Parameters<CompatibleAiHttpRequest>[1]['headers']>;
    payload: Record<string, unknown>;
  }> = [];
  let useCompatibleAdapter = false;
  const neverFetch = vi.fn(() => {
    throw new Error('Real fetch is forbidden in DeepSeek integration tests');
  });
  const ratePrefixes = [
    createHash('sha256')
      .update(JSON.stringify(['deepseek', 'default', 'site', 'default']))
      .digest('hex'),
    ...actorIds.map((id) =>
      createHash('sha256')
        .update(JSON.stringify(['deepseek', 'default', 'actor', id]))
        .digest('hex'),
    ),
  ];
  const bucketWhere = { OR: ratePrefixes.map((key) => ({ key: { startsWith: `${key}:` } })) };
  const config = (b = false): AppConfig => ({
    sites: [
      {
        id: 'default',
        title: 'DeepSeek integration',
        publicUrl: b ? 'https://deepseek-b.example/learn' : 'https://deepseek-a.example',
        basePath: b ? '/learn' : '',
        hosts: [b ? 'deepseek-b.example' : 'deepseek-a.example'],
        databaseUrl: b ? databaseB : databaseA,
        authSecret: b ? authSecretB : authSecretA,
        bootstrapToken: 'deepseek-bootstrap-unused-'.repeat(3),
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
  });
  const mockResult = (input: DeepSeekRequest): DeepSeekResult => {
    const userText = input.messages[1]?.content ?? '';
    let content = '{"ok":true}';
    if (userText.startsWith('{"lemma":')) {
      const plan = JSON.parse(userText) as {
        definitions: Array<{ sourceSenseId: string; field: string; sourceTextSha256: string }>;
        exampleSource: { sourceSenseId: string; sourceTextSha256: string } | null;
      };
      content = JSON.stringify({
        definitions: plan.definitions.map((item) => ({
          sourceSenseId: item.sourceSenseId,
          field: item.field,
          sourceTextSha256: item.sourceTextSha256,
          value:
            item.field === 'definitionEn'
              ? 'Water falling from clouds in drops.'
              : '从云中落下的水滴。',
        })),
        examples: plan.exampleSource
          ? [
              {
                sourceSenseId: plan.exampleSource.sourceSenseId,
                sourceTextSha256: plan.exampleSource.sourceTextSha256,
                exampleEn: 'The rain soaked our coats beside the station.',
                exampleZh: '雨水在车站旁打湿了我们的外套。',
              },
            ]
          : [],
      });
    }
    return {
      content,
      model: input.model,
      usage: { promptTokens: 12, completionTokens: 10, totalTokens: 22 },
    };
  };
  const transport: DeepSeekTransport = async (input) => {
    callCount++;
    seenRequests.push(input);
    if (behavior === 'hold') await new Promise<void>((resolve) => pending.push(resolve));
    if (behavior === 'auth-failed')
      throw new DeepSeekProviderError(502, 'deepseek_authentication_failed');
    const result = mockResult(input);
    if (behavior === 'bad-schema') result.content = '{"secret":"invalid schema"}';
    if (behavior === 'key-leak')
      result.content = JSON.stringify({ ok: true, unexpected: input.apiKey });
    if (useCompatibleAdapter && input.provider === 'custom') {
      const raw =
        input.protocol === 'openai-chat'
          ? { choices: [{ finish_reason: 'stop', message: { content: result.content } }] }
          : input.protocol === 'openai-responses'
            ? {
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: result.content }],
                  },
                ],
              }
            : input.protocol === 'anthropic-messages'
              ? {
                  type: 'message',
                  role: 'assistant',
                  stop_reason: 'end_turn',
                  content: [{ type: 'text', text: result.content }],
                }
              : {
                  candidates: [
                    {
                      finishReason: 'STOP',
                      content: { role: 'model', parts: [{ text: result.content }] },
                    },
                  ],
                };
      const fakeRequest: CompatibleAiHttpRequest = (url, options, callback) => {
        const request = new EventEmitter() as ClientRequest;
        request.destroy = (() => request) as ClientRequest['destroy'];
        request.end = ((body: Buffer) => {
          wireRequests.push({
            url: url.toString(),
            headers: options.headers ?? {},
            payload: JSON.parse(body.toString('utf8')),
          });
          queueMicrotask(() => {
            const response = new Readable({ read() {} }) as IncomingMessage;
            response.statusCode = 200;
            response.headers = { 'content-type': 'application/json' };
            callback(response);
            response.push(Buffer.from(JSON.stringify(raw)));
            response.push(null);
          });
          return request;
        }) as ClientRequest['end'];
        return request;
      };
      return requestCompatibleAi(input as CompatibleAiRequest, {
        resolveFn: async () => [{ address: '93.184.216.34', family: 4 }],
        requestFn: fakeRequest,
      });
    }
    return result;
  };
  function request(
    method: 'GET' | 'PUT' | 'POST',
    route: string,
    body?: unknown,
    actor = adminA,
    b = false,
    secondReplica = false,
  ) {
    return (b ? appB : secondReplica ? replica : appA).inject({
      method,
      url: `${b ? '/learn' : ''}/api/v2/admin/ai/deepseek${route}`,
      remoteAddress: b ? '10.77.53.2' : '10.77.53.1',
      headers: {
        host: b ? 'deepseek-b.example' : 'deepseek-a.example',
        ...(cookies.get(actor) ? { cookie: cookies.get(actor)! } : {}),
        ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  }
  async function signIn(actor: string, b = false) {
    const response = await (b ? appB : appA).inject({
      method: 'POST',
      url: `${b ? '/learn' : ''}/api/auth/sign-in/email`,
      remoteAddress: b ? '10.77.53.2' : '10.77.53.1',
      headers: {
        host: b ? 'deepseek-b.example' : 'deepseek-a.example',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ email: `${actor}@example.test`, password }),
    });
    expect(response.statusCode).toBe(200);
    const set = response.headers['set-cookie'];
    cookies.set(
      actor,
      (Array.isArray(set) ? set : [set])
        .filter(Boolean)
        .map((v) => String(v).split(';')[0])
        .join('; '),
    );
  }
  async function waitPending(count: number) {
    for (let i = 0; i < 100 && pending.length < count; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(pending).toHaveLength(count);
  }
  beforeAll(async () => {
    vi.stubGlobal('fetch', neverFetch);
    const [stateA, stateB] = await Promise.all([
      dbA.siteState.findUniqueOrThrow({ where: { id: 'singleton' } }),
      dbB.siteState.findUniqueOrThrow({ where: { id: 'singleton' } }),
    ]);
    expect(stateA.siteId).toBe('default');
    expect(stateB.siteId).toBe('default');
    instanceA = stateA.instanceId;
    instanceB = stateB.instanceId;
    [savedA, savedB] = await Promise.all([
      dbA.deepSeekSetting.findUnique({ where: { id: 'singleton' } }),
      dbB.deepSeekSetting.findUnique({ where: { id: 'singleton' } }),
    ]);
    [savedBucketsA, savedBucketsB] = await Promise.all([
      dbA.rateBucket.findMany({ where: bucketWhere }),
      dbB.rateBucket.findMany({ where: bucketWhere }),
    ]);
    saved = true;
    const hash = await hashPassword(password);
    for (const [db, ids] of [
      [dbA, [adminA, adminA2, adminA3, learner]],
      [dbB, [adminB]],
    ] as const)
      for (const id of ids)
        await db.user.create({
          data: {
            id,
            email: `${id}@example.test`,
            name: 'Synthetic DeepSeek test user',
            role: id === learner ? 'user' : 'admin',
            accounts: {
              create: {
                id: `${id}-account`,
                accountId: id,
                providerId: 'credential',
                password: hash,
              },
            },
          },
        });
    await dbA.word.create({
      data: {
        id: wordId,
        lemma: 'rain',
        normalizedLemma: `${prefix}-rain`,
        goalTags: [],
        sourceRef: 'NightStudy integration fixture',
        senses: { create: { id: senseId, pos: 'n.', definitionZh: '雨；雨水 ', definitionEn: '' } },
      },
    });
    ({ app: appA } = await buildApp(config(), false, { deepSeekTransport: transport }));
    ({ app: replica } = await buildApp(config(), false, { deepSeekTransport: transport }));
    ({ app: appB } = await buildApp(config(true), false, { deepSeekTransport: transport }));
    for (const id of [adminA, adminA2, adminA3, learner]) await signIn(id);
    await signIn(adminB, true);
  }, 30000);
  beforeEach(async () => {
    behavior = 'ok';
    callCount = 0;
    pending.splice(0);
    seenRequests.splice(0);
    wireRequests.splice(0);
    useCompatibleAdapter = false;
    await Promise.all([
      dbA.rateBucket.deleteMany({ where: bucketWhere }),
      dbB.rateBucket.deleteMany({ where: bucketWhere }),
      dbA.deepSeekRequestLease.deleteMany({ where: { actorId: { in: actorIds } } }),
      dbB.deepSeekRequestLease.deleteMany({ where: { actorId: { in: actorIds } } }),
    ]);
    expect(
      (
        await request('PUT', '', {
          enabled: true,
          assessmentEnabled: false,
          provider: 'deepseek',
          baseUrl: 'https://api.deepseek.com',
          protocol: 'openai-chat',
          authMode: 'bearer',
          model: 'deepseek-flash',
          apiKey: fakeKeyA,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request(
          'PUT',
          '',
          {
            enabled: true,
            assessmentEnabled: false,
            provider: 'deepseek',
            baseUrl: 'https://api.deepseek.com',
            protocol: 'openai-chat',
            authMode: 'bearer',
            model: 'deepseek-flash',
            apiKey: fakeKeyB,
          },
          adminB,
          true,
        )
      ).statusCode,
    ).toBe(200);
  });
  afterAll(async () => {
    for (const resolve of pending.splice(0)) resolve();
    await Promise.all([appA?.close(), replica?.close(), appB?.close()]);
    if (saved) {
      for (const [db, setting, buckets] of [
        [dbA, savedA, savedBucketsA],
        [dbB, savedB, savedBucketsB],
      ] as const) {
        await db.deepSeekRequestLease.deleteMany({ where: { actorId: { in: actorIds } } });
        await db.adminAuditLog.deleteMany({
          where: { actorId: { in: actorIds }, action: 'ai.deepseek.configure' },
        });
        await db.user.deleteMany({ where: { id: { in: actorIds } } });
        await db.rateBucket.deleteMany({ where: bucketWhere });
        if (buckets.length) await db.rateBucket.createMany({ data: buckets });
        if (setting)
          await db.deepSeekSetting.upsert({
            where: { id: 'singleton' },
            create: setting,
            update: setting,
          });
        else await db.deepSeekSetting.deleteMany({ where: { id: 'singleton' } });
      }
      await dbA.word.deleteMany({ where: { id: wordId, normalizedLemma: `${prefix}-rain` } });
    }
    await Promise.all([dbA.$disconnect(), dbB.$disconnect()]);
    fs.rmSync(root, { recursive: true, force: true });
    expect(neverFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  }, 30000);

  it('restricts all configuration and paid actions to authenticated site administrators', async () => {
    for (const [method, route, body] of [
      ['GET', '', undefined],
      ['PUT', '', { enabled: false }],
      ['POST', '/test', {}],
      ['POST', '/preview', { wordId }],
    ] as const) {
      expect((await request(method, route, body, 'anonymous')).statusCode).toBe(401);
      expect((await request(method, route, body, learner)).statusCode).toBe(403);
    }
    expect(callCount).toBe(0);
  });
  it('reads the pre-custom v1 ciphertext format without changing its encryption or official destination', async () => {
    // Construct the original, documented v1 envelope independently of the
    // current encrypt helper; the deployment's realm identity is unchanged.
    const key = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(authSecretA),
        Buffer.from(JSON.stringify([instanceA, 'default'])),
        Buffer.from('nightstudy-deepseek-api-key-v1'),
        32,
      ),
    );
    const iv = Buffer.from('00112233445566778899aabb', 'hex');
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(
      Buffer.from(
        JSON.stringify(['nightstudy-deepseek-api-key-v1', instanceA, 'default', 'singleton']),
      ),
    );
    const encrypted = Buffer.concat([cipher.update(fakeKeyA, 'utf8'), cipher.final()]);
    const legacy = [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
    await dbA.deepSeekSetting.update({
      where: { id: 'singleton' },
      data: { keyCiphertext: legacy },
    });
    const read = await request('GET', '');
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      configured: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      protocol: 'openai-chat',
      authMode: 'bearer',
      model: 'deepseek-flash',
      keyPreview: '••••1234',
    });
    expect(read.body).not.toContain(legacy);
    expect((await request('POST', '/test', {})).statusCode).toBe(200);
    expect(seenRequests[0]).toMatchObject({
      apiKey: fakeKeyA,
      provider: 'deepseek',
      model: 'deepseek-flash',
    });
    expect(
      (await dbA.deepSeekSetting.findUniqueOrThrow({ where: { id: 'singleton' } })).keyCiphertext,
    ).toBe(legacy);
  });
  it.each([
    ['openai-chat', 'bearer', 'vendor/chat-1', '/v1/chat/completions'],
    ['openai-responses', 'bearer', 'vendor/responses-1', '/v1/responses'],
    ['anthropic-messages', 'x-api-key', 'claude-vendor-1', '/v1/messages'],
    ['anthropic-messages', 'bearer', 'claude-relay-1', '/v1/messages'],
    [
      'gemini',
      'x-goog-api-key',
      'models/gemini-vendor-1',
      '/v1beta/models/gemini-vendor-1:generateContent',
    ],
  ] as const)(
    'binds %s/%s settings and source preview to the selected model and exactly one wire auth header',
    async (protocol, authMode, model, suffix) => {
      const relayKey = 'relay_synthetic_no_sk_prefix_Abcd9876';
      const configured = await request('PUT', '', {
        provider: 'custom',
        baseUrl: 'https://gateway.example',
        protocol,
        authMode,
        model,
        apiKey: relayKey,
        enabled: true,
      });
      expect(configured.statusCode, configured.body).toBe(200);
      expect(configured.json()).toMatchObject({
        provider: 'custom',
        protocol,
        authMode,
        model,
        baseUrl: 'https://gateway.example',
        configured: true,
        keyPreview: '••••9876',
      });
      useCompatibleAdapter = true;
      const test = await request('POST', '/test', {});
      expect(test.statusCode, test.body).toBe(200);
      expect(test.json()).toMatchObject({ ok: true, provider: 'custom', model });
      const preview = await request('POST', '/preview', { wordId });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json().preview).toMatchObject({ wordId, lemma: 'rain', applied: false });
      expect(preview.json().preview.definitions[0]).toMatchObject({
        sourceSenseId: senseId,
        sourceTextSha256: createHash('sha256').update('雨；雨水 ').digest('hex'),
        contentMetadata: { provider: 'custom', protocol, model, review: 'pending' },
      });
      expect(wireRequests).toHaveLength(2);
      for (const sent of wireRequests) {
        expect(sent.url).toBe('https://gateway.example' + suffix);
        const headers = Object.fromEntries(
          Object.entries(sent.headers).map(([name, value]) => [name.toLowerCase(), value]),
        );
        expect(headers.authorization).toBe(
          authMode === 'bearer' ? 'Bearer ' + relayKey : undefined,
        );
        expect(headers['x-api-key']).toBe(authMode === 'x-api-key' ? relayKey : undefined);
        expect(headers['x-goog-api-key']).toBe(
          authMode === 'x-goog-api-key' ? relayKey : undefined,
        );
        if (protocol === 'anthropic-messages')
          expect(headers['anthropic-version']).toBe('2023-06-01');
        if (protocol === 'gemini') {
          expect(sent.payload).toMatchObject({
            contents: [{ role: 'user' }],
            generationConfig: { responseMimeType: 'application/json' },
          });
          expect(sent.payload).not.toHaveProperty('model');
        } else expect(sent.payload.model).toBe(model);
      }
      expect(
        seenRequests.every(
          (value) =>
            value.provider === 'custom' &&
            value.protocol === protocol &&
            value.authMode === authMode &&
            value.model === model,
        ),
      ).toBe(true);
      expect(test.body + preview.body + configured.body).not.toContain(relayKey);
      expect((await request('GET', '', undefined, adminB, true)).json()).toMatchObject({
        provider: 'deepseek',
        keyPreview: '••••9876',
      });
      expect((await request('POST', '/test', {}, learner)).statusCode).toBe(403);
      expect((await request('POST', '/test', {}, adminA, true)).statusCode).toBe(401);
    },
  );
  it.each([
    ['base URL', { baseUrl: 'https://another-gateway.example' }],
    ['protocol', { protocol: 'openai-responses' }],
    ['auth mode', { protocol: 'anthropic-messages', authMode: 'x-api-key' }],
    [
      'provider',
      {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        protocol: 'openai-chat',
        authMode: 'bearer',
        model: 'deepseek-flash',
      },
    ],
  ])('requires a replacement key or explicit removal before changing %s', async (_name, change) => {
    expect(
      (
        await request('PUT', '', {
          provider: 'custom',
          baseUrl: 'https://gateway.example',
          protocol: 'openai-chat',
          authMode: 'bearer',
          model: 'vendor/model-1',
          apiKey: fakeKeyA,
        })
      ).statusCode,
    ).toBe(200);
    const old = await dbA.deepSeekSetting.findUniqueOrThrow({ where: { id: 'singleton' } });
    const blocked = await request('PUT', '', change);
    expect(blocked.statusCode, blocked.body).toBe(400);
    expect(blocked.json().code).toBe('ai_destination_key_required');
    expect(await dbA.deepSeekSetting.findUniqueOrThrow({ where: { id: 'singleton' } })).toEqual(
      old,
    );
    expect((await request('PUT', '', { ...change, apiKey: '' })).json().code).toBe(
      'ai_destination_key_required',
    );
    const removed = await request('PUT', '', { ...change, removeKey: true });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toMatchObject({ enabled: false, configured: false, keyPreview: null });
    expect((await request('POST', '/test', {})).statusCode).toBe(503);
    expect(callCount).toBe(0);
  });
  it('accepts long non-sk keys, stores only ciphertext, and never puts the key or envelope into responses or audits', async () => {
    const relayKey = 'A'.repeat(4092) + 'TAIL';
    const response = await request('PUT', '', {
      provider: 'custom',
      baseUrl: 'https://gateway.example:8443/api',
      protocol: 'openai-chat',
      authMode: 'bearer',
      model: 'vendor/model-1',
      apiKey: relayKey,
    });
    expect(response.statusCode, response.body).toBe(200);
    const stored = await dbA.deepSeekSetting.findUniqueOrThrow({ where: { id: 'singleton' } });
    expect(
      decryptDeepSeekKey(
        authSecretA,
        { siteId: 'default', instanceId: instanceA },
        stored.keyCiphertext!,
      ),
    ).toBe(relayKey);
    expect(response.json().keyPreview).toBe('••••TAIL');
    const read = await request('GET', '');
    const audit = await dbA.adminAuditLog.findMany({
      where: { actorId: adminA, action: 'ai.deepseek.configure' },
    });
    for (const value of [response.body, read.body, JSON.stringify(audit)]) {
      expect(value).not.toContain(relayKey);
      expect(value).not.toContain(stored.keyCiphertext!);
    }
    expect((await request('POST', '/test', {})).statusCode).toBe(200);
    expect((await request('PUT', '', { apiKey: 'ABCDEFGH' })).statusCode).toBe(200);
    expect((await request('PUT', '', { apiKey: 'A'.repeat(4097) })).statusCode).toBe(400);
    expect((await request('PUT', '', { apiKey: 'bad\nkey' })).statusCode).toBe(400);
  });
  it('rejects private/metadata destinations and credential-bearing URLs before any transport or configuration write', async () => {
    const before = await dbA.deepSeekSetting.findUniqueOrThrow({ where: { id: 'singleton' } });
    for (const baseUrl of [
      'http://127.0.0.1:15721',
      'https://127.0.0.1',
      'https://169.254.169.254',
      'https://[::1]',
      'https://metadata.google.internal',
      'https://user:password@gateway.example',
      'https://gateway.example?api_key=synthetic',
      'https://gateway.example/path#secret',
    ]) {
      const value = await request('PUT', '', {
        provider: 'custom',
        baseUrl,
        protocol: 'openai-chat',
        authMode: 'bearer',
        model: 'vendor/model-1',
        apiKey: fakeKeyA,
      });
      expect(value.statusCode, value.body).toBe(400);
      expect(await dbA.deepSeekSetting.findUniqueOrThrow({ where: { id: 'singleton' } })).toEqual(
        before,
      );
    }
    expect(callCount).toBe(0);
  });
  it('preserves ciphertext for a model-only change on the same destination but discards its in-flight preview', async () => {
    expect(
      (
        await request('PUT', '', {
          provider: 'custom',
          baseUrl: 'https://gateway.example',
          protocol: 'openai-chat',
          authMode: 'bearer',
          model: 'vendor/model-1',
          apiKey: fakeKeyA,
        })
      ).statusCode,
    ).toBe(200);
    const stored = await dbA.deepSeekSetting.findUniqueOrThrow({ where: { id: 'singleton' } });
    expect((await request('PUT', '', { model: 'vendor/model-2' })).statusCode).toBe(200);
    expect(
      (await dbA.deepSeekSetting.findUniqueOrThrow({ where: { id: 'singleton' } })).keyCiphertext,
    ).toBe(stored.keyCiphertext);
    const source = await dbA.sense.findUniqueOrThrow({ where: { id: senseId } });
    behavior = 'hold';
    const held = request('POST', '/preview', { wordId }).then((value) => value);
    await waitPending(1);
    try {
      expect(
        (await request('PUT', '', { model: 'vendor/model-3' }, adminA2, false, true)).statusCode,
      ).toBe(200);
      expect(
        (await dbA.deepSeekSetting.findUniqueOrThrow({ where: { id: 'singleton' } })).keyCiphertext,
      ).toBe(stored.keyCiphertext);
      behavior = 'ok';
      pending.shift()!();
      const response = await held;
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe('deepseek_configuration_changed');
      expect(await dbA.sense.findUniqueOrThrow({ where: { id: senseId } })).toEqual(source);
      expect(callCount).toBe(1);
      expect(await dbA.deepSeekRequestLease.count({ where: { actorId: adminA } })).toBe(0);
    } finally {
      behavior = 'ok';
      for (const resolve of pending.splice(0)) resolve();
      await held;
    }
  });
  it('rechecks model, enabled state and destination after a blocked PG lease claim before any upstream call', async () => {
    const source = await dbA.word.findUniqueOrThrow({
      where: { id: wordId },
      include: { senses: true, examples: true },
    });
    const actorRatePrefix =
      createHash('sha256')
        .update(JSON.stringify(['deepseek', 'default', 'actor', adminA]))
        .digest('hex') + ':';
    const changes = [
      { model: 'deepseek-v4-pro' },
      { enabled: false },
      {
        provider: 'custom',
        baseUrl: 'https://another-gateway.example',
        protocol: 'openai-chat',
        authMode: 'bearer',
        model: 'vendor/model-1',
        apiKey: fakeKeyB,
      },
    ];
    for (const change of changes) {
      expect(
        (
          await request('PUT', '', {
            provider: 'deepseek',
            baseUrl: 'https://api.deepseek.com',
            protocol: 'openai-chat',
            authMode: 'bearer',
            model: 'deepseek-flash',
            apiKey: fakeKeyA,
            enabled: true,
          })
        ).statusCode,
      ).toBe(200);
      const beforeCount = (
        await dbA.rateBucket.findMany({
          where: { key: { startsWith: actorRatePrefix } },
        })
      ).reduce((sum, bucket) => sum + bucket.count, 0);
      // This is the real lock used by acquireRequest, in the same isolated _test DB.
      // Holding it prevents the service from creating its lease or invoking transport.
      const blocker = new Client({ connectionString: databaseA });
      await blocker.connect();
      let inTransaction = false;
      let attempt: Promise<Awaited<ReturnType<typeof request>>> | undefined;
      try {
        await blocker.query('BEGIN');
        inTransaction = true;
        await blocker.query('SELECT pg_advisory_xact_lock($1)', [89124801]);
        attempt = request('POST', '/preview', { wordId }).then((response) => response);
        let waiting = false;
        for (let n = 0; n < 100 && !waiting; n++) {
          const result = await blocker.query<{ waiting: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory'
              AND objid=$1 AND NOT granted
              AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`,
            [89124801],
          );
          waiting = result.rows[0]?.waiting === true;
          if (!waiting) await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        expect(waiting).toBe(true);
        const acquiredCount = (
          await dbA.rateBucket.findMany({
            where: { key: { startsWith: actorRatePrefix } },
          })
        ).reduce((sum, bucket) => sum + bucket.count, 0);
        expect(acquiredCount).toBe(beforeCount + 1);
        expect(callCount).toBe(0);
        expect(await dbA.deepSeekRequestLease.count({ where: { actorId: adminA } })).toBe(0);
        // The other replica can change configuration without needing the lease lock.
        expect((await request('PUT', '', change, adminA2, false, true)).statusCode).toBe(200);
        await blocker.query('COMMIT');
        inTransaction = false;
        const response = await attempt;
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json().code).toBe('deepseek_configuration_changed');
        expect(response.body).not.toContain(fakeKeyA);
        expect(response.body).not.toContain(fakeKeyB);
        expect(callCount).toBe(0);
        expect(seenRequests).toHaveLength(0);
        expect(await dbA.deepSeekRequestLease.count({ where: { actorId: adminA } })).toBe(0);
        expect(
          await dbA.word.findUniqueOrThrow({
            where: { id: wordId },
            include: { senses: true, examples: true },
          }),
        ).toEqual(source);
      } finally {
        if (inTransaction) await blocker.query('ROLLBACK');
        await blocker.end();
        await attempt;
      }
    }
  });
  it('encrypts keys, returns only masked preview, preserves blank keys and strips keys from audits', async () => {
    const stored = await dbA.deepSeekSetting.findUniqueOrThrow({ where: { id: 'singleton' } });
    expect(stored.keyCiphertext).not.toContain(fakeKeyA);
    expect(
      decryptDeepSeekKey(
        authSecretA,
        { siteId: 'default', instanceId: instanceA },
        stored.keyCiphertext!,
      ),
    ).toBe(fakeKeyA);
    const get = await request('GET', '');
    expect(get.json()).toMatchObject({
      enabled: true,
      configured: true,
      model: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com',
      keyPreview: '••••1234',
    });
    expect(get.body).not.toContain(fakeKeyA);
    expect(get.body).not.toContain(stored.keyCiphertext!);
    const put = await request('PUT', '', { apiKey: '', model: 'deepseek-v4-pro' });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(fakeKeyA);
    expect(
      (await dbA.deepSeekSetting.findUniqueOrThrow({ where: { id: 'singleton' } })).keyCiphertext,
    ).toBe(stored.keyCiphertext);
    const audits = await dbA.adminAuditLog.findMany({
      where: { actorId: adminA, action: 'ai.deepseek.configure' },
    });
    expect(JSON.stringify(audits)).not.toContain(fakeKeyA);
    expect(JSON.stringify(audits)).not.toContain(stored.keyCiphertext!);
    expect((await request('POST', '/test', {})).json()).toMatchObject({
      ok: true,
      model: 'deepseek-v4-pro',
    });
  });
  it('rejects arbitrary upstreams, old model aliases, key removal ambiguity and enabling without a key', async () => {
    for (const value of [
      { baseUrl: 'http://127.0.0.1' },
      { baseUrl: 'https://api.deepseek.com.attacker.test' },
      { model: 'deepseek-chat' },
      { apiKey: fakeKeyA, removeKey: true },
      { apiKey: 'bad\nkey' },
      { apiKey: '123', enabled: true },
    ])
      expect((await request('PUT', '', value)).statusCode).toBe(400);
    expect((await request('PUT', '', { removeKey: true })).json()).toMatchObject({
      enabled: false,
      configured: false,
      keyPreview: null,
    });
    expect((await request('PUT', '', { enabled: true })).statusCode).toBe(400);
    expect((await request('POST', '/test', {})).statusCode).toBe(503);
    expect(callCount).toBe(0);
  });
  it('isolates separate site databases, cookies and encryption bindings', async () => {
    expect((await request('GET', '', undefined, adminB, true)).json().keyPreview).toBe('••••9876');
    expect((await request('GET', '', undefined, adminA, true)).statusCode).toBe(401);
    expect((await request('POST', '/preview', { wordId }, adminB, true)).statusCode).toBe(404);
    const setting = await dbA.deepSeekSetting.findUniqueOrThrow({ where: { id: 'singleton' } });
    expect(() =>
      decryptDeepSeekKey(
        authSecretA,
        { siteId: 'default', instanceId: instanceB },
        setting.keyCiphertext!,
      ),
    ).toThrow('deepseek_key_unreadable');
    await dbB.deepSeekSetting.update({
      where: { id: 'singleton' },
      data: { keyCiphertext: setting.keyCiphertext, keyPreview: setting.keyPreview },
    });
    expect((await request('POST', '/test', {}, adminB, true)).json().code).toBe(
      'deepseek_key_unreadable',
    );
    expect(callCount).toBe(0);
  });
  it('produces source-bound bilingual candidates without changing source words, examples or learning progress', async () => {
    const before = await dbA.word.findUniqueOrThrow({
      where: { id: wordId },
      include: { senses: true, examples: true },
    });
    const progressBefore = await dbA.studyProgress.count({ where: { userId: { in: actorIds } } });
    const response = await request('POST', '/preview', { wordId });
    expect(response.statusCode).toBe(200);
    const preview = response.json().preview;
    expect(preview).toMatchObject({ wordId, lemma: 'rain', review: 'pending', applied: false });
    expect(preview.definitions).toHaveLength(1);
    expect(preview.examples).toHaveLength(1);
    expect(preview.definitions[0]).toMatchObject({
      sourceSenseId: senseId,
      field: 'definitionEn',
      sourceText: '雨；雨水 ',
      sourceField: 'definitionZh',
      sourceLanguage: 'zh',
      sourceTextSha256: createHash('sha256').update('雨；雨水 ').digest('hex'),
      contentMetadata: { kind: 'machine-translation', review: 'pending', sourceLanguage: 'zh' },
    });
    expect(preview.examples[0].contentMetadata.exampleEn.kind).toBe('generated');
    expect(preview.examples[0]).toMatchObject({
      sourceText: '雨；雨水 ',
      sourceField: 'definitionZh',
      sourceLanguage: 'zh',
    });
    expect(response.body).not.toContain(fakeKeyA);
    expect(
      await dbA.word.findUniqueOrThrow({
        where: { id: wordId },
        include: { senses: true, examples: true },
      }),
    ).toEqual(before);
    expect(await dbA.studyProgress.count({ where: { userId: { in: actorIds } } })).toBe(
      progressBefore,
    );
  });
  it('sanitizes failures and secret-bearing replies, does not retry and releases PG leases', async () => {
    for (const mode of ['auth-failed', 'bad-schema', 'key-leak'] as const) {
      behavior = mode;
      const before = callCount;
      const response = await request('POST', '/test', {});
      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain(fakeKeyA);
      expect(response.body).not.toContain('unexpected');
      expect(callCount).toBe(before + 1);
      expect(await dbA.deepSeekRequestLease.count({ where: { actorId: adminA } })).toBe(0);
    }
  });
  it('enforces shared site/actor concurrency across app replicas while another realm remains available', async () => {
    behavior = 'hold';
    const first = request('POST', '/test', {}, adminA).then((x) => x);
    await waitPending(1);
    expect((await request('POST', '/test', {}, adminA, false, true)).json().code).toBe(
      'deepseek_busy',
    );
    const second = request('POST', '/test', {}, adminA2, false, true).then((x) => x);
    await waitPending(2);
    expect((await request('POST', '/test', {}, adminA3)).json().code).toBe('deepseek_busy');
    behavior = 'ok';
    expect((await request('POST', '/test', {}, adminB, true)).statusCode).toBe(200);
    for (const release of pending.splice(0)) release();
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    expect(await dbA.deepSeekRequestLease.count({ where: { actorId: { in: actorIds } } })).toBe(0);
  });
  it('discards an in-flight response after key removal and rechecks administrator role before returning it', async () => {
    behavior = 'hold';
    const first = request('POST', '/test', {}).then((x) => x);
    await waitPending(1);
    expect((await request('PUT', '', { removeKey: true }, adminA2, false, true)).statusCode).toBe(
      200,
    );
    behavior = 'ok';
    pending.shift()!();
    expect((await first).json().code).toBe('deepseek_configuration_changed');
    expect((await request('PUT', '', { enabled: true, apiKey: fakeKeyA })).statusCode).toBe(200);
    behavior = 'hold';
    const next = request('POST', '/test', {}).then((x) => x);
    await waitPending(1);
    await dbA.user.update({ where: { id: adminA }, data: { role: 'user' } });
    behavior = 'ok';
    pending.shift()!();
    expect((await next).statusCode).toBe(403);
    await dbA.user.update({ where: { id: adminA }, data: { role: 'admin' } });
  });
  it('honors durable per-actor request limits across replicas before sending another paid request', async () => {
    const key = createHash('sha256')
      .update(JSON.stringify(['deepseek', 'default', 'actor', adminA]))
      .digest('hex');
    await dbA.$executeRaw`INSERT INTO "RateBucket" ("key","count","expiresAt") SELECT ${key} || ':' || (floor(extract(epoch from clock_timestamp()) / 60) + window_offset)::text, 6, clock_timestamp() + interval '3 minutes' FROM generate_series(0,1) AS window_offset ON CONFLICT ("key") DO UPDATE SET "count"=6`;
    const response = await request('POST', '/test', {}, adminA, false, true);
    expect(response.statusCode).toBe(429);
    expect(response.json().code).toBe('deepseek_rate_limit');
    expect(callCount).toBe(0);
  });
  it('does not call the provider for already complete content or overwrite that content', async () => {
    const exampleId = `${prefix}-complete-example`;
    try {
      await dbA.sense.update({
        where: { id: senseId },
        data: { definitionEn: 'Existing administrator definition.' },
      });
      await dbA.wordExample.create({
        data: {
          id: exampleId,
          wordId,
          exampleEn: 'The rain soaked our coats beside the station.',
          exampleZh: '雨水在车站旁打湿了我们的外套。',
        },
      });
      const response = await request('POST', '/preview', { wordId });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        preview: { applied: false, reason: 'no_missing_content', definitions: [], examples: [] },
        usage: null,
      });
      expect(callCount).toBe(0);
      expect((await dbA.sense.findUniqueOrThrow({ where: { id: senseId } })).definitionEn).toBe(
        'Existing administrator definition.',
      );
    } finally {
      await dbA.wordExample.deleteMany({ where: { id: exampleId, wordId } });
      await dbA.sense.update({ where: { id: senseId }, data: { definitionEn: '' } });
    }
  });
  it('discards candidates if the source changes or a missing field is filled during the paid request', async () => {
    for (const update of [
      { definitionZh: '管理员已重新编辑的原中文' },
      { definitionEn: 'Administrator filled the missing field.' },
    ]) {
      behavior = 'hold';
      const held = request('POST', '/preview', { wordId }).then((value) => value);
      await waitPending(1);
      try {
        await dbA.sense.update({ where: { id: senseId }, data: update });
        behavior = 'ok';
        pending.shift()!();
        const response = await held;
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('deepseek_content_changed');
        expect(
          (await dbA.sense.findUniqueOrThrow({ where: { id: senseId } }))[
            Object.keys(update)[0] as 'definitionZh' | 'definitionEn'
          ],
        ).toBe(Object.values(update)[0]);
      } finally {
        behavior = 'ok';
        for (const release of pending.splice(0)) release();
        await held;
        await dbA.sense.update({
          where: { id: senseId },
          data: { definitionZh: '雨；雨水 ', definitionEn: '' },
        });
      }
    }
  });
  it('returns current exact source snapshots if another administrator edits after lookup but before preview', async () => {
    for (const update of [
      { definitionZh: '  从云中落下的水滴；降水\n', definitionEn: '' },
      { definitionZh: '', definitionEn: '  Water falling from clouds.\n' },
    ]) {
      const lookup = await appA.inject({
        method: 'GET',
        url: `/api/v2/dictionary/resolve?text=${encodeURIComponent(`${prefix}-rain`)}`,
        remoteAddress: '10.77.53.1',
        headers: { host: 'deepseek-a.example', cookie: cookies.get(adminA)! },
      });
      expect(lookup.statusCode).toBe(200);
      const cached = lookup.json().word;
      expect(cached.id).toBe(wordId);
      expect(cached.senses.find((sense: { id: string }) => sense.id === senseId).definitionZh).toBe(
        '雨；雨水 ',
      );
      try {
        await dbA.sense.update({ where: { id: senseId }, data: update });
        const response = await request('POST', '/preview', { wordId: cached.id });
        expect(response.statusCode).toBe(200);
        const preview = response.json().preview;
        expect(preview).toMatchObject({ wordId: cached.id, lemma: cached.lemma, applied: false });
        const sourceField = update.definitionZh ? 'definitionZh' : 'definitionEn';
        const sourceText = update[sourceField];
        for (const item of [...preview.definitions, ...preview.examples]) {
          expect(item).toMatchObject({
            sourceText,
            sourceField,
            sourceLanguage: sourceField === 'definitionZh' ? 'zh' : 'en',
            sourceSenseId: senseId,
            sourceTextSha256: createHash('sha256').update(sourceText).digest('hex'),
          });
          expect(item.sourceTextSha256).not.toBe(
            createHash('sha256').update('雨；雨水 ').digest('hex'),
          );
        }
        const stored = await dbA.sense.findUniqueOrThrow({ where: { id: senseId } });
        expect(stored.definitionZh).toBe(update.definitionZh);
        expect(stored.definitionEn).toBe(update.definitionEn);
      } finally {
        await dbA.sense.update({
          where: { id: senseId },
          data: { definitionZh: '雨；雨水 ', definitionEn: '' },
        });
      }
    }
  });
  it('rejects an exact-source spelling hold before configuration lookup or any provider call', async () => {
    const warning = {
      code: 'source-spelling-unverified',
      message: 'Original synthetic fixture spelling hold.',
      sourceTextSha256: createHash('sha256').update('雨；雨水 ').digest('hex'),
    };
    try {
      await dbA.sense.update({
        where: { id: senseId },
        data: { contentMetadata: { lexicalWarnings: [warning] } },
      });
      expect((await request('PUT', '', { removeKey: true })).statusCode).toBe(200);
      const before = await dbA.sense.findUniqueOrThrow({ where: { id: senseId } });
      const response = await request('POST', '/preview', { wordId });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        code: 'deepseek_source_spelling_unverified',
        message: '词条拼写待核对，请先确认原词形后再预览',
      });
      expect(callCount).toBe(0);
      expect(await dbA.deepSeekRequestLease.count({ where: { actorId: adminA } })).toBe(0);
      expect(await dbA.sense.findUniqueOrThrow({ where: { id: senseId } })).toEqual(before);
    } finally {
      await dbA.sense.update({ where: { id: senseId }, data: { contentMetadata: {} } });
    }
  });
});
