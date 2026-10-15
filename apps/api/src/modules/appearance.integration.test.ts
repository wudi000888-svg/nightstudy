import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import sharp from 'sharp';
import type { SiteAppearance } from '@prisma/client';
import { buildApp } from '../app.js';
import { createDatabase } from '../db.js';
import type { AppConfig } from '../config.js';

const databaseA = process.env.TEST_DATABASE_URL,
  databaseB = process.env.TEST_DATABASE_URL_B;
const suite = databaseA && databaseB ? describe : describe.skip;
suite('site wallpaper settings, real image decoding and PostgreSQL revision boundaries', () => {
  if (!databaseA || !databaseB) return;
  if (
    ![databaseA, databaseB].every((url) => new URL(url).pathname.endsWith('_test')) ||
    new URL(databaseA).pathname === new URL(databaseB).pathname
  )
    throw new Error('wallpaper_requires_two_distinct_test_databases');
  const dbA = createDatabase(databaseA),
    dbB = createDatabase(databaseB);
  const prefix = `appearance-${randomUUID()}`;
  const admin = `${prefix}-admin`,
    learner = `${prefix}-learner`;
  const actors = [admin, learner];
  const password = 'Synthetic-appearance-fixture-only-2026!';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-appearance-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html>Wallpaper integration fixture</html>');
  const ipTail = (parseInt(prefix.slice(11, 13).replace(/[^a-f\d]/g, '') || 'a1', 16) % 240) + 1;
  const cookies = new Map<string, string>();
  const rateKeys = new Set<string>();
  let savedA: SiteAppearance | null = null,
    savedB: SiteAppearance | null = null,
    saved = false;
  let appA: Awaited<ReturnType<typeof buildApp>>,
    replica: Awaited<ReturnType<typeof buildApp>>,
    appB: Awaited<ReturnType<typeof buildApp>>;
  let png: Buffer;
  const defaults = {
    mode: 'rain-night',
    positionX: 50,
    positionY: 50,
    overlay: 0.4,
    animationEnabled: true,
  };
  const deniedFetch = vi.fn(() =>
    Promise.reject(new Error('wallpaper_tests_forbid_external_network')),
  );
  const config = (other = false): AppConfig => ({
    sites: [
      {
        id: 'default',
        title: 'Wallpaper integration',
        publicUrl: other ? 'https://wallpaper-b.example/school' : 'https://wallpaper-a.example',
        basePath: other ? '/school' : '',
        hosts: [other ? 'wallpaper-b.example' : 'wallpaper-a.example'],
        databaseUrl: other ? databaseB : databaseA,
        authSecret: (other ? 'wallpaper-secret-b-' : 'wallpaper-secret-a-').repeat(5),
        bootstrapToken: 'wallpaper-unused-bootstrap-'.repeat(3),
        registrationOpen: true,
      },
    ],
    host: '127.0.0.1',
    port: 5198,
    production: false,
    webRoot: root,
    trustedProxy: [],
    poolSize: 4,
    maxSites: 2,
  });
  function request(
    method: 'GET' | 'HEAD' | 'POST' | 'PUT',
    route: string,
    payload?: unknown,
    actor: string | null = admin,
    other = false,
    alternate = false,
    extraHeaders: Record<string, string> = {},
  ) {
    const ip = `10.249.${ipTail}.${other ? 2 : 1}`;
    const minute = Math.floor(Date.now() / 60000);
    rateKeys.add(createHash('sha256').update(`default:${ip}:api:${minute}`).digest('hex'));
    return (other ? appB : alternate ? replica : appA).app.inject({
      method,
      url: `${other ? '/school' : ''}/api/v2${route}`,
      remoteAddress: ip,
      headers: {
        host: other ? 'wallpaper-b.example' : 'wallpaper-a.example',
        ...(actor && cookies.get(`${other}:${actor}`)
          ? { cookie: cookies.get(`${other}:${actor}`)! }
          : {}),
        ...(['GET', 'HEAD'].includes(method) ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }
  const upload = (expectedRevision = 0, bytes = png, contentType = 'image/png') => ({
    expectedRevision,
    fileName: 'original-wallpaper.png',
    contentType,
    dataBase64: bytes.toString('base64'),
  });
  beforeAll(async () => {
    vi.stubGlobal('fetch', deniedFetch);
    [savedA, savedB] = await Promise.all([
      dbA.siteAppearance.findUnique({ where: { id: 'singleton' } }),
      dbB.siteAppearance.findUnique({ where: { id: 'singleton' } }),
    ]);
    saved = true;
    const hash = await hashPassword(password);
    for (const db of [dbA, dbB])
      for (const id of actors)
        await db.user.create({
          data: {
            id,
            name: 'Wallpaper fixture',
            email: `${id}@example.test`,
            role: id === admin ? 'admin' : 'user',
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
    png = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#193a4b' } })
      .withMetadata({
        orientation: 6,
        density: 300,
        exif: { IFD0: { Copyright: 'Fixture private metadata must be removed' } },
      })
      .png()
      .toBuffer();
    expect((await sharp(png).metadata()).exif).toBeDefined();
    appA = await buildApp(config(), false);
    replica = await buildApp(config(), false);
    appB = await buildApp(config(true), false);
    for (const [app, other] of [
      [appA, false],
      [appB, true],
    ] as const)
      for (const actor of actors) {
        const ip = `10.249.${ipTail}.${other ? 2 : 1}`;
        const minute = Math.floor(Date.now() / 60000);
        rateKeys.add(createHash('sha256').update(`default:${ip}:auth:${minute}`).digest('hex'));
        const response = await app.app.inject({
          method: 'POST',
          url: `${other ? '/school' : ''}/api/auth/sign-in/email`,
          remoteAddress: ip,
          headers: {
            host: other ? 'wallpaper-b.example' : 'wallpaper-a.example',
            'content-type': 'application/json',
          },
          payload: JSON.stringify({ email: `${actor}@example.test`, password }),
        });
        expect(response.statusCode).toBe(200);
        const headers = response.headers['set-cookie'];
        cookies.set(
          `${other}:${actor}`,
          (Array.isArray(headers) ? headers : [headers])
            .filter(Boolean)
            .map((value) => String(value).split(';')[0])
            .join('; '),
        );
      }
  }, 30000);
  beforeEach(async () => {
    await Promise.all([
      dbA.siteAppearance.deleteMany({ where: { id: 'singleton' } }),
      dbB.siteAppearance.deleteMany({ where: { id: 'singleton' } }),
    ]);
  });
  afterAll(async () => {
    await Promise.all([appA?.app.close(), replica?.app.close(), appB?.app.close()]);
    if (saved)
      for (const [db, previous] of [
        [dbA, savedA],
        [dbB, savedB],
      ] as const) {
        await db.siteAppearance.deleteMany({ where: { id: 'singleton' } });
        if (previous)
          await db.siteAppearance.create({
            data: {
              ...previous,
              imageBytes: previous.imageBytes ? new Uint8Array(previous.imageBytes) : null,
            },
          });
      }
    for (const db of [dbA, dbB]) {
      await db.adminAuditLog.deleteMany({
        where: { actorId: { in: actors }, action: { startsWith: 'appearance.' } },
      });
      await db.user.deleteMany({ where: { id: { in: actors } } });
      await db.rateBucket.deleteMany({ where: { key: { in: [...rateKeys] } } });
    }
    await Promise.all([dbA.$disconnect(), dbB.$disconnect()]);
    fs.rmSync(root, { recursive: true, force: true });
    expect(deniedFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  }, 30000);

  it('reads public defaults without creating settings and rejects unauthenticated or ordinary-user writes', async () => {
    const response = await request('GET', '/appearance', undefined, null);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ appearance: { ...defaults, imageUrl: null, revision: 0 } });
    expect(await dbA.siteAppearance.count()).toBe(0);
    for (const actor of [null, learner]) {
      const status = actor ? 403 : 401;
      expect((await request('GET', '/admin/appearance', undefined, actor)).statusCode).toBe(status);
      expect(
        (await request('PUT', '/admin/appearance', { ...defaults, expectedRevision: 0 }, actor))
          .statusCode,
      ).toBe(status);
      expect(
        (await request('POST', '/admin/appearance/wallpaper', upload(), actor)).statusCode,
      ).toBe(status);
      expect(
        (await request('POST', '/admin/appearance/reset', { expectedRevision: 0 }, actor))
          .statusCode,
      ).toBe(status);
    }
    expect(await dbA.siteAppearance.count()).toBe(0);
  });

  it('admits exactly one first writer across processes and prevents stale overwrites', async () => {
    const response = await Promise.all([
      request('PUT', '/admin/appearance', { ...defaults, overlay: 0.25, expectedRevision: 0 }),
      request(
        'PUT',
        '/admin/appearance',
        { ...defaults, overlay: 0.75, expectedRevision: 0 },
        admin,
        false,
        true,
      ),
    ]);
    expect(response.map((value) => value.statusCode).sort()).toEqual([200, 409]);
    const committed = response.find((value) => value.statusCode === 200)!.json();
    expect((await request('GET', '/appearance', undefined, null)).json()).toEqual(committed);
    const stale = await request('PUT', '/admin/appearance', {
      ...defaults,
      positionX: 12,
      expectedRevision: 0,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('appearance_conflict');
    expect((await request('GET', '/appearance', undefined, null)).json()).toEqual(committed);
    expect(
      await dbA.adminAuditLog.count({ where: { actorId: admin, action: 'appearance.update' } }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('decodes real PNG, honours orientation, strips metadata and serves content-addressed WebP with ETag and HEAD', async () => {
    const response = await request('POST', '/admin/appearance/wallpaper', upload());
    expect(response.statusCode).toBe(200);
    const settings = response.json().appearance;
    expect(settings).toMatchObject({ mode: 'custom', revision: 1 });
    expect(settings.imageUrl).toMatch(/^\/api\/v2\/appearance\/wallpaper\/[a-f0-9]{64}\.webp$/);
    expect(Object.keys(settings).sort()).toEqual(
      [
        'animationEnabled',
        'imageUrl',
        'mode',
        'overlay',
        'positionX',
        'positionY',
        'revision',
      ].sort(),
    );
    const served = await request('GET', settings.imageUrl.slice('/api/v2'.length), undefined, null);
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/webp');
    expect(served.headers['cache-control']).toBe('public, max-age=86400, immutable');
    const metadata = await sharp(served.rawPayload).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 80, height: 120 });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    const sha = createHash('sha256').update(served.rawPayload).digest('hex');
    expect(settings.imageUrl).toContain(sha);
    expect(served.headers.etag).toBe(`"${sha}"`);
    const head = await request('HEAD', settings.imageUrl.slice('/api/v2'.length), undefined, null);
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload.length).toBe(0);
    expect(head.headers.etag).toBe(served.headers.etag);
    for (const method of ['GET', 'HEAD'] as const) {
      const cached = await request(
        method,
        settings.imageUrl.slice('/api/v2'.length),
        undefined,
        null,
        false,
        false,
        { 'if-none-match': served.headers.etag! },
      );
      expect(cached.statusCode).toBe(304);
      expect(cached.rawPayload.length).toBe(0);
    }
  });

  it('rejects active images, MIME mismatch, oversized input, external links and injected settings fields', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>alert(1)</script></svg>',
    );
    for (const payload of [
      upload(0, svg, 'image/svg+xml'),
      upload(0, svg, 'image/png'),
      upload(0, png, 'image/jpeg'),
      { ...upload(), dataBase64: 'https://example.test/image.png' },
      { ...upload(), dataBase64: '%%%%' },
      { ...upload(), imageUrl: 'https://example.test/pixel.png' },
    ]) {
      const response = await request('POST', '/admin/appearance/wallpaper', payload);
      expect(response.statusCode).toBe(400);
    }
    expect(
      (
        await request(
          'POST',
          '/admin/appearance/wallpaper',
          upload(0, Buffer.alloc(4 * 1024 * 1024 + 1)),
        )
      ).statusCode,
    ).toBe(413);
    for (const patch of [
      { imageUrl: 'https://example.test/photo.png' },
      { positionX: -1 },
      { positionY: 101 },
      { overlay: 0.86 },
      { siteId: 'other-site' },
    ])
      expect(
        (await request('PUT', '/admin/appearance', { ...defaults, expectedRevision: 0, ...patch }))
          .statusCode,
      ).toBe(400);
    expect(
      (
        await request('PUT', '/admin/appearance', {
          ...defaults,
          expectedRevision: 0,
          mode: 'custom',
        })
      ).json().code,
    ).toBe('wallpaper_required');
    expect(await dbA.siteAppearance.count()).toBe(0);
  });

  it('preserves a prior wallpaper when switching to original art and clears it only on explicit reset', async () => {
    const uploaded = (await request('POST', '/admin/appearance/wallpaper', upload())).json()
      .appearance;
    const original = await request('PUT', '/admin/appearance', {
      ...defaults,
      expectedRevision: 1,
    });
    expect(original.statusCode).toBe(200);
    expect(original.json().appearance).toMatchObject({
      mode: 'rain-night',
      revision: 2,
      imageUrl: uploaded.imageUrl,
    });
    const custom = await request('PUT', '/admin/appearance', {
      ...defaults,
      mode: 'custom',
      positionX: 21,
      positionY: 78,
      expectedRevision: 2,
    });
    expect(custom.statusCode).toBe(200);
    expect(custom.json().appearance).toMatchObject({
      imageUrl: uploaded.imageUrl,
      revision: 3,
      positionX: 21,
      positionY: 78,
    });
    const staleReset = await request('POST', '/admin/appearance/reset', { expectedRevision: 2 });
    expect(staleReset.statusCode).toBe(409);
    const reset = await request('POST', '/admin/appearance/reset', { expectedRevision: 3 });
    expect(reset.json()).toEqual({ appearance: { ...defaults, imageUrl: null, revision: 4 } });
    expect(
      (await request('GET', uploaded.imageUrl.slice('/api/v2'.length), undefined, null)).statusCode,
    ).toBe(404);
    expect(
      await dbA.siteAppearance.findUnique({
        where: { id: 'singleton' },
        select: { imageBytes: true, imageSha256: true },
      }),
    ).toEqual({ imageBytes: null, imageSha256: null });
  });

  it('keeps root and subpath realms, sessions, settings and image bytes isolated', async () => {
    const uploadedA = (await request('POST', '/admin/appearance/wallpaper', upload())).json()
      .appearance;
    expect((await request('GET', '/appearance', undefined, null, true)).json()).toEqual({
      appearance: { ...defaults, imageUrl: null, revision: 0 },
    });
    const crossCookie = await request(
      'PUT',
      '/admin/appearance',
      { ...defaults, expectedRevision: 0 },
      null,
      true,
      false,
      { cookie: cookies.get(`false:${admin}`)! },
    );
    expect(crossCookie.statusCode).toBe(401);
    const bytesB = await sharp({
      create: { width: 70, height: 130, channels: 3, background: '#716044' },
    })
      .png()
      .toBuffer();
    const uploadedB = await request(
      'POST',
      '/admin/appearance/wallpaper',
      upload(0, bytesB),
      admin,
      true,
    );
    expect(uploadedB.statusCode).toBe(200);
    const settingsB = uploadedB.json().appearance;
    expect(settingsB.imageUrl).toMatch(
      /^\/school\/api\/v2\/appearance\/wallpaper\/[a-f0-9]{64}\.webp$/,
    );
    expect((await request('GET', '/appearance', undefined, null)).json().appearance).toEqual(
      uploadedA,
    );
    expect(
      (
        await request(
          'GET',
          settingsB.imageUrl.slice('/school/api/v2'.length),
          undefined,
          null,
          true,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await request('GET', uploadedA.imageUrl.slice('/api/v2'.length), undefined, null, true))
        .statusCode,
    ).toBe(404);
    expect(
      (await request('GET', settingsB.imageUrl.slice('/school/api/v2'.length), undefined, null))
        .statusCode,
    ).toBe(404);
    const resetB = await request(
      'POST',
      '/admin/appearance/reset',
      { expectedRevision: 1 },
      admin,
      true,
    );
    expect(resetB.statusCode).toBe(200);
    expect(
      (await request('GET', uploadedA.imageUrl.slice('/api/v2'.length), undefined, null))
        .statusCode,
    ).toBe(200);
  });
});
