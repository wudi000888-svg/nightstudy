import { createHash, randomUUID } from 'node:crypto';
import { HttpError, type RequestContext } from '../context.js';
import {
  DeepSeekProviderError,
  requestDeepSeek,
  type DeepSeekTransport,
} from '../providers/deepseek.js';
import { decryptDeepSeekKey } from './deepseek-crypto.js';
import { requestCompatibleAi } from '../providers/compatible-ai.js';
import {
  aiConfigurationFingerprint,
  normalizedAiConnection,
  validateAiKeyDestination,
} from './ai-settings.js';

export function deepSeekProviderError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof DeepSeekProviderError) {
    const messages: Record<string, string> = {
      deepseek_authentication_failed: 'AI 密钥无效，请检查后台配置',
      deepseek_insufficient_balance: 'AI 服务账户余额不足，请自行检查账户',
      deepseek_upstream_limited: 'AI 请求受限，请稍后手动重试',
      deepseek_timeout: 'AI 请求超时，本次不会自动重试',
      deepseek_response_invalid: 'AI 返回内容未通过校验，请稍后手动重试',
      deepseek_upstream_rejected: 'AI 服务不接受当前请求，请检查模型配置',
      compatible_ai_authentication_failed: 'AI 密钥无效，请检查接口地址和认证方式',
      compatible_ai_insufficient_balance: 'AI 服务账户余额不足，请自行检查账户',
      compatible_ai_upstream_limited: 'AI 请求受限，请稍后手动重试',
      compatible_ai_timeout: 'AI 请求超时，本次不会自动重试',
      compatible_ai_response_invalid: 'AI 返回内容未通过校验，请检查模型与接口类型',
      compatible_ai_upstream_rejected: 'AI 服务不接受当前请求，请检查模型与接口类型',
      compatible_ai_url_invalid: '接口地址格式无效，请填写正确的服务地址',
      compatible_ai_url_private: '接口地址指向受限网络；本机代理需部署者配置受信任入口',
    };
    throw new HttpError(
      error.statusCode,
      error.code,
      messages[error.code] ?? 'AI 服务暂不可用，本次不会自动重试',
    );
  }
  throw new HttpError(502, 'deepseek_upstream_failed', 'AI 服务暂不可用，本次不会自动重试');
}
async function acquireRequest(ctx: RequestContext, actorId: string) {
  for (const [kind, identity, limit] of [
    ['site', ctx.siteId, 20],
    ['actor', actorId, 6],
  ] as const) {
    const key = createHash('sha256')
      .update(JSON.stringify(['deepseek', ctx.siteId, kind, identity]))
      .digest('hex');
    const result = await ctx.prisma.$queryRaw<
      Array<{ count: number }>
    >`INSERT INTO "RateBucket" ("key", "count", "expiresAt") VALUES (${key} || ':' || floor(extract(epoch from clock_timestamp()) / 60)::text, 1, clock_timestamp() + interval '2 minutes') ON CONFLICT ("key") DO UPDATE SET "count" = "RateBucket"."count" + 1 RETURNING "count"`;
    if ((result[0]?.count ?? limit + 1) > limit)
      throw new HttpError(429, 'deepseek_rate_limit', 'AI 请求过于频繁，请稍后再试');
  }
  const id = randomUUID();
  await ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(89124801)`;
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    const now = clock[0]!.now;
    await tx.deepSeekRequestLease.deleteMany({ where: { expiresAt: { lte: now } } });
    const active = await tx.deepSeekRequestLease.findMany({
      where: { siteId: ctx.siteId },
      select: { actorId: true },
    });
    if (active.length >= 2 || active.some((value) => value.actorId === actorId))
      throw new HttpError(429, 'deepseek_busy', '本站或当前用户已有 AI 请求正在处理');
    await tx.deepSeekRequestLease.create({
      data: { id, siteId: ctx.siteId, actorId, expiresAt: new Date(now.getTime() + 90000) },
    });
  });
  return id;
}
export async function configuredDeepSeek(ctx: RequestContext) {
  const setting = await ctx.prisma.deepSeekSetting.findUnique({ where: { id: 'singleton' } });
  if (!setting?.enabled || !setting.keyCiphertext)
    throw new HttpError(503, 'deepseek_not_configured', '请先在后台配置并启用 AI 服务');
  let connection;
  try {
    connection = normalizedAiConnection(setting, ctx.aiNetworkPolicy);
  } catch (error) {
    return deepSeekProviderError(error);
  }
  let apiKey: string;
  try {
    apiKey = decryptDeepSeekKey(ctx.fleetSecret, ctx, setting.keyCiphertext);
  } catch {
    throw new HttpError(503, 'deepseek_key_unreadable', '本站密钥无法解密，请重新配置 AI 密钥');
  }
  validateAiKeyDestination(apiKey, connection, ctx.aiNetworkPolicy);
  return { setting, apiKey, ...connection };
}
export async function callDeepSeek(
  ctx: RequestContext,
  actorId: string,
  config: Awaited<ReturnType<typeof configuredDeepSeek>>,
  messages: Parameters<DeepSeekTransport>[0]['messages'],
  maxTokens: number,
  options: { transport?: DeepSeekTransport; assessment?: boolean } = {},
) {
  const lease = await acquireRequest(ctx, actorId);
  const assertCurrentConfiguration = async () => {
    const latest = await ctx.prisma.deepSeekSetting.findUnique({ where: { id: 'singleton' } });
    if (
      !latest?.enabled ||
      (options.assessment && !latest.assessmentEnabled) ||
      JSON.stringify(aiConfigurationFingerprint(latest)) !==
        JSON.stringify(aiConfigurationFingerprint(config.setting))
    )
      throw new HttpError(
        409,
        'deepseek_configuration_changed',
        '配置已改变，本次请求已取消，请重新确认',
      );
  };
  try {
    await assertCurrentConfiguration();
    const input = {
      apiKey: config.apiKey,
      model: config.model,
      provider: config.provider,
      baseUrl: config.baseUrl,
      protocol: config.protocol,
      authMode: config.authMode,
      messages,
      maxTokens,
    };
    const result = options.transport
      ? await options.transport(input)
      : config.provider === 'custom'
        ? await requestCompatibleAi(input, { policy: ctx.aiNetworkPolicy })
        : await requestDeepSeek(input);
    if (result.content.includes(config.apiKey))
      throw new DeepSeekProviderError(502, 'deepseek_response_invalid');
    await assertCurrentConfiguration();
    return result;
  } catch (error) {
    return deepSeekProviderError(error);
  } finally {
    await ctx.prisma.deepSeekRequestLease.deleteMany({
      where: { id: lease, siteId: ctx.siteId, actorId },
    });
  }
}
