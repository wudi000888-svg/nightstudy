import { isIP } from 'node:net';
import { z } from 'zod';
import type { CompatibleAiNetworkPolicy } from './compatible-ai.js';
import { normalizeCompatibleBaseUrl } from './compatible-ai.js';

/** Deployment-only policy: never accepted from an administrator HTTP request. */
export function readAiNetworkPolicy(raw: string | undefined): CompatibleAiNetworkPolicy {
  if (!raw?.trim()) return { privateEndpoints: [] };
  try {
    if (raw.length > 16000) throw new Error('too_large');
    const rules = z
      .array(
        z
          .object({
            origin: z.string().min(1).max(2048),
            addresses: z
              .array(z.string().refine((value) => Boolean(isIP(value))))
              .min(1)
              .max(16),
          })
          .strict(),
      )
      .max(16)
      .parse(JSON.parse(raw));
    const origins = new Set<string>();
    for (const rule of rules) {
      const url = new URL(rule.origin);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.origin !== rule.origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/' ||
        origins.has(rule.origin) ||
        new Set(rule.addresses).size !== rule.addresses.length
      )
        throw new Error('invalid_rule');
      origins.add(rule.origin);
    }
    for (const rule of rules)
      normalizeCompatibleBaseUrl(rule.origin, 'openai-chat', { privateEndpoints: rules });
    return { privateEndpoints: rules };
  } catch {
    throw new Error('AI_PRIVATE_ENDPOINTS_JSON must contain exact origins and fixed IP addresses');
  }
}
