import type { Prisma, Sense } from '@prisma/client';
import { selectWordLearningSense, type Db } from './shared.js';

const sourceSelect = {
  id: true,
  wordId: true,
  pos: true,
  definitionZh: true,
  definitionEn: true,
  contentMetadata: true,
} as const;

/** Eligibility never needs pronunciation, examples, or related phrase graphs. */
export const learningEligibilityInclude = {
  senses: { select: sourceSelect },
  learningSenses: {
    where: { status: 'published' },
    include: { sourceBindings: { include: { sourceSense: { select: sourceSelect } } } },
  },
} as const satisfies Prisma.WordInclude;
export const learningEligibilitySelect = {
  id: true,
  ...learningEligibilityInclude,
} as const satisfies Prisma.WordSelect;
export type LearningEligibilityWord = Prisma.WordGetPayload<{
  select: typeof learningEligibilitySelect;
}>;
export type EligibleProgress = Prisma.StudyProgressGetPayload<{
  include: { word: { select: typeof learningEligibilitySelect } };
}>;
export type EligibleBookItem = Prisma.BookItemGetPayload<{
  include: { word: { select: typeof learningEligibilitySelect } };
}>;

const sourceSense = (sense: LearningEligibilityWord['senses'][number]): Sense => ({
  ...sense,
  ordinal: 0,
  exampleEn: '',
  exampleZh: '',
});

/** Same content decision as selectWordLearningSense, with unused fields omitted from SQL. */
export function hasLearningContent(word: LearningEligibilityWord, focusSenseId?: string | null) {
  return Boolean(
    selectWordLearningSense(
      {
        id: word.id,
        senses: word.senses.map(sourceSense),
        learningSenses: word.learningSenses.map((sense) => ({
          ...sense,
          examples: [],
          sourceBindings: sense.sourceBindings.map((binding) => ({
            ...binding,
            sourceSense: sourceSense(binding.sourceSense),
          })),
        })),
      },
      focusSenseId,
    ),
  );
}

const PAGE_SIZE = 128;
type ProgressOrder = Prisma.StudyProgressOrderByWithRelationInput;
type BookOrder = Prisma.BookItemOrderByWithRelationInput;
const stableOrder = <T extends ProgressOrder | BookOrder>(order: T | T[]): T[] => {
  const values = Array.isArray(order) ? order : [order];
  return values.some((value) => value.id) ? values : [...values, { id: 'asc' } as T];
};

// Only positive equality in a conjunction proves a fixed user/book scope. An OR
// containing one scoped branch does not constrain the other branches.
function hasScope(where: object, field: 'userId' | 'bookId'): boolean {
  const value = where as Record<string, unknown>;
  if (typeof value[field] === 'string' && value[field]) return true;
  const and = value.AND;
  return (Array.isArray(and) ? and : and && typeof and === 'object' ? [and] : []).some(
    (part) => part && typeof part === 'object' && hasScope(part, field),
  );
}
function requireScope(where: object, field: 'userId' | 'bookId') {
  if (!hasScope(where, field)) throw new Error('learning_eligibility_requires_fixed_' + field);
}
function requireLimit(limit: number | undefined) {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
    throw new Error('learning_eligibility_invalid_limit');
}

async function scan<
  T extends { id: string; word: LearningEligibilityWord; focusSenseId?: string | null },
>(fetch: (cursor: string | undefined) => Promise<T[]>, visit: (row: T) => void, limit?: number) {
  requireLimit(limit);
  if (limit === 0) return;
  let cursor: string | undefined;
  let accepted = 0;
  for (;;) {
    const rows = await fetch(cursor);
    for (const row of rows) {
      if (!hasLearningContent(row.word, row.focusSenseId)) continue;
      visit(row);
      if (++accepted === limit) return;
    }
    if (rows.length < PAGE_SIZE) return;
    const next = rows.at(-1)!.id;
    if (next === cursor) throw new Error('learning_eligibility_cursor_not_advancing');
    cursor = next;
  }
}
const progressFetcher = (
  db: Db,
  where: Prisma.StudyProgressWhereInput,
  orderBy: ProgressOrder | ProgressOrder[],
) => {
  requireScope(where, 'userId');
  return (cursor: string | undefined) =>
    db.studyProgress.findMany({
      where,
      orderBy: stableOrder(orderBy),
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { word: { select: learningEligibilitySelect } },
    });
};
const bookFetcher = (
  db: Db,
  where: Prisma.BookItemWhereInput,
  orderBy: BookOrder | BookOrder[],
) => {
  requireScope(where, 'bookId');
  return (cursor: string | undefined) =>
    db.bookItem.findMany({
      where,
      orderBy: stableOrder(orderBy),
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { word: { select: learningEligibilitySelect } },
    });
};

export async function findEligibleProgress(
  db: Db,
  where: Prisma.StudyProgressWhereInput,
  orderBy: ProgressOrder | ProgressOrder[],
  limit?: number,
) {
  const result: EligibleProgress[] = [];
  await scan(progressFetcher(db, where, orderBy), (row) => result.push(row), limit);
  return result;
}
export async function findEligibleBookItems(
  db: Db,
  where: Prisma.BookItemWhereInput,
  orderBy: BookOrder | BookOrder[] = { ordinal: 'asc' },
  limit?: number,
) {
  const result: EligibleBookItem[] = [];
  await scan(bookFetcher(db, where, orderBy), (row) => result.push(row), limit);
  return result;
}

/** Create once per read/transaction; discard before any mutation or another request. */
export type LearningEligibilityCache = WeakMap<object, Map<string, Promise<number>>>;
export const createLearningEligibilityCache = (): LearningEligibilityCache => new WeakMap();
async function cachedCount(
  cache: LearningEligibilityCache | undefined,
  db: Db,
  key: string,
  calculate: () => Promise<number>,
) {
  if (!cache) return calculate();
  let counts = cache.get(db);
  if (!counts) {
    counts = new Map();
    cache.set(db, counts);
  }
  let result = counts.get(key);
  if (!result) {
    result = calculate();
    counts.set(key, result);
  }
  return result;
}
export async function countEligibleProgress(
  db: Db,
  where: Prisma.StudyProgressWhereInput,
  cache?: LearningEligibilityCache,
) {
  requireScope(where, 'userId');
  return cachedCount(cache, db, 'progress:' + JSON.stringify(where), async () => {
    let count = 0;
    await scan(progressFetcher(db, where, { id: 'asc' }), () => count++);
    return count;
  });
}
export async function countEligibleBookItems(
  db: Db,
  where: Prisma.BookItemWhereInput,
  cache?: LearningEligibilityCache,
) {
  requireScope(where, 'bookId');
  return cachedCount(cache, db, 'book:' + JSON.stringify(where), async () => {
    let count = 0;
    await scan(bookFetcher(db, where, { id: 'asc' }), () => count++);
    return count;
  });
}
