import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { lookup } from 'node:dns/promises';
import type { RequestContext } from '../context.js';
import { HttpError } from '../context.js';
import { registerFleet } from './fleet.js';
import {
  encryptFleetCredential,
  decryptFleetCredential,
  newFleetCredential,
  newPairingToken,
  fleetTokenHash,
  pairingTokenPattern,
  fleetCredentialPattern,
  type FleetBinding,
} from './fleet-crypto.js';
import {
  canonicalFleetUrl,
  publicFleetAddress,
  resolveFleetAddress,
  createFleetDnsResolver,
} from './fleet-transport.js';

describe('fleet token and credential cryptography', () => {
  it('generates independent high-entropy token types and stores only a one-way hash', () => {
    const pairing = newPairingToken(),
      credential = newFleetCredential();
    expect(pairingTokenPattern.test(pairing)).toBe(true);
    expect(fleetCredentialPattern.test(credential)).toBe(true);
    expect(fleetCredentialPattern.test(pairing)).toBe(false);
    expect(pairingTokenPattern.test(credential)).toBe(false);
    expect(newPairingToken()).not.toBe(pairing);
    expect(fleetTokenHash(pairing)).toMatch(/^[a-f0-9]{64}$/);
    expect(fleetTokenHash(pairing)).not.toContain(pairing);
  });
  it('binds encrypted credentials to both realm identities, URL, grant and record', () => {
    const secret = 'private-test-key-'.repeat(4),
      credential = newFleetCredential();
    const binding: FleetBinding = {
      instanceId: randomUUID(),
      siteId: 'default',
      connectionId: randomUUID(),
      remoteInstanceId: randomUUID(),
      remoteSiteId: 'default',
      remoteUrl: 'https://remote.example.com/learn',
      grantId: randomUUID(),
    };
    const encrypted = encryptFleetCredential(secret, binding, credential);
    expect(encrypted).not.toContain(credential);
    expect(decryptFleetCredential(secret, binding, encrypted)).toBe(credential);
    expect(encryptFleetCredential(secret, binding, credential)).not.toBe(encrypted);
    for (const field of Object.keys(binding) as Array<keyof FleetBinding>) {
      expect(() =>
        decryptFleetCredential(
          secret,
          { ...binding, [field]: binding[field] + 'changed' },
          encrypted,
        ),
      ).toThrow('fleet_credential_unreadable');
    }
    expect(() => decryptFleetCredential('other-test-key-'.repeat(4), binding, encrypted)).toThrow(
      'fleet_credential_unreadable',
    );
    const segments = encrypted.split('.');
    segments[2] = 'A'.repeat(22);
    expect(() => decryptFleetCredential(secret, binding, segments.join('.'))).toThrow(
      'fleet_credential_unreadable',
    );
  });
});

describe('fleet public HTTPS transport policy', () => {
  it('canonicalizes legitimate base paths and rejects credentials, private IPs, paths and ports', () => {
    expect(canonicalFleetUrl('https://EXAMPLE.com:443/learn/')).toBe('https://example.com/learn');
    for (const address of [
      'http://example.com',
      'https://user:pass@example.com',
      'https://example.com:8443',
      'https://localhost',
      'https://127.1',
      'https://2130706433',
      'https://0x7f000001',
      'https://[::ffff:127.0.0.1]',
      'https://example.com/?url=private',
      'https://example.com/#private',
      'https://example.com/%2fsecret',
    ])
      expect(() => canonicalFleetUrl(address)).toThrow();
  });
  it('rejects internal, reserved, mapped and transition address classes in both IP families', () => {
    for (const address of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.0.1',
      '192.0.2.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:8.8.8.8',
      '64:ff9b::a00:1',
      '2002:a00::1',
      '2001:db8::1',
      '2001::1',
      '3ffe::1',
      '3fff::1',
    ])
      expect(publicFleetAddress(address), address).toBe(false);
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '2001:4860:4860::8888'])
      expect(publicFleetAddress(address), address).toBe(true);
  });
  it('rejects mixed public/private DNS answers before dialing and returns a pinned public address', async () => {
    const mixed = (async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]) as unknown as typeof lookup;
    await expect(resolveFleetAddress('remote.example.com', mixed)).rejects.toMatchObject({
      code: 'fleet_url_private',
    });
    const publicOnly = (async () => [
      { address: '2606:4700::1111', family: 6 },
      { address: '1.1.1.1', family: 4 },
    ]) as unknown as typeof lookup;
    await expect(resolveFleetAddress('remote.example.com', publicOnly)).resolves.toEqual({
      address: '1.1.1.1',
      family: 4,
    });
  });
  it('holds the DNS concurrency slot after timeout until the uncancellable lookup settles', async () => {
    let settle!: (records: Array<{ address: string; family: number }>) => void;
    const slow = (() =>
      new Promise((resolve) => {
        settle = resolve;
      })) as unknown as typeof lookup;
    const resolve = createFleetDnsResolver(slow, 1, 5);
    await expect(resolve('remote.example.com')).rejects.toMatchObject({ code: 'fleet_timeout' });
    await expect(resolve('another.example.com')).rejects.toMatchObject({
      code: 'fleet_transport_busy',
    });
    settle([{ address: '1.1.1.1', family: 4 }]);
    await new Promise((done) => setTimeout(done, 0));
    await expect(resolve('1.1.1.1')).resolves.toMatchObject({ address: '1.1.1.1' });
  });
});

describe('fleet authority and secret output boundaries', () => {
  async function fixture() {
    const credential = newFleetCredential();
    const now = new Date();
    const grant = {
      id: 'grant-test',
      label: 'controller',
      credentialHash: fleetTokenHash(credential),
      controllerInstanceId: randomUUID(),
      controllerSiteId: 'default',
      controllerUrl: 'https://controller.example.com',
      scopes: ['status:read'],
      createdById: 'issuer',
      revokedAt: null as Date | null,
      lastUsedAt: null,
      createdAt: now,
    };
    const pairing = {
      id: 'pair-test',
      label: 'pair',
      tokenHash: fleetTokenHash(newPairingToken()),
      scopes: ['status:read'],
      expiresAt: new Date(Date.now() + 600000),
      usedAt: null,
      revokedAt: null,
      createdById: 'issuer',
      createdAt: now,
    };
    const site = {
      id: 'site-test',
      label: 'site',
      remoteUrl: 'https://remote.example.com',
      remoteInstanceId: randomUUID(),
      remoteSiteId: 'default',
      grantId: grant.id,
      credentialCiphertext: 'private-ciphertext',
      scopes: ['status:read'],
      status: 'active',
      lastSnapshot: null,
      lastCheckedAt: null,
      lastErrorCode: null,
      createdById: 'issuer',
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    let issuerDisabled = false;
    const db = {
      fleetGrant: {
        findUnique: async ({ where }: { where: { credentialHash: string } }) =>
          where.credentialHash === grant.credentialHash ? grant : null,
        findMany: async () => [grant],
        update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(grant, data),
      },
      fleetPairingToken: { findMany: async () => [pairing] },
      fleetConnection: { findMany: async () => [site] },
      user: {
        findUnique: async () => ({ disabled: issuerDisabled, role: 'admin' }),
        count: async () => 1,
      },
      siteState: { findUniqueOrThrow: async () => ({ contentVersion: 'test' }) },
      contentPack: { findMany: async () => [] },
      book: { count: async () => 0 },
      systemUpdateCheck: { findUnique: async () => null },
      adminAuditLog: { create: async () => ({}) },
      $transaction: async (operation: (tx: unknown) => unknown) => operation(db),
    };
    const ctx = {
      instanceId: randomUUID(),
      siteId: 'default',
      title: 'test site',
      publicUrl: 'https://target.example.com',
      basePath: '',
      fleetSecret: 'private-unit-secret-'.repeat(3),
      registrationOpen: true,
      user: { id: 'issuer', name: 'admin', email: 'admin@example.com', role: 'admin' },
      prisma: db,
    } as unknown as RequestContext;
    const app = Fastify();
    app.setErrorHandler((error, _req, reply) =>
      error instanceof HttpError
        ? reply.code(error.statusCode).send({ code: error.code })
        : reply.code(503).send({ code: 'service_unavailable' }),
    );
    await registerFleet(app, async () => ctx);
    await app.ready();
    const headers = {
      authorization: `Bearer ${credential}`,
      'x-nightstudy-fleet-instance': ctx.instanceId,
      'x-nightstudy-fleet-site': ctx.siteId,
    };
    return {
      app,
      ctx,
      grant,
      pairing,
      site,
      credential,
      headers,
      disableIssuer: () => {
        issuerDisabled = true;
      },
    };
  }
  it('requires a grant, matching realm identity and scope even with an administrator cookie', async () => {
    const f = await fixture();
    try {
      expect(
        (
          await f.app.inject({
            url: '/fleet/remote/status',
            headers: { cookie: 'administrator-cookie' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await f.app.inject({
            url: '/fleet/remote/status',
            headers: { ...f.headers, 'x-nightstudy-fleet-instance': randomUUID() },
          })
        ).json(),
      ).toMatchObject({ code: 'fleet_remote_identity_changed' });
      const good = await f.app.inject({ url: '/fleet/remote/status', headers: f.headers });
      expect(good.statusCode, good.body).toBe(200);
      expect(good.json().site.instanceId).toBe(f.ctx.instanceId);
      expect(
        (await f.app.inject({ url: '/fleet/remote/users', headers: f.headers })).statusCode,
      ).toBe(403);
      f.grant.revokedAt = new Date();
      expect(
        (await f.app.inject({ url: '/fleet/remote/status', headers: f.headers })).json(),
      ).toMatchObject({ code: 'fleet_grant_revoked' });
    } finally {
      await f.app.close();
    }
  });
  it('invalidates issuer authority and still permits a credential to revoke only its own grant', async () => {
    const f = await fixture();
    try {
      f.disableIssuer();
      expect(
        (await f.app.inject({ url: '/fleet/remote/status', headers: f.headers })).json(),
      ).toMatchObject({ code: 'fleet_issuer_inactive' });
      const unpair = await f.app.inject({
        method: 'POST',
        url: '/fleet/remote/unpair',
        headers: f.headers,
        payload: {},
      });
      expect(unpair.statusCode, unpair.body).toBe(200);
      expect(f.grant.revokedAt).not.toBeNull();
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/fleet/remote/unpair',
            headers: f.headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await f.app.close();
    }
  });
  it('omits all raw tokens, hashes, ciphertext and the site key from public administrative summaries', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ url: '/admin/fleet' });
      expect(response.statusCode, response.body).toBe(200);
      for (const privateValue of [
        f.credential,
        f.ctx.fleetSecret,
        f.grant.credentialHash,
        f.pairing.tokenHash,
        f.site.credentialCiphertext,
      ])
        expect(response.body).not.toContain(privateValue);
      expect(response.json().controllers[0].controllerInstanceId).toBe(
        f.grant.controllerInstanceId,
      );
    } finally {
      await f.app.close();
    }
  });
});
