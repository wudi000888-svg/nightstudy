import type { FastifyInstance } from 'fastify';
import { appVersion } from '@nightstudy/core';
import { z } from 'zod';
import { requireAdmin, type ContextResolver } from '../context.js';
import { getUpdateState, checkForUpdates } from '../updates.js';
import { audit, parse } from './shared.js';

export async function registerSystem(app: FastifyInstance, getContext: ContextResolver) {
  app.get('/admin/system', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    const state = await ctx.prisma.siteState.findUniqueOrThrow({ where: { id: 'singleton' } });
    return {
      version: appVersion,
      siteId: ctx.siteId,
      instanceId: ctx.instanceId,
      initialized: state.initialized,
      registrationOpen: ctx.registrationOpen,
      update: await getUpdateState(ctx.prisma),
    };
  });
  app.post('/admin/system/check-update', async (req) => {
    const ctx = await getContext(req),
      admin = requireAdmin(ctx);
    parse(z.object({}).strict(), req.body ?? {});
    const update = await checkForUpdates(ctx.prisma);
    await audit(ctx.prisma, admin.id, 'system.update.check', ctx.siteId, {
      status: update.status,
      cached: update.cached ?? false,
    });
    return { update };
  });
}
