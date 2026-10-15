import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { SiteAppearance } from '@prisma/client';
import sharp from 'sharp';
import { z } from 'zod';
import { HttpError, requireAdmin, type ContextResolver } from '../context.js';
import { audit, parse, type Db } from './shared.js';

const appearanceFields = {
  mode: z.enum(['rain-night', 'custom']),
  positionX: z.number().finite().min(0).max(100),
  positionY: z.number().finite().min(0).max(100),
  overlay: z.number().finite().min(0).max(0.85),
  animationEnabled: z.boolean(),
};
const revisionInput = z.object({ expectedRevision: z.number().int().nonnegative() }).strict();
const settingsInput = revisionInput.extend(appearanceFields).strict();
const uploadInput = revisionInput
  .extend({
    fileName: z.string().trim().min(1).max(200),
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    dataBase64: z.string().min(4).max(5_592_408),
  })
  .strict();
const publicSelect = {
  id: true,
  mode: true,
  positionX: true,
  positionY: true,
  overlay: true,
  animationEnabled: true,
  revision: true,
  imageSha256: true,
  updatedAt: true,
} as const;
type Appearance = Omit<SiteAppearance, 'imageBytes'>;
const defaults = {
  mode: 'rain-night',
  positionX: 50,
  positionY: 50,
  overlay: 0.4,
  animationEnabled: true,
  revision: 0,
  imageSha256: null,
};
function dto(value: Appearance | null, basePath: string) {
  const settings = value ?? defaults;
  return {
    appearance: {
      mode: settings.mode,
      imageUrl: settings.imageSha256
        ? `${basePath}/api/v2/appearance/wallpaper/${settings.imageSha256}.webp`
        : null,
      positionX: settings.positionX,
      positionY: settings.positionY,
      overlay: settings.overlay,
      animationEnabled: settings.animationEnabled,
      revision: settings.revision,
    },
  };
}
async function write(db: Db, expectedRevision: number, data: Partial<SiteAppearance>) {
  await db.siteAppearance.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: {},
  });
  const updated = await db.siteAppearance.updateMany({
    where: { id: 'singleton', revision: expectedRevision },
    data: { ...data, revision: { increment: 1 } },
  });
  if (updated.count !== 1)
    throw new HttpError(409, 'appearance_conflict', '壁纸设置已更新，请重新读取后再保存。');
  return db.siteAppearance.findUniqueOrThrow({ where: { id: 'singleton' }, select: publicSelect });
}

export async function registerAppearance(app: FastifyInstance, getContext: ContextResolver) {
  // A process bound prevents several large image decoders from competing with learning requests.
  let decoding = 0;
  app.get('/appearance', async (req) => {
    const ctx = await getContext(req);
    return dto(
      await ctx.prisma.siteAppearance.findUnique({
        where: { id: 'singleton' },
        select: publicSelect,
      }),
      ctx.basePath,
    );
  });
  app.get('/admin/appearance', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    return dto(
      await ctx.prisma.siteAppearance.findUnique({
        where: { id: 'singleton' },
        select: publicSelect,
      }),
      ctx.basePath,
    );
  });
  app.put('/admin/appearance', async (req) => {
    const ctx = await getContext(req),
      admin = requireAdmin(ctx);
    const { expectedRevision, ...settings } = parse(settingsInput, req.body);
    const saved = await ctx.prisma.$transaction(async (tx) => {
      if (settings.mode === 'custom') {
        const current = await tx.siteAppearance.findUnique({
          where: { id: 'singleton' },
          select: { imageSha256: true },
        });
        if (!current?.imageSha256)
          throw new HttpError(400, 'wallpaper_required', '请先上传一张壁纸。');
      }
      const result = await write(tx, expectedRevision, settings);
      await audit(tx, admin.id, 'appearance.update', ctx.siteId, { revision: result.revision });
      return result;
    });
    return dto(saved, ctx.basePath);
  });
  app.post('/admin/appearance/wallpaper', { bodyLimit: 5_650_000 }, async (req) => {
    const ctx = await getContext(req),
      admin = requireAdmin(ctx);
    const input = parse(uploadInput, req.body);
    // Repeated grouped regexes overflow V8's regex stack on otherwise valid
    // multi-megabyte base64. These scans stay linear with no recursive groups.
    const encodedText = input.dataBase64;
    const padding = encodedText.endsWith('==') ? 2 : encodedText.endsWith('=') ? 1 : 0;
    if (
      encodedText.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/.test(encodedText) ||
      encodedText.slice(0, encodedText.length - padding).includes('=')
    )
      throw new HttpError(400, 'wallpaper_invalid', '图片格式无法读取。');
    if ((encodedText.length / 4) * 3 - padding > 4 * 1024 * 1024)
      throw new HttpError(413, 'wallpaper_too_large', '壁纸最大为4 MB。');
    const bytes = Buffer.from(encodedText, 'base64');
    if (decoding >= 2) throw new HttpError(429, 'wallpaper_busy', '正在处理壁纸，请稍后重试。');
    decoding++;
    let encoded: Buffer;
    try {
      const image = sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'warning' });
      const metadata = await image.metadata();
      const expected = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }[
        input.contentType
      ];
      if (metadata.format !== expected || (metadata.pages ?? 1) > 1)
        throw new Error('unsupported_image');
      encoded = await image
        .rotate()
        .resize({ width: 1920, height: 2560, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      if (encoded.length > 1_500_000) throw new Error('encoded_image_too_large');
    } catch {
      throw new HttpError(400, 'wallpaper_invalid', '请使用有效的静态 JPG、PNG 或 WebP 图片。');
    } finally {
      decoding--;
    }
    const imageSha256 = createHash('sha256').update(encoded).digest('hex');
    const saved = await ctx.prisma.$transaction(async (tx) => {
      const result = await write(tx, input.expectedRevision, {
        mode: 'custom',
        imageBytes: new Uint8Array(encoded),
        imageSha256,
      });
      await audit(tx, admin.id, 'appearance.wallpaper.upload', ctx.siteId, {
        revision: result.revision,
        imageSha256,
        bytes: encoded.length,
      });
      return result;
    });
    return dto(saved, ctx.basePath);
  });
  app.post('/admin/appearance/reset', async (req) => {
    const ctx = await getContext(req),
      admin = requireAdmin(ctx);
    const { expectedRevision } = parse(revisionInput, req.body);
    const saved = await ctx.prisma.$transaction(async (tx) => {
      const { revision: _revision, ...settings } = defaults;
      const result = await write(tx, expectedRevision, { ...settings, imageBytes: null });
      await audit(tx, admin.id, 'appearance.reset', ctx.siteId, { revision: result.revision });
      return result;
    });
    return dto(saved, ctx.basePath);
  });
  app.get('/appearance/wallpaper/:file', async (req, reply) => {
    const ctx = await getContext(req);
    const { file } = parse(
      z.object({ file: z.string().regex(/^[a-f0-9]{64}\.webp$/) }),
      req.params,
    );
    const current = await ctx.prisma.siteAppearance.findUnique({
      where: { id: 'singleton', imageSha256: file.slice(0, 64) },
      select: { imageBytes: true, imageSha256: true },
    });
    if (!current?.imageBytes) throw new HttpError(404, 'wallpaper_not_found', '壁纸已更新。');
    const etag = `"${current.imageSha256}"`;
    reply
      .type('image/webp')
      .header('ETag', etag)
      .header('Cache-Control', 'public, max-age=86400, immutable');
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.send(Buffer.from(current.imageBytes));
  });
}
