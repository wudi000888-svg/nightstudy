import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { HttpError, requireUser, type RequestContext } from '../context.js';
import { visibleBookWhere } from './book-access.js';
import { digest, id, normalize, parse, progressDto, wordDto, wordInclude } from './shared.js';

const inputSchema = z
  .object({
    bookId: id.refine((value) => !value.includes('\0')).optional(),
    view: z.enum(['all', 'unlearned', 'learning', 'recent', 'learned', 'known']).optional(),
    q: z
      .string()
      .trim()
      .max(120)
      .refine((value) => !value.includes('\0'))
      .default(''),
    sort: z.enum(['book', 'az', 'za', 'recent']).optional(),
    locate: id.refine((value) => !value.includes('\0')).optional(),
    cursor: z.string().min(1).max(1600).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const keySchema = z
  .object({
    id,
    lemma: z.string().max(160),
    ordinal: z.number().int().nonnegative(),
    at: z.string().datetime(),
  })
  .strict();
const cursorSchema = z
  .object({
    v: z.literal(1),
    scope: z.string(),
    revision: z.string(),
    expires: z.number().int(),
    key: keySchema,
  })
  .strict();
type Key = z.infer<typeof keySchema>;
type Row = { id: string; wordId: string; lemma: string; ordinal: number; at: Date };
function signature(ctx: Pick<RequestContext, 'fleetSecret'>, body: string) {
  return crypto
    .createHmac('sha256', ctx.fleetSecret)
    .update('nightstudy:library:v2:')
    .update(body)
    .digest();
}
export function libraryBrowseCursor(
  ctx: Pick<RequestContext, 'fleetSecret'>,
  scope: string,
  revision: string,
  key: Key,
  now = Date.now(),
) {
  const body = Buffer.from(
    JSON.stringify({ v: 1, scope, revision, expires: now + 15 * 60 * 1000, key }),
  ).toString('base64url');
  return `${body}.${signature(ctx, body).toString('base64url')}`;
}
export function readLibraryBrowseCursor(
  ctx: Pick<RequestContext, 'fleetSecret'>,
  token: string | undefined,
  scope: string,
  revision: string,
  now = Date.now(),
): Key | null {
  if (!token) return null;
  let value: z.infer<typeof cursorSchema>;
  try {
    if (token.length > 1600) throw new Error('length');
    const parts = token.split('.');
    if (parts.length !== 2 || parts.some((part) => !/^[\w-]+$/.test(part)))
      throw new Error('format');
    const [body, mac] = parts as [string, string],
      actual = Buffer.from(mac, 'base64url'),
      expected = signature(ctx, body);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected))
      throw new Error('signature');
    value = cursorSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    if (value.scope !== scope) throw new Error('scope');
  } catch {
    throw new HttpError(400, 'invalid_cursor', '分页条件已改变，请从第一页重新加载');
  }
  if (value.expires <= now) throw new HttpError(410, 'cursor_expired', '列表已过期，请重新加载');
  if (value.revision !== revision)
    throw new HttpError(409, 'list_changed', '学习列表已更新，请重新加载');
  return value.key;
}
const rowKey = (row: Row): Key => ({
  id: row.id,
  lemma: row.lemma,
  ordinal: row.ordinal,
  at: row.at.toISOString(),
});
const browseWordInclude = {
  ...wordInclude,
  senses: { ...wordInclude.senses, take: 3 },
  examples: { take: 0 },
  collocations: { ...wordInclude.collocations, take: 0 },
  learningSenses: {
    ...wordInclude.learningSenses,
    include: { ...wordInclude.learningSenses.include, examples: { take: 0 } },
  },
};

export async function browseLibrary(ctx: RequestContext, input: unknown) {
  const user = requireUser(ctx),
    query = parse(inputSchema, input),
    bookMode = !!query.bookId;
  const view = query.view ?? (bookMode ? 'all' : 'learning'),
    sort = query.sort ?? (bookMode ? 'book' : 'recent');
  if (!bookMode && (['all', 'unlearned'].includes(view) || sort === 'book'))
    throw new HttpError(400, 'invalid_input');
  if (query.cursor && query.locate) throw new HttpError(400, 'invalid_input');
  return ctx.prisma.$transaction(
    async (tx) => {
      const book = bookMode
        ? await tx.book.findFirst({
            where: { id: query.bookId, ...visibleBookWhere(user.id) },
            select: { id: true, title: true, updatedAt: true },
          })
        : null;
      if (bookMode && !book) throw new HttpError(404, 'book_not_found');
      const revisionRows = await tx.lookupRevision.findMany({
        where: { scope: { in: ['catalog', `user:${user.id}`] } },
      });
      const revision = digest({
        bookVersion: book?.updatedAt.toISOString() ?? null,
        rows: revisionRows.map((r) => [r.scope, r.revision.toString()]).sort(),
      });
      const scope = digest({
        kind: 'library-v2',
        site: ctx.siteId,
        instance: ctx.instanceId,
        path: ctx.basePath,
        user: user.id,
        book: book?.id ?? null,
        view,
        sort,
        q: normalize(query.q),
      });
      let after = readLibraryBrowseCursor(ctx, query.cursor, scope, revision);
      const known = Prisma.sql`(EXISTS(SELECT 1 FROM "AutoKnownWord" ak WHERE ak."userId"=${user.id} AND ak."wordId"=w.id AND ak."revokedAt" IS NULL)
      OR EXISTS(SELECT 1 FROM "KnownClaim" kc JOIN "KnownImport" ki ON ki.id=kc."importId" WHERE kc."userId"=${user.id} AND kc."wordId"=w.id AND ki.status='confirmed'))`;
      const conditions: Prisma.Sql[] = [Prisma.sql`w.status='published'`];
      if (book) conditions.push(Prisma.sql`b."bookId"=${book.id}`);
      if (query.q) conditions.push(Prisma.sql`strpos(w."normalizedLemma",${normalize(query.q)})>0`);
      if (view === 'unlearned') conditions.push(Prisma.sql`p."firstLearnedAt" IS NULL`);
      else if (view === 'known') conditions.push(known);
      else if (view !== 'all') {
        conditions.push(Prisma.sql`p."firstLearnedAt" IS NOT NULL`);
        if (view === 'recent')
          conditions.push(Prisma.sql`p."lastReviewAt">=${new Date(Date.now() - 30 * 86400000)}`);
        if (view === 'learning')
          conditions.push(
            Prisma.sql`NOT EXISTS(SELECT 1 FROM "UserWord" uw WHERE uw."userId"=${user.id} AND uw."wordId"=w.id AND uw.paused=true)`,
          );
      }
      const from = book
        ? Prisma.sql`FROM "BookItem" b JOIN "Word" w ON w.id=b."wordId" LEFT JOIN "StudyProgress" p ON p."wordId"=w.id AND p."userId"=${user.id}`
        : Prisma.sql`FROM "Word" w LEFT JOIN "StudyProgress" p ON p."wordId"=w.id AND p."userId"=${user.id}`;
      const keyId = book ? Prisma.sql`b.id` : Prisma.sql`w.id`,
        ordinal = book ? Prisma.sql`b.ordinal` : Prisma.sql`0`;
      const at = Prisma.sql`COALESCE(p."lastReviewAt",p."firstLearnedAt",TIMESTAMP '1970-01-01')`;
      const select = Prisma.sql`SELECT ${keyId} AS id,w.id AS "wordId",w."normalizedLemma" AS lemma,${ordinal} AS ordinal,${at} AS at`;
      const base = Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;
      if (query.locate) {
        const [target] = await tx.$queryRaw<Row[]>(
          Prisma.sql`${select} ${from} ${base} AND w.id=${query.locate}`,
        );
        if (!target)
          throw new HttpError(
            404,
            'library_anchor_not_found',
            '这个词不在当前词表中，请调整筛选后再找',
          );
        after = rowKey(target);
      }
      const direction = sort === 'za' || sort === 'recent' ? 'desc' : 'asc';
      const orderValue =
        sort === 'book' ? ordinal : sort === 'recent' ? at : Prisma.sql`w."normalizedLemma"`;
      const order =
        direction === 'asc'
          ? Prisma.sql`${orderValue} ASC,${keyId} ASC`
          : Prisma.sql`${orderValue} DESC,${keyId} DESC`;
      const more: Prisma.Sql[] = [];
      if (after) {
        const value =
          sort === 'book' ? after.ordinal : sort === 'recent' ? new Date(after.at) : after.lemma;
        const strict =
          direction === 'asc'
            ? Prisma.sql`${orderValue}>${value}`
            : Prisma.sql`${orderValue}<${value}`;
        const tie =
          direction === 'asc'
            ? query.locate
              ? Prisma.sql`${keyId}>=${after.id}`
              : Prisma.sql`${keyId}>${after.id}`
            : query.locate
              ? Prisma.sql`${keyId}<=${after.id}`
              : Prisma.sql`${keyId}<${after.id}`;
        more.push(Prisma.sql`AND (${strict} OR (${orderValue}=${value} AND ${tie}))`);
      }
      const [rows, count] = await Promise.all([
        tx.$queryRaw<Row[]>(
          Prisma.sql`${select} ${from} ${base} ${more.length ? Prisma.join(more, ' ') : Prisma.empty} ORDER BY ${order} LIMIT ${query.limit + 1}`,
        ),
        tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`SELECT COUNT(*) AS total ${from} ${base}`),
      ]);
      const selected = rows.slice(0, query.limit),
        ids = selected.map((row) => row.wordId);
      const [words, progress, memberships, counts] = await Promise.all([
        tx.word.findMany({ where: { id: { in: ids } }, include: browseWordInclude }),
        tx.studyProgress.findMany({ where: { userId: user.id, wordId: { in: ids } } }),
        tx.userWord.findMany({
          where: { userId: user.id, wordId: { in: ids } },
          select: { wordId: true, paused: true, graduatedAt: true },
        }),
        tx.reviewLog.groupBy({
          by: ['wordId'],
          where: { userId: user.id, wordId: { in: ids }, wasNew: false },
          _count: { _all: true },
        }),
      ]);
      const byWord = new Map(words.map((w) => [w.id, w])),
        byProgress = new Map(progress.map((p) => [p.wordId, p])),
        byMembership = new Map(memberships.map((m) => [m.wordId, m]));
      return {
        book: book ? { id: book.id, title: book.title } : null,
        items: selected.map((row) => {
          const word = byWord.get(row.wordId)!,
            p = byProgress.get(row.wordId),
            m = byMembership.get(row.wordId);
          const details = wordDto(word);
          const meaning = (sense: {
            id: string;
            pos: string;
            definitionZh: string;
            definitionEn: string;
          }) => ({
            id: sense.id,
            pos: sense.pos,
            definitionZh: sense.definitionZh,
            definitionEn: sense.definitionEn,
          });
          return {
            word: {
              id: details.id,
              lemma: details.lemma,
              entryKind: details.entryKind,
              phonetic: details.phonetic,
              phoneticUs: details.phoneticUs,
              phoneticUk: details.phoneticUk,
              audio: details.audio,
              pronunciationCompatible: details.pronunciationCompatible,
              senses: details.senses.slice(0, 3).map(meaning),
              learningDefinitions: details.learningDefinitions?.slice(0, 2).map(meaning) ?? [],
              detailAvailable: true,
            },
            progress: p ? progressDto(p) : null,
            reviewedAt: p?.lastReviewAt?.toISOString() ?? null,
            learnedAt: p?.firstLearnedAt?.toISOString() ?? null,
            dueAt: p?.dueAt.toISOString() ?? null,
            reviewCount: counts.find((c) => c.wordId === row.wordId)?._count._all ?? 0,
            paused: m?.paused ?? false,
            collection: {
              inWordbook: !!m && !m.graduatedAt,
              wordbookStatus: m ? (m.graduatedAt ? 'consolidated' : 'active') : null,
            },
          };
        }),
        page: {
          total: Number(count[0]?.total ?? 0),
          hasMore: rows.length > query.limit,
          nextCursor:
            rows.length > query.limit && selected.length
              ? libraryBrowseCursor(ctx, scope, revision, rowKey(selected.at(-1)!))
              : null,
          ...(query.locate ? { anchorWordId: query.locate } : {}),
        },
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
