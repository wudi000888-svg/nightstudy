import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireAdmin, type ContextResolver, type RequestContext } from '../context.js';
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODELS,
  type DeepSeekTransport,
} from '../providers/deepseek.js';
import { encryptDeepSeekKey, deepSeekKeyPreview, validDeepSeekKey } from './deepseek-crypto.js';
import {
  DEEPSEEK_PROMPT_VERSION,
  planMissingContent,
  previewMessages,
  sourceBoundPreview,
} from './deepseek-preview.js';
import { configuredDeepSeek, callDeepSeek } from './deepseek-service.js';

const settingsInput = z
  .object({
    enabled: z.boolean().optional(),
    assessmentEnabled: z.boolean().optional(),
    model: z.enum(DEEPSEEK_MODELS).optional(),
    baseUrl: z.literal(DEEPSEEK_BASE_URL).optional(),
    apiKey: z
      .string()
      .trim()
      .max(256)
      .refine((value) => value === '' || validDeepSeekKey(value), '密钥格式无效')
      .optional(),
    removeKey: z.boolean().optional(),
  })
  .strict()
  .refine((v) => !(v.removeKey && v.apiKey), '删除密钥时不能同时提交新密钥');
type Setting = {
  enabled: boolean;
  assessmentEnabled: boolean;
  model: string;
  keyCiphertext: string | null;
  keyPreview: string | null;
  updatedAt: Date;
};
function settingDto(setting: Setting | null) {
  return {
    enabled: setting?.enabled ?? false,
    assessmentEnabled: setting?.assessmentEnabled ?? false,
    configured: Boolean(setting?.keyCiphertext),
    model: setting?.model ?? DEEPSEEK_MODELS[0],
    models: [...DEEPSEEK_MODELS],
    baseUrl: DEEPSEEK_BASE_URL,
    keyPreview: setting?.keyCiphertext ? setting.keyPreview : null,
    updatedAt: setting?.updatedAt.toISOString() ?? null,
  };
}
export async function registerDeepSeek(
  app: FastifyInstance,
  getContext: ContextResolver,
  options: { transport?: DeepSeekTransport } = {},
) {
  const transport = options.transport;
  const loadWord = (ctx: RequestContext, wordId: string) =>
    ctx.prisma.word.findFirst({
      where: { id: wordId, status: 'published' },
      include: {
        senses: { orderBy: [{ ordinal: 'asc' }, { id: 'asc' }], take: 65 },
        examples: { where: { NOT: [{ exampleEn: '' }, { exampleZh: '' }] }, take: 1 },
      },
    });
  app.get('/admin/ai/deepseek', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    return settingDto(await ctx.prisma.deepSeekSetting.findUnique({ where: { id: 'singleton' } }));
  });
  app.put('/admin/ai/deepseek', async (req) => {
    const ctx = await getContext(req),
      actor = requireAdmin(ctx),
      input = settingsInput.parse(req.body);
    const setting = await ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(89124802)`;
      const previous = await tx.deepSeekSetting.findUnique({ where: { id: 'singleton' } });
      const keyCiphertext = input.removeKey
        ? null
        : input.apiKey
          ? encryptDeepSeekKey(ctx.fleetSecret, ctx, input.apiKey)
          : (previous?.keyCiphertext ?? null);
      const keyPreview = input.removeKey
        ? null
        : input.apiKey
          ? deepSeekKeyPreview(input.apiKey)
          : (previous?.keyPreview ?? null);
      const enabled = input.removeKey ? false : (input.enabled ?? previous?.enabled ?? false);
      if (enabled && !keyCiphertext)
        throw new HttpError(400, 'deepseek_key_required', '启用前请先保存 DeepSeek 密钥');
      const assessmentEnabled =
        enabled && !input.removeKey
          ? (input.assessmentEnabled ?? previous?.assessmentEnabled ?? false)
          : false;
      const data = {
        enabled,
        assessmentEnabled,
        model: input.model ?? previous?.model ?? DEEPSEEK_MODELS[0],
        keyCiphertext,
        keyPreview,
      };
      const saved = await tx.deepSeekSetting.upsert({
        where: { id: 'singleton' },
        create: { id: 'singleton', ...data },
        update: data,
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: actor.id,
          action: 'ai.deepseek.configure',
          targetId: ctx.siteId,
          detail: {
            enabled,
            assessmentEnabled,
            model: data.model,
            keyChanged: Boolean(input.apiKey),
            keyRemoved: input.removeKey ?? false,
          },
        },
      });
      return saved;
    });
    return settingDto(setting);
  });
  const call = (
    ctx: RequestContext,
    actorId: string,
    config: Awaited<ReturnType<typeof configuredDeepSeek>>,
    messages: Parameters<DeepSeekTransport>[0]['messages'],
    maxTokens: number,
  ) => callDeepSeek(ctx, actorId, config, messages, maxTokens, { transport });
  app.post('/admin/ai/deepseek/test', async (req) => {
    const ctx = await getContext(req),
      actor = requireAdmin(ctx);
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const config = await configuredDeepSeek(ctx);
    const result = await call(
      ctx,
      actor.id,
      config,
      [
        { role: 'system', content: 'Return only valid JSON: {"ok":true}.' },
        { role: 'user', content: 'Connection check. Return {"ok":true} in JSON.' },
      ],
      32,
    );
    requireAdmin(await getContext(req));
    try {
      z.object({ ok: z.literal(true) })
        .strict()
        .parse(JSON.parse(result.content));
    } catch {
      throw new HttpError(502, 'deepseek_response_invalid', 'DeepSeek 返回内容未通过连接测试校验');
    }
    return { ok: true, provider: 'deepseek', model: result.model, usage: result.usage };
  });
  app.post('/admin/ai/deepseek/preview', async (req) => {
    const ctx = await getContext(req),
      actor = requireAdmin(ctx);
    const { wordId } = z
      .object({ wordId: z.string().min(1).max(128) })
      .strict()
      .parse(req.body);
    const word = await loadWord(ctx, wordId);
    if (!word) throw new HttpError(404, 'word_not_found', '词条不存在');
    if (word.senses.length > 64)
      throw new HttpError(422, 'deepseek_source_too_large', '义项过多，请先在后台分项整理');
    const plan = planMissingContent(word);
    if (!plan.definitions.length && !plan.exampleSource)
      return {
        preview: {
          wordId: word.id,
          lemma: word.lemma,
          definitions: [],
          examples: [],
          review: 'pending',
          applied: false,
          reason: 'no_missing_content',
        },
        usage: null,
      };
    const config = await configuredDeepSeek(ctx);
    const result = await call(ctx, actor.id, config, previewMessages(plan), 2400);
    requireAdmin(await getContext(req));
    const refreshed = await loadWord(ctx, wordId);
    let unchanged = false;
    try {
      unchanged = Boolean(
        refreshed &&
        refreshed.senses.length <= 64 &&
        JSON.stringify(planMissingContent(refreshed)) === JSON.stringify(plan),
      );
    } catch {
      /* Changed source quality/size is also a stale preview. */
    }
    if (!unchanged)
      throw new HttpError(
        409,
        'deepseek_content_changed',
        '词条内容已改变，本次候选已丢弃，请重新读取词条',
      );
    const candidate = sourceBoundPreview(plan, result.content);
    const generatedAt = new Date().toISOString();
    const metadata = (
      source: { sourceSenseId: string; sourceLanguage: string; sourceTextSha256: string },
      kind: 'machine-translation' | 'generated',
      targetLanguage: 'en' | 'zh',
    ) => ({
      kind,
      review: 'pending',
      provider: 'deepseek',
      model: config.model,
      promptVersion: DEEPSEEK_PROMPT_VERSION,
      sourceSenseId: source.sourceSenseId,
      sourceLanguage: source.sourceLanguage,
      targetLanguage,
      sourceTextSha256: source.sourceTextSha256,
      generatedAt,
    });
    return {
      preview: {
        wordId: candidate.wordId,
        lemma: candidate.lemma,
        definitions: candidate.definitions.map((value) => ({
          ...value,
          contentMetadata: metadata(
            plan.definitions.find(
              (d) => d.sourceSenseId === value.sourceSenseId && d.field === value.field,
            )!,
            'machine-translation',
            value.field === 'definitionEn' ? 'en' : 'zh',
          ),
        })),
        examples: candidate.examples.map((value) => ({
          ...value,
          contentMetadata: {
            exampleEn: metadata(plan.exampleSource!, 'generated', 'en'),
            exampleZh: metadata(plan.exampleSource!, 'generated', 'zh'),
          },
        })),
        review: 'pending',
        applied: false,
      },
      usage: result.usage,
    };
  });
}
