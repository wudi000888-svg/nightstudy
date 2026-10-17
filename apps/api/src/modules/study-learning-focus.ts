import type { Db } from './shared.js';

type BookIdentity = {
  id: string;
  slug: string;
  goal: string;
  kind: string;
  version: string;
  packId: string;
  packVersion: string;
  packSha256: string;
};

// Exact identities produced by the three pinned, released installers. Neither
// public ownership nor an ID/title prefix establishes an installed catalog book.
const dictionary = {
  id: 'ecdict-bc015ed2e24a7',
  version: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
  sha256: '1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf',
};
const phrases = {
  id: 'phrase-books-v1',
  version: '2026-10-14-v1',
  sha256: '0242c24f0841a99d80b696ccfa82b44d824e4be0b35ff147d845d9d073ddff7e',
};
const exams = {
  id: 'exam-books-v1',
  version: '2026-10-16',
  sha256: '3fc6824371b4d8119a9eff7906209e937da68bbae365078adf1a8a0c666b1a1b',
};
const packIdentity = (pack: typeof dictionary) => ({
  packId: pack.id,
  packVersion: pack.version,
  packSha256: pack.sha256,
});
export const builtInDefaultBooks: readonly BookIdentity[] = [
  ...['daily', 'high-school', 'cet4', 'cet6', 'ielts'].map((goal) => {
    const id = `content-${dictionary.id}-${goal}`;
    return {
      id,
      slug: id,
      goal,
      kind: 'vocabulary',
      version: dictionary.id,
      ...packIdentity(dictionary),
    };
  }),
  ...(['cet4', 'cet6'] as const).map((goal) => ({
    id: `content-${phrases.id}-${goal}-phrases`,
    slug: `${goal}-phrases`,
    goal,
    kind: 'phrases',
    version: phrases.version,
    ...packIdentity(phrases),
  })),
  ...(
    [
      ['cet4-open', 'cet4', 'vocabulary'],
      ['cet6-open', 'cet6', 'vocabulary'],
      ['tem4-open', 'tem4', 'vocabulary'],
      ['tem8-open', 'tem8', 'vocabulary'],
      ['toefl-open', 'toefl', 'vocabulary'],
      ['gre-open', 'gre', 'vocabulary'],
      ['tem4-phrases', 'tem4', 'phrases'],
      ['tem8-phrases', 'tem8', 'phrases'],
      ['toefl-extended', 'toefl', 'vocabulary'],
      ['gre-extended', 'gre', 'vocabulary'],
      ['postgraduate', 'postgraduate', 'vocabulary'],
    ] as const
  ).map(([suffix, goal, kind]) => {
    const id = `content-${exams.id}-${suffix}`;
    return {
      id,
      slug: id,
      goal,
      kind,
      version: exams.id,
      ...packIdentity(exams),
    };
  }),
];
const registered = new Map(builtInDefaultBooks.map((book) => [book.id, book]));

/** Request/transaction-local proof; no cache survives administrator edits. */
export async function isBuiltInDefaultBook(db: Pick<Db, 'book' | 'contentPack'>, bookId: string) {
  const expected = registered.get(bookId);
  if (!expected) return false;
  const { packId, packVersion, packSha256, ...identity } = expected;
  const book = await db.book.findFirst({
    where: {
      ...identity,
      ownerId: null,
      status: 'published',
      imports: { none: {} },
    },
    select: { id: true },
  });
  if (!book) return false;
  return Boolean(
    await db.contentPack.findFirst({
      where: { id: packId, version: packVersion, sha256: packSha256, status: 'ready' },
      select: { id: true },
    }),
  );
}

/** The current pointer is written only by an accepted rating, atomically with
 * progress. Read at most 20 indexed user/word rows; never scan SessionItem
 * history on the planning path. The caller still verifies current source proof. */
export async function loadAcceptedReviewFocusIds(
  db: Pick<Db, 'studyProgress'>,
  userId: string,
  wordIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(wordIds)];
  if (!ids.length) return new Map();
  if (!userId || ids.length > 20) throw new Error('invalid_review_focus_scope');
  const rows = await db.studyProgress.findMany({
    where: { userId, wordId: { in: ids } },
    select: {
      wordId: true,
      reviewFocusSenseId: true,
      reviewFocusRevision: true,
      revision: true,
      firstLearnedAt: true,
      lastReviewAt: true,
    },
  });
  return new Map(
    rows.flatMap((row) =>
      row.reviewFocusSenseId?.trim() &&
      row.reviewFocusRevision > 0 &&
      row.reviewFocusRevision <= row.revision &&
      row.firstLearnedAt &&
      row.lastReviewAt
        ? [[row.wordId, row.reviewFocusSenseId] as const]
        : [],
    ),
  );
}
