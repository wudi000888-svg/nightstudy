import Fastify, { type FastifyRequest } from 'fastify';
import staticFiles from '@fastify/static';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { hashPassword } from 'better-auth/crypto';
import { appVersion } from '@nightstudy/core';
import type { AppConfig } from './config.js';
import { HttpError } from './context.js';
import { SiteRegistry } from './sites.js';
import { registerModules } from './modules/index.js';
import { siteOrigins, requestClientIp, authenticationHeaders } from './auth.js';
import { maintenanceTick } from './maintenance.js';
import type { FleetTransport } from './modules/fleet-transport.js';
import { registerDeepSeek } from './modules/deepseek.js';
import type { DeepSeekTransport } from './providers/deepseek.js';

const setupInput = z.object({
  token: z.string().min(32).max(256),
  email: z.email().max(254),
  name: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(128),
});

export async function buildApp(
  config: AppConfig,
  logging = true,
  options: { fleetTransport?: FleetTransport; deepSeekTransport?: DeepSeekTransport } = {},
) {
  const app = Fastify({
    logger: logging
      ? {
          redact: [
            'req.headers.cookie',
            'req.headers.authorization',
            'req.body.password',
            'req.body.token',
            'req.body.pairingToken',
            'req.body.credential',
            'req.body.apiKey',
          ],
        }
      : false,
    bodyLimit: 1024 * 1024,
    trustProxy: config.trustedProxy.length ? config.trustedProxy : false,
  });
  const registry = new SiteRegistry(config);
  const context = (request: FastifyRequest) => registry.context(request);

  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin')
      .header('X-Frame-Options', 'DENY');
    if (['/health/live', '/health/ready'].includes(request.url.split('?')[0] || '')) return;
    const site = registry.resolve(request);
    const pathname = new URL(request.url, 'http://internal.invalid').pathname;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      const origin = request.headers.origin;
      const allowed = siteOrigins(site, config.production);
      if (origin && !allowed.includes(origin))
        throw new HttpError(403, 'untrusted_origin', '请求来源未获允许');
      if (request.headers['sec-fetch-site'] === 'cross-site')
        throw new HttpError(403, 'cross_site_request');
      if (!request.headers['content-type']?.startsWith('application/json'))
        throw new HttpError(415, 'json_required');
    }
    if (
      pathname.startsWith(`${site.basePath}/api/`) ||
      (pathname === `${site.basePath}/setup` && request.method === 'POST')
    ) {
      reply.header('Cache-Control', 'no-store');
      const minute = Math.floor(Date.now() / 60000);
      const sensitive =
        pathname.startsWith(`${site.basePath}/api/auth/`) ||
        pathname.endsWith('/setup') ||
        pathname === `${site.basePath}/api/v2/fleet/pair`;
      const clientIp = requestClientIp(request, config);
      const key = createHash('sha256')
        .update(`${site.id}:${clientIp}:${sensitive ? 'auth' : 'api'}:${minute}`)
        .digest('hex');
      const prisma = registry.runtime(site).prisma;
      const state = await prisma.siteState.findUnique({ where: { id: 'singleton' } });
      if (!state || state.siteId !== site.id) throw new HttpError(503, 'database_not_prepared');
      const rows = await prisma.$queryRaw<
        Array<{ count: number }>
      >`INSERT INTO "RateBucket" ("key", "count", "expiresAt") VALUES (${key}, 1, ${new Date((minute + 2) * 60000)}) ON CONFLICT ("key") DO UPDATE SET "count" = "RateBucket"."count" + 1 RETURNING "count"`;
      if ((rows[0]?.count || 0) > (sensitive ? 30 : 600)) {
        reply.header('Retry-After', '60');
        throw new HttpError(429, 'rate_limit', '请求过于频繁，请稍后再试');
      }
    }
  });

  app.get('/health/live', () => ({ status: 'alive', version: appVersion }));
  app.get('/health/ready', async () => {
    await Promise.all(
      config.sites.map(async (site) => {
        const state = await registry
          .runtime(site)
          .prisma.siteState.findUnique({ where: { id: 'singleton' } });
        if (!state || state.siteId !== site.id) throw new HttpError(503, 'database_not_prepared');
      }),
    );
    return { status: 'ready', siteCount: config.sites.length, version: appVersion };
  });

  for (const basePath of [...new Set(config.sites.map((site) => site.basePath))]) {
    app.register(
      async (scope) => {
        scope.get('/site', async (request) => {
          const runtime = registry.runtime(registry.resolve(request));
          const state = await runtime.prisma.siteState.findUnique({ where: { id: 'singleton' } });
          if (!state || state.siteId !== runtime.config.id)
            throw new HttpError(503, 'database_not_prepared', '站点数据库尚未准备完成');
          return {
            siteId: runtime.config.id,
            title: runtime.config.title,
            basePath: runtime.config.basePath,
            publicUrl: runtime.config.publicUrl,
            version: appVersion,
            contentVersion: state.contentVersion,
            initialized: state.initialized,
            registrationOpen: state.registrationOpenOverride ?? runtime.config.registrationOpen,
          };
        });
        scope.get('/me', async (request) => {
          const ctx = await context(request);
          return { user: ctx.user, siteId: ctx.siteId };
        });
        await registerModules(scope, context, options);
        await registerDeepSeek(scope, context, { transport: options.deepSeekTransport });
      },
      { prefix: `${basePath}/api/v2` },
    );

    app.route({
      method: ['GET', 'POST'],
      url: `${basePath}/api/auth/*`,
      handler: async (request, reply) => {
        const runtime = registry.runtime(registry.resolve(request));
        if (request.url.split('?')[0]?.endsWith('/sign-up/email')) {
          z.object({ name: z.string().trim().min(1).max(80) }).parse(request.body);
          const state = await runtime.prisma.siteState.findUnique({ where: { id: 'singleton' } });
          if (!(state?.registrationOpenOverride ?? runtime.config.registrationOpen))
            throw new HttpError(403, 'registration_closed', '本站暂未开放注册');
        }
        if (request.url.split('?')[0]?.endsWith('/update-user'))
          z.object({ name: z.string().trim().min(1).max(80).optional() }).parse(request.body);
        const url = new URL(request.url, new URL(runtime.config.publicUrl).origin);
        const response = await runtime.auth.handler(
          new Request(url, {
            method: request.method,
            headers: authenticationHeaders(request, config),
            ...(request.body ? { body: JSON.stringify(request.body) } : {}),
          }),
        );
        response.headers.forEach((value, key) => {
          if (key !== 'set-cookie') reply.header(key, value);
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header('set-cookie', cookies);
        return reply.status(response.status).send(await response.text());
      },
    });

    app.post(`${basePath}/setup`, async (request, reply) => {
      const input = setupInput.parse(request.body);
      const runtime = registry.runtime(registry.resolve(request));
      const given = Buffer.from(input.token);
      const wanted = Buffer.from(runtime.config.bootstrapToken);
      if (given.length !== wanted.length || !timingSafeEqual(given, wanted))
        throw new HttpError(403, 'invalid_bootstrap_token', '初始化口令不正确');
      const password = await hashPassword(input.password);
      const user = await runtime.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(89124612)`;
        const state = await tx.siteState.findUnique({ where: { id: 'singleton' } });
        if (!state || state.siteId !== runtime.config.id)
          throw new HttpError(503, 'database_not_prepared');
        if (state.initialized) throw new HttpError(409, 'already_initialized', '站点已完成初始化');
        const id = randomUUID();
        const user = await tx.user.create({
          data: {
            id,
            name: input.name,
            email: input.email.trim().toLowerCase(),
            role: 'admin',
            accounts: {
              create: { id: randomUUID(), accountId: id, providerId: 'credential', password },
            },
          },
          select: { id: true, email: true, name: true, role: true },
        });
        await tx.siteState.update({
          where: { id: 'singleton' },
          data: { initialized: true, initializedAt: new Date() },
        });
        await tx.adminAuditLog.create({
          data: {
            actorId: id,
            action: 'site.initialize',
            targetId: runtime.config.id,
            detail: { version: appVersion },
          },
        });
        return user;
      });
      return reply.status(201).send({ user, initialized: true });
    });

    if (fs.existsSync(path.join(config.webRoot, 'assets')))
      app.register(staticFiles, {
        root: path.join(config.webRoot, 'assets'),
        prefix: `${basePath}/assets/`,
        decorateReply: false,
        maxAge: '1y',
        immutable: true,
      });
  }

  app.setNotFoundHandler(async (request, reply) => {
    const site = registry.resolve(request);
    const pathname = new URL(request.url, 'http://internal.invalid').pathname;
    if (
      !['GET', 'HEAD'].includes(request.method) ||
      pathname.startsWith(`${site.basePath}/api/`) ||
      pathname.includes('/assets/')
    )
      return reply.status(404).send({ code: 'not_found', message: '资源不存在' });
    const file = path.join(config.webRoot, 'index.html');
    if (!fs.existsSync(file))
      return reply.status(503).send({ code: 'frontend_not_built', message: '请先执行 pnpm build' });
    const nonce = randomBytes(18).toString('base64');
    const boot = JSON.stringify({ basePath: site.basePath }).replace(/</g, '\\u003c');
    const html = fs
      .readFileSync(file, 'utf8')
      .replace(
        '<head>',
        `<head><base href="${site.basePath || ''}/"><script nonce="${nonce}">window.__NIGHTSTUDY_CONFIG__=${boot}</script>`,
      );
    reply
      .header(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'`,
      )
      .header('Cache-Control', 'no-store');
    reply.type('text/html; charset=utf-8');
    if (request.method === 'HEAD')
      return reply.header('Content-Length', Buffer.byteLength(html)).send();
    return reply.send(html);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError)
      return reply
        .status(error.statusCode)
        .send({ code: error.code, message: error.message, details: error.details });
    if (error instanceof z.ZodError)
      return reply.status(400).send({
        code: 'invalid_input',
        message: '输入格式有误',
        details: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002')
      return reply.status(409).send({ code: 'already_exists', message: '这条记录已存在' });
    const detail =
      error && typeof error === 'object'
        ? (error as { statusCode?: number; code?: string; name?: string; message?: string })
        : {};
    if (detail.statusCode && detail.statusCode < 500)
      return reply
        .status(detail.statusCode)
        .send({ code: detail.code || 'request_error', message: detail.message });
    // Do not expose adapter connection strings, SQL, or authentication internals.
    request.log.error({ name: detail.name, code: detail.code }, 'Request failed');
    return reply
      .status(503)
      .send({ code: 'service_unavailable', message: '服务暂时不可用，请稍后重试' });
  });
  let maintaining: Promise<void> | undefined;
  const runMaintenance = () => {
    if (maintaining) return;
    maintaining = Promise.all(
      config.sites.map(async (site) => {
        try {
          await maintenanceTick(registry.runtime(site).prisma, site.id);
        } catch {
          app.log.warn({ siteId: site.id }, 'Maintenance unavailable');
        }
      }),
    )
      .then(() => {})
      .finally(() => {
        maintaining = undefined;
      });
  };
  const maintenanceTimer = setInterval(runMaintenance, 60000).unref();
  app.addHook('onListen', async () => {
    runMaintenance();
  });
  app.addHook('onClose', async () => {
    clearInterval(maintenanceTimer);
    await maintaining;
    await registry.close();
  });
  await app.ready();
  return { app, registry };
}
