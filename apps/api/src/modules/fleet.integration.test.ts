import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../app.js';
import { createDatabase } from '../db.js';
import type { AppConfig } from '../config.js';
import {
  decryptFleetCredential,
  encryptFleetCredential,
  fleetScopes,
  fleetTokenHash,
  newFleetCredential,
} from './fleet-crypto.js';
import { FleetTransportError, type FleetTransport } from './fleet-transport.js';

const controlDatabase = process.env.TEST_DATABASE_URL;
const managedDatabase = process.env.TEST_DATABASE_URL_B;
const suite = controlDatabase && managedDatabase ? describe : describe.skip;

suite('PostgreSQL fleet, real authentication and isolated realms', () => {
  if (!controlDatabase || !managedDatabase) return;
  if (
    ![controlDatabase, managedDatabase].every((value) =>
      new URL(value).pathname.endsWith('_test'),
    ) ||
    new URL(controlDatabase).pathname === new URL(managedDatabase).pathname
  )
    throw new Error('Fleet tests require two different isolated databases ending in _test');
  const controlDb = createDatabase(controlDatabase),
    managedDb = createDatabase(managedDatabase);
  const runId = randomUUID();
  const prefix = `fleet-it-${runId}`;
  const password = 'Fleet-integration-password-2026!';
  const adminA = `${prefix}-admin-a`,
    adminB = `${prefix}-admin-b`,
    userB = `${prefix}-user-b`;
  const emailA = `${adminA}@example.test`,
    emailB = `${adminB}@example.test`,
    emailUser = `${userB}@example.test`;
  const signupEmail = `${prefix}-signup@example.test`;
  const controlUrl = 'https://control.example',
    managedUrl = 'https://managed.example/learn';
  const secretA = 'fleet-controlled-test-key-a-'.repeat(3);
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-fleet-test-'));
  fs.writeFileSync(
    path.join(webRoot, 'index.html'),
    '<html><body><div id="root"></div></body></html>',
  );
  const octet = Number.parseInt(runId.slice(0, 2), 16);
  const ipA = `10.78.${octet}.1`,
    ipB = `10.78.${octet}.2`,
    peerIp = `10.78.${octet}.3`;
  let control: FastifyInstance, managed: FastifyInstance;
  let cookieA = '',
    cookieB = '',
    cookieUser = '';
  let instanceA = '',
    instanceB = '';
  let overrideA: boolean | null = null,
    overrideB: boolean | null = null;
  let savedState = false;
  let offline = false,
    proxy401 = false,
    mismatchedPublicUrl = false;
  const exchanged = new Map<string, string>();

  const makeConfig = (databaseUrl: string, managedSite = false): AppConfig => ({
    sites: [
      {
        id: 'default',
        title: managedSite ? 'Managed integration' : 'Control integration',
        publicUrl: managedSite ? managedUrl : controlUrl,
        basePath: managedSite ? '/learn' : '',
        hosts: [managedSite ? 'managed.example' : 'control.example'],
        databaseUrl,
        authSecret: managedSite ? 'fleet-controlled-test-key-b-'.repeat(3) : secretA,
        bootstrapToken: 'fleet-bootstrap-not-used-'.repeat(3),
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
  });
  const request = (
    site: 'control' | 'managed',
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    route: string,
    body?: unknown,
    cookie = site === 'control' ? cookieA : cookieB,
    extra: Record<string, string> = {},
  ) => {
    const isManaged = site === 'managed';
    return (isManaged ? managed : control).inject({
      method,
      url: `${isManaged ? '/learn' : ''}${route}`,
      remoteAddress: isManaged ? ipB : ipA,
      headers: {
        host: isManaged ? 'managed.example' : 'control.example',
        ...(cookie ? { cookie } : {}),
        ...(['POST', 'PATCH', 'DELETE'].includes(method)
          ? { 'content-type': 'application/json' }
          : {}),
        ...extra,
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  };
  const machine = (
    path: string,
    credential?: string,
    body?: unknown,
    expected = { instanceId: instanceB, siteId: 'default' },
  ) =>
    request(
      'managed',
      body === undefined ? 'GET' : 'POST',
      `/api/v2/fleet/remote/${path}`,
      body,
      '',
      {
        'x-nightstudy-fleet-instance': expected.instanceId,
        'x-nightstudy-fleet-site': expected.siteId,
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
    );
  const transport: FleetTransport = async (input) => {
    if (offline) throw new FleetTransportError('fleet_unreachable');
    if (proxy401) return { status: 401, data: { code: 'proxy_authentication_required' } };
    if (input.baseUrl !== managedUrl) throw new Error('Unexpected test destination');
    // This controlled transport uses only machine credential and expected identity. User cookies never cross realms.
    const response = await managed.inject({
      method: input.method,
      url: `/learn${input.path}`,
      remoteAddress: peerIp,
      headers: {
        host: 'managed.example',
        ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(input.credential ? { authorization: `Bearer ${input.credential}` } : {}),
        ...(input.targetIdentity
          ? {
              'x-nightstudy-fleet-instance': input.targetIdentity.instanceId,
              'x-nightstudy-fleet-site': input.targetIdentity.siteId,
            }
          : {}),
      },
      ...(input.body !== undefined ? { payload: JSON.stringify(input.body) } : {}),
    });
    const data = response.json();
    if (input.path.endsWith('/pair') && response.statusCode === 200) {
      exchanged.set(String(data.grantId), String(data.credential));
      if (mismatchedPublicUrl) data.site.publicUrl = 'https://alias.example/learn';
    }
    return { status: response.statusCode, data };
  };
  async function signin(site: 'control' | 'managed', email: string) {
    const result = await request(site, 'POST', '/api/auth/sign-in/email', { email, password }, '');
    expect(result.statusCode).toBe(200);
    const cookies = result.headers['set-cookie'];
    return (Array.isArray(cookies) ? cookies : [cookies])
      .filter(Boolean)
      .map((value) => String(value).split(';')[0])
      .join('; ');
  }
  async function issue(scopes: readonly string[] = fleetScopes) {
    const result = await request('managed', 'POST', '/api/v2/admin/fleet/pairing-tokens', {
      label: prefix,
      scopes,
    });
    expect(result.statusCode).toBe(200);
    return result.json() as { token: string; pairingToken: { id: string; expiresAt: string } };
  }
  async function connect(scopes: readonly string[] = fleetScopes) {
    const token = await issue(scopes);
    const result = await request('control', 'POST', '/api/v2/admin/fleet/sites', {
      url: managedUrl,
      token: token.token,
      label: prefix,
    });
    expect(result.statusCode).toBe(200);
    const site = result.json().site as {
      id: string;
      status: string;
      remoteInstanceId: string;
      remoteSiteId: string;
    };
    const row = await controlDb.fleetConnection.findUniqueOrThrow({ where: { id: site.id } });
    return { site, row, credential: exchanged.get(row.grantId)! };
  }
  async function disconnect(id: string) {
    const result = await request('control', 'DELETE', `/api/v2/admin/fleet/sites/${id}`, {});
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ revoked: true, remoteRevoked: true });
  }

  beforeAll(async () => {
    const [stateA, stateB] = await Promise.all([
      controlDb.siteState.findUniqueOrThrow({ where: { id: 'singleton' } }),
      managedDb.siteState.findUniqueOrThrow({ where: { id: 'singleton' } }),
    ]);
    expect(stateA.siteId).toBe('default');
    expect(stateB.siteId).toBe('default');
    instanceA = stateA.instanceId;
    instanceB = stateB.instanceId;
    expect(instanceA).not.toBe(instanceB);
    overrideA = stateA.registrationOpenOverride;
    overrideB = stateB.registrationOpenOverride;
    savedState = true;
    const passwordHash = await hashPassword(password);
    for (const [db, id, email, role] of [
      [controlDb, adminA, emailA, 'admin'],
      [managedDb, adminB, emailB, 'admin'],
      [managedDb, userB, emailUser, 'user'],
    ] as const) {
      await db.user.create({
        data: {
          id,
          email,
          name: prefix,
          role,
          accounts: {
            create: {
              id: randomUUID(),
              providerId: 'credential',
              accountId: id,
              password: passwordHash,
            },
          },
        },
      });
    }
    managed = (await buildApp(makeConfig(managedDatabase, true), false)).app;
    control = (await buildApp(makeConfig(controlDatabase), false, { fleetTransport: transport }))
      .app;
    cookieA = await signin('control', emailA);
    cookieB = await signin('managed', emailB);
    cookieUser = await signin('managed', emailUser);
  }, 60000);

  afterAll(async () => {
    offline = false;
    proxy401 = false;
    await control?.close();
    await managed?.close();
    if (savedState)
      await Promise.all([
        controlDb.siteState.update({
          where: { id: 'singleton' },
          data: { registrationOpenOverride: overrideA },
        }),
        managedDb.siteState.update({
          where: { id: 'singleton' },
          data: { registrationOpenOverride: overrideB },
        }),
      ]);
    await controlDb.fleetConnection.deleteMany({ where: { createdById: adminA } });
    for (const db of [controlDb, managedDb]) {
      await db.fleetGrant.deleteMany({ where: { createdById: { in: [adminA, adminB] } } });
      await db.fleetPairingToken.deleteMany({ where: { createdById: { in: [adminA, adminB] } } });
      await db.adminAuditLog.deleteMany({ where: { actorId: { in: [adminA, adminB] } } });
      await db.announcement.deleteMany({ where: { title: { startsWith: prefix } } });
      await db.user.deleteMany({
        where: { email: { in: [emailA, emailB, emailUser, signupEmail] } },
      });
      await db.$disconnect();
    }
    fs.rmSync(webRoot, { recursive: true, force: true });
  }, 60000);

  it('consumes a pairing token once under concurrent PostgreSQL transactions and stores hashes only', async () => {
    const token = await issue(['status:read']);
    const body = {
      token: token.token,
      controllerInstanceId: instanceA,
      controllerSiteId: 'default',
      controllerUrl: controlUrl,
    };
    const responses = await Promise.all([
      request('managed', 'POST', '/api/v2/fleet/pair', body, ''),
      request('managed', 'POST', '/api/v2/fleet/pair', body, ''),
    ]);
    expect(responses.map((value) => value.statusCode).sort()).toEqual([200, 409]);
    const winner = responses.find((value) => value.statusCode === 200)!.json();
    const loser = responses.find((value) => value.statusCode === 409)!.json();
    expect(loser.code).toBe('fleet_pairing_token_used');
    const storedToken = await managedDb.fleetPairingToken.findUniqueOrThrow({
      where: { id: token.pairingToken.id },
    });
    const grant = await managedDb.fleetGrant.findUniqueOrThrow({ where: { id: winner.grantId } });
    expect(storedToken.usedAt).not.toBeNull();
    expect(storedToken.tokenHash).toBe(fleetTokenHash(token.token));
    expect(grant.credentialHash).toBe(fleetTokenHash(winner.credential));
    expect(JSON.stringify(grant)).not.toContain(winner.credential);
    await managedDb.fleetGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date() } });
  });

  it('binds an encrypted connection to distinct installation identities even when both site IDs are default', async () => {
    const { site, row, credential } = await connect();
    expect(site).toMatchObject({
      status: 'active',
      remoteInstanceId: instanceB,
      remoteSiteId: 'default',
    });
    expect(row.credentialCiphertext).not.toContain(credential);
    expect(
      decryptFleetCredential(
        secretA,
        {
          instanceId: instanceA,
          siteId: 'default',
          connectionId: row.id,
          remoteInstanceId: instanceB,
          remoteSiteId: 'default',
          remoteUrl: managedUrl,
          grantId: row.grantId,
        },
        row.credentialCiphertext,
      ),
    ).toBe(credential);
    const status = await machine('status', credential);
    expect(status.statusCode).toBe(200);
    expect(status.json().site.instanceId).toBe(instanceB);
    const summary = await request('control', 'GET', '/api/v2/admin/fleet');
    for (const hidden of [credential, row.credentialCiphertext, secretA])
      expect(summary.body).not.toContain(hidden);
    expect(
      (await request('managed', 'GET', '/api/v2/me', undefined, cookieA)).json().user,
    ).toBeNull();
    expect(
      (await request('managed', 'GET', '/api/v2/fleet/remote/status', undefined, cookieB))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await machine('status', credential, undefined, { instanceId: instanceA, siteId: 'default' })
      ).json().code,
    ).toBe('fleet_remote_identity_changed');
    expect(
      (
        await machine('status', credential, undefined, { instanceId: instanceB, siteId: 'other' })
      ).json().code,
    ).toBe('fleet_remote_identity_changed');
    await disconnect(site.id);
  });

  it('enforces delegated scopes in both controller and controlled realm', async () => {
    const { site, credential } = await connect(['status:read']);
    expect(
      (await request('control', 'GET', `/api/v2/admin/fleet/sites/${site.id}/settings`)).statusCode,
    ).toBe(200);
    expect(
      (await request('control', 'GET', `/api/v2/admin/fleet/sites/${site.id}/users`)).json().code,
    ).toBe('fleet_scope_denied');
    expect((await machine('users', credential)).json().code).toBe('fleet_scope_denied');
    expect(
      (
        await machine('actions', credential, {
          commandId: randomUUID(),
          action: 'registration.set',
          payload: { registrationOpen: false },
        })
      ).statusCode,
    ).toBe(403);
    await disconnect(site.id);
  });

  it('disables a real user, immediately invalidates its auth session and protects the final administrator', async () => {
    const { site } = await connect();
    expect(
      (await request('managed', 'GET', '/api/v2/me', undefined, cookieUser)).json().user.id,
    ).toBe(userB);
    const disabled = await request(
      'control',
      'PATCH',
      `/api/v2/admin/fleet/sites/${site.id}/users/${userB}`,
      { disabled: true, commandId: randomUUID() },
    );
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().user.disabled).toBe(true);
    expect(
      (await request('managed', 'GET', '/api/v2/me', undefined, cookieUser)).json().user,
    ).toBeNull();
    expect(await managedDb.session.count({ where: { userId: userB } })).toBe(0);
    const deniedLogin = await request(
      'managed',
      'POST',
      '/api/auth/sign-in/email',
      { email: emailUser, password },
      '',
    );
    expect([400, 401, 403]).toContain(deniedLogin.statusCode);
    expect(await managedDb.session.count({ where: { userId: userB } })).toBe(0);
    if ((await managedDb.user.count({ where: { role: 'admin', disabled: false } })) === 1) {
      const lastAdmin = await request(
        'control',
        'PATCH',
        `/api/v2/admin/fleet/sites/${site.id}/users/${adminB}`,
        { disabled: true, commandId: randomUUID() },
      );
      expect(lastAdmin.statusCode).toBe(409);
      expect(lastAdmin.json().code).toBe('last_admin_protected');
    }
    const enabled = await request(
      'control',
      'PATCH',
      `/api/v2/admin/fleet/sites/${site.id}/users/${userB}`,
      { disabled: false, commandId: randomUUID() },
    );
    expect(enabled.statusCode).toBe(200);
    cookieUser = await signin('managed', emailUser);
    await disconnect(site.id);
  });

  it('applies a registration override to actual sign-up and reopens registration without changing config', async () => {
    const { site } = await connect();
    const signupBody = { email: signupEmail, password, name: prefix, role: 'admin' };
    expect(
      (
        await request('control', 'PATCH', `/api/v2/admin/fleet/sites/${site.id}/settings`, {
          registrationOpen: false,
          commandId: randomUUID(),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await request('managed', 'GET', '/api/v2/site', undefined, '')).json().registrationOpen,
    ).toBe(false);
    const rejected = await request('managed', 'POST', '/api/auth/sign-up/email', signupBody, '');
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().code).toBe('registration_closed');
    expect(await managedDb.user.count({ where: { email: signupEmail } })).toBe(0);
    expect(
      (
        await request('control', 'PATCH', `/api/v2/admin/fleet/sites/${site.id}/settings`, {
          registrationOpen: true,
          commandId: randomUUID(),
        })
      ).statusCode,
    ).toBe(200);
    const accepted = await request('managed', 'POST', '/api/auth/sign-up/email', signupBody, '');
    expect(accepted.statusCode).toBe(200);
    expect((await managedDb.user.findUniqueOrThrow({ where: { email: signupEmail } })).role).toBe(
      'user',
    );
    await disconnect(site.id);
  });

  it('commits one announcement for a durable repeated command and rejects changed content under the same command', async () => {
    const { site, row } = await connect();
    const body = {
      title: `${prefix}-announcement`,
      body: 'Synthetic fleet announcement',
      status: 'published',
      commandId: randomUUID(),
    };
    const create = () =>
      request('control', 'POST', `/api/v2/admin/fleet/sites/${site.id}/announcements`, body);
    const [first, repeated] = await Promise.all([create(), create()]);
    expect(first.statusCode).toBe(200);
    expect(repeated.statusCode).toBe(200);
    expect(first.json().announcement.id).toBe(repeated.json().announcement.id);
    expect(await managedDb.announcement.count({ where: { title: body.title } })).toBe(1);
    expect(
      await managedDb.commandReceipt.count({
        where: { userId: adminB, commandId: `fleet:${row.grantId}:${body.commandId}` },
      }),
    ).toBe(1);
    const changed = await request(
      'control',
      'POST',
      `/api/v2/admin/fleet/sites/${site.id}/announcements`,
      { ...body, body: 'Changed' },
    );
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe('idempotency_conflict');
    const deleted = await request(
      'control',
      'DELETE',
      `/api/v2/admin/fleet/sites/${site.id}/announcements/${first.json().announcement.id}`,
      { commandId: randomUUID() },
    );
    expect(deleted.statusCode).toBe(200);
    await disconnect(site.id);
  });

  it('revokes a delegated controller immediately at the owner and clears only the corresponding local credential', async () => {
    const { site, row, credential } = await connect();
    expect(
      (await request('managed', 'DELETE', `/api/v2/admin/fleet/controllers/${row.grantId}`, {}))
        .statusCode,
    ).toBe(200);
    expect((await machine('status', credential)).json().code).toBe('fleet_grant_revoked');
    const refresh = await request(
      'control',
      'POST',
      `/api/v2/admin/fleet/sites/${site.id}/refresh`,
      {},
    );
    expect(refresh.statusCode).toBe(401);
    expect(refresh.json().code).toBe('fleet_grant_revoked');
    const revoked = await controlDb.fleetConnection.findUniqueOrThrow({ where: { id: row.id } });
    expect(revoked.status).toBe('revoked');
    expect(revoked.credentialCiphertext).toBe('');
    expect((await request('control', 'GET', '/api/v2/me')).json().user.id).toBe(adminA);
  });

  it('retains an encrypted credential through network and unknown-proxy-401 unpair failures, then retries safely', async () => {
    const { site, row } = await connect();
    proxy401 = true;
    const unconfirmed = await request(
      'control',
      'POST',
      `/api/v2/admin/fleet/sites/${site.id}/refresh`,
      {},
    );
    expect(unconfirmed.statusCode).toBe(502);
    expect(unconfirmed.json().code).toBe('fleet_remote_authorization_unconfirmed');
    const preserved = await controlDb.fleetConnection.findUniqueOrThrow({ where: { id: row.id } });
    expect(preserved.status).toBe('unreachable');
    expect(preserved.credentialCiphertext).toBe(row.credentialCiphertext);
    expect(preserved.lastSnapshot).toEqual(row.lastSnapshot);
    proxy401 = false;
    offline = true;
    const lost = await request('control', 'DELETE', `/api/v2/admin/fleet/sites/${site.id}`, {});
    expect(lost.json()).toMatchObject({ revoked: false, pending: true });
    expect(
      (await controlDb.fleetConnection.findUniqueOrThrow({ where: { id: row.id } }))
        .credentialCiphertext,
    ).toBe(row.credentialCiphertext);
    expect(
      (await managedDb.fleetGrant.findUniqueOrThrow({ where: { id: row.grantId } })).revokedAt,
    ).toBeNull();
    expect(
      (await request('control', 'GET', `/api/v2/admin/fleet/sites/${site.id}/users`)).json().code,
    ).toBe('fleet_disconnect_pending');
    offline = false;
    proxy401 = true;
    const proxy = await request('control', 'DELETE', `/api/v2/admin/fleet/sites/${site.id}`, {});
    expect(proxy.json()).toMatchObject({ revoked: false, pending: true });
    expect(
      (await controlDb.fleetConnection.findUniqueOrThrow({ where: { id: row.id } }))
        .credentialCiphertext,
    ).toBe(row.credentialCiphertext);
    expect(
      (await managedDb.fleetGrant.findUniqueOrThrow({ where: { id: row.grantId } })).revokedAt,
    ).toBeNull();
    proxy401 = false;
    await disconnect(site.id);
    expect(
      (await managedDb.fleetGrant.findUniqueOrThrow({ where: { id: row.grantId } })).revokedAt,
    ).not.toBeNull();
    expect(
      (await controlDb.fleetConnection.findUniqueOrThrow({ where: { id: row.id } }))
        .credentialCiphertext,
    ).toBe('');
  });

  it('revokes a newly issued grant when canonical remote identity validation fails after token exchange', async () => {
    const token = await issue();
    const previous = new Set(exchanged.keys());
    mismatchedPublicUrl = true;
    try {
      const result = await request('control', 'POST', '/api/v2/admin/fleet/sites', {
        url: managedUrl,
        token: token.token,
      });
      expect(result.statusCode).toBe(502);
      expect(result.json().code).toBe('fleet_remote_identity_changed');
    } finally {
      mismatchedPublicUrl = false;
    }
    const grantId = [...exchanged.keys()].find((value) => !previous.has(value))!;
    expect(
      (await managedDb.fleetGrant.findUniqueOrThrow({ where: { id: grantId } })).revokedAt,
    ).not.toBeNull();
  });

  it('explicitly forgets only a local stale binding after an installation change and re-pairs with the same record ID', async () => {
    const { site, row, credential } = await connect();
    // Simulate the old stored tuple referring to a previous installation without changing
    // the fixture realm's persisted identity or any unrelated deployment records.
    const oldRemoteInstance = randomUUID();
    await controlDb.fleetConnection.update({
      where: { id: row.id },
      data: {
        remoteInstanceId: oldRemoteInstance,
        credentialCiphertext: encryptFleetCredential(
          secretA,
          {
            instanceId: instanceA,
            siteId: 'default',
            connectionId: row.id,
            remoteInstanceId: oldRemoteInstance,
            remoteSiteId: 'default',
            remoteUrl: managedUrl,
            grantId: row.grantId,
          },
          credential,
        ),
      },
    });
    const refresh = await request(
      'control',
      'POST',
      `/api/v2/admin/fleet/sites/${site.id}/refresh`,
      {},
    );
    expect(refresh.statusCode).toBe(502);
    expect(refresh.json().code).toBe('fleet_remote_identity_changed');
    const unpair = await request('control', 'DELETE', `/api/v2/admin/fleet/sites/${site.id}`, {});
    expect(unpair.json()).toMatchObject({ revoked: false, pending: true });
    const invalidAck = await request(
      'control',
      'POST',
      `/api/v2/admin/fleet/sites/${site.id}/forget`,
      { acknowledgeRemoteGrantMayRemain: false },
    );
    expect(invalidAck.statusCode).toBe(400);
    const forgotten = await request(
      'control',
      'POST',
      `/api/v2/admin/fleet/sites/${site.id}/forget`,
      { acknowledgeRemoteGrantMayRemain: true },
    );
    expect(forgotten.statusCode).toBe(200);
    expect(forgotten.json()).toMatchObject({
      forgotten: true,
      remoteRevocationConfirmed: false,
      site: { status: 'forgotten' },
    });
    expect(forgotten.json()).not.toHaveProperty('remoteRevoked');
    expect(
      (await controlDb.fleetConnection.findUniqueOrThrow({ where: { id: row.id } }))
        .credentialCiphertext,
    ).toBe('');
    expect(
      (await managedDb.fleetGrant.findUniqueOrThrow({ where: { id: row.grantId } })).revokedAt,
    ).toBeNull();
    expect(
      (await request('control', 'GET', `/api/v2/admin/fleet/sites/${site.id}/users`)).json().code,
    ).toBe('fleet_site_forgotten');
    expect(
      (await request('control', 'DELETE', `/api/v2/admin/fleet/sites/${site.id}`, {})).json().code,
    ).toBe('fleet_site_forgotten');
    const replacement = await connect();
    expect(replacement.site.id).toBe(site.id);
    expect(replacement.site.status).toBe('active');
    expect(replacement.row.grantId).not.toBe(row.grantId);
    expect(replacement.site.remoteInstanceId).toBe(instanceB);
    await disconnect(site.id);
    // The previous grant deliberately remains active until the controlled owner revokes it.
    await request('managed', 'DELETE', `/api/v2/admin/fleet/controllers/${row.grantId}`, {});
  });

  it('bounds historical long names in remote user lists and successful mutation receipts without rewriting account data', async () => {
    const { site } = await connect();
    const historicalName = '旧'.repeat(201);
    await managedDb.user.update({ where: { id: userB }, data: { name: historicalName } });
    try {
      const users = await request(
        'control',
        'GET',
        `/api/v2/admin/fleet/sites/${site.id}/users?limit=100`,
      );
      expect(users.statusCode).toBe(200);
      expect(users.json().items.find((entry: { id: string }) => entry.id === userB).name).toBe(
        '旧'.repeat(80),
      );
      const body = { disabled: true, commandId: randomUUID() };
      const first = await request(
        'control',
        'PATCH',
        `/api/v2/admin/fleet/sites/${site.id}/users/${userB}`,
        body,
      );
      const repeated = await request(
        'control',
        'PATCH',
        `/api/v2/admin/fleet/sites/${site.id}/users/${userB}`,
        body,
      );
      expect(first.statusCode).toBe(200);
      expect(repeated.statusCode).toBe(200);
      expect(first.json().user.name).toBe('旧'.repeat(80));
      expect(repeated.json().user.name).toBe('旧'.repeat(80));
      expect((await managedDb.user.findUniqueOrThrow({ where: { id: userB } })).name).toBe(
        historicalName,
      );
      await request('control', 'PATCH', `/api/v2/admin/fleet/sites/${site.id}/users/${userB}`, {
        disabled: false,
        commandId: randomUUID(),
      });
    } finally {
      await managedDb.user.update({
        where: { id: userB },
        data: { name: prefix, disabled: false },
      });
      await disconnect(site.id);
    }
  });

  it('keeps active controllers visible and refuses the 101st active grant without consuming its token', async () => {
    const activeBefore = await managedDb.fleetGrant.count({ where: { revokedAt: null } });
    const createdIds = Array.from({ length: Math.max(0, 100 - activeBefore) }, () => randomUUID());
    await managedDb.fleetGrant.createMany({
      data: createdIds.map((id) => ({
        id,
        label: prefix,
        credentialHash: fleetTokenHash(newFleetCredential()),
        controllerInstanceId: instanceA,
        controllerSiteId: 'default',
        controllerUrl: controlUrl,
        scopes: ['status:read'],
        createdById: adminB,
      })),
    });
    try {
      const summary = await request('managed', 'GET', '/api/v2/admin/fleet');
      expect(summary.json().controllers).toHaveLength(100);
      expect(
        summary
          .json()
          .controllers.every((entry: { revokedAt: string | null }) => entry.revokedAt === null),
      ).toBe(true);
      const token = await issue(['status:read']);
      const response = await request(
        'managed',
        'POST',
        '/api/v2/fleet/pair',
        {
          token: token.token,
          controllerInstanceId: instanceA,
          controllerSiteId: 'default',
          controllerUrl: controlUrl,
        },
        '',
      );
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('fleet_grant_limit');
      expect(
        (
          await managedDb.fleetPairingToken.findUniqueOrThrow({
            where: { id: token.pairingToken.id },
          })
        ).usedAt,
      ).toBeNull();
    } finally {
      await managedDb.fleetGrant.deleteMany({ where: { id: { in: createdIds } } });
    }
  });
});
