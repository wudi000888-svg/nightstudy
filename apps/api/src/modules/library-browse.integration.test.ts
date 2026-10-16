import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../db.js';
import type { RequestContext } from '../context.js';
import { browseLibrary, libraryBrowseCursor } from './library-browse.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('real PostgreSQL book browsing, global ordering, anchors and private signed keysets', () => {
  if (!databaseUrl) return;
  if (!new URL(databaseUrl).pathname.endsWith('_test'))
    throw new Error('library_browse_requires_an_isolated_test_database');
  const db = createDatabase(databaseUrl);
  const stem = `browse${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const owner = `${stem}-owner`,
    other = `${stem}-other`;
  const publicBook = `${stem}-public`,
    ownBook = `${stem}-private`,
    otherBook = `${stem}-other-private`,
    hiddenBook = `${stem}-archived`;
  const words = Array.from({ length: 9 }, (_, index) => ({
    id: `${stem}-word-${index}`,
    lemma: `${stem}${String.fromCharCode(97 + index)}`,
    normalizedLemma: `${stem}${String.fromCharCode(97 + index)}`,
  }));
  const order = [6, 1, 5, 0, 3, 2, 7, 4];
  const now = new Date(),
    recentA = new Date(now.getTime() - 3600000),
    recentB = new Date(now.getTime() - 7200000),
    old = new Date(now.getTime() - 40 * 86400000);
  const context: RequestContext = {
    siteId: 'library-browse-fixture',
    instanceId: 'library-browse-instance',
    basePath: '/study',
    publicUrl: 'https://library-browse.example.test/study',
    title: 'Original browse test',
    fleetSecret: 'original-library-browse-integration-secret'.repeat(3),
    registrationOpen: false,
    prisma: db,
    user: { id: owner, name: 'Browse fixture', email: `${owner}@example.test`, role: 'user' },
  };
  const asOther = {
    ...context,
    user: { id: other, name: 'Other fixture', email: `${other}@example.test`, role: 'admin' },
  };
  const ids = (page: Awaited<ReturnType<typeof browseLibrary>>) =>
    page.items.map((item) => item.word.id);
  const list = (query: Record<string, unknown>, ctx = context) => browseLibrary(ctx, query);
  const collect = async (query: Record<string, unknown>) => {
    const result: string[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 10; index++) {
      const page = await list({ ...query, limit: 2, ...(cursor ? { cursor } : {}) });
      result.push(...ids(page));
      if (!page.page.hasMore) {
        expect(page.page.nextCursor).toBeNull();
        return result;
      }
      cursor = page.page.nextCursor!;
      expect(cursor).toBeTruthy();
    }
    throw new Error('Unbounded library pagination');
  };
  const snapshot = async () => ({
    progress: await db.studyProgress.findMany({
      where: { userId: { in: [owner, other] } },
      orderBy: { id: 'asc' },
    }),
    reviews: await db.reviewLog.findMany({
      where: { userId: { in: [owner, other] } },
      orderBy: { id: 'asc' },
    }),
    collection: await db.userWord.findMany({
      where: { userId: { in: [owner, other] } },
      orderBy: { id: 'asc' },
    }),
    known: await db.autoKnownWord.findMany({
      where: { userId: { in: [owner, other] } },
      orderBy: { id: 'asc' },
    }),
    imports: await db.knownImport.findMany({
      where: { userId: { in: [owner, other] } },
      orderBy: { id: 'asc' },
    }),
    claims: await db.knownClaim.findMany({
      where: { userId: { in: [owner, other] } },
      orderBy: { id: 'asc' },
    }),
    revisions: await db.lookupRevision.findMany({
      where: { scope: { in: ['catalog', `user:${owner}`, `user:${other}`] } },
      orderBy: { scope: 'asc' },
    }),
    plans: await db.dailyPlan.count({ where: { userId: { in: [owner, other] } } }),
    sessions: await db.studySession.count({ where: { userId: { in: [owner, other] } } }),
    preferences: await db.userLearningPreference.count({
      where: { userId: { in: [owner, other] } },
    }),
  });
  beforeAll(async () => {
    await db.user.createMany({
      data: [owner, other].map((id) => ({
        id,
        name: 'Original browse fixture',
        email: `${id}@example.test`,
      })),
    });
    await db.word.createMany({
      data: words.map((word, index) => ({
        ...word,
        status: index === 8 ? 'archived' : 'published',
        sourceRef: 'Original browse fixture, no external content',
        contentVersion: 'test-only',
      })),
    });
    await db.sense.createMany({
      data: words.map((word) => ({
        id: `${word.id}-sense`,
        wordId: word.id,
        pos: 'n.',
        definitionZh: '原创检索测试词义',
        definitionEn: 'An original browsing fixture.',
      })),
    });
    await db.book.createMany({
      data: [
        {
          id: publicBook,
          slug: publicBook,
          title: 'Original public book',
          description: 'Test fixture',
          goal: 'daily',
        },
        {
          id: ownBook,
          slug: ownBook,
          title: 'Original private book',
          description: 'Test fixture',
          goal: 'daily',
          ownerId: owner,
        },
        {
          id: otherBook,
          slug: otherBook,
          title: 'Another private book',
          description: 'Test fixture',
          goal: 'daily',
          ownerId: other,
        },
        {
          id: hiddenBook,
          slug: hiddenBook,
          title: 'Archived fixture',
          description: 'Test fixture',
          goal: 'daily',
          status: 'archived',
        },
      ],
    });
    await db.bookItem.createMany({
      data: [
        ...order.map((index, ordinal) => ({
          id: `${stem}-item-${index}`,
          bookId: publicBook,
          wordId: words[index]!.id,
          ordinal,
        })),
        ...[0, 1, 2].map((index, ordinal) => ({
          id: `${stem}-own-item-${index}`,
          bookId: ownBook,
          wordId: words[index]!.id,
          ordinal,
        })),
        ...[3, 4].map((index, ordinal) => ({
          id: `${stem}-other-item-${index}`,
          bookId: otherBook,
          wordId: words[index]!.id,
          ordinal,
        })),
      ],
    });
    await db.studyProgress.createMany({
      data: [
        ...[0, 2, 5].map((index) => ({
          userId: owner,
          wordId: words[index]!.id,
          firstLearnedAt: old,
          lastReviewAt: index === 0 ? recentA : index === 2 ? recentB : old,
          dueAt: now,
          fsrsJson: { state: 2, reps: index + 1 },
        })),
        {
          userId: owner,
          wordId: words[6]!.id,
          firstLearnedAt: null,
          dueAt: now,
          fsrsJson: { state: 0, reps: 0 },
        },
        {
          userId: other,
          wordId: words[1]!.id,
          firstLearnedAt: recentA,
          lastReviewAt: recentA,
          dueAt: now,
          fsrsJson: { state: 2, reps: 1 },
        },
      ],
    });
    await db.userWord.createMany({
      data: [
        { userId: owner, wordId: words[0]!.id },
        { userId: owner, wordId: words[2]!.id, graduatedAt: recentB },
        { userId: owner, wordId: words[5]!.id, paused: true },
        { userId: owner, wordId: words[4]!.id },
        { userId: other, wordId: words[0]!.id, paused: true },
      ],
    });
    await db.autoKnownWord.createMany({
      data: [
        { userId: owner, wordId: words[3]!.id, confirmedAt: recentA },
        { userId: owner, wordId: words[1]!.id, confirmedAt: old, revokedAt: recentA },
      ],
    });
    for (const [index, status] of [
      [4, 'confirmed'],
      [6, 'preview'],
    ] as const)
      await db.knownImport.create({
        data: {
          id: `${stem}-import-${index}`,
          userId: owner,
          status,
          rowsJson: [],
          countsJson: {},
          claims: { create: { userId: owner, wordId: words[index]!.id } },
        },
      });
    await db.reviewLog.createMany({
      data: [
        { userId: owner, wordId: words[0]!.id, commandId: `${stem}-new`, wasNew: true },
        { userId: owner, wordId: words[0]!.id, commandId: `${stem}-review-a`, wasNew: false },
        { userId: owner, wordId: words[0]!.id, commandId: `${stem}-review-b`, wasNew: false },
        { userId: other, wordId: words[0]!.id, commandId: `${stem}-other-review`, wasNew: false },
      ].map((row) => ({ ...row, rating: 'good', beforeState: {}, afterState: {} })),
    });
  }, 60000);
  afterAll(async () => {
    await db.book.deleteMany({
      where: { id: { in: [publicBook, ownBook, otherBook, hiddenBook] } },
    });
    await db.user.deleteMany({ where: { id: { in: [owner, other] } } });
    await db.word.deleteMany({ where: { id: { in: words.map((word) => word.id) } } });
    await db.lookupRevision.deleteMany({
      where: { scope: { in: [`user:${owner}`, `user:${other}`] } },
    });
    await db.$disconnect();
  }, 60000);

  it('includes every published book word before learning, with genuine progress and collection states', async () => {
    const before = await snapshot();
    const all = await list({ bookId: publicBook });
    expect(all.book).toEqual({ id: publicBook, title: 'Original public book' });
    expect(ids(all)).toEqual(order.map((index) => words[index]!.id));
    expect(all.page.total).toBe(8);
    expect(all.items.find((row) => row.word.id === words[1]!.id)?.progress).toBeNull();
    expect(all.items.find((row) => row.word.id === words[0]!.id)).toMatchObject({
      reviewCount: 2,
      paused: false,
      collection: { inWordbook: true, wordbookStatus: 'active' },
    });
    expect(all.items.find((row) => row.word.id === words[2]!.id)).toMatchObject({
      collection: { inWordbook: false, wordbookStatus: 'consolidated' },
    });
    expect(all.items.find((row) => row.word.id === words[1]!.id)).toMatchObject({
      collection: { inWordbook: false, wordbookStatus: null },
    });
    const unlearned = await list({ bookId: publicBook, view: 'unlearned', sort: 'az' });
    expect(ids(unlearned)).toEqual([1, 3, 4, 6, 7].map((index) => words[index]!.id));
    expect(ids(await list({ bookId: publicBook, view: 'known', sort: 'az' }))).toEqual(
      [3, 4].map((index) => words[index]!.id),
    );
    expect(ids(await list({ q: stem, view: 'recent' }))).toEqual(
      [0, 2].map((index) => words[index]!.id),
    );
    expect(ids(await list({ q: stem, view: 'learning', sort: 'recent' }))).toEqual(
      [0, 2].map((index) => words[index]!.id),
    );
    expect(ids(await list({ q: stem, view: 'learned', sort: 'recent' }))).toEqual(
      [0, 2, 5].map((index) => words[index]!.id),
    );
    expect(await snapshot()).toEqual(before);
  });

  it('globally sorts all pages rather than sorting each book-order page locally', async () => {
    expect(await collect({ bookId: publicBook, sort: 'book' })).toEqual(
      order.map((index) => words[index]!.id),
    );
    expect(await collect({ bookId: publicBook, sort: 'az' })).toEqual(
      words.slice(0, 8).map((word) => word.id),
    );
    expect(await collect({ bookId: publicBook, sort: 'za' })).toEqual(
      words
        .slice(0, 8)
        .reverse()
        .map((word) => word.id),
    );
    expect(await collect({ q: stem, view: 'learned', sort: 'recent' })).toEqual(
      [0, 2, 5].map((index) => words[index]!.id),
    );
    const page = await list({ bookId: publicBook, sort: 'az', limit: 2 });
    const next = await list({
      bookId: publicBook,
      sort: 'az',
      limit: 3,
      cursor: page.page.nextCursor!,
    });
    expect(ids(next)).toEqual([2, 3, 4].map((index) => words[index]!.id));
  });

  it('normalizes word search while treating SQL wildcard characters as literal text', async () => {
    const fullwidth = stem
      .toUpperCase()
      .split('')
      .map((letter) => String.fromCharCode(letter.charCodeAt(0) + 0xfee0))
      .join('');
    expect(ids(await list({ bookId: publicBook, q: fullwidth, sort: 'az' }))).toEqual(
      words.slice(0, 8).map((word) => word.id),
    );
    for (const q of ['%', '_', '\\'])
      expect((await list({ bookId: publicBook, q })).page.total).toBe(0);
  });

  it('uses a stable tiebreaker when recent dates are equal across page boundaries', async () => {
    await db.studyProgress.create({
      data: {
        userId: owner,
        wordId: words[7]!.id,
        firstLearnedAt: old,
        lastReviewAt: recentB,
        dueAt: now,
        fsrsJson: { state: 2, reps: 1 },
      },
    });
    try {
      expect(await collect({ q: stem, view: 'learned', sort: 'recent' })).toEqual(
        [0, 7, 2, 5].map((index) => words[index]!.id),
      );
    } finally {
      await db.studyProgress.delete({
        where: { userId_wordId: { userId: owner, wordId: words[7]!.id } },
      });
    }
  });

  it('locates the actual word under the current filters and continues after that anchor exactly once', async () => {
    const located = await list({
      bookId: publicBook,
      sort: 'book',
      locate: words[5]!.id,
      limit: 2,
    });
    expect(ids(located)).toEqual([5, 0].map((index) => words[index]!.id));
    expect(located.page).toMatchObject({ anchorWordId: words[5]!.id, total: 8, hasMore: true });
    const next = await list({
      bookId: publicBook,
      sort: 'book',
      cursor: located.page.nextCursor!,
      limit: 2,
    });
    expect(ids(next)).toEqual([3, 2].map((index) => words[index]!.id));
    await expect(
      list({ bookId: publicBook, view: 'unlearned', locate: words[0]!.id }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'library_anchor_not_found' });
    await expect(
      list({ bookId: publicBook, q: `${stem}c`, locate: words[0]!.id }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'library_anchor_not_found' });
    await expect(list({ bookId: publicBook, locate: words[8]!.id })).rejects.toMatchObject({
      statusCode: 404,
      code: 'library_anchor_not_found',
    });
  });

  it('enforces private-book ownership even for administrators and never accepts user or site selectors', async () => {
    expect(ids(await list({ bookId: ownBook }))).toEqual(
      [0, 1, 2].map((index) => words[index]!.id),
    );
    await expect(list({ bookId: ownBook }, asOther)).rejects.toMatchObject({
      statusCode: 404,
      code: 'book_not_found',
    });
    await expect(list({ bookId: otherBook })).rejects.toMatchObject({
      statusCode: 404,
      code: 'book_not_found',
    });
    await expect(list({ bookId: hiddenBook })).rejects.toMatchObject({
      statusCode: 404,
      code: 'book_not_found',
    });
    await expect(list({ bookId: publicBook }, { ...context, user: null })).rejects.toMatchObject({
      statusCode: 401,
    });
    for (const invalid of [
      { bookId: publicBook, userId: other },
      { bookId: publicBook, siteId: 'another-site' },
    ])
      await expect(list(invalid)).rejects.toMatchObject({ statusCode: 400, code: 'invalid_input' });
  });

  it('rejects valid cursors reused across user, realm, book, filter or ordering conditions', async () => {
    const first = await list({ bookId: publicBook, sort: 'az', limit: 2 });
    const cursor = first.page.nextCursor!;
    for (const ctx of [
      asOther,
      { ...context, siteId: 'different-site' },
      { ...context, instanceId: 'different-instance' },
      { ...context, basePath: '/another-mount' },
    ])
      await expect(list({ bookId: publicBook, sort: 'az', cursor }, ctx)).rejects.toMatchObject({
        statusCode: 400,
        code: 'invalid_cursor',
      });
    for (const query of [
      { bookId: ownBook, sort: 'az' },
      { bookId: publicBook, sort: 'za' },
      { bookId: publicBook, sort: 'az', view: 'unlearned' },
      { bookId: publicBook, sort: 'az', q: stem },
    ])
      await expect(list({ ...query, cursor })).rejects.toMatchObject({
        statusCode: 400,
        code: 'invalid_cursor',
      });
    const payload = JSON.parse(Buffer.from(cursor.split('.')[0]!, 'base64url').toString('utf8'));
    const expired = libraryBrowseCursor(
      context,
      payload.scope,
      payload.revision,
      payload.key,
      Date.now() - 16 * 60 * 1000,
    );
    await expect(list({ bookId: publicBook, sort: 'az', cursor: expired })).rejects.toMatchObject({
      statusCode: 410,
      code: 'cursor_expired',
    });
  });

  it('invalidates cursors after progress updates, changed book order, known imports and catalog edits', async () => {
    const expectChanged = async (change: () => Promise<unknown>) => {
      const first = await list({ bookId: publicBook, sort: 'az', limit: 2 });
      await change();
      await expect(
        list({ bookId: publicBook, sort: 'az', cursor: first.page.nextCursor! }),
      ).rejects.toMatchObject({ statusCode: 409, code: 'list_changed' });
    };
    try {
      await expectChanged(() =>
        db.studyProgress.update({
          where: { userId_wordId: { userId: owner, wordId: words[0]!.id } },
          data: { lastReviewAt: now, revision: { increment: 1 } },
        }),
      );
      await expectChanged(() =>
        db.bookItem.update({ where: { id: `${stem}-item-6` }, data: { ordinal: 8 } }),
      );
      await expectChanged(() =>
        db.knownImport.update({ where: { id: `${stem}-import-4` }, data: { status: 'revoked' } }),
      );
      await expectChanged(() =>
        db.autoKnownWord.update({
          where: { userId_wordId: { userId: owner, wordId: words[3]!.id } },
          data: { revokedAt: now },
        }),
      );
      await expectChanged(() =>
        db.knownClaim.updateMany({
          where: { importId: `${stem}-import-6` },
          data: { createdAt: recentA },
        }),
      );
      await expectChanged(() =>
        db.book.update({
          where: { id: publicBook },
          data: { title: 'Edited original public fixture' },
        }),
      );
      await expectChanged(() =>
        db.word.update({ where: { id: words[7]!.id }, data: { status: 'archived' } }),
      );
    } finally {
      await db.studyProgress.update({
        where: { userId_wordId: { userId: owner, wordId: words[0]!.id } },
        data: { lastReviewAt: recentA },
      });
      await db.bookItem.update({ where: { id: `${stem}-item-6` }, data: { ordinal: 0 } });
      await db.knownImport.update({
        where: { id: `${stem}-import-4` },
        data: { status: 'confirmed' },
      });
      await db.autoKnownWord.update({
        where: { userId_wordId: { userId: owner, wordId: words[3]!.id } },
        data: { revokedAt: null },
      });
      await db.book.update({ where: { id: publicBook }, data: { title: 'Original public book' } });
      await db.word.update({ where: { id: words[7]!.id }, data: { status: 'published' } });
    }
  });
});
