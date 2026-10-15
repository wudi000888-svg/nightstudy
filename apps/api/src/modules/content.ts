import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { Prisma, type ContentPack } from '@prisma/client';
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
  json,
  transact,
  audit,
  type Db,
  type WordWithSenses,
} from './shared.js';
import { decodeCursor, pageInfo } from './pagination.js';
import { visibleBookWhere } from './book-access.js';
import { learningPreferencesInput, updateLearningPreferences } from './learning-preferences.js';
import { summarySenses } from './content-presentation.js';
import { collectionState } from './collection-state.js';
import { lockLearningPreferences } from './tasks.js';

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().max(1200).optional(),
});
async function readyPacks(db: Db) {
  return db.contentPack.findMany({ where: { status: 'ready' }, orderBy: { installedAt: 'desc' } });
}
function packDto(pack: ContentPack) {
  return {
    id: pack.id,
    version: pack.version,
    sourceUrl: pack.sourceUrl,
    sha256: pack.sha256,
    license: pack.license,
    entryCount: pack.entryCount,
    phoneticCount: pack.phoneticCount,
    definitionZhCount: pack.definitionZhCount,
    definitionEnCount: pack.definitionEnCount,
    tagCounts: pack.tagCounts,
    installedAt: pack.installedAt.toISOString(),
  };
}
export function catalogWordDto(
  word: WordWithSenses,
  packs: ContentPack[] = [],
  summary = false,
  includeHeldSources = false,
) {
  const dto = wordDto(word, includeHeldSources);
  const sourcePack = packs.find((pack) => word.sourceRef === `pack:${pack.id}`);
  const wordHasSiteEdits = /^(?:edit|authored)-/.test(word.contentVersion);
  const dictionaryPack = packs.find((pack) => pack.id.startsWith('ecdict-'));
  const senses = dto.senses.map((sense) => {
    const dictionary = sense.id.startsWith('content-ecdict-');
    const originalDemo = /^demo-word-\d+-sense-/.test(sense.id);
    const pack = dictionary ? dictionaryPack : sourcePack;
    const source = {
      kind: dictionary
        ? 'dictionary'
        : originalDemo
          ? 'original-demo'
          : wordHasSiteEdits
            ? 'site-authored'
            : 'unknown',
      reference: dictionary
        ? `pack:${pack?.id ?? 'ecdict'}`
        : originalDemo
          ? 'NightStudy original demo'
          : word.sourceRef,
      packId: pack?.id ?? null,
      license: dictionary
        ? (pack?.license ?? null)
        : originalDemo
          ? 'MIT'
          : (pack?.license ?? null),
      sourceUrl: pack?.sourceUrl ?? null,
      wordHasSiteEdits,
      siteEditVersion: wordHasSiteEdits ? word.contentVersion : null,
    };
    return {
      ...sense,
      source,
      exampleSource:
        !sense.exampleEn && !sense.exampleZh
          ? null
          : Object.keys(obj(sense.contentMetadata.exampleEn)).length ||
              Object.keys(obj(sense.contentMetadata.exampleZh)).length
            ? null
            : dictionary
              ? {
                  kind: 'site-authored',
                  reference: 'Site-authored example',
                  packId: null,
                  license: null,
                  sourceUrl: null,
                  wordHasSiteEdits,
                  siteEditVersion: wordHasSiteEdits ? word.contentVersion : null,
                }
              : source,
    };
  });
  const sources = packs.filter(
    (pack) =>
      pack === sourcePack ||
      (pack.id.startsWith('ecdict-') &&
        word.senses.some((sense) => sense.id.startsWith('content-ecdict-'))) ||
      word.phoneticSource.includes(pack.id) ||
      word.senses.some((sense) => obj(sense.contentMetadata).packId === pack.id) ||
      (word.examples ?? []).some((example) => obj(example.contentMetadata).packId === pack.id),
  );
  return {
    ...dto,
    senses: summary ? summarySenses(senses) : senses,
    senseCount: dto.senseCount,
    detailAvailable: true,
    phonetics: [
      ...(word.phoneticUs
        ? [
            {
              text: word.phoneticUs,
              ipa: word.phoneticUs,
              region: 'US',
              notation: 'ipa',
              sourceRef: word.phoneticSource,
            },
          ]
        : []),
      ...(word.phoneticUk
        ? [
            {
              text: word.phoneticUk,
              ipa: word.phoneticUk,
              region: 'UK',
              notation: 'ipa',
              sourceRef: word.phoneticSource,
            },
          ]
        : []),
      ...(word.phonetic
        ? [
            {
              text: word.phonetic,
              ipa: word.phonetic,
              region: 'unspecified',
              notation: 'source-transcription',
              sourceRef: word.sourceRef,
            },
          ]
        : []),
    ],
    source: {
      reference: word.sourceRef,
      packId: sourcePack?.id ?? null,
      license:
        sourcePack?.license ?? (word.sourceRef === 'NightStudy original demo' ? 'MIT' : null),
      sourceUrl: sourcePack?.sourceUrl ?? null,
      wordHasSiteEdits,
    },
    sources: sources.map(packDto),
  };
}

export async function registerContent(app: FastifyInstance, getContext: ContextResolver) {
  app.get('/books', async (req) => {
    const ctx = await getContext(req);
    const books = await ctx.prisma.book.findMany({
      where: visibleBookWhere(ctx.user?.id),
      orderBy: { title: 'asc' },
    });
    const profiles = ctx.user
      ? await ctx.prisma.masteryProfile.findMany({ where: { userId: ctx.user.id } })
      : [];
    const verified = [
      ...new Set(
        profiles.flatMap((p) =>
          Array.isArray(obj(p.evidenceJson).verifiedWordIds)
            ? (obj(p.evidenceJson).verifiedWordIds as string[])
            : [],
        ),
      ),
    ];
    const baseWhere: Prisma.BookItemWhereInput = {
      bookId: { in: books.map((book) => book.id) },
      word: { status: 'published' },
    };
    const counts = (where: Prisma.BookItemWhereInput) =>
      ctx.prisma.bookItem.groupBy({ by: ['bookId'], where, _count: { _all: true } });
    const [totals, learned, covered, known] = await Promise.all([
      counts(baseWhere),
      ctx.user
        ? counts({
            ...baseWhere,
            word: {
              status: 'published',
              progress: { some: { userId: ctx.user.id, firstLearnedAt: { not: null } } },
            },
          })
        : [],
      ctx.user
        ? counts({
            ...baseWhere,
            OR: [
              {
                word: {
                  progress: { some: { userId: ctx.user.id, firstLearnedAt: { not: null } } },
                },
              },
              { wordId: { in: verified } },
            ],
          })
        : [],
      ctx.user
        ? counts({
            ...baseWhere,
            word: {
              status: 'published',
              OR: [
                { claims: { some: { userId: ctx.user.id, import: { status: 'confirmed' } } } },
                { autoKnownWords: { some: { userId: ctx.user.id, revokedAt: null } } },
              ],
            },
          })
        : [],
    ]);
    const count = (rows: typeof totals, bookId: string) =>
      rows.find((row) => row.bookId === bookId)?._count._all ?? 0;
    return {
      items: books.map((b) => ({
        id: b.id,
        slug: b.slug,
        title: b.title,
        description: b.description,
        goal: b.goal,
        kind: b.kind,
        version: b.version,
        wordCount: count(totals, b.id),
        learnedCount: count(learned, b.id),
        coveredCount: count(covered, b.id),
        claimedKnownCount: count(known, b.id),
        isDemo: b.version.startsWith('demo-'),
        visibility: b.ownerId ? 'private' : 'public',
        ownedByMe: Boolean(ctx.user && b.ownerId === ctx.user.id),
      })),
    };
  });
  app.get('/books/:id', async (req) => {
    const ctx = await getContext(req),
      params = parse(z.object({ id }), req.params);
    const query = parse(pageQuery, req.query);
    const scope = `book:${params.id}`,
      after = decodeCursor(scope, query.cursor, 'number');
    const book = await ctx.prisma.book.findFirst({
      where: { id: params.id, ...visibleBookWhere(ctx.user?.id) },
    });
    if (!book) throw new HttpError(404, 'book_not_found');
    const where: Prisma.BookItemWhereInput = { bookId: book.id, word: { status: 'published' } };
    const [rows, total, packs] = await Promise.all([
      ctx.prisma.bookItem.findMany({
        where: { ...where, ...(after !== null ? { ordinal: { gt: after } } : {}) },
        include: { word: { include: wordInclude } },
        orderBy: { ordinal: 'asc' },
        take: query.limit + 1,
      }),
      ctx.prisma.bookItem.count({ where }),
      readyPacks(ctx.prisma),
    ]);
    const pagination = pageInfo(rows, query.limit, total, scope, (row) => row.ordinal);
    return {
      book: {
        id: book.id,
        title: book.title,
        goal: book.goal,
        kind: book.kind,
        description: book.description,
        version: book.version,
        visibility: book.ownerId ? 'private' : 'public',
        ownedByMe: Boolean(ctx.user && book.ownerId === ctx.user.id),
      },
      items: pagination.items.map((i) => catalogWordDto(i.word, packs, true)),
      page: pagination.page,
    };
  });
  app.post('/books/:id/select', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    const book = await ctx.prisma.book.findFirst({
      where: { id: params.id, ...visibleBookWhere(user.id) },
    });
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
          cursor: z.string().max(1200).optional(),
        }),
        req.query,
      );
    const term = normalize(query.q);
    const scope = `dictionary:${term}`,
      after = decodeCursor(scope, query.cursor, 'string');
    const packs = await readyPacks(ctx.prisma);
    const catalog = {
      source: 'postgres-catalog',
      completeDictionary: packs.some((pack) => pack.id.startsWith('ecdict-')),
      sources: packs.map(packDto),
    };
    if (!term)
      return { items: [], page: { total: 0, hasMore: false, nextCursor: null }, ...catalog };
    const where: Prisma.WordWhereInput = {
      status: 'published',
      normalizedLemma: { startsWith: term },
    };
    const [rows, total] = await Promise.all([
      ctx.prisma.word.findMany({
        where: {
          ...where,
          normalizedLemma: { startsWith: term, ...(after !== null ? { gt: after } : {}) },
        },
        include: wordInclude,
        orderBy: { normalizedLemma: 'asc' },
        take: query.limit + 1,
      }),
      ctx.prisma.word.count({ where }),
    ]);
    const pagination = pageInfo(rows, query.limit, total, scope, (row) => row.normalizedLemma);
    return {
      items: pagination.items.map((word) => catalogWordDto(word, packs, true)),
      page: pagination.page,
      ...catalog,
    };
  });
  app.get('/dictionary/stats', async (req) => {
    const ctx = await getContext(req),
      packs = await readyPacks(ctx.prisma);
    return {
      source: 'postgres-catalog',
      installedDictionary: packs.some((pack) => pack.id.startsWith('ecdict-')),
      countBasis: 'installed-pack-metadata',
      declaredEntryCount: packs
        .filter(
          (pack) =>
            ![
              'phonetics',
              'audio',
              'bilingual',
              'phrase-books',
              'exam-books',
              'sentence-audio',
            ].includes(String(obj(pack.tagCounts).kind)),
        )
        .reduce((sum, pack) => sum + pack.entryCount, 0),
      packs: packs.map(packDto),
    };
  });
  app.get('/dictionary/credits', async (req) => {
    const ctx = await getContext(req);
    const { q } = parse(z.object({ q: z.string().max(160).default('') }), req.query);
    const packs = await readyPacks(ctx.prisma);
    const word = q.trim()
      ? await ctx.prisma.word.findFirst({
          where: { normalizedLemma: normalize(q), status: 'published' },
          include: wordInclude,
        })
      : null;
    return {
      packs: packs.map(packDto),
      word: word ? catalogWordDto(word, packs, false, true) : null,
    };
  });
  app.get('/words/:id', async (req) => {
    const ctx = await getContext(req),
      params = parse(z.object({ id }), req.params);
    const word = await ctx.prisma.word.findFirst({
      where: { id: params.id, status: 'published' },
      include: wordInclude,
    });
    if (!word) throw new HttpError(404, 'word_not_found');
    return { word: catalogWordDto(word, await readyPacks(ctx.prisma)) };
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
    const input = parse(learningPreferencesInput, req.body);
    return transact(ctx.prisma, async (tx) => ({
      settings: await updateLearningPreferences(tx, user.id, input),
    }));
  });
  app.get('/wordbook', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    const query = parse(
      z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().min(1).max(1200).optional(),
          status: z.enum(['active', 'consolidated', 'all']).default('active'),
        })
        .strict(),
      req.query,
    );
    const scope = `wordbook:${ctx.siteId}:${user.id}${query.status === 'active' ? '' : `:${query.status}`}`,
      cursor = decodeCursor(scope, query.cursor, 'string');
    let after: { updatedAt: Date; id: string } | null = null;
    if (cursor !== null) {
      try {
        const value = z
          .object({ updatedAt: z.string().datetime(), id })
          .strict()
          .parse(JSON.parse(cursor));
        after = { updatedAt: new Date(value.updatedAt), id: value.id };
      } catch {
        throw new HttpError(400, 'invalid_cursor', '分页游标无效，请从第一页重新加载');
      }
    }
    const membership = {
      userId: user.id,
      ...(query.status === 'active'
        ? { graduatedAt: null }
        : query.status === 'consolidated'
          ? { graduatedAt: { not: null } }
          : {}),
    };
    return ctx.prisma.$transaction(
      async (tx) => {
        const rows = await tx.userWord.findMany({
          where: {
            ...membership,
            ...(after
              ? {
                  OR: [
                    { updatedAt: { lt: after.updatedAt } },
                    { updatedAt: after.updatedAt, id: { lt: after.id } },
                  ],
                }
              : {}),
          },
          include: { word: { include: wordInclude } },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
        });
        const total = await tx.userWord.count({ where: membership });
        const result = pageInfo(rows, query.limit, total, scope, (row) =>
          JSON.stringify({ updatedAt: row.updatedAt.toISOString(), id: row.id }),
        );
        const progress = await tx.studyProgress.findMany({
          where: { userId: user.id, wordId: { in: result.items.map((x) => x.wordId) } },
        });
        return {
          items: result.items.map((row) => ({
            id: row.id,
            wordId: row.wordId,
            word: wordDto(row.word),
            note: row.note,
            favorite: row.favorite,
            paused: row.paused,
            status: row.graduatedAt ? 'consolidated' : 'active',
            graduatedAt: row.graduatedAt?.toISOString() ?? null,
            progress: progressDto(progress.find((x) => x.wordId === row.wordId) ?? null),
          })),
          page: result.page,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  });
  app.get('/wordbook/:wordId', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    const { wordId } = parse(z.object({ wordId: id }), req.params);
    return ctx.prisma.$transaction(
      async (tx) => {
        const row = await tx.userWord.findFirst({
          where: { userId: user.id, wordId },
          select: {
            id: true,
            wordId: true,
            note: true,
            favorite: true,
            paused: true,
            graduatedAt: true,
          },
        });
        const item =
          row && !row.graduatedAt
            ? {
                id: row.id,
                wordId: row.wordId,
                note: row.note,
                favorite: row.favorite,
                paused: row.paused,
              }
            : null;
        const consolidatedItem = row?.graduatedAt
          ? { ...row, graduatedAt: row.graduatedAt.toISOString() }
          : null;
        return { item, consolidatedItem, collection: await collectionState(tx, user.id, wordId) };
      },
      { isolationLevel: 'RepeatableRead' },
    );
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
    return transact(ctx.prisma, async (tx) => {
      await lockLearningPreferences(tx, user.id);
      const existing = await tx.userWord.findUnique({
        where: { userId_wordId: { userId: user.id, wordId: input.wordId } },
      });
      if (existing && !existing.graduatedAt)
        return {
          item: existing,
          added: false,
          alreadySaved: true,
          collection: await collectionState(tx, user.id, input.wordId),
        };
      const item = existing
        ? await tx.userWord.update({
            where: { id: existing.id },
            data: {
              graduatedAt: null,
              favorite: true,
              ...(input.note !== undefined ? { note: input.note } : {}),
            },
          })
        : await tx.userWord.create({
            data: { userId: user.id, wordId: input.wordId, note: input.note ?? '' },
          });
      return {
        item,
        added: true,
        alreadySaved: false,
        collection: await collectionState(tx, user.id, input.wordId),
      };
    });
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
    return transact(ctx.prisma, async (tx) => {
      await lockLearningPreferences(tx, user.id);
      const existing = await tx.userWord.findFirst({
        where: { userId: user.id, wordId: params.wordId, graduatedAt: null },
      });
      if (!existing) throw new HttpError(404, 'wordbook_item_not_found');
      return { item: await tx.userWord.update({ where: { id: existing.id }, data: input }) };
    });
  });
  app.delete('/wordbook/:wordId', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ wordId: id }), req.params);
    return transact(ctx.prisma, async (tx) => {
      await lockLearningPreferences(tx, user.id);
      await tx.userWord.deleteMany({ where: { userId: user.id, wordId: params.wordId } });
      return {
        deleted: true,
        progressRetained: true,
        collection: await collectionState(tx, user.id, params.wordId),
      };
    });
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
      ctx.prisma.book.count({ where: { ownerId: null } }),
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
    return {
      items: await ctx.prisma.book.findMany({
        where: { ownerId: null },
        orderBy: { title: 'asc' },
      }),
    };
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
      if (!(await tx.book.findFirst({ where: { id: params.id, ownerId: null } })))
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
    const query = parse(
      z.object({
        q: z.string().max(160).default(''),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().max(1200).optional(),
      }),
      req.query,
    );
    const term = normalize(query.q),
      scope = `admin-words:${term}`,
      after = decodeCursor(scope, query.cursor, 'string');
    const where: Prisma.WordWhereInput = { normalizedLemma: { startsWith: term } };
    const [rows, total, packs] = await Promise.all([
      ctx.prisma.word.findMany({
        where: { normalizedLemma: { startsWith: term, ...(after !== null ? { gt: after } : {}) } },
        include: wordInclude,
        take: query.limit + 1,
        orderBy: { normalizedLemma: 'asc' },
      }),
      ctx.prisma.word.count({ where }),
      readyPacks(ctx.prisma),
    ]);
    const pagination = pageInfo(rows, query.limit, total, scope, (row) => row.normalizedLemma);
    return {
      items: pagination.items.map((word) => catalogWordDto(word, packs, true, true)),
      page: pagination.page,
      matchMode: 'prefix',
    };
  });
  app.get('/admin/words/:id', async (req) => {
    const ctx = await getContext(req);
    requireAdmin(ctx);
    const params = parse(z.object({ id }), req.params);
    const [word, packs] = await Promise.all([
      ctx.prisma.word.findUnique({ where: { id: params.id }, include: wordInclude }),
      readyPacks(ctx.prisma),
    ]);
    if (!word) throw new HttpError(404, 'word_not_found');
    return { word: catalogWordDto(word, packs, false, true) };
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
          expectedContentVersion: z.string().max(200).optional(),
          definitionZh: z.string().trim().max(4000).optional(),
          definitionEn: z.string().trim().max(4000).optional(),
          exampleEn: z.string().max(2000).optional(),
          exampleZh: z.string().max(2000).optional(),
        })
        .strict(),
      req.body,
    );
    return transact(ctx.prisma, async (tx) => {
      const word = await tx.word.findUnique({ where: { id: params.id }, include: wordInclude });
      if (!word) throw new HttpError(404, 'word_not_found');
      if (
        input.expectedContentVersion !== undefined &&
        input.expectedContentVersion !== word.contentVersion
      )
        throw new HttpError(409, 'word_content_changed', '词条已被更新，请重新载入后校对');
      const {
        status,
        senseId,
        expectedContentVersion: _expectedContentVersion,
        ...senseData
      } = input;
      if (Object.keys(senseData).length) {
        const sense = word.senses.find((x) => x.id === (senseId ?? word.senses[0]?.id));
        if (!sense) throw new HttpError(400, 'sense_not_in_word');
        if (
          !(senseData.definitionZh ?? sense.definitionZh).trim() &&
          !(senseData.definitionEn ?? sense.definitionEn).trim()
        )
          throw new HttpError(400, 'sense_definition_required', '请至少保留一项中文或英文释义');
        const contentMetadata = { ...obj(sense.contentMetadata) };
        for (const [field, value] of Object.entries(senseData)) {
          if (!(typeof value === 'string' && value.trim())) {
            delete contentMetadata[field];
            continue;
          }
          if (sense[field as keyof typeof sense] === value) continue;
          contentMetadata[field] = { kind: 'site-authored', review: 'source' };
          // Replacing a meaning does not resolve a warning about the canonical spelling.
          if (field === 'definitionZh' && Array.isArray(contentMetadata.lexicalWarnings)) {
            const warnings = contentMetadata.lexicalWarnings.filter(
              (warning) => obj(warning).code !== 'source-meaning-unverified',
            );
            if (warnings.length) contentMetadata.lexicalWarnings = warnings;
            else delete contentMetadata.lexicalWarnings;
          }
        }
        await tx.sense.update({
          where: { id: sense.id },
          data: { ...senseData, contentMetadata: json(contentMetadata) },
        });
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
