import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { Prisma } from '@prisma/client';
import { createDatabase } from '../db.js';
import { registerContent } from './content.js';
import { visibleBookWhere } from './book-access.js';
import { bookCatalogCounts } from './book-catalog-counts.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('PostgreSQL live book counts preserve publication, ownership and user evidence', () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith('_test')) throw new Error('use_a_disposable_test_database');
  const db = createDatabase(url);
  const prefix = 'catalog-counts-' + randomUUID();
  const userA = prefix + '-a',
    userB = prefix + '-b';
  const words = Array.from({ length: 11 }, (_, i) => prefix + '-word-' + i);
  // A quoted identity exercises bound values rather than string interpolation.
  const publicBook = prefix + "-public'quoted",
    secondBook = prefix + '-second';
  const emptyBook = prefix + '-empty',
    privateA = prefix + '-private-a';
  const privateB = prefix + '-private-b',
    draftBook = prefix + '-draft';
  const bookIds = [publicBook, secondBook, emptyBook, privateA, privateB, draftBook];
  const imports = [
    prefix + '-confirmed-1',
    prefix + '-confirmed-2',
    prefix + '-preview',
    prefix + '-revoked',
    prefix + '-other',
  ];
  const verifiedA = [
    words[0]!,
    words[1]!,
    words[8]!,
    words[5]!,
    words[6]!,
    words[7]!,
    'nonexistent-' + prefix,
    words[8]!,
  ];
  const verifiedB = [words[3]!, words[4]!];
  const app = Fastify();
  const actor = (id: string) => ({
    id,
    name: prefix,
    email: id + '@example.invalid',
    role: id === userB ? 'admin' : 'user',
  });
  const request = (userId?: string) =>
    app.inject({
      method: 'GET',
      url: '/books',
      headers: userId ? { 'x-fixture-actor': userId } : {},
    });

  beforeAll(async () => {
    await db.user.createMany({ data: [actor(userA), actor(userB)] });
    await db.word.createMany({
      data: words.map((id, i) => ({
        id,
        lemma: id,
        normalizedLemma: id,
        status: i === 5 ? 'archived' : i === 6 ? 'draft' : i === 7 ? 'zz-unpublished' : 'published',
        sourceRef: prefix,
        contentVersion: 'synthetic-catalog-counts',
      })),
    });
    await db.book.createMany({
      data: bookIds.map((id) => ({
        id,
        slug: id,
        title: id,
        description: 'Original synthetic counting fixture',
        goal: 'daily',
        ownerId: id === privateA ? userA : id === privateB ? userB : null,
        status: id === draftBook ? 'draft' : 'published',
        version: 'synthetic-catalog-counts',
      })),
    });
    const memberships: Array<[string, number[]]> = [
      [publicBook, words.map((_, i) => i)],
      [secondBook, [0, 2, 4, 8]],
      [privateA, [0, 1, 3, 5, 8]],
      [privateB, [0, 4, 6, 9]],
      [draftBook, [0, 1]],
    ];
    await db.bookItem.createMany({
      data: memberships.flatMap(([bookId, indices]) =>
        indices.map((index, ordinal) => ({
          id: prefix + '-item-' + bookIds.indexOf(bookId) + '-' + ordinal,
          bookId,
          wordId: words[index]!,
          ordinal,
        })),
      ),
    });
    await db.studyProgress.createMany({
      data: [
        [userA, 0, true],
        [userA, 1, false],
        [userA, 5, true],
        [userA, 6, true],
        [userA, 7, true],
        [userB, 4, true],
      ].map(([userId, index, learned], i) => ({
        id: prefix + '-progress-' + i,
        userId: userId as string,
        wordId: words[index as number]!,
        fsrsJson: {},
        dueAt: new Date(),
        firstLearnedAt: learned ? new Date() : null,
      })),
    });
    await db.masteryProfile.createMany({
      data: [
        { userId: userA, goal: 'daily', evidenceJson: { verifiedWordIds: verifiedA } },
        { userId: userA, goal: 'cet4', evidenceJson: { verifiedWordIds: [words[0]!, words[8]!] } },
        { userId: userB, goal: 'daily', evidenceJson: { verifiedWordIds: verifiedB } },
      ],
    });
    await db.knownImport.createMany({
      data: imports.map((id, i) => ({
        id,
        userId: i === 4 ? userB : userA,
        status: i === 2 ? 'preview' : i === 3 ? 'revoked' : 'confirmed',
        rowsJson: [],
        countsJson: {},
      })),
    });
    await db.knownClaim.createMany({
      data: [
        [0, userA, 0],
        [1, userA, 0],
        [0, userA, 2],
        [2, userA, 3],
        [3, userA, 9],
        [0, userA, 5],
        [0, userA, 6],
        [0, userA, 7],
        [4, userB, 4],
      ].map(([importIndex, userId, wordIndex], i) => ({
        id: prefix + '-claim-' + i,
        userId: userId as string,
        wordId: words[wordIndex as number]!,
        importId: imports[importIndex as number]!,
      })),
    });
    await db.autoKnownWord.createMany({
      data: [
        [userA, 0, false],
        [userA, 3, true],
        [userA, 9, false],
        [userB, 4, false],
      ].map(([userId, wordIndex, revoked], i) => ({
        id: prefix + '-auto-' + i,
        userId: userId as string,
        wordId: words[wordIndex as number]!,
        confirmedAt: new Date(),
        revokedAt: revoked ? new Date() : null,
      })),
    });
    // Supply trusted test contexts, so the real route selects visibility and
    // profiles itself. Authentication is covered by private-books integration.
    await registerContent(app, async (req) => {
      const selected = req.headers['x-fixture-actor'];
      return {
        siteId: 'default',
        basePath: '',
        publicUrl: 'http://catalog-counts.test',
        instanceId: prefix,
        title: prefix,
        fleetSecret: prefix,
        registrationOpen: false,
        prisma: db,
        user: selected === userA || selected === userB ? actor(selected) : null,
      };
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.book.deleteMany({
      where: { id: { in: bookIds }, version: 'synthetic-catalog-counts' },
    });
    await db.user.deleteMany({ where: { id: { in: [userA, userB] }, name: prefix } });
    await db.word.deleteMany({ where: { id: { in: words }, sourceRef: prefix } });
    await db.$disconnect();
  });

  async function legacyCounts(ids: string[], userId?: string, verified: string[] = []) {
    const base: Prisma.BookItemWhereInput = { bookId: { in: ids }, word: { status: 'published' } };
    const count = (where: Prisma.BookItemWhereInput) =>
      db.bookItem.groupBy({ by: ['bookId'], where, _count: { _all: true } });
    const [total, learned, covered, known] = await Promise.all([
      count(base),
      userId
        ? count({
            ...base,
            word: {
              status: 'published',
              progress: { some: { userId, firstLearnedAt: { not: null } } },
            },
          })
        : [],
      userId
        ? count({
            ...base,
            OR: [
              { word: { progress: { some: { userId, firstLearnedAt: { not: null } } } } },
              { wordId: { in: verified } },
            ],
          })
        : [],
      userId
        ? count({
            ...base,
            word: {
              status: 'published',
              OR: [
                { claims: { some: { userId, import: { status: 'confirmed' } } } },
                { autoKnownWords: { some: { userId, revokedAt: null } } },
              ],
            },
          })
        : [],
    ]);
    const n = (rows: typeof total, id: string) =>
      rows.find((row) => row.bookId === id)?._count._all ?? 0;
    return total
      .map((row) => ({
        bookId: row.bookId,
        wordCount: row._count._all,
        learnedCount: n(learned, row.bookId),
        coveredCount: n(covered, row.bookId),
        claimedKnownCount: n(known, row.bookId),
      }))
      .sort((a, b) => a.bookId.localeCompare(b.bookId));
  }

  it('matches the former relational queries for every visible book and actor, with distinct overlapping evidence', async () => {
    for (const [userId, verified] of [
      [undefined, []],
      [userA, verifiedA],
      [userB, verifiedB],
    ] as const) {
      const ids = (
        await db.book.findMany({
          where: { id: { in: bookIds }, ...visibleBookWhere(userId) },
          select: { id: true },
        })
      ).map((book) => book.id);
      const actual = (await bookCatalogCounts(db, ids, userId, [...verified])).sort((a, b) =>
        a.bookId.localeCompare(b.bookId),
      );
      expect(actual).toEqual(await legacyCounts(ids, userId, [...verified]));
    }
    expect(await bookCatalogCounts(db, [], userA, verifiedA)).toEqual([]);
    expect(await bookCatalogCounts(db, [publicBook], userA, verifiedA)).toEqual([
      { bookId: publicBook, wordCount: 8, learnedCount: 1, coveredCount: 3, claimedKnownCount: 3 },
    ]);
    expect(await bookCatalogCounts(db, [publicBook], userB, verifiedB)).toEqual([
      { bookId: publicBook, wordCount: 8, learnedCount: 1, coveredCount: 2, claimedKnownCount: 1 },
    ]);
  });

  it('keeps private and draft books out of each route response, including public-content administrators', async () => {
    for (const userId of [undefined, userA, userB]) {
      const response = await request(userId);
      expect(response.statusCode).toBe(200);
      const items = response
        .json()
        .items.filter((book: { id: string }) => bookIds.includes(book.id));
      const ids = items.map((book: { id: string }) => book.id).sort();
      expect(ids).toEqual(
        [
          publicBook,
          secondBook,
          emptyBook,
          ...(userId === userA ? [privateA] : userId === userB ? [privateB] : []),
        ].sort(),
      );
      expect(items.find((book: { id: string }) => book.id === emptyBook)).toMatchObject({
        wordCount: 0,
        learnedCount: 0,
        coveredCount: 0,
        claimedKnownCount: 0,
        visibility: 'public',
        ownedByMe: false,
      });
      expect(items.find((book: { id: string }) => book.id === publicBook)).toMatchObject({
        wordCount: 8,
        learnedCount: userId ? 1 : 0,
        coveredCount: userId === userA ? 3 : userId === userB ? 2 : 0,
        claimedKnownCount: userId === userA ? 3 : userId === userB ? 1 : 0,
      });
    }
  });

  it('immediately reflects publication and membership changes without stale shared or per-user counts', async () => {
    try {
      await db.word.update({ where: { id: words[8] }, data: { status: 'archived' } });
      const response = await request(userA);
      expect(response.statusCode).toBe(200);
      expect(
        response.json().items.find((book: { id: string }) => book.id === publicBook),
      ).toMatchObject({ wordCount: 7, learnedCount: 1, coveredCount: 2, claimedKnownCount: 3 });
      await db.bookItem.delete({ where: { id: prefix + '-item-0-0' } });
      const changed = await request(userA);
      expect(
        changed.json().items.find((book: { id: string }) => book.id === publicBook),
      ).toMatchObject({ wordCount: 6, learnedCount: 0, coveredCount: 1, claimedKnownCount: 2 });
      expect(
        (await request(userB)).json().items.find((book: { id: string }) => book.id === publicBook),
      ).toMatchObject({ wordCount: 6, learnedCount: 1, coveredCount: 2, claimedKnownCount: 1 });
    } finally {
      await db.word.update({ where: { id: words[8] }, data: { status: 'published' } });
      await db.bookItem.upsert({
        where: { id: prefix + '-item-0-0' },
        create: { id: prefix + '-item-0-0', bookId: publicBook, wordId: words[0]!, ordinal: 0 },
        update: {},
      });
    }
  });
});
