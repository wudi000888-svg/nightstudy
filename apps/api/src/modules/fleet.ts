import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  Prisma,
  type FleetConnection,
  type FleetGrant,
  type FleetPairingToken,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appVersion } from '@nightstudy/core';
import { HttpError, requireAdmin, type ContextResolver, type RequestContext } from '../context.js';
import { parse, id, obj, json, transact, audit, digest, getReceipt, type Db } from './shared.js';
import {
  fleetScopes,
  fleetProtocol,
  newPairingToken,
  newFleetCredential,
  fleetTokenHash,
  pairingTokenPattern,
  fleetCredentialPattern,
  encryptFleetCredential,
  decryptFleetCredential,
  type FleetBinding,
} from './fleet-crypto.js';
import {
  canonicalFleetUrl,
  fleetTransport,
  FleetTransportError,
  type FleetTransport,
} from './fleet-transport.js';
import { getUpdateState, checkForUpdates } from '../updates.js';

const scopesInput = z
  .array(z.enum(fleetScopes))
  .min(1)
  .max(5)
  .refine((scopes) => scopes.includes('status:read'), 'status:read is required');
const identity = z.string().min(1).max(80);
const labelInput = z.string().trim().max(120);
const remoteSiteInput = z.object({
  instanceId: identity,
  siteId: identity,
  title: z.string().max(100),
  publicUrl: z.string().max(1000),
  basePath: z.string().max(200),
  version: z.string().max(80),
  contentVersion: z.string().max(200).optional(),
});
const updateInput = z.object({
  status: z.enum(['unchecked', 'up-to-date', 'available', 'ahead', 'no-release', 'failed']),
  checkedAt: z.string().datetime().nullable(),
  latestVersion: z.string().max(128).nullable(),
  releaseUrl: z
    .string()
    .max(600)
    .nullable()
    .refine(
      (value) =>
        value === null ||
        /^https:\/\/github\.com\/wudi000888-svg\/nightstudy\/releases\/tag\/v[A-Za-z0-9.+-]+$/.test(
          value,
        ),
    ),
  message: z.string().max(400),
  channel: z.enum(['prerelease', 'stable']),
  cached: z.boolean().optional(),
  stale: z.boolean().optional(),
  lastSuccessfulAt: z.string().datetime().nullable().optional(),
});
const snapshotInput = z.object({
  site: remoteSiteInput,
  registrationOpen: z.boolean(),
  counts: z.object({
    users: z.number().int().nonnegative(),
    disabledUsers: z.number().int().nonnegative(),
    books: z.number().int().nonnegative(),
    words: z.number().int().nonnegative(),
  }),
  wordCountBasis: z.literal('installed-pack-metadata'),
  checkedAt: z.string().datetime(),
  update: updateInput.optional(),
});
const actionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('registration.set'), registrationOpen: z.boolean() }).strict(),
  z.object({ action: z.literal('user.set-disabled'), userId: id, disabled: z.boolean() }).strict(),
  z
    .object({
      action: z.literal('announcement.create'),
      title: z.string().trim().min(1).max(160),
      body: z.string().trim().min(1).max(4000),
      status: z.enum(['published', 'draft']).default('published'),
    })
    .strict(),
  z.object({ action: z.literal('announcement.delete'), announcementId: id }).strict(),
  z.object({ action: z.literal('updates.check') }).strict(),
]);
type FleetAction = z.infer<typeof actionInput>;
function scopeFor(action: FleetAction) {
  return action.action === 'registration.set'
    ? 'settings:write'
    : action.action === 'user.set-disabled'
      ? 'users:write'
      : action.action === 'updates.check'
        ? 'status:read'
        : 'announcements:write';
}
function pairingDto(token: FleetPairingToken) {
  return {
    id: token.id,
    label: token.label,
    scopes: token.scopes,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
    status: token.revokedAt
      ? 'revoked'
      : token.usedAt
        ? 'used'
        : token.expiresAt <= new Date()
          ? 'expired'
          : 'active',
  };
}
function grantDto(grant: FleetGrant) {
  return {
    id: grant.id,
    label: grant.label,
    controllerInstanceId: grant.controllerInstanceId,
    controllerSiteId: grant.controllerSiteId,
    controllerUrl: grant.controllerUrl,
    scopes: grant.scopes,
    createdAt: grant.createdAt,
    lastUsedAt: grant.lastUsedAt,
    revokedAt: grant.revokedAt,
  };
}
function connectionDto(connection: FleetConnection) {
  return {
    id: connection.id,
    label: connection.label,
    remoteUrl: connection.remoteUrl,
    remoteInstanceId: connection.remoteInstanceId,
    remoteSiteId: connection.remoteSiteId,
    scopes: connection.scopes,
    status: connection.status,
    lastSnapshot: connection.lastSnapshot,
    lastCheckedAt: connection.lastCheckedAt,
    lastErrorCode: connection.lastErrorCode,
    createdAt: connection.createdAt,
  };
}
function remoteUserDto<T extends { name: string }>(user: T): T {
  // Historical accounts may predate the current profile length limit. Bound display data
  // without changing the account, so a successful remote mutation remains representable.
  return { ...user, name: user.name.slice(0, 80) };
}
function binding(ctx: RequestContext, connection: FleetConnection): FleetBinding {
  return {
    instanceId: ctx.instanceId,
    siteId: ctx.siteId,
    connectionId: connection.id,
    remoteInstanceId: connection.remoteInstanceId,
    remoteSiteId: connection.remoteSiteId,
    remoteUrl: connection.remoteUrl,
    grantId: connection.grantId,
  };
}
function secret(ctx: RequestContext, connection: FleetConnection) {
  try {
    return decryptFleetCredential(
      ctx.fleetSecret,
      binding(ctx, connection),
      connection.credentialCiphertext,
    );
  } catch {
    throw new HttpError(
      503,
      'fleet_credential_unreadable',
      '本站凭据密钥已变更，须由站点管理员重新处理配对',
    );
  }
}
function normalizeUrl(value: string) {
  try {
    return canonicalFleetUrl(value);
  } catch (error) {
    if (error instanceof FleetTransportError)
      throw new HttpError(error.statusCode, error.code, '仅支持 HTTPS 公网域名与规范站点路径');
    throw error;
  }
}
async function connection(
  ctx: RequestContext,
  connectionId: string,
  scope: string,
  allowPending = false,
) {
  const value = await ctx.prisma.fleetConnection.findUnique({ where: { id: connectionId } });
  if (!value) throw new HttpError(404, 'fleet_site_not_found');
  if (value.status === 'revoked') throw new HttpError(409, 'fleet_site_revoked');
  if (value.status === 'forgotten') throw new HttpError(409, 'fleet_site_forgotten');
  if (!allowPending && value.status === 'disconnect_pending')
    throw new HttpError(409, 'fleet_disconnect_pending');
  if (!value.scopes.includes(scope)) throw new HttpError(403, 'fleet_scope_denied');
  return value;
}
async function authorizeGrant(
  ctx: RequestContext,
  db: Db,
  request: FastifyRequest,
  scope?: string,
  revokeOnly = false,
) {
  if (
    request.headers['x-nightstudy-fleet-instance'] !== ctx.instanceId ||
    request.headers['x-nightstudy-fleet-site'] !== ctx.siteId
  )
    throw new HttpError(401, 'fleet_remote_identity_changed');
  const authorization = request.headers.authorization;
  const credential =
    typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : '';
  if (!fleetCredentialPattern.test(credential))
    throw new HttpError(401, 'fleet_authentication_required');
  const grant = await db.fleetGrant.findUnique({
    where: { credentialHash: fleetTokenHash(credential) },
  });
  if (!grant || (grant.revokedAt && !revokeOnly)) throw new HttpError(401, 'fleet_grant_revoked');
  const owner = await db.user.findUnique({
    where: { id: grant.createdById },
    select: { disabled: true, role: true },
  });
  if ((!owner || owner.disabled || owner.role !== 'admin') && !revokeOnly)
    throw new HttpError(403, 'fleet_issuer_inactive');
  if (scope && !grant.scopes.includes(scope)) throw new HttpError(403, 'fleet_scope_denied');
  return grant;
}
function remoteError(response: { status: number; data: unknown }) {
  const code = obj(response.data).code;
  if (response.status === 401 && code === 'fleet_remote_identity_changed')
    return new HttpError(502, 'fleet_remote_identity_changed');
  if (response.status === 401 && code === 'fleet_grant_revoked')
    return new HttpError(401, 'fleet_grant_revoked');
  if (response.status === 401) return new HttpError(502, 'fleet_remote_authorization_unconfirmed');
  if (response.status === 403 && code === 'fleet_issuer_inactive')
    return new HttpError(403, 'fleet_issuer_inactive');
  if (response.status === 403) return new HttpError(403, 'fleet_scope_denied');
  if (
    response.status === 409 &&
    [
      'last_admin_protected',
      'fleet_pairing_token_used',
      'fleet_grant_limit',
      'idempotency_conflict',
      'already_initialized',
    ].includes(String(code))
  )
    return new HttpError(409, String(code));
  if (response.status === 400) return new HttpError(400, 'fleet_remote_input_rejected');
  if (response.status === 404) return new HttpError(404, 'fleet_remote_resource_not_found');
  if (response.status === 429) return new HttpError(429, 'fleet_remote_rate_limit');
  return new HttpError(502, 'fleet_remote_failed');
}
async function send(
  ctx: RequestContext,
  value: FleetConnection,
  transport: FleetTransport,
  path: string,
  body?: unknown,
) {
  try {
    const response = await transport({
      baseUrl: value.remoteUrl,
      path,
      method: body === undefined ? 'GET' : 'POST',
      credential: secret(ctx, value),
      targetIdentity: { instanceId: value.remoteInstanceId, siteId: value.remoteSiteId },
      ...(body !== undefined ? { body } : {}),
    });
    if (response.status < 200 || response.status >= 300) throw remoteError(response);
    return response.data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof FleetTransportError)
      throw new HttpError(
        error.statusCode,
        error.code,
        '远程站点连接未成功，请确认地址、凭据和网络',
      );
    throw new HttpError(502, 'fleet_unreachable');
  }
}
async function snapshot(ctx: RequestContext) {
  const [state, packs, users, disabledUsers, books, update] = await Promise.all([
    ctx.prisma.siteState.findUniqueOrThrow({ where: { id: 'singleton' } }),
    ctx.prisma.contentPack.findMany({ where: { status: 'ready' }, orderBy: { updatedAt: 'desc' } }),
    ctx.prisma.user.count(),
    ctx.prisma.user.count({ where: { disabled: true } }),
    ctx.prisma.book.count(),
    getUpdateState(ctx.prisma),
  ]);
  const coverage = packs
    .map((pack) => obj(obj(pack.tagCounts).coverage))
    .find((entry) => typeof entry.words === 'number');
  const words =
    typeof coverage?.words === 'number'
      ? coverage.words
      : packs
          .filter((pack) => obj(pack.tagCounts).kind !== 'phonetics')
          .reduce((sum, pack) => sum + pack.entryCount, 0);
  return {
    site: {
      instanceId: ctx.instanceId,
      siteId: ctx.siteId,
      title: ctx.title,
      publicUrl: ctx.publicUrl,
      basePath: ctx.basePath,
      version: appVersion,
      contentVersion: state.contentVersion,
    },
    registrationOpen: ctx.registrationOpen,
    counts: { users, disabledUsers, books, words },
    wordCountBasis: 'installed-pack-metadata',
    checkedAt: new Date().toISOString(),
    update,
  };
}
async function refresh(ctx: RequestContext, value: FleetConnection, transport: FleetTransport) {
  try {
    const raw = await send(ctx, value, transport, '/api/v2/fleet/remote/status');
    const parsed = snapshotInput.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.site.instanceId !== value.remoteInstanceId ||
      parsed.data.site.siteId !== value.remoteSiteId ||
      normalizeUrl(parsed.data.site.publicUrl) !== value.remoteUrl
    )
      throw new HttpError(502, 'fleet_remote_identity_changed');
    const changed = await ctx.prisma.fleetConnection.updateMany({
      where: {
        id: value.id,
        grantId: value.grantId,
        credentialCiphertext: value.credentialCiphertext,
        status: { in: ['active', 'unreachable'] },
      },
      data: {
        lastSnapshot: json(parsed.data),
        status: 'active',
        lastCheckedAt: new Date(),
        lastErrorCode: null,
      },
    });
    if (!changed.count) throw new HttpError(409, 'fleet_connection_changed');
    return ctx.prisma.fleetConnection.findUniqueOrThrow({ where: { id: value.id } });
  } catch (error) {
    const code = error instanceof HttpError ? error.code : 'fleet_unreachable';
    const revoked = code === 'fleet_grant_revoked';
    await ctx.prisma.fleetConnection.updateMany({
      where: {
        id: value.id,
        grantId: value.grantId,
        credentialCiphertext: value.credentialCiphertext,
        status: { in: ['active', 'unreachable'] },
      },
      data: {
        status: revoked ? 'revoked' : 'unreachable',
        ...(revoked ? { revokedAt: new Date(), credentialCiphertext: '' } : {}),
        lastErrorCode: code,
        lastCheckedAt: new Date(),
      },
    });
    const updated = await ctx.prisma.fleetConnection.findUniqueOrThrow({ where: { id: value.id } });
    throw new HttpError(
      error instanceof HttpError ? error.statusCode : 502,
      code,
      '远程状态刷新未成功；保留上次快照',
      { site: connectionDto(updated) },
    );
  }
}

export async function registerFleet(
  app: FastifyInstance,
  getContext: ContextResolver,
  options: { transport?: FleetTransport } = {},
) {
  const transport = options.transport ?? fleetTransport;
  app.get('/admin/fleet', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    const [tokens, grants, sites] = await Promise.all([
      ctx.prisma.fleetPairingToken.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
      ctx.prisma.fleetGrant.findMany({
        orderBy: [{ revokedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
        take: 100,
      }),
      ctx.prisma.fleetConnection.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
    ]);
    return {
      pairingTokens: tokens.map(pairingDto),
      controllers: grants.map(grantDto),
      sites: sites.map(connectionDto),
    };
  });
  app.get('/admin/fleet/pairing-tokens', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    return {
      items: (
        await ctx.prisma.fleetPairingToken.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
      ).map(pairingDto),
    };
  });
  app.post('/admin/fleet/pairing-tokens', async (req) => {
    const ctx = await getContext(req),
      actor = requireAdmin(ctx);
    const input = parse(
      z
        .object({ label: labelInput.default(''), scopes: scopesInput.default([...fleetScopes]) })
        .strict(),
      req.body ?? {},
    );
    const token = newPairingToken();
    const value = await transact(ctx.prisma, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(89124620)`;
      if (
        (await tx.fleetPairingToken.count({
          where: { usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        })) >= 20
      )
        throw new HttpError(409, 'fleet_pairing_token_limit');
      const created = await tx.fleetPairingToken.create({
        data: {
          label: input.label,
          scopes: [...new Set(input.scopes)],
          tokenHash: fleetTokenHash(token),
          expiresAt: new Date(Date.now() + 600000),
          createdById: actor.id,
        },
      });
      await audit(tx, actor.id, 'fleet.pairing-token.create', created.id, {
        scopes: created.scopes,
        expiresAt: created.expiresAt,
      });
      return created;
    });
    return { pairingToken: pairingDto(value), token };
  });
  app.delete('/admin/fleet/pairing-tokens/:id', async (req) => {
    const ctx = await getContext(req),
      actor = requireAdmin(ctx),
      params = parse(z.object({ id }), req.params);
    await transact(ctx.prisma, async (tx) => {
      const found = await tx.fleetPairingToken.findUnique({ where: { id: params.id } });
      if (!found) throw new HttpError(404, 'fleet_pairing_token_not_found');
      await tx.fleetPairingToken.update({
        where: { id: found.id },
        data: { revokedAt: found.revokedAt ?? new Date() },
      });
      await audit(tx, actor.id, 'fleet.pairing-token.revoke', found.id, {});
    });
    return { revoked: true };
  });
  app.delete('/admin/fleet/controllers/:id', async (req) => {
    const ctx = await getContext(req),
      actor = requireAdmin(ctx),
      params = parse(z.object({ id }), req.params);
    await transact(ctx.prisma, async (tx) => {
      const grant = await tx.fleetGrant.findUnique({ where: { id: params.id } });
      if (!grant) throw new HttpError(404, 'fleet_controller_not_found');
      await tx.fleetGrant.update({
        where: { id: grant.id },
        data: { revokedAt: grant.revokedAt ?? new Date() },
      });
      await audit(tx, actor.id, 'fleet.controller.revoke', grant.id, {});
    });
    return { revoked: true };
  });
  app.post('/fleet/pair', async (req) => {
    const ctx = await getContext(req);
    const input = parse(
      z
        .object({
          token: z.string().regex(pairingTokenPattern),
          controllerInstanceId: identity,
          controllerSiteId: identity,
          controllerUrl: z.string().max(1000),
          label: labelInput.default(''),
        })
        .strict(),
      req.body,
    );
    const controllerUrl = normalizeUrl(input.controllerUrl);
    if (input.controllerInstanceId === ctx.instanceId && input.controllerSiteId === ctx.siteId)
      throw new HttpError(400, 'fleet_self_pair');
    const credential = newFleetCredential();
    const grant = await transact(ctx.prisma, async (tx) => {
      const tokenHash = fleetTokenHash(input.token);
      await tx.$queryRaw`SELECT "id" FROM "FleetPairingToken" WHERE "tokenHash"=${tokenHash} FOR UPDATE`;
      const token = await tx.fleetPairingToken.findUnique({ where: { tokenHash } });
      if (!token || token.revokedAt || token.expiresAt <= new Date())
        throw new HttpError(401, 'fleet_pairing_token_invalid');
      if (token.usedAt) throw new HttpError(409, 'fleet_pairing_token_used');
      const issuer = await tx.user.findUnique({
        where: { id: token.createdById },
        select: { disabled: true, role: true },
      });
      if (!issuer || issuer.disabled || issuer.role !== 'admin')
        throw new HttpError(401, 'fleet_pairing_token_invalid');
      await tx.$queryRaw`SELECT "id" FROM "SiteState" WHERE "id"='singleton' FOR UPDATE`;
      if ((await tx.fleetGrant.count({ where: { revokedAt: null } })) >= 100)
        throw new HttpError(409, 'fleet_grant_limit');
      const created = await tx.fleetGrant.create({
        data: {
          label: input.label || token.label,
          credentialHash: fleetTokenHash(credential),
          controllerInstanceId: input.controllerInstanceId,
          controllerSiteId: input.controllerSiteId,
          controllerUrl,
          scopes: token.scopes,
          createdById: token.createdById,
        },
      });
      await tx.fleetPairingToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
      await audit(tx, token.createdById, 'fleet.controller.pair', created.id, {
        controllerInstanceId: input.controllerInstanceId,
        controllerSiteId: input.controllerSiteId,
        controllerUrl,
        scopes: token.scopes,
      });
      return created;
    });
    return {
      protocol: fleetProtocol,
      site: {
        instanceId: ctx.instanceId,
        siteId: ctx.siteId,
        title: ctx.title,
        publicUrl: ctx.publicUrl,
        basePath: ctx.basePath,
        version: appVersion,
      },
      grantId: grant.id,
      credential,
      scopes: grant.scopes,
    };
  });
  app.get('/fleet/remote/status', async (req) => {
    const ctx = await getContext(req),
      grant = await authorizeGrant(ctx, ctx.prisma, req, 'status:read');
    await ctx.prisma.fleetGrant.update({
      where: { id: grant.id },
      data: { lastUsedAt: new Date() },
    });
    return snapshot(ctx);
  });
  app.get('/fleet/remote/users', async (req) => {
    const ctx = await getContext(req);
    await authorizeGrant(ctx, ctx.prisma, req, 'users:read');
    const query = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: id.optional(),
      }),
      req.query,
    );
    const rows = await ctx.prisma.user.findMany({
      where: query.cursor ? { id: { gt: query.cursor } } : {},
      select: { id: true, name: true, email: true, role: true, disabled: true, createdAt: true },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });
    const items = rows.slice(0, query.limit).map(remoteUserDto);
    return {
      items,
      page: {
        hasMore: rows.length > query.limit,
        nextCursor: rows.length > query.limit ? items.at(-1)!.id : null,
      },
    };
  });
  app.get('/fleet/remote/announcements', async (req) => {
    const ctx = await getContext(req);
    await authorizeGrant(ctx, ctx.prisma, req, 'announcements:write');
    return {
      items: await ctx.prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
    };
  });
  app.post('/fleet/remote/actions', async (req) => {
    const ctx = await getContext(req),
      outer = parse(
        z
          .object({
            commandId: z.string().min(1).max(80),
            action: z.string(),
            payload: z.unknown(),
          })
          .strict(),
        req.body,
      );
    const input = parse(actionInput, { ...obj(outer.payload), action: outer.action });
    if (input.action === 'updates.check') {
      const grant = await authorizeGrant(ctx, ctx.prisma, req, 'status:read');
      const update = await checkForUpdates(ctx.prisma);
      await audit(ctx.prisma, grant.createdById, 'fleet.remote.updates.check', grant.id, {
        controllerInstanceId: grant.controllerInstanceId,
        commandId: outer.commandId,
        status: update.status,
      });
      return { update };
    }
    return transact(ctx.prisma, async (tx) => {
      const grant = await authorizeGrant(ctx, tx, req, scopeFor(input));
      await tx.$queryRaw`SELECT "id" FROM "FleetGrant" WHERE "id"=${grant.id} FOR UPDATE`;
      await authorizeGrant(ctx, tx, req, scopeFor(input));
      const commandId = `fleet:${grant.id}:${outer.commandId}`,
        hash = digest({ grantId: grant.id, input });
      const old = await getReceipt(tx, grant.createdById, commandId, hash);
      if (old) {
        const response = obj(old.responseJson),
          user = obj(response.user);
        return {
          ...response,
          ...(typeof user.name === 'string'
            ? { user: remoteUserDto({ ...user, name: user.name }) }
            : {}),
          duplicate: true,
        };
      }
      let response: Record<string, unknown>;
      if (input.action === 'registration.set') {
        await tx.siteState.update({
          where: { id: 'singleton' },
          data: { registrationOpenOverride: input.registrationOpen },
        });
        response = { settings: { registrationOpen: input.registrationOpen } };
      } else if (input.action === 'user.set-disabled') {
        const user = await tx.user.findUnique({ where: { id: input.userId } });
        if (!user) throw new HttpError(404, 'user_not_found');
        if (
          input.disabled &&
          user.role === 'admin' &&
          (await tx.user.count({ where: { role: 'admin', disabled: false } })) <= 1
        )
          throw new HttpError(409, 'last_admin_protected');
        const updated = await tx.user.update({
          where: { id: user.id },
          data: { disabled: input.disabled },
          select: { id: true, name: true, email: true, role: true, disabled: true },
        });
        if (input.disabled) await tx.session.deleteMany({ where: { userId: user.id } });
        response = { user: remoteUserDto(updated) };
      } else if (input.action === 'announcement.create') {
        response = {
          announcement: await tx.announcement.create({
            data: { title: input.title, body: input.body, status: input.status },
          }),
        };
      } else {
        await tx.announcement.deleteMany({ where: { id: input.announcementId } });
        response = { deleted: true };
      }
      await tx.fleetGrant.update({ where: { id: grant.id }, data: { lastUsedAt: new Date() } });
      await audit(tx, grant.createdById, `fleet.remote.${input.action}`, grant.id, {
        grantId: grant.id,
        controllerInstanceId: grant.controllerInstanceId,
        controllerSiteId: grant.controllerSiteId,
        commandId: outer.commandId,
        action: input,
      });
      const result = { ...response, duplicate: false };
      await tx.commandReceipt.create({
        data: {
          userId: grant.createdById,
          commandId,
          requestHash: hash,
          responseJson: json(result),
        },
      });
      return result;
    });
  });
  app.post('/fleet/remote/unpair', async (req) => {
    const ctx = await getContext(req);
    return transact(ctx.prisma, async (tx) => {
      const grant = await authorizeGrant(ctx, tx, req, undefined, true);
      await tx.fleetGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date() } });
      await audit(tx, grant.createdById, 'fleet.controller.remote-unpair', grant.id, {});
      return { revoked: true };
    });
  });
  app.get('/admin/fleet/sites', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    return {
      items: (
        await ctx.prisma.fleetConnection.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
      ).map(connectionDto),
    };
  });
  app.post('/admin/fleet/sites', async (req) => {
    const ctx = await getContext(req),
      actor = requireAdmin(ctx),
      input = parse(
        z
          .object({
            url: z.string().max(1000),
            token: z.string().regex(pairingTokenPattern),
            label: labelInput.default(''),
          })
          .strict(),
        req.body,
      );
    const remoteUrl = normalizeUrl(input.url);
    if (remoteUrl === ctx.publicUrl) throw new HttpError(400, 'fleet_self_pair');
    const existing = await ctx.prisma.fleetConnection.findUnique({ where: { remoteUrl } });
    if (existing && !['revoked', 'forgotten'].includes(existing.status))
      throw new HttpError(409, 'fleet_site_already_connected');
    let exchanged;
    try {
      exchanged = await transport({
        baseUrl: remoteUrl,
        path: '/api/v2/fleet/pair',
        method: 'POST',
        body: {
          token: input.token,
          controllerInstanceId: ctx.instanceId,
          controllerSiteId: ctx.siteId,
          controllerUrl: ctx.publicUrl,
          label: input.label || ctx.title,
        },
      });
    } catch (error) {
      throw new HttpError(
        error instanceof FleetTransportError ? error.statusCode : 502,
        error instanceof FleetTransportError ? error.code : 'fleet_unreachable',
      );
    }
    if (exchanged.status < 200 || exchanged.status >= 300) throw remoteError(exchanged);
    const cleanupCredential = z
      .object({
        site: z.object({ instanceId: identity, siteId: identity }),
        credential: z.string().regex(fleetCredentialPattern),
      })
      .safeParse(exchanged.data);
    let stored: FleetConnection;
    try {
      const result = parse(
        z.object({
          protocol: z.literal(fleetProtocol),
          site: remoteSiteInput,
          grantId: id,
          credential: z.string().regex(fleetCredentialPattern),
          scopes: scopesInput,
        }),
        exchanged.data,
      );
      if (
        normalizeUrl(result.site.publicUrl) !== remoteUrl ||
        (result.site.instanceId === ctx.instanceId && result.site.siteId === ctx.siteId)
      )
        throw new HttpError(502, 'fleet_remote_identity_changed');
      const data = {
        label: input.label || result.site.title,
        remoteUrl,
        remoteInstanceId: result.site.instanceId,
        remoteSiteId: result.site.siteId,
        grantId: result.grantId,
        scopes: [...new Set(result.scopes)],
        status: 'active',
        createdById: actor.id,
        revokedAt: null,
        lastSnapshot: Prisma.DbNull,
        lastCheckedAt: null,
        lastErrorCode: null,
      };
      stored = await transact(ctx.prisma, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(89124621)`;
        const duplicate = await tx.fleetConnection.findUnique({ where: { remoteUrl } });
        if (duplicate && !['revoked', 'forgotten'].includes(duplicate.status))
          throw new HttpError(409, 'fleet_site_already_connected');
        if (!duplicate && (await tx.fleetConnection.count()) >= 100)
          throw new HttpError(409, 'fleet_site_limit');
        const connectionId = duplicate?.id ?? randomUUID();
        const ciphertext = encryptFleetCredential(
          ctx.fleetSecret,
          {
            instanceId: ctx.instanceId,
            siteId: ctx.siteId,
            connectionId,
            remoteInstanceId: data.remoteInstanceId,
            remoteSiteId: data.remoteSiteId,
            remoteUrl,
            grantId: result.grantId,
          },
          result.credential,
        );
        const created = duplicate
          ? await tx.fleetConnection.update({
              where: { id: duplicate.id },
              data: { ...data, credentialCiphertext: ciphertext },
            })
          : await tx.fleetConnection.create({
              data: { ...data, id: connectionId, credentialCiphertext: ciphertext },
            });
        await audit(tx, actor.id, 'fleet.site.connect', created.id, {
          remoteUrl,
          remoteInstanceId: data.remoteInstanceId,
          remoteSiteId: data.remoteSiteId,
          scopes: data.scopes,
        });
        return created;
      });
    } catch (error) {
      if (cleanupCredential.success) {
        try {
          await transport({
            baseUrl: remoteUrl,
            path: '/api/v2/fleet/remote/unpair',
            method: 'POST',
            credential: cleanupCredential.data.credential,
            targetIdentity: cleanupCredential.data.site,
            body: {},
          });
        } catch {
          /* The controlled admin can revoke an unconfirmed grant. */
        }
      }
      throw error;
    }
    try {
      stored = await refresh(ctx, stored, transport);
    } catch {
      stored = await ctx.prisma.fleetConnection.findUniqueOrThrow({ where: { id: stored.id } });
    }
    return { site: connectionDto(stored) };
  });
  app.post('/admin/fleet/sites/:id/refresh', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    const params = parse(z.object({ id }), req.params),
      value = await connection(ctx, params.id, 'status:read');
    return { site: connectionDto(await refresh(ctx, value, transport)) };
  });
  app.delete('/admin/fleet/sites/:id', async (req) => {
    const ctx = await getContext(req),
      actor = requireAdmin(ctx),
      params = parse(z.object({ id }), req.params);
    const value = await ctx.prisma.fleetConnection.findUnique({ where: { id: params.id } });
    if (!value) throw new HttpError(404, 'fleet_site_not_found');
    if (value.status === 'revoked') return { revoked: true, remoteRevoked: true };
    if (value.status === 'forgotten') throw new HttpError(409, 'fleet_site_forgotten');
    const changed = await ctx.prisma.fleetConnection.updateMany({
      where: {
        id: value.id,
        grantId: value.grantId,
        credentialCiphertext: value.credentialCiphertext,
        status: { in: ['active', 'unreachable', 'disconnect_pending'] },
      },
      data: { status: 'disconnect_pending' },
    });
    if (!changed.count) throw new HttpError(409, 'fleet_connection_changed');
    let remoteRevoked = false;
    try {
      const response = obj(await send(ctx, value, transport, '/api/v2/fleet/remote/unpair', {}));
      remoteRevoked = response.revoked === true;
    } catch (error) {
      if (error instanceof HttpError && error.code === 'fleet_grant_revoked') remoteRevoked = true;
    }
    const updated = await transact(ctx.prisma, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "FleetConnection" WHERE "id"=${value.id} FOR UPDATE`;
      const current = await tx.fleetConnection.findUniqueOrThrow({ where: { id: value.id } });
      if (
        current.grantId !== value.grantId ||
        (current.credentialCiphertext !== value.credentialCiphertext &&
          current.status !== 'revoked')
      )
        throw new HttpError(409, 'fleet_connection_changed');
      if (current.status === 'revoked') return current;
      const row = await tx.fleetConnection.update({
        where: { id: value.id },
        data: remoteRevoked
          ? {
              status: 'revoked',
              revokedAt: new Date(),
              credentialCiphertext: '',
              lastErrorCode: null,
            }
          : { status: 'disconnect_pending', lastErrorCode: 'fleet_disconnect_pending' },
      });
      await audit(
        tx,
        actor.id,
        remoteRevoked ? 'fleet.site.disconnect' : 'fleet.site.disconnect-pending',
        row.id,
        { remoteRevoked },
      );
      return row;
    });
    return remoteRevoked
      ? { revoked: true, remoteRevoked: true }
      : { revoked: false, pending: true, site: connectionDto(updated) };
  });
  app.post('/admin/fleet/sites/:id/forget', async (req) => {
    const ctx = await getContext(req),
      actor = requireAdmin(ctx),
      params = parse(z.object({ id }), req.params);
    parse(z.object({ acknowledgeRemoteGrantMayRemain: z.literal(true) }).strict(), req.body);
    const updated = await transact(ctx.prisma, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "FleetConnection" WHERE "id"=${params.id} FOR UPDATE`;
      const current = await tx.fleetConnection.findUnique({ where: { id: params.id } });
      if (!current) throw new HttpError(404, 'fleet_site_not_found');
      const row = await tx.fleetConnection.update({
        where: { id: current.id },
        data: {
          status: 'forgotten',
          credentialCiphertext: '',
          revokedAt: null,
          lastErrorCode: 'fleet_remote_revocation_unconfirmed',
        },
      });
      await audit(tx, actor.id, 'fleet.site.forget', row.id, {
        remoteUrl: current.remoteUrl,
        remoteInstanceId: current.remoteInstanceId,
        remoteSiteId: current.remoteSiteId,
        grantId: current.grantId,
        remoteRevocationConfirmed: false,
      });
      return row;
    });
    return { forgotten: true, remoteRevocationConfirmed: false, site: connectionDto(updated) };
  });
  app.get('/admin/fleet/sites/:id/settings', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    const params = parse(z.object({ id }), req.params),
      value = await connection(ctx, params.id, 'status:read');
    const updated = await refresh(ctx, value, transport);
    return { settings: { registrationOpen: obj(updated.lastSnapshot).registrationOpen } };
  });
  app.get('/admin/fleet/sites/:id/users', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    const params = parse(z.object({ id }), req.params),
      query = parse(
        z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: id.optional(),
        }),
        req.query,
      );
    const value = await connection(ctx, params.id, 'users:read'),
      qs = new URLSearchParams({
        limit: String(query.limit),
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
    const raw = await send(ctx, value, transport, `/api/v2/fleet/remote/users?${qs.toString()}`);
    return parse(
      z.object({
        items: z
          .array(
            z.object({
              id,
              name: z.string().max(200),
              email: z.string().max(254),
              role: z.string().max(40),
              disabled: z.boolean(),
              createdAt: z.string().datetime(),
            }),
          )
          .max(100),
        page: z.object({ nextCursor: id.nullable(), hasMore: z.boolean() }),
      }),
      raw,
    );
  });
  app.get('/admin/fleet/sites/:id/announcements', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    const params = parse(z.object({ id }), req.params),
      value = await connection(ctx, params.id, 'announcements:write');
    return parse(
      z.object({
        items: z
          .array(
            z.object({
              id,
              title: z.string().max(160),
              body: z.string().max(4000),
              status: z.string().max(40),
              createdAt: z.string().datetime(),
              updatedAt: z.string().datetime(),
            }),
          )
          .max(50),
      }),
      await send(ctx, value, transport, '/api/v2/fleet/remote/announcements'),
    );
  });
  async function forward(req: FastifyRequest, action: FleetAction, commandId: string) {
    const ctx = await getContext(req),
      actor = requireAdmin(ctx),
      params = parse(z.object({ id }), req.params),
      value = await connection(ctx, params.id, scopeFor(action));
    const { action: name, ...payload } = action;
    const raw = await send(ctx, value, transport, '/api/v2/fleet/remote/actions', {
      commandId,
      action: name,
      payload,
    });
    const response =
      name === 'registration.set'
        ? parse(z.object({ settings: z.object({ registrationOpen: z.boolean() }) }), raw)
        : name === 'user.set-disabled'
          ? parse(
              z.object({
                user: z.object({
                  id,
                  name: z.string().max(200),
                  email: z.string().max(254),
                  role: z.string().max(40),
                  disabled: z.boolean(),
                }),
              }),
              raw,
            )
          : name === 'announcement.delete'
            ? parse(z.object({ deleted: z.literal(true) }), raw)
            : name === 'updates.check'
              ? parse(z.object({ update: updateInput }), raw)
              : parse(
                  z.object({
                    announcement: z.object({
                      id,
                      title: z.string().max(160),
                      body: z.string().max(4000),
                      status: z.string().max(40),
                      createdAt: z.string().datetime(),
                      updatedAt: z.string().datetime(),
                    }),
                  }),
                  raw,
                );
    await audit(ctx.prisma, actor.id, `fleet.site.${name}`, value.id, { commandId, action });
    return response;
  }
  const mutationId = z.string().min(1).max(80).optional();
  app.patch('/admin/fleet/sites/:id/settings', async (req) => {
    const input = parse(
      z.object({ registrationOpen: z.boolean(), commandId: mutationId }).strict(),
      req.body,
    );
    return forward(
      req,
      { action: 'registration.set', registrationOpen: input.registrationOpen },
      input.commandId ?? randomUUID(),
    );
  });
  app.post('/admin/fleet/sites/:id/check-update', async (req) => {
    const input = parse(z.object({ commandId: mutationId }).strict(), req.body ?? {});
    return forward(req, { action: 'updates.check' }, input.commandId ?? randomUUID());
  });
  app.patch('/admin/fleet/sites/:id/users/:userId', async (req) => {
    const input = parse(
        z.object({ disabled: z.boolean(), commandId: mutationId }).strict(),
        req.body,
      ),
      params = parse(z.object({ id, userId: id }), req.params);
    return forward(
      req,
      { action: 'user.set-disabled', userId: params.userId, disabled: input.disabled },
      input.commandId ?? randomUUID(),
    );
  });
  app.post('/admin/fleet/sites/:id/announcements', async (req) => {
    const input = parse(
      z
        .object({
          title: z.string().trim().min(1).max(160),
          body: z.string().trim().min(1).max(4000),
          status: z.enum(['published', 'draft']).default('published'),
          commandId: mutationId,
        })
        .strict(),
      req.body,
    );
    return forward(
      req,
      { action: 'announcement.create', title: input.title, body: input.body, status: input.status },
      input.commandId ?? randomUUID(),
    );
  });
  app.delete('/admin/fleet/sites/:id/announcements/:announcementId', async (req) => {
    const input = parse(z.object({ commandId: mutationId }).strict(), req.body ?? {}),
      params = parse(z.object({ id, announcementId: id }), req.params);
    return forward(
      req,
      { action: 'announcement.delete', announcementId: params.announcementId },
      input.commandId ?? randomUUID(),
    );
  });
}
