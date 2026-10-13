import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { HttpError, requireUser, type ContextResolver } from '../context.js';
import {
  TRANSLATION_MAX_LENGTH,
  TranslationProviderError,
  readBoundedJson,
  translateGoogleWeb,
  validateTranslationPayload,
  type GoogleWebResult,
  type TranslationPayload,
} from '../providers/google-web.js';

export function translationWebsite(value: unknown) {
  const payload = validateTranslationPayload(value);
  const url = new URL('https://translate.google.com/');
  url.search = new URLSearchParams({
    sl: payload.sourceLanguage,
    tl: payload.targetLanguage,
    text: payload.text,
    op: 'translate',
  }).toString();
  return { provider: 'google', mode: 'external', url: url.href, iframeSupported: false };
}

export async function translateThroughGateway(
  payload: TranslationPayload,
  gateway: { gatewayUrl: string; gatewaySecret: string },
  options: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<GoogleWebResult> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 8000);
  try {
    const response = await (options.fetchFn ?? fetch)(gateway.gatewayUrl, {
      method: 'POST',
      signal,
      redirect: 'error',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${gateway.gatewaySecret}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok)
      throw new TranslationProviderError(
        response.status === 429 ? 429 : response.status === 504 ? 504 : 502,
        response.status === 429
          ? 'translation_upstream_limited'
          : response.status === 504
            ? 'translation_timeout'
            : 'translation_gateway_failed',
      );
    const raw = await readBoundedJson(response);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new TranslationProviderError(502, 'translation_response_invalid');
    const result = raw as Record<string, unknown>;
    if (
      typeof result.translatedText !== 'string' ||
      !result.translatedText.trim() ||
      result.translatedText.length > 12000 ||
      result.provider !== 'google-web-compat' ||
      result.unofficial !== true ||
      !(result.detectedSourceLanguage === null || typeof result.detectedSourceLanguage === 'string')
    )
      throw new TranslationProviderError(502, 'translation_response_invalid');
    return {
      translatedText: result.translatedText,
      detectedSourceLanguage:
        typeof result.detectedSourceLanguage === 'string' &&
        result.detectedSourceLanguage.length <= 32
          ? result.detectedSourceLanguage
          : null,
      provider: 'google-web-compat',
      unofficial: true,
    };
  } catch (error) {
    if (error instanceof TranslationProviderError) throw error;
    throw new TranslationProviderError(
      signal.aborted ? 504 : 502,
      signal.aborted ? 'translation_timeout' : 'translation_gateway_failed',
    );
  }
}

export async function registerTranslation(app: FastifyInstance, getContext: ContextResolver) {
  app.get('/translation/provider', async (req) => {
    const ctx = await getContext(req);
    const transport =
      ctx.translation?.mode === 'direct'
        ? 'direct'
        : ctx.translation?.mode === 'gateway' &&
            ctx.translation.gatewayUrl &&
            ctx.translation.gatewaySecret
          ? 'gateway'
          : null;
    return {
      provider: {
        id: 'google',
        mode: transport ? 'integrated' : 'website-official',
        transport,
        configured: Boolean(transport),
        unofficial: Boolean(transport),
        bestEffort: Boolean(transport),
        iframeSupported: false,
        maxTextLength: TRANSLATION_MAX_LENGTH,
        websiteUrl: 'https://translate.google.com/',
        retainsTranslationHistory: false,
      },
    };
  });
  app.post('/translation/website', async (req) => {
    await getContext(req);
    try {
      return translationWebsite(req.body);
    } catch (error) {
      if (error instanceof TranslationProviderError)
        throw new HttpError(
          error.statusCode,
          error.code,
          '请输入不超过1000字的有效文本和支持的语言',
        );
      throw error;
    }
  });
  app.post('/translation/text', async (req, reply) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    try {
      const payload = validateTranslationPayload(req.body);
      if (!ctx.translation || ctx.translation.mode === 'website-official')
        throw new HttpError(
          503,
          'translation_not_configured',
          '站内翻译未配置，请使用官方网页入口',
        );
      if (
        ctx.translation.mode === 'gateway' &&
        (!ctx.translation.gatewayUrl || !ctx.translation.gatewaySecret)
      )
        throw new HttpError(
          503,
          'translation_not_configured',
          '站内翻译未配置，请使用官方网页入口',
        );
      const minute = Math.floor(Date.now() / 60000);
      const key = createHash('sha256')
        .update(`translation:${ctx.siteId}:${user.id}:${minute}`)
        .digest('hex');
      const rows = await ctx.prisma.$queryRaw<
        Array<{ count: number }>
      >`INSERT INTO "RateBucket" ("key", "count", "expiresAt") VALUES (${key}, 1, ${new Date((minute + 2) * 60000)}) ON CONFLICT ("key") DO UPDATE SET "count" = "RateBucket"."count" + 1 RETURNING "count"`;
      if ((rows[0]?.count ?? 0) > 20) {
        reply.header('Retry-After', String(60 - (Math.floor(Date.now() / 1000) % 60)));
        throw new HttpError(429, 'translation_rate_limit', '翻译请求过于频繁，请稍后再试');
      }
      const transport = ctx.translation.mode;
      const result =
        transport === 'direct'
          ? await translateGoogleWeb(payload)
          : await translateThroughGateway(payload, {
              gatewayUrl: ctx.translation.gatewayUrl!,
              gatewaySecret: ctx.translation.gatewaySecret!,
            });
      return {
        translation: {
          ...payload,
          ...result,
          bestEffort: true,
          transport,
          translatedAt: new Date().toISOString(),
        },
        website: translationWebsite(payload),
      };
    } catch (error) {
      if (error instanceof TranslationProviderError) {
        if (error.statusCode === 429) reply.header('Retry-After', '60');
        throw new HttpError(
          error.statusCode,
          error.code,
          error.statusCode === 400
            ? '请输入不超过1000字的有效文本和支持的语言'
            : '翻译服务暂不可用，请稍后再试或打开官方网页',
        );
      }
      throw error;
    }
  });
}
