import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig, SiteConfig } from './config.js';
import { SiteRegistry } from './sites.js';
import { HttpError } from './context.js';
import { registerPwa } from './pwa.js';

describe('mount-scoped H5 installation and public-only service worker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-pwa-'));
  const site = (id: string, basePath: string, host = 'pwa.example'): SiteConfig => ({
    id,
    basePath,
    hosts: [host],
    title: `学习 ${id}`,
    publicUrl: `https://${host}${basePath}`,
    databaseUrl: 'postgresql://not-used.invalid/no_database',
    authSecret: 'unused'.repeat(10),
    bootstrapToken: 'unused'.repeat(10),
    registrationOpen: true,
  });
  const config: AppConfig = {
    sites: [
      site('root', ''),
      site('school', '/school-a'),
      site('nested', '/school-a/nested'),
      site('other', '/foreign', 'other.example'),
    ],
    host: '127.0.0.1',
    port: 5198,
    production: true,
    webRoot: root,
    trustedProxy: [],
    poolSize: 1,
    maxSites: 10,
  };
  const resolver = new SiteRegistry(config);
  let instance = 'pwa-instance-one',
    app: FastifyInstance;
  const state = vi.fn(async (siteId: string) => ({ siteId, instanceId: instance }));
  const fixtures = new Map([
    [
      '/assets/index-ABCdef12.js',
      { body: 'export const build="original-public-code";', type: 'text/javascript' },
    ],
    ['/assets/study-XYZabcd12.css', { body: 'body{color:teal}', type: 'text/css' }],
    ['/assets/font-ZzYYaa22.woff2', { body: 'synthetic-font-test-bytes', type: 'font/woff2' }],
    ['/app-icons/icon-192.png', { body: 'synthetic-192-test-bytes', type: 'image/png' }],
    ['/app-icons/icon-512.png', { body: 'synthetic-512-test-bytes', type: 'image/png' }],
  ]);
  beforeAll(async () => {
    for (const [name, fixture] of fixtures) {
      const filename = path.join(root, name);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, fixture.body);
    }
    fs.writeFileSync(path.join(root, 'assets/private.js'), 'not a content-hashed build asset');
    fs.writeFileSync(path.join(root, 'assets/index-ABCdef12.js.map'), '{"private":"map"}');
    const oversized = fs.openSync(path.join(root, 'assets/oversize-AAAAbbbb.js'), 'w');
    fs.ftruncateSync(oversized, 8 * 1024 * 1024 + 1);
    fs.closeSync(oversized);
    fs.symlinkSync(
      path.join(root, 'assets/private.js'),
      path.join(root, 'assets/symlink-AAAAbbbb.js'),
    );
    fs.writeFileSync(
      path.join(root, 'index.html'),
      '<script nonce="private-dynamic-nonce"></script>',
    );
    app = Fastify();
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof HttpError)
        return reply.status(error.statusCode).send({ code: error.code });
      return reply.status(500).send({ code: 'unexpected' });
    });
    await registerPwa(app, config, {
      resolve: (request) => resolver.resolve(request),
      runtime: (selected) => ({ prisma: { siteState: { findUnique: () => state(selected.id) } } }),
    });
  });
  afterAll(async () => {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (url: string, host = 'pwa.example') =>
    app.inject({ method: 'GET', url, headers: { host } });
  async function worker(mount = '') {
    const response = await request(`${mount}/sw.js`);
    expect(response.statusCode, response.body).toBe(200);
    const offline = (await request(`${mount}/offline.html`)).body;
    const stores = new Map<string, Map<string, Response>>();
    const caches = {
      async open(name: string) {
        if (!stores.has(name)) stores.set(name, new Map());
        const entries = stores.get(name)!;
        return {
          async match(url: string) {
            return entries.get(String(url))?.clone();
          },
          async put(url: string, value: Response) {
            entries.set(String(url), value.clone());
          },
        };
      },
      async keys() {
        return [...stores.keys()];
      },
      async delete(name: string) {
        return stores.delete(name);
      },
    };
    const handlers = new Map<string, (event: any) => void>();
    const skipWaiting = vi.fn(async () => undefined),
      claim = vi.fn(async () => undefined);
    const network = vi.fn(async (input: string | { url: string }, _options?: unknown) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname === `${mount}/offline.html`)
        return new Response(offline, { headers: { 'content-type': 'text/html' } });
      const fixture = fixtures.get(url.pathname.slice(mount.length));
      if (fixture)
        return new Response(fixture.body, {
          headers: { 'content-type': fixture.type, 'cache-control': 'public' },
        });
      return new Response('<html>account-private-page-and-nonce</html>', {
        headers: { 'content-type': 'text/html', 'cache-control': 'no-store' },
      });
    });
    const context = vm.createContext({
      self: {
        location: { origin: 'https://pwa.example' },
        addEventListener: (name: string, handler: (event: any) => void) =>
          handlers.set(name, handler),
        skipWaiting,
        clients: { claim },
      },
      caches,
      fetch: network,
      URL,
      Response,
      Request,
      Headers,
      crypto: webcrypto,
      Uint8Array,
      Map,
      Promise,
    });
    vm.runInContext(response.body, context);
    async function lifecycle(name: string, data?: unknown) {
      let pending: Promise<unknown> | undefined;
      handlers.get(name)?.({
        data,
        waitUntil: (promise: Promise<unknown>) => {
          pending = promise;
        },
      });
      await pending;
    }
    async function fetch(url: string, extra: Record<string, unknown> = {}) {
      let pending: Promise<Response> | undefined;
      const request = {
        url: new URL(url, 'https://pwa.example').href,
        method: 'GET',
        mode: 'cors',
        headers: new Headers(),
        ...extra,
      };
      handlers.get('fetch')!({
        request,
        respondWith: (promise: Promise<Response>) => {
          pending = promise;
        },
      });
      return pending ? await pending : undefined;
    }
    return {
      lifecycle,
      fetch,
      network,
      skipWaiting,
      claim,
      caches,
      stores,
      context,
      source: response.body,
    };
  }
  it('publishes separate install identities and exact safe scopes without resolving account or database', async () => {
    state.mockClear();
    const root = await request('/manifest.webmanifest'),
      child = await request('/school-a/manifest.webmanifest');
    expect(root.statusCode).toBe(200);
    expect(root.headers['cache-control']).toBe('no-store');
    expect(child.json()).toMatchObject({
      id: '/school-a/',
      name: '学习 school',
      start_url: '/school-a/',
      scope: '/school-a/',
      display: 'standalone',
    });
    expect(child.json().icons.map((icon: any) => icon.src)).toEqual([
      '/school-a/app-icons/icon-192.png',
      '/school-a/app-icons/icon-512.png',
    ]);
    expect(root.json().id).toBe('/');
    expect((await request('/foreign/manifest.webmanifest')).statusCode).toBe(404);
    expect((await request('/foreign/manifest.webmanifest', 'other.example')).json().scope).toBe(
      '/foreign/',
    );
    expect((await request('/school-a/offline.html')).body).toContain('href="/school-a/"');
    expect((await request('/school-a/app-icons/icon-192.png')).headers['content-type']).toBe(
      'image/png',
    );
    expect(state).not.toHaveBeenCalled();
  });
  it('binds worker source to instance/build/mount and permits only its own registration scope', async () => {
    const first = await request('/school-a/sw.js');
    expect(first.headers['cache-control']).toBe('no-store, max-age=0');
    expect(first.headers['service-worker-allowed']).toBe('/school-a/');
    instance = 'pwa-instance-two';
    const second = await request('/school-a/sw.js');
    expect(second.body).not.toBe(first.body);
    expect((await request('/sw.js')).headers['service-worker-allowed']).toBe('/');
    expect(state).toHaveBeenCalledWith('school');
    state.mockResolvedValueOnce({ siteId: 'wrong-realm', instanceId: 'wrong-instance' });
    expect((await request('/school-a/sw.js')).statusCode).toBe(503);
  });
  it('installs only exact digest-verified public build resources and never skips waiting automatically', async () => {
    const sw = await worker('/school-a');
    await sw.lifecycle('install');
    const entries = [...sw.stores.values()].flatMap((cache) => [...cache.keys()]);
    expect(entries).toHaveLength(fixtures.size + 1);
    expect(entries.every((url) => url.startsWith('https://pwa.example/school-a/'))).toBe(true);
    expect(entries.some((url) => /private|\.map|index\.html|api|auth/.test(url))).toBe(false);
    expect(sw.source).not.toMatch(/oversize-AAAAbbbb|symlink-AAAAbbbb/);
    expect(sw.network.mock.calls.every((call) => (call[1] as any).credentials === 'omit')).toBe(
      true,
    );
    expect(sw.skipWaiting).not.toHaveBeenCalled();
    await sw.lifecycle('message', { type: 'unrelated' });
    expect(sw.skipWaiting).not.toHaveBeenCalled();
    await sw.lifecycle('message', { type: 'ACTIVATE' });
    expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
  });
  it('never intercepts auth/private requests, cross-origin resources or another configured mount', async () => {
    const sw = await worker();
    await sw.lifecycle('install');
    sw.network.mockClear();
    for (const route of [
      '/api/v2/me',
      '/api/auth/get-session',
      '/admin',
      '/setup',
      '/school-a/learn',
      '/school-a/api/v2/library/notes',
      '/school-a/nested/',
      'https://other.example/assets/index-ABCdef12.js',
    ])
      expect(await sw.fetch(route, { mode: 'navigate' })).toBeUndefined();
    expect(await sw.fetch('/assets/index-ABCdef12.js', { method: 'POST' })).toBeUndefined();
    expect(
      await sw.fetch('/assets/index-ABCdef12.js', {
        headers: new Headers({ authorization: 'private-test-token' }),
      }),
    ).toBeUndefined();
    expect(await sw.fetch('/assets/index-ABCdef12.js?account=private')).toBeUndefined();
    expect(sw.network).not.toHaveBeenCalled();
    const child = await worker('/school-a');
    expect(await child.fetch('/school-a2/learn', { mode: 'navigate' })).toBeUndefined();
    expect(await child.fetch('/school-a/nested/learn', { mode: 'navigate' })).toBeUndefined();
  });
  it('uses live navigation responses without caching their nonce or private data, and only a generic offline fallback', async () => {
    const sw = await worker('/school-a');
    await sw.lifecycle('install');
    const before = [...sw.stores.values()].flatMap((cache) => [...cache.keys()]);
    expect(await (await sw.fetch('/school-a/me', { mode: 'navigate' }))!.text()).toContain(
      'account-private-page',
    );
    expect([...sw.stores.values()].flatMap((cache) => [...cache.keys()])).toEqual(before);
    sw.network.mockRejectedValueOnce(new TypeError('offline'));
    const offline = await (await sw.fetch('/school-a/learn?session=private', {
      mode: 'navigate',
    }))!.text();
    expect(offline).toContain('连接网络后');
    expect(offline).not.toMatch(/account-private|nonce|private-test-token|session=private/);
  });
  it('rejects changed or private responses instead of poisoning the public cache', async () => {
    const sw = await worker();
    sw.network.mockResolvedValueOnce(
      new Response('private account HTML', { headers: { 'cache-control': 'private, no-store' } }),
    );
    await expect(sw.lifecycle('install')).rejects.toThrow('private_resource_rejected');
    expect(sw.stores.size).toBe(0);
    const mismatch = await worker();
    const font = fixtures.get('/assets/font-ZzYYaa22.woff2')!;
    mismatch.network.mockResolvedValueOnce(
      new Response('X' + font.body.slice(1), { headers: { 'content-type': font.type } }),
    );
    await expect(mismatch.lifecycle('install')).rejects.toThrow('public_resource_digest_mismatch');
    expect(mismatch.stores.size).toBe(0);
    const badType = await worker();
    badType.network.mockResolvedValueOnce(
      new Response(font.body, { headers: { 'content-type': 'text/html' } }),
    );
    await expect(badType.lifecycle('install')).rejects.toThrow('public_resource_type_mismatch');
    expect(badType.stores.size).toBe(0);
  });
  it('keeps the current and previous public build cache, preserves other mounts and can read the previous hashed resource', async () => {
    const sw = await worker('/school-a');
    await sw.lifecycle('install');
    const prefix = vm.runInContext('PREFIX', sw.context) as string;
    await sw.caches.open(prefix + 'old-one');
    const previous = await sw.caches.open(prefix + 'old-two');
    await previous.put(
      'https://pwa.example/school-a/assets/lazy-oldHASH12.js',
      new Response('old verified public chunk'),
    );
    await sw.caches.open('different-site-and-mount-cache');
    await sw.lifecycle('activate');
    expect((await sw.caches.keys()).filter((key) => key.startsWith(prefix))).toHaveLength(2);
    expect(await sw.caches.keys()).toContain('different-site-and-mount-cache');
    expect(await (await sw.fetch('/school-a/assets/lazy-oldHASH12.js'))!.text()).toBe(
      'old verified public chunk',
    );
    expect(sw.claim).toHaveBeenCalledTimes(1);
  });
});
