import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { bootstrapAdministrator } from './bootstrap-admin.js';
import { createDatabase } from './db.js';
import { createAuthentication } from './auth.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('private automatic administrator initialization', () => {
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Use an isolated _test database');
  const db = createDatabase(url),
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-admin-'));
  const site = { id: 'default', publicUrl: 'http://bootstrap.test' };
  let previous: { initialized: boolean; initializedAt: Date | null };
  let createdId: string | undefined;
  beforeAll(async () => {
    if (await db.user.findUnique({ where: { username: 'admin' } }))
      throw new Error('Bootstrap test namespace not clean');
    const state = await db.siteState.findUniqueOrThrow({ where: { id: 'singleton' } });
    previous = { initialized: state.initialized, initializedAt: state.initializedAt };
    await db.siteState.update({
      where: { id: 'singleton' },
      data: { initialized: false, initializedAt: null },
    });
  });
  afterAll(async () => {
    if (createdId) {
      await db.adminAuditLog.deleteMany({ where: { actorId: createdId } });
      await db.user.deleteMany({ where: { id: createdId } });
    }
    if (previous) await db.siteState.update({ where: { id: 'singleton' }, data: previous });
    await db.$disconnect();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it('creates one admin under concurrent init, privately persists the random password and supports username login', async () => {
    const results = await Promise.all([
      bootstrapAdministrator(db, site, directory),
      bootstrapAdministrator(db, site, directory),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['already-initialized', 'created']);
    const file = path.join(directory, 'default.credentials.json');
    const credentials = JSON.parse(fs.readFileSync(file, 'utf8'));
    createdId = credentials.userId;
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(credentials.username).toBe('admin');
    expect(credentials.password.length).toBeGreaterThanOrEqual(32);
    const auth = createAuthentication(
      {
        ...site,
        title: 'Bootstrap',
        basePath: '',
        hosts: ['bootstrap.test'],
        databaseUrl: url,
        authSecret: 'bootstrap-test-secret-'.repeat(3),
        bootstrapToken: 'bootstrap-test-token-'.repeat(3),
        registrationOpen: true,
      },
      db,
      false,
    );
    const result = await auth.api.signInUsername({
      body: { username: 'admin', password: credentials.password },
      asResponse: true,
    });
    expect(result.status).toBe(200);
    expect(result.headers.get('set-cookie')).toContain('HttpOnly');
    expect((await db.user.findUniqueOrThrow({ where: { id: credentials.userId } })).role).toBe(
      'admin',
    );
    expect(JSON.stringify(results)).not.toContain(credentials.password);
  });
  it('does not rotate an existing administrator password or rewrite the credential file', async () => {
    const file = path.join(directory, 'default.credentials.json'),
      before = fs.readFileSync(file, 'utf8');
    expect(
      (
        await bootstrapAdministrator(db, site, directory, {
          initialPassword: 'A-new-password-must-not-be-applied',
        })
      ).status,
    ).toBe('already-initialized');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    await expect(
      bootstrapAdministrator(db, { ...site, id: 'wrong-site' }, directory),
    ).rejects.toThrow('binding_mismatch');
  });
  it('retires an uncommitted candidate when a different administrator already owns the initialized site', async () => {
    const file = path.join(directory, 'default.credentials.json');
    const candidate = JSON.parse(fs.readFileSync(file, 'utf8'));
    candidate.userId = randomUUID();
    fs.writeFileSync(file, JSON.stringify(candidate), { mode: 0o600 });
    expect((await bootstrapAdministrator(db, site, directory)).status).toBe('already-initialized');
    expect(fs.existsSync(file)).toBe(false);
    expect(
      fs
        .readdirSync(directory)
        .some((name) => name.startsWith('default.credentials.json.unconfirmed-')),
    ).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: createdId! } })).role).toBe('admin');
  });
});
