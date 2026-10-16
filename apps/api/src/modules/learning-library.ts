import type { FastifyInstance } from 'fastify';
import type { LibraryNote, LibrarySentence, Prisma, UserLearningPreference } from '@prisma/client';
import { z } from 'zod';
import { HttpError, requireUser, type ContextResolver } from '../context.js';
import {
  digest,
  id,
  json,
  learningSense,
  normalize,
  obj,
  parse,
  progressDto,
  transact,
  wordDto,
  wordInclude,
  type Db,
} from './shared.js';
import { decodeCursor, pageInfo } from './pagination.js';
import { verifiedLearningSenses, type AtomicLearningSense } from './learning-sense-view.js';

const listInput = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(1200).optional(),
    q: z.string().trim().max(120).default(''),
    wordId: id.optional(),
  })
  .strict();
const plain = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((v) => !v.includes('\0'));
const preferencePatch = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    theme: z.enum(['day', 'night', 'system']).optional(),
    accent: z.enum(['us', 'uk']).optional(),
    autoPlay: z.boolean().optional(),
    spellingEnabled: z.boolean().optional(),
    fontScale: z.union([z.literal(1), z.literal(1.125), z.literal(1.25)]).optional(),
    reminderEnabled: z.boolean().optional(),
    reminderTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
  })
  .strict();
export const defaultLearningPreferences = {
  theme: 'day',
  accent: 'us',
  autoPlay: false,
  spellingEnabled: true,
  fontScale: 1,
  reminderEnabled: false,
  reminderTime: '20:00',
  revision: 0,
};
const preferencesDto = (value: UserLearningPreference | null) =>
  value
    ? {
        theme: value.theme,
        accent: value.accent,
        autoPlay: value.autoPlay,
        spellingEnabled: value.spellingEnabled,
        fontScale: value.fontScale,
        reminderEnabled: value.reminderEnabled,
        reminderTime: value.reminderTime,
        revision: value.revision,
      }
    : { ...defaultLearningPreferences };
export async function lockLibraryUser(db: Db, userId: string) {
  const rows = await db.$queryRaw<
    { id: string }[]
  >`SELECT "id" FROM "User" WHERE "id"=${userId} FOR UPDATE`;
  if (!rows.length) throw new HttpError(401, 'authentication_required');
}
export function libraryCursor(scope: string, cursor?: string) {
  const value = decodeCursor(scope, cursor, 'string');
  if (!value) return null;
  try {
    const parsed = z.object({ at: z.string().datetime(), id }).strict().parse(JSON.parse(value));
    return { at: new Date(parsed.at), id: parsed.id };
  } catch {
    throw new HttpError(400, 'invalid_cursor');
  }
}
async function publishedWord(db: Db, wordId: string) {
  // Canonical Words are site catalog records; a private Book never makes another user's membership public.
  // If private Word ownership is introduced, this is the visibility boundary to extend.
  if (
    !(await db.word.findFirst({ where: { id: wordId, status: 'published' }, select: { id: true } }))
  )
    throw new HttpError(404, 'word_not_found');
}
const sentenceDto = (row: LibrarySentence) => ({
  id: row.id,
  wordId: row.wordId,
  sourceType: row.sourceType,
  sourceId: row.sourceId,
  exampleEn: row.exampleEn,
  exampleZh: row.exampleZh,
  metadata: row.metadata,
  createdAt: row.createdAt.toISOString(),
});
type SentenceSourceType = 'word-example' | 'sense';
const validBoundSource = (source: {
  wordId: string;
  contentVersion: string;
  learningSense: Omit<AtomicLearningSense, 'examples'> | null;
}) =>
  source.learningSense !== null &&
  source.contentVersion === source.learningSense.contentVersion &&
  verifiedLearningSenses({
    id: source.wordId,
    learningSenses: [{ ...source.learningSense, examples: [] }],
  }).length === 1;
type SentenceSource = {
  id: string;
  wordId: string;
  exampleEn: string;
  exampleZh: string;
  contentMetadata: Prisma.JsonValue;
  learningSenseId?: string | null;
  contextLabel?: string;
  contentVersion?: string;
  learningSense?: {
    id: string;
    pos: string;
    definitionZh: string;
    definitionEn: string;
    contentVersion: string;
    bindingHash: string;
  } | null;
  word: { sourceRef: string; contentVersion: string };
};
function sentenceSnapshot(sourceType: SentenceSourceType, source: SentenceSource) {
  const metadata = {
    ...obj(source.contentMetadata),
    sourceWordId: source.wordId,
    sourceRef: source.word.sourceRef,
    contentVersion: source.word.contentVersion,
    ...(source.learningSense
      ? {
          learningSenseId: source.learningSenseId,
          contextLabel: source.contextLabel,
          exampleContentVersion: source.contentVersion,
          meaning: {
            id: source.learningSense.id,
            pos: source.learningSense.pos,
            definitionZh: source.learningSense.definitionZh,
            definitionEn: source.learningSense.definitionEn,
            contentVersion: source.learningSense.contentVersion,
            bindingHash: source.learningSense.bindingHash,
          },
        }
      : {}),
  };
  return {
    metadata,
    sourceHash: digest([
      sourceType,
      source.id,
      source.wordId,
      source.exampleEn,
      source.exampleZh,
      metadata,
    ]),
  };
}
const sentenceSourceLimit = 1000;
const noteDto = (row: LibraryNote) => ({
  id: row.id,
  wordId: row.wordId,
  title: row.title,
  body: row.body,
  revision: row.revision,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export async function registerLearningLibrary(app: FastifyInstance, getContext: ContextResolver) {
  app.get('/learning-preferences', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    return {
      preferences: preferencesDto(
        await ctx.prisma.userLearningPreference.findUnique({ where: { userId: user.id } }),
      ),
    };
  });
  app.put('/learning-preferences', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      input = parse(preferencePatch, req.body);
    return transact(ctx.prisma, async (tx) => {
      await lockLibraryUser(tx, user.id);
      const previous = await tx.userLearningPreference.findUnique({ where: { userId: user.id } });
      if ((previous?.revision ?? 0) !== input.expectedRevision)
        throw new HttpError(409, 'learning_preferences_conflict', '偏好已被更新，请重新读取', {
          preferences: preferencesDto(previous),
        });
      const { expectedRevision: _expected, ...patch } = input;
      const saved = previous
        ? await tx.userLearningPreference.update({
            where: { userId: user.id },
            data: { ...patch, revision: { increment: 1 } },
          })
        : await tx.userLearningPreference.create({
            data: { userId: user.id, ...patch, revision: 1 },
          });
      return { preferences: preferencesDto(saved) };
    });
  });
  app.get('/library/words', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    const query = parse(
      listInput
        .omit({ wordId: true })
        .extend({ view: z.enum(['learning', 'recent', 'learned']).default('learning') })
        .strict(),
      req.query,
    );
    const scope = `library-words:${ctx.siteId}:${ctx.instanceId}:${user.id}:${digest([query.view, query.q])}`;
    const cursor = libraryCursor(scope, query.cursor);
    const where: Prisma.StudyProgressWhereInput = {
      userId: user.id,
      firstLearnedAt: { not: null },
      ...(query.view === 'recent'
        ? { lastReviewAt: { gte: new Date(Date.now() - 30 * 86400000) } }
        : {}),
      word: {
        status: 'published',
        ...(query.q
          ? {
              OR: [
                { lemma: { contains: query.q, mode: 'insensitive' } },
                { normalizedLemma: { contains: normalize(query.q) } },
              ],
            }
          : {}),
        ...(query.view === 'learning'
          ? { userWords: { none: { userId: user.id, paused: true } } }
          : {}),
      },
    };
    const [rows, total] = await Promise.all([
      ctx.prisma.studyProgress.findMany({
        where: {
          ...where,
          ...(cursor
            ? {
                OR: [
                  { updatedAt: { lt: cursor.at } },
                  { updatedAt: cursor.at, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        include: { word: { include: wordInclude } },
      }),
      ctx.prisma.studyProgress.count({ where }),
    ]);
    const page = pageInfo(rows, query.limit, total, scope, (row) =>
      JSON.stringify({ at: row.updatedAt.toISOString(), id: row.id }),
    );
    const wordIds = page.items.map((row) => row.wordId);
    const [counts, memberships] = await Promise.all([
      ctx.prisma.reviewLog.groupBy({
        by: ['wordId'],
        where: { userId: user.id, wordId: { in: wordIds }, wasNew: false },
        _count: { _all: true },
      }),
      ctx.prisma.userWord.findMany({
        where: { userId: user.id, wordId: { in: wordIds } },
        select: { wordId: true, paused: true },
      }),
    ]);
    return {
      items: page.items.map((row) => ({
        word: {
          ...wordDto({
            ...row.word,
            senses: row.word.senses.slice(0, 3),
            examples: row.word.examples.slice(0, 1),
          }),
          senseCount: row.word.senses.filter(learningSense).length,
        },
        progress: progressDto(row),
        reviewedAt: row.lastReviewAt?.toISOString() ?? null,
        dueAt: row.dueAt.toISOString(),
        learnedAt: row.firstLearnedAt?.toISOString() ?? null,
        reviewCount: counts.find((count) => count.wordId === row.wordId)?._count._all ?? 0,
        paused: memberships.find((item) => item.wordId === row.wordId)?.paused ?? false,
      })),
      page: page.page,
    };
  });
  app.get('/sentences', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      query = parse(listInput, req.query);
    const scope = `sentences:${ctx.siteId}:${ctx.instanceId}:${user.id}:${digest([query.q, query.wordId ?? null])}`,
      cursor = libraryCursor(scope, query.cursor);
    const where: Prisma.LibrarySentenceWhereInput = {
      userId: user.id,
      ...(query.wordId ? { wordId: query.wordId } : {}),
      AND: [
        { OR: [{ wordId: null }, { word: { status: 'published' } }] },
        ...(query.q
          ? [
              {
                OR: [
                  { exampleEn: { contains: query.q, mode: 'insensitive' as const } },
                  { exampleZh: { contains: query.q } },
                ],
              },
            ]
          : []),
      ],
    };
    const [rows, total] = await Promise.all([
      ctx.prisma.librarySentence.findMany({
        where: {
          ...where,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.at } },
                  { createdAt: cursor.at, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
      ctx.prisma.librarySentence.count({ where }),
    ]);
    const page = pageInfo(rows, query.limit, total, scope, (row) =>
      JSON.stringify({ at: row.createdAt.toISOString(), id: row.id }),
    );
    return { items: page.items.map(sentenceDto), page: page.page };
  });
  app.get('/sentences/status', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      query = parse(z.object({ wordId: id }).strict(), req.query);
    // One bounded catalog read and one user-scoped lookup, independent of sentence-list pagination.
    // Keep a consistent read snapshot when source text/provenance is edited concurrently.
    return transact(ctx.prisma, async (tx) => {
      const word = await tx.word.findFirst({
        where: { id: query.wordId, status: 'published' },
        select: {
          id: true,
          sourceRef: true,
          contentVersion: true,
          examples: {
            where: {
              status: 'published',
              learningSense: { status: 'published' },
              exampleEn: { not: '' },
              exampleZh: { not: '' },
            },
            orderBy: [{ ordinal: 'asc' }, { id: 'asc' }],
            take: sentenceSourceLimit + 1,
            include: {
              learningSense: { include: { sourceBindings: { include: { sourceSense: true } } } },
            },
          },
        },
      });
      if (!word) throw new HttpError(404, 'word_not_found');
      // Never silently omit identities and incorrectly label an existing favorite as unsaved.
      if (word.examples.length > sentenceSourceLimit)
        throw new HttpError(413, 'sentence_sources_limit', '该词例句数量超过单次状态查询上限');
      const sources = [
        ...word.examples
          .filter(validBoundSource)
          .map((source) => ({ sourceType: 'word-example' as const, source })),
      ]
        .filter(({ source }) => source.exampleEn.trim() && source.exampleZh.trim())
        .map(({ sourceType, source }) => ({
          sourceType,
          sourceId: source.id,
          ...sentenceSnapshot(sourceType, { ...source, word }),
        }));
      const saved = sources.length
        ? await tx.librarySentence.findMany({
            where: {
              userId: user.id,
              wordId: word.id,
              sourceHash: { in: sources.map((source) => source.sourceHash) },
            },
            select: { id: true, sourceType: true, sourceId: true, sourceHash: true },
          })
        : [];
      const identities = new Map(
        saved.map((row) => [
          JSON.stringify([row.sourceType, row.sourceId, row.sourceHash]),
          row.id,
        ]),
      );
      return {
        wordId: word.id,
        items: sources.map(({ sourceType, sourceId, sourceHash }) => {
          const sentenceId =
            identities.get(JSON.stringify([sourceType, sourceId, sourceHash])) ?? null;
          return { sourceType, sourceId, saved: sentenceId !== null, sentenceId };
        }),
      };
    });
  });
  app.post('/sentences', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      input = parse(
        z
          .object({
            sourceType: z.literal('word-example'),
            sourceId: id,
            wordId: id.optional(),
          })
          .strict(),
        req.body,
      );
    return transact(ctx.prisma, async (tx) => {
      await lockLibraryUser(tx, user.id);
      const source = await tx.wordExample.findFirst({
        where: {
          id: input.sourceId,
          status: 'published',
          learningSense: { status: 'published' },
          word: { status: 'published' },
        },
        include: {
          word: { select: { id: true, sourceRef: true, contentVersion: true } },
          learningSense: { include: { sourceBindings: { include: { sourceSense: true } } } },
        },
      });
      if (
        !source ||
        (input.wordId && source.wordId !== input.wordId) ||
        !source.exampleEn.trim() ||
        !source.exampleZh.trim() ||
        !source.learningSenseId ||
        !validBoundSource(source)
      )
        throw new HttpError(404, 'sentence_source_not_found', '例句不存在或当前不可收藏');
      const { metadata, sourceHash } = sentenceSnapshot(input.sourceType, source);
      const existing = await tx.librarySentence.findUnique({
        where: {
          userId_sourceType_sourceId_sourceHash: {
            userId: user.id,
            sourceType: input.sourceType,
            sourceId: source.id,
            sourceHash,
          },
        },
      });
      if (existing) return { sentence: sentenceDto(existing), duplicate: true };
      if ((await tx.librarySentence.count({ where: { userId: user.id } })) >= 5000)
        throw new HttpError(429, 'sentence_limit', '句库最多收藏5000句');
      const saved = await tx.librarySentence.create({
        data: {
          userId: user.id,
          wordId: source.wordId,
          sourceType: input.sourceType,
          sourceId: source.id,
          sourceHash,
          exampleEn: source.exampleEn,
          exampleZh: source.exampleZh,
          metadata: json(metadata),
        },
      });
      return { sentence: sentenceDto(saved), duplicate: false };
    });
  });
  app.delete('/sentences/:id', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    parse(z.object({}).strict(), req.body ?? {});
    const result = await ctx.prisma.librarySentence.deleteMany({
      where: { id: params.id, userId: user.id },
    });
    if (!result.count) throw new HttpError(404, 'sentence_not_found');
    return { deleted: true };
  });
  app.get('/notes', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      query = parse(listInput, req.query);
    const scope = `notes:${ctx.siteId}:${ctx.instanceId}:${user.id}:${digest([query.q, query.wordId ?? null])}`,
      cursor = libraryCursor(scope, query.cursor);
    const where: Prisma.LibraryNoteWhereInput = {
      userId: user.id,
      ...(query.wordId ? { wordId: query.wordId } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { body: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      ctx.prisma.libraryNote.findMany({
        where: {
          AND: [
            where,
            ...(cursor
              ? [
                  {
                    OR: [
                      { updatedAt: { lt: cursor.at } },
                      { updatedAt: cursor.at, id: { lt: cursor.id } },
                    ],
                  },
                ]
              : []),
          ],
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
      ctx.prisma.libraryNote.count({ where }),
    ]);
    const page = pageInfo(rows, query.limit, total, scope, (row) =>
      JSON.stringify({ at: row.updatedAt.toISOString(), id: row.id }),
    );
    return { items: page.items.map(noteDto), page: page.page };
  });
  app.get('/notes/:id', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    const note = await ctx.prisma.libraryNote.findFirst({
      where: { id: params.id, userId: user.id },
    });
    if (!note) throw new HttpError(404, 'note_not_found');
    return { note: noteDto(note) };
  });
  app.post('/notes', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      input = parse(
        z
          .object({ title: plain(120), body: plain(20000), wordId: id.nullable().optional() })
          .strict(),
        req.body,
      );
    return transact(ctx.prisma, async (tx) => {
      await lockLibraryUser(tx, user.id);
      if (input.wordId) await publishedWord(tx, input.wordId);
      if ((await tx.libraryNote.count({ where: { userId: user.id } })) >= 1000)
        throw new HttpError(429, 'note_limit', '笔记最多1000篇');
      return {
        note: noteDto(await tx.libraryNote.create({ data: { userId: user.id, ...input } })),
      };
    });
  });
  app.patch('/notes/:id', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    const input = parse(
      z
        .object({
          expectedRevision: z.number().int().nonnegative(),
          title: plain(120).optional(),
          body: plain(20000).optional(),
          wordId: id.nullable().optional(),
        })
        .strict(),
      req.body,
    );
    return transact(ctx.prisma, async (tx) => {
      await lockLibraryUser(tx, user.id);
      const note = await tx.libraryNote.findFirst({ where: { id: params.id, userId: user.id } });
      if (!note) throw new HttpError(404, 'note_not_found');
      if (note.revision !== input.expectedRevision)
        throw new HttpError(409, 'note_conflict', '笔记已在另一处更新', { note: noteDto(note) });
      if (input.wordId) await publishedWord(tx, input.wordId);
      const { expectedRevision: _expected, ...patch } = input;
      return {
        note: noteDto(
          await tx.libraryNote.update({
            where: { id: note.id },
            data: { ...patch, revision: { increment: 1 } },
          }),
        ),
      };
    });
  });
  app.delete('/notes/:id', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params),
      input = parse(
        z.object({ expectedRevision: z.number().int().nonnegative() }).strict(),
        req.body,
      );
    return transact(ctx.prisma, async (tx) => {
      await lockLibraryUser(tx, user.id);
      const note = await tx.libraryNote.findFirst({ where: { id: params.id, userId: user.id } });
      if (!note) throw new HttpError(404, 'note_not_found');
      if (note.revision !== input.expectedRevision)
        throw new HttpError(409, 'note_conflict', '笔记已在另一处更新', { note: noteDto(note) });
      await tx.libraryNote.delete({ where: { id: note.id } });
      return { deleted: true };
    });
  });
}
