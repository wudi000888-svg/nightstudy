import Fastify from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  translateGoogleWeb,
  validateTranslationPayload,
  TranslationProviderError,
  type GoogleWebResult,
  type TranslationPayload,
} from './providers/google-web.js';

/** A closed VPS service for NightStudy's server, never an arbitrary-URL browser proxy. */
export function buildTranslationGateway(options: {
  secret: string;
  requestsPerMinute?: number;
  translate?: (payload: TranslationPayload) => Promise<GoogleWebResult>;
}) {
  if (options.secret.length < 32 || options.secret.length > 256)
    throw new Error('Gateway secret must contain 32–256 characters');
  const maximum = options.requestsPerMinute ?? 120;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 2000)
    throw new Error('Gateway request budget must be between 1 and 2000 per minute');
  const token = Buffer.from(`Bearer ${options.secret}`);
  const app = Fastify({ logger: false, bodyLimit: 8192, requestTimeout: 10000 });
  let minute = -1,
    count = 0;
  const cache = new Map<
    string,
    { expires: number; value: GoogleWebResult; timer: ReturnType<typeof setTimeout> }
  >();
  const evict = (key: string) => {
    const entry = cache.get(key);
    if (entry) clearTimeout(entry.timer);
    cache.delete(key);
  };
  const pending = new Map<string, Promise<GoogleWebResult>>();
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY');
    if (request.method === 'GET' && request.url === '/health/ready') return;
    const supplied = Buffer.from(request.headers.authorization || '');
    if (supplied.length !== token.length || !timingSafeEqual(supplied, token))
      return reply.code(401).send({ code: 'gateway_authentication_required' });
    const current = Math.floor(Date.now() / 60000);
    if (current !== minute) {
      minute = current;
      count = 0;
    }
    if (++count > maximum)
      return reply.header('Retry-After', '60').code(429).send({ code: 'gateway_rate_limit' });
  });
  app.get('/health/ready', () => ({
    status: 'ready',
    provider: 'google-web-compat',
    unofficial: true,
  }));
  app.post('/translate', async (request) => {
    const payload = validateTranslationPayload(request.body);
    const key = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return { ...cached.value, cached: true };
    evict(key);
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= 8) throw new TranslationProviderError(429, 'translation_provider_busy');
    const operation = (options.translate ?? translateGoogleWeb)(payload);
    pending.set(key, operation);
    try {
      const value = await operation;
      // RAM only: bounded 200 entries, ten minutes, no translation text in logs or backups.
      if (cache.size >= 200) evict(cache.keys().next().value!);
      const timer = setTimeout(() => evict(key), 600000).unref();
      cache.set(key, { expires: Date.now() + 600000, value, timer });
      return value;
    } finally {
      pending.delete(key);
    }
  });
  app.addHook('onClose', async () => {
    for (const key of cache.keys()) evict(key);
    pending.clear();
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof TranslationProviderError)
      return reply.code(error.statusCode).send({ code: error.code });
    const status =
      typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 502;
    return reply
      .code(status >= 400 && status < 500 ? status : 502)
      .send({ code: status === 413 ? 'translation_body_too_large' : 'translation_request_failed' });
  });
  return app;
}
