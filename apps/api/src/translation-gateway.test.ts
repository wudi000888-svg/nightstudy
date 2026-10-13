import { describe, expect, it, vi } from 'vitest';
import { buildTranslationGateway } from './translation-gateway.js';
import { TranslationProviderError } from './providers/google-web.js';
const secret = 'gateway-test-token-'.repeat(3);
const input = { text: 'rain', sourceLanguage: 'en', targetLanguage: 'zh-CN' };
const result = {
  translatedText: '雨',
  detectedSourceLanguage: 'en',
  provider: 'google-web-compat',
  unofficial: true,
} as const;

describe('closed VPS translation gateway', () => {
  it('requires server authentication and rejects arbitrary upstream fields', async () => {
    const translate = vi.fn(async () => result);
    const app = buildTranslationGateway({ secret, translate });
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/translate', payload: input })).statusCode,
      ).toBe(401);
      const request = await app.inject({
        method: 'POST',
        url: '/translate',
        headers: { authorization: `Bearer ${secret}` },
        payload: { ...input, url: 'http://127.0.0.1/' },
      });
      expect(request.statusCode).toBe(400);
      expect(translate).not.toHaveBeenCalled();
      expect((await app.inject('/health/ready')).json()).toMatchObject({
        status: 'ready',
        unofficial: true,
      });
    } finally {
      await app.close();
    }
  });
  it('shares concurrent requests, caches successful results, and applies a global request budget', async () => {
    let resolve!: (value: typeof result) => void;
    const translate = vi.fn(
      () =>
        new Promise<typeof result>((done) => {
          resolve = done;
        }),
    );
    const app = buildTranslationGateway({ secret, translate, requestsPerMinute: 3 });
    try {
      const request = () =>
        app.inject({
          method: 'POST',
          url: '/translate',
          headers: { authorization: `Bearer ${secret}` },
          payload: input,
        });
      const first = request();
      const second = request();
      await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
      resolve(result);
      expect((await first).json()).toMatchObject(result);
      expect((await second).json()).toMatchObject(result);
      expect((await request()).json()).toMatchObject({ ...result, cached: true });
      expect((await request()).statusCode).toBe(429);
      expect(translate).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it('never caches a provider error or produces a substitute translation', async () => {
    const translate = vi
      .fn()
      .mockRejectedValueOnce(new TranslationProviderError(504, 'translation_timeout'))
      .mockResolvedValue(result);
    const app = buildTranslationGateway({ secret, translate });
    try {
      const request = () =>
        app.inject({
          method: 'POST',
          url: '/translate',
          headers: { authorization: `Bearer ${secret}` },
          payload: input,
        });
      expect((await request()).json()).toEqual({ code: 'translation_timeout' });
      expect((await request()).json()).toMatchObject(result);
      expect(translate).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
