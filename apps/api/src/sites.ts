import type { FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig, SiteConfig } from './config.js';
import { createDatabase } from './db.js';
import { createAuthentication, authenticationHeaders } from './auth.js';
import { HttpError, type RequestContext } from './context.js';

export interface SiteRuntime {
  config: SiteConfig;
  prisma: PrismaClient;
  auth: ReturnType<typeof createAuthentication>;
  lastUsed: number;
}

export class SiteRegistry {
  private runtimes = new Map<string, SiteRuntime>();
  constructor(public config: AppConfig) {}

  resolve(request: FastifyRequest): SiteConfig {
    let host: string;
    const authority = request.headers.host || '';
    if (!/^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:.]+\])(?::\d{1,5})?$/.test(authority))
      throw new HttpError(404, 'unknown_site');
    try {
      host = new URL(`http://${authority}`).hostname.toLowerCase();
    } catch {
      throw new HttpError(404, 'unknown_site');
    }
    const pathname = new URL(request.url, 'http://internal.invalid').pathname;
    const matches = this.config.sites
      .filter(
        (site) =>
          site.hosts.includes(host) &&
          (!site.basePath ||
            pathname === site.basePath ||
            pathname.startsWith(`${site.basePath}/`)),
      )
      .sort((a, b) => b.basePath.length - a.basePath.length);
    if (!matches[0]) throw new HttpError(404, 'unknown_site');
    return matches[0];
  }

  runtime(site: SiteConfig): SiteRuntime {
    const existing = this.runtimes.get(site.id);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    // Hard bound avoids unbounded database pools; provisioning is operator-only.
    if (this.runtimes.size >= this.config.maxSites)
      throw new HttpError(503, 'site_capacity_reached');
    const prisma = createDatabase(site.databaseUrl, this.config.poolSize);
    const runtime = {
      config: site,
      prisma,
      auth: createAuthentication(site, prisma, this.config.production),
      lastUsed: Date.now(),
    };
    this.runtimes.set(site.id, runtime);
    return runtime;
  }

  async context(request: FastifyRequest): Promise<RequestContext> {
    const runtime = this.runtime(this.resolve(request));
    const state = await runtime.prisma.siteState.findUnique({ where: { id: 'singleton' } });
    if (!state || state.siteId !== runtime.config.id)
      throw new HttpError(503, 'database_not_prepared');
    const session = await runtime.auth.api.getSession({
      headers: authenticationHeaders(request, this.config),
    });
    const user = session
      ? await runtime.prisma.user.findUnique({
          where: { id: session.user.id },
          select: { id: true, email: true, name: true, role: true, disabled: true },
        })
      : null;
    return {
      siteId: runtime.config.id,
      basePath: runtime.config.basePath,
      publicUrl: runtime.config.publicUrl,
      instanceId: state.instanceId,
      title: runtime.config.title,
      fleetSecret: runtime.config.authSecret,
      registrationOpen: state.registrationOpenOverride ?? runtime.config.registrationOpen,
      translation: runtime.config.translation,
      prisma: runtime.prisma,
      user:
        user && !user.disabled
          ? { id: user.id, email: user.email, name: user.name, role: user.role }
          : null,
    };
  }

  async close(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.prisma.$disconnect()));
    this.runtimes.clear();
  }
}
