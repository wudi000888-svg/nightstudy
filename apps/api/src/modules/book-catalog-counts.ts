import { Prisma } from '@prisma/client';
import type { Db } from './shared.js';

export interface BookCatalogCount {
  bookId: string;
  wordCount: number;
  learnedCount: number;
  coveredCount: number;
  claimedKnownCount: number;
}

/** The caller supplies only IDs selected by visibleBookWhere for this request.
 * Count current memberships, never static source totals or cached user state. */
export async function bookCatalogCounts(
  db: Db,
  bookIds: string[],
  userId?: string | null,
  verifiedWordIds: string[] = [],
): Promise<BookCatalogCount[]> {
  if (!bookIds.length) return [];
  const verified = verifiedWordIds.length
    ? Prisma.sql`SELECT unnest(ARRAY[${Prisma.join(verifiedWordIds)}]::text[]) AS "wordId"`
    : Prisma.sql`SELECT NULL::text AS "wordId" WHERE false`;
  const states = userId
    ? Prisma.sql`WITH learned AS MATERIALIZED (
        SELECT DISTINCT "wordId" FROM "StudyProgress"
        WHERE "userId"=${userId} AND "firstLearnedAt" IS NOT NULL
      ), covered AS MATERIALIZED (
        SELECT "wordId" FROM learned UNION ${verified}
      ), known AS MATERIALIZED (
        SELECT c."wordId" FROM "KnownClaim" c
        JOIN "KnownImport" i ON i.id=c."importId"
        WHERE c."userId"=${userId} AND i.status='confirmed'
        UNION SELECT "wordId" FROM "AutoKnownWord"
        WHERE "userId"=${userId} AND "revokedAt" IS NULL
      )`
    : Prisma.empty;
  const columns = userId
    ? Prisma.sql`count(l."wordId")::int AS "learnedCount",
        count(c."wordId")::int AS "coveredCount", count(k."wordId")::int AS "claimedKnownCount"`
    : Prisma.sql`0::int AS "learnedCount",0::int AS "coveredCount",0::int AS "claimedKnownCount"`;
  const joins = userId
    ? Prisma.sql`LEFT JOIN learned l ON l."wordId"=bi."wordId"
        LEFT JOIN covered c ON c."wordId"=bi."wordId"
        LEFT JOIN known k ON k."wordId"=bi."wordId"`
    : Prisma.empty;
  // Word.status and BookItem.wordId are non-null; the latter has a Word FK.
  // Therefore excluding every non-published Word is exactly the positive join.
  // Two indexable status ranges avoid rescanning the large, mostly published
  // dictionary. Do not replace them with a fixed list of unpublished statuses.
  return db.$queryRaw<BookCatalogCount[]>(Prisma.sql`
    ${states}
    SELECT bi."bookId",count(*)::int AS "wordCount",${columns}
    FROM "BookItem" bi ${joins}
    WHERE bi."bookId" IN (${Prisma.join(bookIds)})
      AND bi."wordId" NOT IN (
        SELECT w.id FROM "Word" w WHERE w.status<'published' OR w.status>'published'
      )
    GROUP BY bi."bookId"
  `);
}
