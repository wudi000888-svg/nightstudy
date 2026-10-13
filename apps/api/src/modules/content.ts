import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { HttpError, requireUser, requireAdmin, type ContextResolver } from '../context.js';
import {
  parse,
  id,
  goal,
  settings,
  wordInclude,
  wordDto,
  progressDto,
  normalize,
  obj,
  transact,
  audit,
} from './shared.js';

export async function registerContent(app: FastifyInstance, getContext: ContextResolver) {
  app.get('/books', async (req) => {
    const ctx = await getContext(req);
    const books = await ctx.prisma.book.findMany({
      where: { status: 'published' },
      include: { items: { select: { wordId: true } } },
      orderBy: { title: 'asc' },
    });
    const progress = ctx.user
      ? await ctx.prisma.studyProgress.findMany({
          where: { userId: ctx.user.id, firstLearnedAt: { not: null } },
          select: { wordId: true },
        })
      : [];
    const claims = ctx.user
      ? await ctx.prisma.knownClaim.findMany({
          where: { userId: ctx.user.id, import: { status: 'confirmed' } },
          select: { wordId: true },
        })
      : [];
    const profiles = ctx.user
      ? await ctx.prisma.masteryProfile.findMany({ where: { userId: ctx.user.id } })
      : [];
    const learned = new Set(progress.map((x) => x.wordId)),
      known = new Set(claims.map((x) => x.wordId));
    const verified = new Set(
      profiles.flatMap((p) =>
        Array.isArray(obj(p.evidenceJson).verifiedWordIds)
          ? (obj(p.evidenceJson).verifiedWordIds as string[])
          : [],
      ),
    );
    return {
      items: books.map((b) => ({
        id: b.id,
        slug: b.slug,
        title: b.title,
        description: b.description,
        goal: b.goal,
        version: b.version,
        wordCount: b.items.length,
        learnedCount: b.items.filter((x) => learned.has(x.wordId)).length,
        coveredCount: b.items.filter((x) => learned.has(x.wordId) || verified.has(x.wordId)).length,
        claimedKnownCount: b.items.filter((x) => known.has(x.wordId)).length,
        isDemo: b.version.startsWith('demo-'),
      })),
    };
  });
  app.get('/books/:id', async (req) => {
    const ctx = await getContext(req),
      params = parse(z.object({ id }), req.params);
    const book = await ctx.prisma.book.findFirst({
      where: { id: params.id, status: 'published' },
      include: {
        items: {
          include: { word: { include: wordInclude } },
          orderBy: { ordinal: 'asc' },
          take: 500,
        },
      },
    });
    if (!book) throw new HttpError(404, 'book_not_found');
    return {
      book: {
        id: book.id,
        title: book.title,
        goal: book.goal,
        description: book.description,
        version: book.version,
      },
      items: book.items.map((i) => wordDto(i.word)),
    };
  });
  app.post('/books/:id/select', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    const book = await ctx.prisma.book.findFirst({ where: { id: params.id, status: 'published' } });
    if (!book) throw new HttpError(404, 'book_not_found');
    const value = await ctx.prisma.userSettings.upsert({
      where: { userId: user.id },
      create: { userId: user.id, currentBookId: book.id, goal: book.goal },
      update: { currentBookId: book.id, goal: book.goal, revision: { increment: 1 } },
    });
    return { settings: value };
  });
  app.get('/dictionary', async (req) => {
    const ctx = await getContext(req),
      query = parse(
        z.object({
          q: z.string().max(160).default(''),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
        req.query,
      );
    const term = normalize(query.q);
    if (!term) return { items: [], source: 'original-demo', completeDictionary: false };
    const words = await ctx.prisma.word.findMany({
      where: { status: 'published', normalizedLemma: { startsWith: term } },
      include: wordInclude,
      orderBy: { normalizedLemma: 'asc' },
      take: query.limit,
    });
    words.sort((a, b) => Number(b.normalizedLemma === term) - Number(a.normalizedLemma === term));
    return { items: words.map(wordDto), source: 'original-demo', completeDictionary: false };
  });
  app.get('/words/:id', async (req) => {
    const ctx = await getContext(req),
      params = parse(z.object({ id }), req.params);
    const word = await ctx.prisma.word.findFirst({
      where: { id: params.id, status: 'published' },
      include: wordInclude,
    });
    if (!word) throw new HttpError(404, 'word_not_found');
    return { word: wordDto(word) };
  });
  app.get('/me/settings', async (req) => {
    const ctx = await getContext(req);
    return { settings: await settings(ctx.prisma, requireUser(ctx).id) };
  });
  app.patch('/me/profile', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      input = parse(z.object({ name: z.string().trim().min(1).max(80) }).strict(), req.body);
    return {
      user: await ctx.prisma.user.update({
        where: { id: user.id },
        data: input,
        select: { id: true, name: true, email: true, role: true },
      }),
    };
  });
  app.patch('/me/settings', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    const input = parse(
      z
        .object({
          goal: goal.optional(),
          currentBookId: id.nullable().optional(),
          dailyNewLimit: z.number().int().min(1).max(100).optional(),
          groupSize: z.number().int().min(1).max(20).optional(),
          timeZone: z.string().max(80).optional(),
          expectedRevision: z.number().int().nonnegative().optional(),
        })
        .strict(),
      req.body,
    );
    if (input.timeZone) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: input.timeZone });
      } catch {
        throw new HttpError(400, 'invalid_timezone');
      }
    }
    if (
      input.currentBookId &&
      !(await ctx.prisma.book.findFirst({
        where: { id: input.currentBookId, status: 'published' },
      }))
    )
      throw new HttpError(404, 'book_not_found');
    const { expectedRevision, ...data } = input;
    return transact(ctx.prisma, async (tx) => {
      const current = await settings(tx, user.id);
      if (expectedRevision !== undefined && expectedRevision !== current.revision)
        throw new HttpError(409, 'settings_conflict', '设置已被更新', { settings: current });
      return {
        settings: await tx.userSettings.update({
          where: { userId: user.id },
          data: { ...data, revision: { increment: 1 } },
        }),
      };
    });
  });
  app.get('/wordbook', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    const rows = await ctx.prisma.userWord.findMany({
      where: { userId: user.id },
      include: { word: { include: wordInclude } },
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });
    const progress = await ctx.prisma.studyProgress.findMany({
      where: { userId: user.id, wordId: { in: rows.map((x) => x.wordId) } },
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        wordId: row.wordId,
        word: wordDto(row.word),
        note: row.note,
        favorite: row.favorite,
        paused: row.paused,
        progress: progressDto(progress.find((x) => x.wordId === row.wordId) ?? null),
      })),
    };
  });
  app.post('/wordbook', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      input = parse(
        z.object({ wordId: id, note: z.string().max(4000).optional() }).strict(),
        req.body,
      );
    if (!(await ctx.prisma.word.findFirst({ where: { id: input.wordId, status: 'published' } })))
      throw new HttpError(404, 'word_not_found');
    const item = await ctx.prisma.userWord.upsert({
      where: { userId_wordId: { userId: user.id, wordId: input.wordId } },
      create: { userId: user.id, wordId: input.wordId, note: input.note ?? '' },
      update: { favorite: true, ...(input.note !== undefined ? { note: input.note } : {}) },
    });
    return { item };
  });
  app.patch('/wordbook/:wordId', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ wordId: id }), req.params);
    const input = parse(
      z
        .object({
          note: z.string().max(4000).optional(),
          favorite: z.boolean().optional(),
          paused: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    const existing = await ctx.prisma.userWord.findUnique({
      where: { userId_wordId: { userId: user.id, wordId: params.wordId } },
    });
    if (!existing) throw new HttpError(404, 'wordbook_item_not_found');
    return { item: await ctx.prisma.userWord.update({ where: { id: existing.id }, data: input }) };
  });
  app.delete('/wordbook/:wordId', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ wordId: id }), req.params);
    await ctx.prisma.userWord.deleteMany({ where: { userId: user.id, wordId: params.wordId } });
    return { deleted: true, progressRetained: true };
  });
  app.get('/announcements', async (req) => {
    const ctx = await getContext(req);
    return {
      items: await ctx.prisma.announcement.findMany({
        where: { status: 'published' },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    };
  });

  app.get('/admin/overview', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    const [users, words, books, reviews, imports] = await Promise.all([
      ctx.prisma.user.count(),
      ctx.prisma.word.count(),
      ctx.prisma.book.count(),
      ctx.prisma.reviewLog.count(),
      ctx.prisma.knownImport.count(),
    ]);
    return { users, words, books, reviews, imports };
  });
  app.get('/admin/users', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    return {
      items: await ctx.prisma.user.findMany({
        select: { id: true, name: true, email: true, role: true, disabled: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    };
  });
  app.patch('/admin/users/:id', async (req) => {
    const ctx = await getContext(req),
      actor = requireAdmin(ctx),
      params = parse(z.object({ id }), req.params);
    const input = parse(z.object({ disabled: z.boolean() }).strict(), req.body);
    return transact(ctx.prisma, async (tx) => {
      const target = await tx.user.findUnique({ where: { id: params.id } });
      if (!target) throw new HttpError(404, 'user_not_found');
      if (
        input.disabled &&
        target.role === 'admin' &&
        (await tx.user.count({ where: { role: 'admin', disabled: false } })) <= 1
      )
        throw new HttpError(409, 'last_admin_protected');
      const user = await tx.user.update({
        where: { id: target.id },
        data: { disabled: input.disabled },
        select: { id: true, name: true, email: true, role: true, disabled: true },
      });
      if (input.disabled) await tx.session.deleteMany({ where: { userId: target.id } });
      await audit(tx, actor.id, input.disabled ? 'user.disable' : 'user.enable', target.id, {
        disabled: input.disabled,
      });
      return { user };
    });
  });
  app.get('/admin/books', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    return { items: await ctx.prisma.book.findMany({ orderBy: { title: 'asc' } }) };
  });
  app.post('/admin/books', async (req) => {
    const ctx = await getContext(req),
      actor = requireAdmin(ctx);
    const input = parse(
      z
        .object({
          slug: z.string().regex(/^[a-z0-9-]{2,80}$/),
          title: z.string().trim().min(1).max(160),
          description: z.string().max(4000).default(''),
          goal,
          wordIds: z.array(id).min(1).max(500),
          status: z.enum(['published', 'draft']).default('draft'),
        })
        .strict(),
      req.body,
    );
    return transact(ctx.prisma, async (tx) => {
      if (new Set(input.wordIds).size !== input.wordIds.length)
        throw new HttpError(400, 'duplicate_book_words');
      if (await tx.book.findUnique({ where: { slug: input.slug } }))
        throw new HttpError(409, 'book_slug_exists');
      const words = await tx.word.findMany({
        where: { id: { in: input.wordIds }, status: 'published' },
        include: wordInclude,
      });
      if (words.length !== input.wordIds.length) throw new HttpError(400, 'unavailable_book_word');
      const book = await tx.book.create({
        data: {
          id: `book-${crypto.randomUUID()}`,
          slug: input.slug,
          title: input.title,
          description: input.description,
          goal: input.goal,
          status: input.status,
          version: `authored-${Date.now()}`,
          items: {
            create: input.wordIds.map((wordId, ordinal) => ({
              wordId,
              ordinal,
              focusSenseId: words.find((w) => w.id === wordId)?.senses[0]?.id ?? null,
            })),
          },
        },
      });
      await audit(tx, actor.id, 'book.create', book.id, {
        title: book.title,
        wordCount: words.length,
      });
      return { book };
    });
  });
  app.patch('/admin/books/:id', async (req) => {
    const ctx = await getContext(req),
      actor = requireAdmin(ctx),
      params = parse(z.object({ id }), req.params);
    const input = parse(
      z
        .object({
          title: z.string().trim().min(1).max(160).optional(),
          description: z.string().max(4000).optional(),
          goal: goal.optional(),
          status: z.enum(['published', 'draft', 'archived']).optional(),
          wordIds: z.array(id).min(1).max(500).optional(),
        })
        .strict(),
      req.body,
    );
    return transact(ctx.prisma, async (tx) => {
      if (!(await tx.book.findUnique({ where: { id: params.id } })))
        throw new HttpError(404, 'book_not_found');
      const { wordIds, ...data } = input;
      if (wordIds) {
        if (new Set(wordIds).size !== wordIds.length)
          throw new HttpError(400, 'duplicate_book_words');
        const words = await tx.word.findMany({
          where: { id: { in: wordIds }, status: 'published' },
          include: wordInclude,
        });
        if (words.length !== wordIds.length) throw new HttpError(400, 'unavailable_book_word');
        await tx.bookItem.deleteMany({ where: { bookId: params.id } });
        await tx.bookItem.createMany({
          data: wordIds.map((wordId, ordinal) => ({
            bookId: params.id,
            wordId,
            ordinal,
            focusSenseId: words.find((w) => w.id === wordId)?.senses[0]?.id ?? null,
          })),
        });
      }
      const book = await tx.book.update({
        where: { id: params.id },
        data: { ...data, version: `authored-${Date.now()}` },
      });
      await audit(tx, actor.id, 'book.edit', book.id, input);
      return { book, existingSessionsRetainSnapshots: true };
    });
  });
  app.get('/admin/words', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    const query = parse(z.object({ q: z.string().max(160).default('') }), req.query);
    return {
      items: (
        await ctx.prisma.word.findMany({
          where: { normalizedLemma: { contains: normalize(query.q) } },
          include: wordInclude,
          take: 100,
          orderBy: { normalizedLemma: 'asc' },
        })
      ).map(wordDto),
    };
  });
  app.patch('/admin/words/:id', async (req) => {
    const ctx = await getContext(req),
      actor = requireAdmin(ctx),
      params = parse(z.object({ id }), req.params);
    const input = parse(
      z
        .object({
          status: z.enum(['published', 'archived']).optional(),
          senseId: id.optional(),
          definitionZh: z.string().min(1).max(4000).optional(),
          definitionEn: z.string().max(4000).optional(),
          exampleEn: z.string().max(2000).optional(),
          exampleZh: z.string().max(2000).optional(),
        })
        .strict(),
      req.body,
    );
    return transact(ctx.prisma, async (tx) => {
      const word = await tx.word.findUnique({ where: { id: params.id }, include: wordInclude });
      if (!word) throw new HttpError(404, 'word_not_found');
      const { status, senseId, ...senseData } = input;
      if (Object.keys(senseData).length) {
        const sense = word.senses.find((x) => x.id === (senseId ?? word.senses[0]?.id));
        if (!sense) throw new HttpError(400, 'sense_not_in_word');
        await tx.sense.update({ where: { id: sense.id }, data: senseData });
      }
      const updated = await tx.word.update({
        where: { id: word.id },
        data: { ...(status ? { status } : {}), contentVersion: `edit-${Date.now()}` },
        include: wordInclude,
      });
      await audit(tx, actor.id, 'content.word.edit', word.id, input);
      return { word: wordDto(updated) };
    });
  });
  app.get('/admin/announcements', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    return {
      items: await ctx.prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
    };
  });
  app.post('/admin/announcements', async (req) => {
    const ctx = await getContext(req),
      actor = requireAdmin(ctx),
      input = parse(
        z
          .object({
            title: z.string().min(1).max(160),
            body: z.string().min(1).max(4000),
            status: z.enum(['published', 'draft']).default('published'),
          })
          .strict(),
        req.body,
      );
    return transact(ctx.prisma, async (tx) => {
      const announcement = await tx.announcement.create({ data: input });
      await audit(tx, actor.id, 'announcement.create', announcement.id, { title: input.title });
      return { announcement };
    });
  });
  app.delete('/admin/announcements/:id', async (req) => {
    const ctx = await getContext(req),
      actor = requireAdmin(ctx),
      params = parse(z.object({ id }), req.params);
    return transact(ctx.prisma, async (tx) => {
      await tx.announcement.deleteMany({ where: { id: params.id } });
      await audit(tx, actor.id, 'announcement.delete', params.id, {});
      return { deleted: true };
    });
  });
  app.get('/admin/audit', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    return {
      items: await ctx.prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
    };
  });
}
