import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readAiNetworkPolicy } from './providers/ai-network-policy.js';
import type { CompatibleAiNetworkPolicy } from './providers/compatible-ai.js';

const pathSchema = z
  .string()
  .refine(
    (value) => value === '' || /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(value),
    'basePath must be empty or a normalized segment path',
  );
const siteInput = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
  title: z.string().min(1).max(100).default('夜读英语'),
  publicUrl: z.url(),
  basePath: pathSchema.default(''),
  hosts: z
    .array(z.string().regex(/^[a-zA-Z0-9.-]+$/))
    .min(1)
    .optional(),
  databaseUrlEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  authSecretEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  bootstrapTokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  registrationOpen: z.boolean().default(true),
  translationMode: z.enum(['website-official', 'direct', 'gateway']).default('website-official'),
  translationGatewayUrl: z.url().optional(),
  translationGatewaySecretEnv: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .optional(),
});

export interface TranslationConfig {
  mode: 'website-official' | 'direct' | 'gateway';
  gatewayUrl?: string;
  gatewaySecret?: string;
}
export interface SiteConfig {
  id: string;
  title: string;
  publicUrl: string;
  basePath: string;
  hosts: string[];
  databaseUrl: string;
  authSecret: string;
  bootstrapToken: string;
  registrationOpen: boolean;
  translation?: TranslationConfig;
}
export interface AppConfig {
  sites: SiteConfig[];
  host: string;
  port: number;
  webRoot: string;
  production: boolean;
  trustedProxy: string[];
  poolSize: number;
  maxSites: number;
  clientIpProfile?: 'socket' | 'render-public';
  aiNetworkPolicy?: CompatibleAiNetworkPolicy;
}

function envSecret(name: string, maximum = Infinity): string {
  const value = process.env[name] || '';
  if (value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  if (value.length > maximum) throw new Error(`${name} must contain at most ${maximum} characters`);
  return value;
}

export function readConfig(): AppConfig {
  const production = process.env.NODE_ENV === 'production';
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(process.env.PORT || 5198);
  let inputs: z.infer<typeof siteInput>[];
  if (process.env.SITES_FILE) {
    inputs = z
      .array(siteInput)
      .min(1)
      .max(100)
      .parse(JSON.parse(fs.readFileSync(path.resolve(process.env.SITES_FILE), 'utf8')));
  } else {
    inputs = [
      siteInput.parse({
        id: 'default',
        title: process.env.SITE_TITLE || '夜读英语',
        publicUrl: process.env.PUBLIC_URL || `http://127.0.0.1:${port}`,
        basePath: process.env.BASE_PATH || '',
        databaseUrlEnv: 'DATABASE_URL',
        authSecretEnv: 'BETTER_AUTH_SECRET',
        bootstrapTokenEnv: 'BOOTSTRAP_TOKEN',
        registrationOpen:
          z
            .enum(['true', 'false'])
            .parse((process.env.REGISTRATION_OPEN || 'true').trim().toLowerCase()) === 'true',
        translationMode: process.env.TRANSLATION_MODE || 'website-official',
        translationGatewayUrl: process.env.TRANSLATION_GATEWAY_URL || undefined,
        translationGatewaySecretEnv: 'TRANSLATION_GATEWAY_SECRET',
      }),
    ];
  }
  const sites = inputs.map((input) => {
    const url = new URL(input.publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error(`Site ${input.id}: publicUrl must be an HTTP(S) URL without credentials`);
    if (
      production &&
      url.protocol !== 'https:' &&
      !['localhost', '127.0.0.1'].includes(url.hostname)
    )
      throw new Error(`Site ${input.id}: HTTPS publicUrl required in production`);
    if (
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname.replace(/\/$/, '') !== input.basePath)
    )
      throw new Error(`Site ${input.id}: publicUrl path must match basePath`);
    const databaseUrl = process.env[input.databaseUrlEnv];
    if (!databaseUrl || !['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol))
      throw new Error(`${input.databaseUrlEnv} must be a PostgreSQL connection string`);
    const hosts = input.hosts || [
      url.hostname,
      ...(!production && ['127.0.0.1', 'localhost'].includes(url.hostname)
        ? ['127.0.0.1', 'localhost']
        : []),
    ];
    if (production && input.translationMode === 'direct')
      throw new Error('Production translation requires the authenticated VPS gateway');
    const translation: TranslationConfig = { mode: input.translationMode };
    if (input.translationMode === 'gateway') {
      if (!input.translationGatewayUrl || !input.translationGatewaySecretEnv)
        throw new Error(`Site ${input.id}: gateway URL and secret environment name required`);
      const gateway = new URL(input.translationGatewayUrl);
      if (
        !['http:', 'https:'].includes(gateway.protocol) ||
        gateway.username ||
        gateway.password ||
        gateway.search ||
        gateway.hash ||
        (gateway.protocol === 'http:' &&
          !['localhost', '127.0.0.1', 'translation-gateway'].includes(gateway.hostname))
      )
        throw new Error(`Site ${input.id}: gateway requires HTTPS or the internal Compose gateway`);
      translation.gatewayUrl = gateway.href;
      translation.gatewaySecret = envSecret(input.translationGatewaySecretEnv, 256);
    }
    return {
      id: input.id,
      title: input.title,
      publicUrl: url.origin + input.basePath,
      basePath: input.basePath,
      hosts: [...new Set(hosts.map((host) => host.toLowerCase()))],
      databaseUrl,
      authSecret: envSecret(input.authSecretEnv),
      bootstrapToken: envSecret(input.bootstrapTokenEnv, 256),
      registrationOpen: input.registrationOpen,
      translation,
    };
  });
  if (new Set(sites.map((site) => site.id)).size !== sites.length)
    throw new Error('Duplicate site id');
  const databaseIdentities = sites.map((site) => {
    const url = new URL(site.databaseUrl);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  });
  if (new Set(databaseIdentities).size !== sites.length)
    throw new Error('Each site requires a separate business/auth database');
  if (new Set(sites.map((site) => site.authSecret)).size !== sites.length)
    throw new Error('Each site requires a separate authentication secret');
  for (const [i, site] of sites.entries()) {
    for (const other of sites.slice(i + 1))
      if (site.basePath === other.basePath && site.hosts.some((host) => other.hosts.includes(host)))
        throw new Error('Ambiguous host/basePath mapping');
  }
  const maxSites = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(process.env.MAX_ACTIVE_SITES || 20);
  if (sites.length > maxSites)
    throw new Error(
      'Configured sites exceed MAX_ACTIVE_SITES; alpha requires a bounded pool for every configured site',
    );
  const clientIpProfile = z
    .enum(['socket', 'render-public'])
    .parse(process.env.CLIENT_IP_PROFILE || 'socket');
  if (clientIpProfile === 'render-public' && process.env.RENDER !== 'true')
    throw new Error('render-public IP profile requires the Render public web-service ingress');
  return {
    sites,
    port,
    host: process.env.HOST || '127.0.0.1',
    webRoot: path.resolve(process.env.WEB_ROOT || 'apps/web/dist'),
    production,
    trustedProxy: (process.env.TRUST_PROXY_CIDRS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    poolSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(30)
      .parse(process.env.DB_POOL_SIZE || 5),
    maxSites,
    clientIpProfile,
    aiNetworkPolicy: readAiNetworkPolicy(process.env.AI_PRIVATE_ENDPOINTS_JSON),
  };
}
