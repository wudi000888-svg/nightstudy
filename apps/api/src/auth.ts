import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import type { PrismaClient } from '@prisma/client';
import type { SiteConfig, AppConfig } from './config.js';
import type { FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { isIP } from 'node:net';
import { HttpError } from './context.js';

export function requestClientIp(request: FastifyRequest, config: AppConfig): string {
  if (config.clientIpProfile !== 'render-public') return request.ip;
  const value = request.headers['cf-connecting-ip'];
  if (typeof value !== 'string' || !isIP(value))
    throw new HttpError(403, 'trusted_client_ip_required');
  return value;
}

export function authenticationHeaders(request: FastifyRequest, config: AppConfig): Headers {
  const headers = fromNodeHeaders(request.headers);
  // Overwrite any caller-supplied value before Better Auth sees it.
  headers.set('x-nightstudy-client-ip', requestClientIp(request, config));
  return headers;
}

export function siteOrigins(site: SiteConfig, production: boolean): string[] {
  const url = new URL(site.publicUrl);
  return [
    ...new Set([
      url.origin,
      ...site.hosts.map((host) => `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`),
      ...(!production ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : []),
    ]),
  ];
}

export function createAuthentication(site: SiteConfig, prisma: PrismaClient, production: boolean) {
  return betterAuth({
    appName: 'NightStudy',
    secret: site.authSecret,
    baseURL: new URL(site.publicUrl).origin,
    basePath: `${site.basePath}/api/auth`,
    trustedOrigins: siteOrigins(site, production),
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      disableSignUp: !site.registrationOpen,
    },
    user: {
      additionalFields: {
        role: { type: 'string', required: false, defaultValue: 'user', input: false },
        disabled: { type: 'boolean', required: false, defaultValue: false, input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ['x-nightstudy-client-ip'] },
      cookiePrefix: `nightstudy-${site.id}`,
      useSecureCookies: production && site.publicUrl.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: site.basePath || '/' },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const user = await prisma.user.findUnique({
              where: { id: session.userId },
              select: { disabled: true },
            });
            if (!user || user.disabled) return false;
            return { data: session };
          },
        },
      },
    },
  });
}
