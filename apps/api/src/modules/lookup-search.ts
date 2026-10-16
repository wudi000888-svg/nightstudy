import crypto from 'node:crypto';
import { Prisma, type Sense } from '@prisma/client';
import { z } from 'zod';
import { HttpError, requireUser, type RequestContext } from '../context.js';
import { displayPos, learningSense, normalize, parse, type Db } from './shared.js';
import { learningDefinitionView } from './learning-definitions.js';
import {
  learningSenseBindingHash,
  learningSenseSourceMatches,
} from './learning-sense-integrity.js';

export const lookupQuery = z
  .object({
    q: z
      .string()
      .max(160)
      .refine((value) => !value.includes('\0'))
      .default(''),
    match: z.enum(['smart', 'prefix', 'contains', 'exact']).default('smart'),
    sort: z.enum(['relevance', 'az', 'za', 'updated-desc']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(1600).optional(),
    status: z.enum(['active', 'consolidated', 'all']).optional(),
  })
  .strict();
export type LookupMatch = z.infer<typeof lookupQuery>['match'];
export type LookupSort = 'relevance' | 'az' | 'za' | 'updated-desc';
type Conditions = {
  q: string;
  match: LookupMatch;
  sort: LookupSort;
  status?: 'active' | 'consolidated' | 'all';
};
type Revision = { catalog: string; collection?: string };
const afterSchema = z
  .object({
    normalizedLemma: z.string().min(1).max(160),
    id: z.string().min(1).max(160),
    tier: z.number().int().min(0).max(2),
    updatedAt: z.string().datetime().optional(),
    userWordId: z.string().min(1).max(160).optional(),
  })
  .strict();
type After = z.infer<typeof afterSchema>;
const cursorSchema = z
  .object({
    v: z.literal(1),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    expires: z.number().int().positive(),
    revision: z
      .object({
        catalog: z.string().regex(/^\d+$/),
        collection: z.string().regex(/^\d+$/).optional(),
      })
      .strict(),
    after: afterSchema,
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;
const cursorLifetimeMs = 15 * 60 * 1000;

function signingKey(ctx: Pick<RequestContext, 'fleetSecret'>) {
  return crypto
    .createHmac('sha256', ctx.fleetSecret)
    .update('nightstudy:lookup-cursor:v1')
    .digest();
}
export function lookupScope(
  ctx: Pick<RequestContext, 'instanceId' | 'siteId' | 'basePath' | 'user'>,
  privateList: boolean,
  query: Conditions,
) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        ranking: 1,
        instanceId: ctx.instanceId,
        siteId: ctx.siteId,
        basePath: ctx.basePath,
        userId: ctx.user?.id ?? null,
        privateList,
        ...query,
      }),
    )
    .digest('hex');
}
export function signLookupCursor(ctx: Pick<RequestContext, 'fleetSecret'>, cursor: Cursor): string {
  const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', signingKey(ctx)).update(body).digest('base64url')}`;
}
export function readLookupCursor(
  ctx: Pick<RequestContext, 'fleetSecret'>,
  token: string | undefined,
  scope: string,
  revision: Revision,
  now = Date.now(),
): After | null {
  if (!token) return null;
  let value: Cursor;
  try {
    if (token.length > 1600) throw new Error('length');
    const parts = token.split('.');
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part)))
      throw new Error('encoding');
    const [body, signature] = parts as [string, string];
    const actual = Buffer.from(signature, 'base64url');
    const expected = crypto.createHmac('sha256', signingKey(ctx)).update(body).digest();
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected))
      throw new Error('signature');
    value = cursorSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    if (value.scope !== scope) throw new Error('scope');
  } catch {
    throw new HttpError(400, 'invalid_cursor', '分页条件已改变，请从第一页重新加载');
  }
  if (value.expires <= now) throw new HttpError(410, 'cursor_expired', '列表已过期，请重新加载');
  if (
    value.revision.catalog !== revision.catalog ||
    value.revision.collection !== revision.collection
  )
    throw new HttpError(409, 'list_changed', '列表已更新，请重新加载');
  return value.after;
}

/** Escape LIKE metacharacters. Search input is always a literal, never a SQL pattern. */
export function literalLike(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}
export function canUseContains(value: string) {
  return /[\p{L}\p{N}]{3}/u.test(value);
}
export function adjacentTranspositions(value: string): string[] {
  if (!/^[a-z]{4,32}$/.test(value)) return [];
  const values = new Set<string>();
  for (let i = 0; i < value.length - 1; i++) {
    if (value[i] === value[i + 1]) continue;
    values.add(value.slice(0, i) + value[i + 1]! + value[i]! + value.slice(i + 2));
  }
  return [...values];
}
/** Bounded optimal-string-alignment distance, only evaluated on a small indexed candidate set. */
export function spellingDistance(left: string, right: string, bound = 2): number {
  if (Math.abs(left.length - right.length) > bound) return bound + 1;
  const rows: number[][] = [Array.from({ length: right.length + 1 }, (_, index) => index)];
  for (let i = 1; i <= left.length; i++) {
    const row = [i];
    for (let j = 1; j <= right.length; j++) {
      let distance = Math.min(
        row[j - 1]! + 1,
        rows[i - 1]![j]! + 1,
        rows[i - 1]![j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1])
        distance = Math.min(distance, rows[i - 2]![j - 2]! + 1);
      row.push(distance);
    }
    rows.push(row);
  }
  return rows[left.length]![right.length]!;
}

type SearchRow = {
  id: string;
  lemma: string;
  normalizedLemma: string;
  tier: number;
  userWordId: string | null;
  note: string | null;
  favorite: boolean | null;
  paused: boolean | null;
  graduatedAt: Date | null;
  updatedAt: Date | null;
};
type Brief = {
  id: string;
  lemma: string;
  normalizedLemma: string;
  pos: string[];
  definitionZh: string;
  definitionEn: string;
  matchType: 'exact' | 'prefix' | 'contains' | null;
  collection: { inWordbook: boolean; wordbookStatus: 'active' | 'consolidated' | null };
};
function matching(q: string, match: LookupMatch): Prisma.Sql {
  if (!q) return Prisma.sql`TRUE`;
  if (match === 'exact') return Prisma.sql`w."normalizedLemma" = ${q}`;
  if (match === 'prefix' || (match === 'smart' && !canUseContains(q)))
    return Prisma.sql`w."normalizedLemma" LIKE ${`${literalLike(q)}%`} ESCAPE '\\'`;
  return Prisma.sql`w."normalizedLemma" LIKE ${`%${literalLike(q)}%`} ESCAPE '\\'`;
}
function matchTier(q: string): Prisma.Sql {
  return q
    ? Prisma.sql`CASE WHEN w."normalizedLemma" = ${q} THEN 0 WHEN w."normalizedLemma" LIKE ${`${literalLike(q)}%`} ESCAPE '\\' THEN 1 ELSE 2 END`
    : Prisma.sql`0`;
}
function membership(privateList: boolean, userId: string | null, status?: string): Prisma.Sql {
  if (!privateList) return Prisma.sql`TRUE`;
  return Prisma.sql`uw."userId" = ${userId} ${status === 'active' ? Prisma.sql`AND uw."graduatedAt" IS NULL` : status === 'consolidated' ? Prisma.sql`AND uw."graduatedAt" IS NOT NULL` : Prisma.empty}`;
}
function afterClause(query: Conditions, after: After | null): Prisma.Sql {
  if (!after) return Prisma.sql`TRUE`;
  if (query.sort === 'updated-desc') {
    if (!after.updatedAt || !after.userWordId) throw new HttpError(400, 'invalid_cursor');
    return Prisma.sql`(uw."updatedAt", uw.id COLLATE "C") < (${new Date(after.updatedAt)}, ${after.userWordId} COLLATE "C")`;
  }
  if (query.sort === 'relevance')
    return Prisma.sql`(${matchTier(query.q)}, w."normalizedLemma" COLLATE "C", w.id COLLATE "C") > (${after.tier}, ${after.normalizedLemma} COLLATE "C", ${after.id} COLLATE "C")`;
  if (query.sort === 'za')
    return Prisma.sql`(w."normalizedLemma" COLLATE "C", w.id COLLATE "C") < (${after.normalizedLemma} COLLATE "C", ${after.id} COLLATE "C")`;
  return Prisma.sql`(w."normalizedLemma" COLLATE "C", w.id COLLATE "C") > (${after.normalizedLemma} COLLATE "C", ${after.id} COLLATE "C")`;
}
function orderClause(query: Conditions): Prisma.Sql {
  if (query.sort === 'updated-desc') return Prisma.sql`uw."updatedAt" DESC, uw.id COLLATE "C" DESC`;
  if (query.sort === 'za')
    return Prisma.sql`w."normalizedLemma" COLLATE "C" DESC, w.id COLLATE "C" DESC`;
  if (query.sort === 'relevance')
    return Prisma.sql`${matchTier(query.q)}, w."normalizedLemma" COLLATE "C", w.id COLLATE "C"`;
  return Prisma.sql`w."normalizedLemma" COLLATE "C", w.id COLLATE "C"`;
}
async function readRevision(tx: Db, userId: string | null): Promise<Revision> {
  const scopes = ['catalog', ...(userId ? [`user:${userId}`] : [])];
  const rows = await tx.$queryRaw<Array<{ scope: string; revision: bigint }>>(Prisma.sql`
    SELECT scope, revision FROM "LookupRevision" WHERE scope IN (${Prisma.join(scopes)})`);
  const revisions = new Map(rows.map((row) => [row.scope, String(row.revision)]));
  return {
    catalog: revisions.get('catalog') ?? '0',
    ...(userId ? { collection: revisions.get(`user:${userId}`) ?? '0' } : {}),
  };
}
async function briefDefinitions(tx: Db, ids: string[]) {
  const result = new Map<string, { pos: string[]; definitionZh: string; definitionEn: string }>();
  if (!ids.length) return result;
  const senses = await tx.$queryRaw<
    Array<{
      id: string;
      wordId: string;
      pos: string;
      definitionZh: string;
      definitionEn: string;
      contentVersion: string;
      bindingHash: string;
    }>
  >(Prisma.sql`
    SELECT s.id, s."wordId", s.pos, s."definitionZh", s."definitionEn", s."contentVersion", s."bindingHash"
    FROM unnest(ARRAY[${Prisma.join(ids)}]::text[]) AS requested(id)
    CROSS JOIN LATERAL (
      SELECT id, "wordId", pos, "definitionZh", "definitionEn", "contentVersion", "bindingHash" FROM "LearningSense"
      WHERE "wordId" = requested.id AND status = 'published' ORDER BY ordinal, id LIMIT 3
    ) s`);
  const bindings = senses.length
    ? await tx.senseSourceBinding.findMany({
        where: { learningSenseId: { in: senses.map((sense) => sense.id) } },
        select: {
          learningSenseId: true,
          wordId: true,
          sourceSenseId: true,
          relation: true,
          sourcePosSha256: true,
          sourceDefinitionZhSha256: true,
          sourceDefinitionEnSha256: true,
          sourceSense: {
            select: { id: true, wordId: true, pos: true, definitionZh: true, definitionEn: true },
          },
        },
      })
    : [];
  const verified = senses.filter((sense) => {
    const sourceBindings = bindings.filter((binding) => binding.learningSenseId === sense.id);
    return (
      sourceBindings.length > 0 &&
      sourceBindings.every(
        (binding) =>
          binding.wordId === sense.wordId &&
          learningSenseSourceMatches(binding, binding.sourceSense),
      ) &&
      sense.bindingHash === learningSenseBindingHash({ ...sense, sourceBindings })
    );
  });
  for (const wordId of ids) {
    const own = verified.filter((sense) => sense.wordId === wordId);
    if (own.length)
      result.set(wordId, {
        pos: [...new Set(own.map((sense) => sense.pos).filter(Boolean))],
        definitionZh: own[0]!.definitionZh.slice(0, 240),
        definitionEn: own[0]!.definitionEn.slice(0, 300),
      });
  }
  const missing = ids.filter((wordId) => !result.has(wordId));
  if (missing.length) {
    const fallback = await tx.$queryRaw<Array<Omit<Sense, 'exampleEn' | 'exampleZh'>>>(Prisma.sql`
      SELECT s.id, s."wordId", s.pos, s."definitionZh", s."definitionEn", s.ordinal, s."contentMetadata"
      FROM unnest(ARRAY[${Prisma.join(missing)}]::text[]) AS requested(id)
      CROSS JOIN LATERAL (
        SELECT id, "wordId", pos, "definitionZh", "definitionEn", ordinal, "contentMetadata" FROM "Sense"
        WHERE "wordId" = requested.id ORDER BY ordinal, id LIMIT 6
      ) s`);
    for (const wordId of missing) {
      const own = fallback
        .filter((sense) => sense.wordId === wordId)
        .map((sense) => ({ ...sense, exampleEn: '', exampleZh: '' }) satisfies Sense)
        .filter(learningSense)
        .map(learningDefinitionView);
      // The two displayed languages always belong to the same source meaning.
      const first =
        own.find((sense) => sense.definitionZh && sense.definitionEn) ??
        own.find((sense) => sense.definitionZh || sense.definitionEn);
      result.set(wordId, {
        pos: [...new Set(own.map(displayPos).filter(Boolean))].slice(0, 3),
        definitionZh: first?.definitionZh.slice(0, 240) ?? '',
        definitionEn: first?.definitionEn.slice(0, 300) ?? '',
      });
    }
  }
  return result;
}
async function suggestions(
  tx: Db,
  q: string,
  privateList: boolean,
  userId: string | null,
  status?: string,
) {
  if (!/^[a-z]{4,32}$/.test(q)) return [];
  const join = privateList ? Prisma.sql`JOIN "UserWord" uw ON uw."wordId" = w.id` : Prisma.empty;
  const constraint = Prisma.sql`w.status = 'published' AND ${membership(privateList, userId, status)}`;
  const swaps = adjacentTranspositions(q);
  const exact = swaps.length
    ? await tx.$queryRaw<Array<{ id: string; lemma: string; normalizedLemma: string }>>(Prisma.sql`
    SELECT w.id, w.lemma, w."normalizedLemma" FROM "Word" w ${join}
    WHERE ${constraint} AND w."normalizedLemma" IN (${Prisma.join(swaps)})`)
    : [];
  // Transaction-local: never alter the next borrower of a pooled connection.
  await tx.$executeRaw`SET LOCAL pg_trgm.similarity_threshold = 0.45`;
  const nearby = await tx.$queryRaw<
    Array<{ id: string; lemma: string; normalizedLemma: string }>
  >(Prisma.sql`
    SELECT w.id, w.lemma, w."normalizedLemma" FROM "Word" w ${join}
    WHERE ${constraint} AND w."normalizedLemma" % ${q}
      AND char_length(w."normalizedLemma") BETWEEN ${q.length - 2} AND ${q.length + 2}
    ORDER BY similarity(w."normalizedLemma", ${q}) DESC, w."normalizedLemma" COLLATE "C", w.id COLLATE "C" LIMIT 128`);
  return [...new Map([...exact, ...nearby].map((row) => [row.id, row])).values()]
    .filter((row) => row.normalizedLemma !== q && /^[a-z]{2,34}$/.test(row.normalizedLemma))
    .map((row) => ({ ...row, distance: spellingDistance(q, row.normalizedLemma) }))
    .filter((row) => row.distance <= 2)
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        (a.normalizedLemma < b.normalizedLemma
          ? -1
          : a.normalizedLemma > b.normalizedLemma
            ? 1
            : a.id < b.id
              ? -1
              : 1),
    )
    .slice(0, 10)
    .map(({ id, lemma }) => ({ id, lemma, matchType: 'spelling' as const }));
}

export async function searchLookup(ctx: RequestContext, input: unknown, privateList = false) {
  const userId = privateList ? requireUser(ctx).id : (ctx.user?.id ?? null);
  const parsed = parse(lookupQuery, input);
  const limit = parsed.limit ?? (privateList ? 50 : 20);
  const q = normalize(parsed.q);
  if (!privateList && (parsed.status !== undefined || parsed.sort === 'updated-desc' || limit > 50))
    throw new HttpError(400, 'invalid_input');
  if (q && parsed.match === 'contains' && !canUseContains(q))
    throw new HttpError(400, 'query_too_short', '包含匹配需要至少三个连续字母或数字');
  const query: Conditions = {
    q,
    match: parsed.match,
    sort: parsed.sort ?? (privateList && !q ? 'updated-desc' : 'relevance'),
    ...(privateList ? { status: parsed.status ?? 'active' } : {}),
  };
  const queryInfo = {
    ...query,
    effectiveMatch: !q
      ? privateList
        ? 'all'
        : 'none'
      : query.match === 'smart' && !canUseContains(q)
        ? 'prefix'
        : query.match,
  };
  const scope = lookupScope(ctx, privateList, query);
  return ctx.prisma.$transaction(
    async (tx) => {
      const revision = await readRevision(tx, userId);
      const after = readLookupCursor(ctx, parsed.cursor, scope, revision);
      if (!privateList && !q)
        return {
          items: [],
          page: { total: 0, hasMore: false, nextCursor: null },
          query: queryInfo,
          revision,
          suggestions: [],
        };
      const join = privateList
        ? Prisma.sql`JOIN "UserWord" uw ON uw."wordId" = w.id`
        : Prisma.sql`LEFT JOIN "UserWord" uw ON uw."wordId" = w.id AND uw."userId" = ${userId}`;
      const where = Prisma.sql`w.status = 'published' AND ${membership(privateList, userId, query.status)} AND ${matching(q, query.match)}`;
      const rows = await tx.$queryRaw<SearchRow[]>(Prisma.sql`
      SELECT w.id, w.lemma, w."normalizedLemma", ${matchTier(q)} AS tier,
        uw.id AS "userWordId", uw.note, uw.favorite, uw.paused, uw."graduatedAt", uw."updatedAt"
      FROM "Word" w ${join} WHERE ${where} AND ${afterClause(query, after)}
      ORDER BY ${orderClause(query)} LIMIT ${limit + 1}`);
      // Keep private totals anchored to this user's collection. A flattened join can
      // choose a full catalog hash scan even for a few thousand saved words. OFFSET 0
      // preserves a correlated, indexed existence check without limiting membership.
      const countSql = privateList
        ? Prisma.sql`SELECT count(*) AS total FROM "UserWord" uw
            WHERE ${membership(true, userId, query.status)} AND EXISTS (
              SELECT 1 FROM "Word" w WHERE w.id = uw."wordId" AND w.status = 'published'
                AND ${matching(q, query.match)} OFFSET 0
            )`
        : Prisma.sql`SELECT count(*) AS total FROM "Word" w WHERE w.status = 'published' AND ${matching(q, query.match)}`;
      const counts = await tx.$queryRaw<Array<{ total: bigint }>>(countSql);
      const visible = rows.slice(0, limit),
        hasMore = rows.length > limit;
      const definitions = await briefDefinitions(
        tx,
        visible.map((row) => row.id),
      );
      const items = visible.map((row) => {
        const word: Brief = {
          id: row.id,
          lemma: row.lemma,
          normalizedLemma: row.normalizedLemma,
          ...(definitions.get(row.id) ?? { pos: [], definitionZh: '', definitionEn: '' }),
          matchType: q ? (row.tier === 0 ? 'exact' : row.tier === 1 ? 'prefix' : 'contains') : null,
          collection: {
            inWordbook: Boolean(row.userWordId && !row.graduatedAt),
            wordbookStatus: row.userWordId ? (row.graduatedAt ? 'consolidated' : 'active') : null,
          },
        };
        return privateList
          ? {
              id: row.userWordId!,
              wordId: row.id,
              note: row.note ?? '',
              favorite: row.favorite ?? false,
              paused: row.paused ?? false,
              status: row.graduatedAt ? 'consolidated' : 'active',
              graduatedAt: row.graduatedAt?.toISOString() ?? null,
              updatedAt: row.updatedAt!.toISOString(),
              word,
            }
          : word;
      });
      const last = visible.at(-1);
      const nextCursor =
        hasMore && last
          ? signLookupCursor(ctx, {
              v: 1,
              scope,
              revision,
              expires: Date.now() + cursorLifetimeMs,
              after: {
                id: last.id,
                normalizedLemma: last.normalizedLemma,
                tier: last.tier,
                ...(query.sort === 'updated-desc'
                  ? { updatedAt: last.updatedAt!.toISOString(), userWordId: last.userWordId! }
                  : {}),
              },
            })
          : null;
      const suggested =
        !after && q && !visible.some((row) => row.tier === 0) && Number(counts[0]?.total ?? 0) < 3
          ? await suggestions(tx, q, privateList, userId, query.status)
          : [];
      return {
        items,
        page: { total: Number(counts[0]?.total ?? 0), hasMore, nextCursor },
        query: queryInfo,
        revision,
        suggestions: suggested,
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
