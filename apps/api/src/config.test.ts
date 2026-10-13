import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from './config.js';

const original = { ...process.env };
let temporary = '';
afterEach(() => {
  process.env = { ...original };
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  temporary = '';
});
function sites(rows: object[]) {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-config-'));
  const file = path.join(temporary, 'sites.json');
  fs.writeFileSync(file, JSON.stringify(rows));
  process.env.SITES_FILE = file;
  process.env.NODE_ENV = 'test';
  process.env.TEST_DB_A = 'postgresql://test:test@127.0.0.1:5432/site_a';
  process.env.TEST_DB_B = 'postgresql://test:test@127.0.0.1:5432/site_b';
  process.env.TEST_AUTH_A = 'a'.repeat(40);
  process.env.TEST_AUTH_B = 'b'.repeat(40);
  process.env.TEST_BOOT_A = 'c'.repeat(40);
  process.env.TEST_BOOT_B = 'd'.repeat(40);
}
const a = {
  id: 'alpha',
  publicUrl: 'https://alpha.example/learn',
  basePath: '/learn',
  databaseUrlEnv: 'TEST_DB_A',
  authSecretEnv: 'TEST_AUTH_A',
  bootstrapTokenEnv: 'TEST_BOOT_A',
};
const b = {
  id: 'beta',
  publicUrl: 'https://beta.example',
  databaseUrlEnv: 'TEST_DB_B',
  authSecretEnv: 'TEST_AUTH_B',
  bootstrapTokenEnv: 'TEST_BOOT_B',
};
describe('operator site configuration', () => {
  it('parses a closed registration flag and rejects spelling mistakes', () => {
    sites([a]);
    delete process.env.SITES_FILE;
    process.env.DATABASE_URL = process.env.TEST_DB_A;
    process.env.BETTER_AUTH_SECRET = process.env.TEST_AUTH_A;
    process.env.BOOTSTRAP_TOKEN = process.env.TEST_BOOT_A;
    process.env.PUBLIC_URL = 'http://alpha.test';
    process.env.REGISTRATION_OPEN = 'FALSE';
    expect(readConfig().sites[0]?.registrationOpen).toBe(false);
    process.env.REGISTRATION_OPEN = 'flase';
    expect(() => readConfig()).toThrow();
  });
  it('rejects unsupported URL schemes and unreachable bootstrap token lengths', () => {
    sites([{ ...a, publicUrl: 'ftp://alpha.example/learn' }]);
    expect(() => readConfig()).toThrow('HTTP(S)');
    sites([a]);
    process.env.TEST_BOOT_A = 'x'.repeat(257);
    expect(() => readConfig()).toThrow('at most 256');
  });
  it('enables the Render public IP profile only inside its deployment environment', () => {
    sites([a]);
    process.env.CLIENT_IP_PROFILE = 'render-public';
    delete process.env.RENDER;
    expect(() => readConfig()).toThrow('Render public');
    process.env.RENDER = 'true';
    expect(readConfig().clientIpProfile).toBe('render-public');
  });
  it('supports explicit domains and normalized subpaths without exposing secrets', () => {
    sites([a, b]);
    const cfg = readConfig();
    expect(cfg.sites.map((s) => s.id)).toEqual(['alpha', 'beta']);
    expect(cfg.sites[0]?.basePath).toBe('/learn');
  });
  it('rejects shared database even with different credentials and query strings', () => {
    sites([a, b]);
    process.env.TEST_DB_B = 'postgresql://other:different@127.0.0.1:5432/site_a?schema=other';
    expect(() => readConfig()).toThrow('separate business/auth database');
  });
  it('rejects shared auth secrets', () => {
    sites([a, b]);
    process.env.TEST_AUTH_B = process.env.TEST_AUTH_A;
    expect(() => readConfig()).toThrow('separate authentication secret');
  });
  it('rejects ambiguous routing and unsafe paths', () => {
    sites([a, { ...b, publicUrl: a.publicUrl, basePath: '/learn' }]);
    expect(() => readConfig()).toThrow('Ambiguous');
  });
  it('rejects production http and path mismatches', () => {
    sites([{ ...a, publicUrl: 'http://alpha.example/wrong' }]);
    process.env.NODE_ENV = 'production';
    expect(() => readConfig()).toThrow('HTTPS');
  });
});
