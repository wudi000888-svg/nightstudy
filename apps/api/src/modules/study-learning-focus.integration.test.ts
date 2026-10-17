import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Client } from 'pg';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase } from '../db.js';
import { HttpError, type RequestContext } from '../context.js';
import { registerStudy } from './study.js';
import { registerKnown } from './known.js';
import { registerContent } from './content.js';
import { freshCard, json, obj } from './shared.js';
import { learningSenseBindingHash, learningSenseTextHash } from './learning-sense-integrity.js';
import {
  builtInDefaultBooks,
  isBuiltInDefaultBook,
  loadAcceptedReviewFocusIds,
} from './study-learning-focus.js';
import { updateLearningPreferences } from './learning-preferences.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('PostgreSQL installed-book first meaning and accepted historical review focus', () => {
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('study_focus_requires_disposable_test_database');
  const db = createDatabase(url),
    stem = 'study-focus-' + randomUUID();
  const wordId = stem + '-grammar',
    oldSourceId = stem + '-old-book-source';
  const ruleSourceId = stem + '-original-rules-source';
  const ruleMeaningId = stem + '-rules',
    bookMeaningId = stem + '-book';
  const spec = builtInDefaultBooks.find((book) => book.goal === 'daily')!;
  const actors: string[] = [],
    books: string[] = [];
  let installedFixture = false,
    madeWord = false,
    app: FastifyInstance;
  const ctx: RequestContext = {
    siteId: 'focus-test',
    instanceId: stem,
    basePath: '',
    publicUrl: 'http://focus.test',
    title: 'Original synthetic focus test',
    fleetSecret: 'synthetic-focus-secret'.repeat(4),
    registrationOpen: false,
    user: null,
    prisma: db,
  };
  async function good(userId: string, method: 'GET' | 'POST', path: string, payload?: unknown) {
    ctx.user = {
      id: userId,
      email: userId + '@example.test',
      name: 'Synthetic focus',
      role: 'user',
    };
    const result = await app.inject({
      method,
      url: path,
      ...(payload === undefined
        ? {}
        : { payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }),
    });
    expect(result.statusCode, result.body).toBe(200);
    return result.json();
  }
  async function actor(selectedBook = spec.id, spelling = false) {
    const id = stem + '-actor-' + actors.length;
    await db.user.create({ data: { id, name: 'Synthetic focus', email: id + '@example.test' } });
    actors.push(id);
    await db.userSettings.create({
      data: {
        userId: id,
        goal: 'daily',
        currentBookId: selectedBook,
        dailyTotalGoal: 1,
        dailyNewLimit: 1,
        groupSize: 1,
      },
    });
    await db.userLearningPreference.create({
      data: { userId: id, spellingEnabled: spelling, meaningChoiceEnabled: false },
    });
    return id;
  }
  async function customBook(ownerId: string | null, focusSenseId = oldSourceId) {
    const id = stem + '-book-' + books.length;
    await db.book.create({
      data: {
        id,
        slug: id,
        title: 'Original synthetic grammar',
        description: 'Synthetic source focus',
        ownerId,
        goal: 'daily',
        version: 'authored-synthetic',
        items: { create: { wordId, focusSenseId, ordinal: 0 } },
      },
    });
    books.push(id);
    return id;
  }
  const issue = async (userId: string, mode = 'learn') =>
    (await good(userId, 'POST', '/study/sessions', { mode, size: 1, commandId: randomUUID() }))
      .session;
  async function rate(userId: string, session: any) {
    const item = session.items[0];
    session = (
      await good(userId, 'POST', '/study/sessions/' + session.id + '/commands', {
        commandId: randomUUID(),
        itemId: item.id,
        action: 'reveal',
        expectedSessionRevision: session.revision,
      })
    ).session;
    return (
      await good(userId, 'POST', '/study/sessions/' + session.id + '/commands', {
        commandId: randomUUID(),
        itemId: item.id,
        action: 'rate',
        rating: 'good',
        expectedSessionRevision: session.revision,
        expectedProgressRevision: item.progressRevision,
      })
    ).session;
  }
  async function selectBook(userId: string, bookId: string) {
    await db.$transaction((tx) => updateLearningPreferences(tx, userId, { currentBookId: bookId }));
  }
  async function makeDue(userId: string) {
    const current = await db.studyProgress.findUniqueOrThrow({
      where: { userId_wordId: { userId, wordId } },
    });
    const due = new Date(Date.now() - 60000);
    await db.studyProgress.update({
      where: { id: current.id },
      data: {
        dueAt: due,
        fsrsJson: json({ ...obj(current.fsrsJson), due: due.toISOString() }),
      },
    });
  }
  beforeAll(async () => {
    expect(await db.book.findUnique({ where: { id: spec.id } })).toBeNull();
    expect(await db.contentPack.findUnique({ where: { id: spec.packId } })).toBeNull();
    expect(await db.word.findUnique({ where: { normalizedLemma: 'grammar' } })).toBeNull();
    await db.word.create({
      data: {
        id: wordId,
        lemma: 'grammar',
        normalizedLemma: 'grammar',
        goalTags: ['daily'],
        sourceRef: 'Original synthetic grammar test',
        contentVersion: stem,
      },
    });
    madeWord = true;
    for (const [sourceId, meaningId, zh, en, ordinal] of [
      [oldSourceId, bookMeaningId, '入门语法书', 'An introductory book explaining grammar.', 1],
      [
        ruleSourceId,
        ruleMeaningId,
        '语言结构的规则体系',
        'The system of rules governing the structure of a language.',
        0,
      ],
    ] as const) {
      const source = await db.sense.create({
        data: {
          id: sourceId,
          wordId,
          pos: 'n.',
          // Reproduce grammar's pinned old source shape, not just a source
          // already narrowed to the book. The new original source sorts last.
          definitionZh: sourceId === oldSourceId ? '语法学, 入门书' : zh,
          definitionEn:
            sourceId === oldSourceId
              ? 'The study of the structure and rules of a language; an introductory textbook.'
              : en,
          ordinal: sourceId === oldSourceId ? 0 : 1000001,
        },
      });
      const binding = {
        sourceSenseId: sourceId,
        relation: sourceId === oldSourceId ? 'narrower' : 'exact',
        sourcePosSha256: learningSenseTextHash(source.pos),
        sourceDefinitionZhSha256: learningSenseTextHash(source.definitionZh),
        sourceDefinitionEnSha256: learningSenseTextHash(source.definitionEn),
      };
      const meaning = {
        id: meaningId,
        wordId,
        pos: 'n.',
        definitionZh: zh,
        definitionEn: en,
        contentVersion: stem,
      };
      await db.learningSense.create({
        data: {
          ...meaning,
          ordinal,
          status: 'published',
          bindingHash: learningSenseBindingHash({ ...meaning, sourceBindings: [binding] }),
        },
      });
      await db.senseSourceBinding.create({
        data: {
          ...binding,
          id: meaningId + '-binding',
          wordId,
          learningSenseId: meaningId,
        },
      });
    }
    await db.contentPack.create({
      data: {
        id: spec.packId,
        version: spec.packVersion,
        sha256: spec.packSha256,
        status: 'ready',
        sourceUrl: 'https://example.test/original-synthetic-registered-pack-fixture',
        license: 'MIT',
        entryCount: 1,
        phoneticCount: 0,
        definitionZhCount: 1,
        definitionEnCount: 1,
        tagCounts: {},
      },
    });
    installedFixture = true;
    await db.book.create({
      data: {
        id: spec.id,
        slug: spec.slug,
        goal: spec.goal,
        kind: spec.kind,
        version: spec.version,
        title: 'Original synthetic installed identity',
        description: 'Synthetic test, not a content installation',
        items: { create: { wordId, focusSenseId: oldSourceId, ordinal: 0 } },
      },
    });
    books.push(spec.id);
    app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof HttpError) reply.code(error.statusCode).send({ code: error.code });
      else reply.send(error);
    });
    await registerStudy(app, async () => ctx);
    await registerKnown(app, async () => ctx);
    await registerContent(app, async () => ctx);
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    if (actors.length) await db.user.deleteMany({ where: { id: { in: actors } } });
    if (books.length) await db.book.deleteMany({ where: { id: { in: books } } });
    if (madeWord) {
      await db.senseSourceBinding.deleteMany({ where: { wordId } });
      await db.learningSense.deleteMany({ where: { wordId } });
      await db.word.deleteMany({
        where: { id: wordId, sourceRef: 'Original synthetic grammar test' },
      });
    }
    if (installedFixture)
      await db.contentPack.deleteMany({
        where: {
          id: spec.packId,
          sourceUrl: 'https://example.test/original-synthetic-registered-pack-fixture',
        },
      });
    await db.$disconnect();
  });
  it('replaces the installed old grammar-book default with the reviewed first meaning without rewriting book rows or issued snapshots', async () => {
    expect(await isBuiltInDefaultBook(db, spec.id)).toBe(true);
    const userId = await actor(),
      session = await issue(userId);
    expect(session.items[0].focusSenseId).toBe(ruleMeaningId);
    const original = await db.sessionItem.findUniqueOrThrow({ where: { id: session.items[0].id } });
    expect(obj(original.questionJson).explanation).toBe('语言结构的规则体系');
    expect((await db.bookItem.findFirstOrThrow({ where: { bookId: spec.id } })).focusSenseId).toBe(
      oldSourceId,
    );
    await db.bookItem.updateMany({
      where: { bookId: spec.id },
      data: { focusSenseId: bookMeaningId },
    });
    try {
      expect(
        (await good(userId, 'GET', '/study/sessions/' + session.id)).session.items[0].focusSenseId,
      ).toBe(ruleMeaningId);
      const after = await db.sessionItem.findUniqueOrThrow({ where: { id: original.id } });
      expect(after.contentSnapshot).toEqual(original.contentSnapshot);
      expect(after.questionJson).toEqual(original.questionJson);
    } finally {
      await db.bookItem.updateMany({
        where: { bookId: spec.id },
        data: { focusSenseId: oldSourceId },
      });
    }
  });
  it('preserves administrator-created and personal-book source choices as well as exact atomic choices in an installed book', async () => {
    const adminBook = await customBook(null),
      adminReader = await actor(adminBook);
    expect((await issue(adminReader)).items[0].focusSenseId).toBe(bookMeaningId);
    const owner = await actor(),
      privateBook = await customBook(owner);
    await selectBook(owner, privateBook);
    expect((await issue(owner)).items[0].focusSenseId).toBe(bookMeaningId);
    await db.bookItem.updateMany({
      where: { bookId: spec.id },
      data: { focusSenseId: bookMeaningId },
    });
    try {
      expect((await issue(await actor())).items[0].focusSenseId).toBe(bookMeaningId);
    } finally {
      await db.bookItem.updateMany({
        where: { bookId: spec.id },
        data: { focusSenseId: oldSourceId },
      });
    }
  });
  it('fails closed after a book edit, pack drift or personal-import association, instead of guessing from catalog-looking text', async () => {
    await db.book.update({ where: { id: spec.id }, data: { version: 'authored-edited' } });
    try {
      expect(await isBuiltInDefaultBook(db, spec.id)).toBe(false);
      expect((await issue(await actor())).items[0].focusSenseId).toBe(bookMeaningId);
    } finally {
      await db.book.update({ where: { id: spec.id }, data: { version: spec.version } });
    }
    await db.contentPack.update({ where: { id: spec.packId }, data: { sha256: 'f'.repeat(64) } });
    try {
      expect((await issue(await actor())).items[0].focusSenseId).toBe(bookMeaningId);
    } finally {
      await db.contentPack.update({
        where: { id: spec.packId },
        data: { sha256: spec.packSha256 },
      });
    }
    const owner = await actor(),
      importId = stem + '-import-association';
    await db.customBookImport.create({
      data: {
        id: importId,
        userId: owner,
        bookId: spec.id,
        title: 'Synthetic conflicting association',
        description: '',
        goal: 'daily',
        filename: 'synthetic.txt',
        format: 'txt',
        sha256: 'a'.repeat(64),
        rowsJson: [],
        countsJson: {},
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    try {
      expect(await isBuiltInDefaultBook(db, spec.id)).toBe(false);
      expect((await issue(owner)).items[0].focusSenseId).toBe(bookMeaningId);
    } finally {
      await db.customBookImport.delete({ where: { id: importId } });
    }
  });
  it('preserves actually accepted rated focus after whole-session cancellation for same-day repeat and extra review', async () => {
    for (const mode of ['daily', 'extra-review']) {
      const userId = await actor(spec.id, true),
        privateBook = await customBook(userId);
      await selectBook(userId, privateBook);
      const first = await issue(userId);
      expect(first.items[0].focusSenseId).toBe(bookMeaningId);
      const rated = await rate(userId, first);
      const pointer = await db.studyProgress.findUniqueOrThrow({
        where: { userId_wordId: { userId, wordId } },
      });
      expect(pointer.reviewFocusSenseId).toBe(bookMeaningId);
      expect(pointer.reviewFocusRevision).toBe(pointer.revision);
      expect(rated.status).toBe('in_progress');
      expect(rated.phase).toBe('practice');
      expect(await db.reviewLog.count({ where: { userId } })).toBe(1);
      const frozen = await db.sessionItem.findUniqueOrThrow({ where: { id: first.items[0].id } });
      await selectBook(userId, spec.id);
      expect((await db.studySession.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
        'cancelled',
      );
      await makeDue(userId);
      const history = await loadAcceptedReviewFocusIds(db, userId, [wordId]);
      expect(history.get(wordId)).toBe(bookMeaningId);
      const review = await issue(userId, mode);
      expect(review.items[0].bucket).toBe('review');
      expect(review.items[0].focusSenseId).toBe(bookMeaningId);
      expect(
        (await db.sessionItem.findUniqueOrThrow({ where: { id: frozen.id } })).contentSnapshot,
      ).toEqual(frozen.contentSnapshot);
      expect(await db.reviewLog.count({ where: { userId } })).toBe(1);
    }
  });
  it('excludes cancelled unrated items and other users accepted ratings', async () => {
    const userId = await actor(),
      privateBook = await customBook(userId);
    await selectBook(userId, privateBook);
    const abandoned = await issue(userId);
    expect(abandoned.items[0].focusSenseId).toBe(bookMeaningId);
    await selectBook(userId, spec.id);
    const past = new Date(Date.now() - 86400000),
      due = new Date(Date.now() - 60000);
    await db.studyProgress.create({
      data: {
        userId,
        wordId,
        revision: 1,
        firstLearnedAt: past,
        lastReviewAt: past,
        dueAt: due,
        fsrsJson: json(freshCard(past)),
      },
    });
    expect(await db.reviewLog.count({ where: { userId } })).toBe(0);
    expect(await loadAcceptedReviewFocusIds(db, userId, [wordId])).toEqual(new Map());
    const review = await issue(userId, 'extra-review');
    expect(review.items[0].focusSenseId).toBe(ruleMeaningId);
    expect(review.items[0].bucket).toBe('review');
    expect(
      (await db.sessionItem.findUniqueOrThrow({ where: { id: abandoned.items[0].id } })).rated,
    ).toBe(false);
  });
  it('rejects a now-invalid historical binding and orders accepted ratings by their actual progress revision', async () => {
    const userId = await actor(),
      privateBook = await customBook(userId);
    await selectBook(userId, privateBook);
    const first = await rate(userId, await issue(userId));
    expect(first.status).toBe('completed');
    await makeDue(userId);
    const source = await db.sense.findUniqueOrThrow({ where: { id: oldSourceId } });
    await db.sense.update({
      where: { id: oldSourceId },
      data: { definitionZh: source.definitionZh + ' drift' },
    });
    let second: any;
    try {
      const review = await issue(userId, 'extra-review');
      expect(review.items[0].focusSenseId).toBe(ruleMeaningId);
      second = await rate(userId, review);
    } finally {
      await db.sense.update({
        where: { id: oldSourceId },
        data: { definitionZh: source.definitionZh },
      });
    }
    expect(await db.reviewLog.count({ where: { userId } })).toBe(2);
    // A session's creation time must not trump a later accepted progress revision.
    await db.studySession.update({
      where: { id: first.id },
      data: { createdAt: new Date(Date.now() + 60000) },
    });
    expect((await loadAcceptedReviewFocusIds(db, userId, [wordId])).get(wordId)).toBe(
      ruleMeaningId,
    );
    await makeDue(userId);
    const third = await issue(userId, 'extra-review');
    expect(third.items[0].focusSenseId).toBe(ruleMeaningId);
    expect(second.items[0].focusSenseId).toBe(ruleMeaningId);
  });
  it('writes no pointer on issue, reveal, preference change or collection import, and rolls a late rating failure back', async () => {
    const userId = await actor(),
      session = await issue(userId),
      item = session.items[0];
    expect(await db.studyProgress.count({ where: { userId } })).toBe(0);
    const revealed = (
      await good(userId, 'POST', '/study/sessions/' + session.id + '/commands', {
        commandId: randomUUID(),
        itemId: item.id,
        action: 'reveal',
        expectedSessionRevision: session.revision,
      })
    ).session;
    expect(await db.studyProgress.count({ where: { userId } })).toBe(0);
    // Real collection and import APIs may change familiarity, never fabricate a
    // rating or a current review pointer.
    await good(userId, 'POST', '/wordbook', { wordId });
    const imported = await good(userId, 'POST', '/known-words/imports', {
      format: 'text',
      text: 'grammar',
    });
    await good(userId, 'POST', '/known-words/imports/' + imported.import.id + '/confirm', {});
    expect(await db.studyProgress.count({ where: { userId } })).toBe(0);
    const triggerName = 'focus_fail_' + randomUUID().replaceAll('-', '');
    await db.$executeRawUnsafe(
      'CREATE FUNCTION "' +
        triggerName +
        '"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."userId"=' +
        "'" +
        userId +
        "'" +
        " THEN RAISE EXCEPTION 'synthetic_late_rating_failure'; END IF; RETURN NEW; END; $$",
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER "' +
        triggerName +
        '" BEFORE INSERT ON "ReviewLog" FOR EACH ROW EXECUTE FUNCTION "' +
        triggerName +
        '"()',
    );
    try {
      ctx.user = {
        id: userId,
        email: userId + '@example.test',
        name: 'Synthetic focus',
        role: 'user',
      };
      const failed = await app.inject({
        method: 'POST',
        url: '/study/sessions/' + session.id + '/commands',
        payload: {
          commandId: randomUUID(),
          itemId: item.id,
          action: 'rate',
          rating: 'good',
          expectedSessionRevision: revealed.revision,
          expectedProgressRevision: item.progressRevision,
        },
      });
      expect(failed.statusCode).toBe(500);
      expect(await db.studyProgress.count({ where: { userId } })).toBe(0);
      expect(await db.reviewLog.count({ where: { userId } })).toBe(0);
      expect((await db.sessionItem.findUniqueOrThrow({ where: { id: item.id } })).rated).toBe(
        false,
      );
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER "' + triggerName + '" ON "ReviewLog"');
      await db.$executeRawUnsafe('DROP FUNCTION "' + triggerName + '"()');
    }
    await selectBook(userId, spec.id);
    expect(await db.studyProgress.count({ where: { userId } })).toBe(0);
  });
  it('treats a held or raw historical pointer as a choice only after current source verification', async () => {
    await db.learningSense.update({ where: { id: bookMeaningId }, data: { status: 'published' } });
    const userId = await actor(),
      privateBook = await customBook(userId);
    await selectBook(userId, privateBook);
    await rate(userId, await issue(userId));
    const progress = await db.studyProgress.findUniqueOrThrow({
      where: { userId_wordId: { userId, wordId } },
    });
    await db.studyProgress.update({
      where: { id: progress.id },
      data: { reviewFocusSenseId: oldSourceId },
    });
    await makeDue(userId);
    // A raw source ID is historical identity, not a DTO containing raw definitions.
    expect((await issue(userId, 'extra-review')).items[0].focusSenseId).toBe(bookMeaningId);
    await selectBook(userId, spec.id);
    await db.learningSense.update({ where: { id: bookMeaningId }, data: { status: 'held' } });
    try {
      const next = await issue(userId, 'extra-review');
      expect(next.items[0].focusSenseId).toBe(ruleMeaningId);
      const frozen = obj(
        (await db.sessionItem.findUniqueOrThrow({ where: { id: next.items[0].id } }))
          .contentSnapshot,
      );
      expect(JSON.stringify(frozen)).not.toContain('An introductory book explaining grammar.');
    } finally {
      await db.learningSense.update({
        where: { id: bookMeaningId },
        data: { status: 'published' },
      });
    }
  });
});

const pointerMigration = fs.readFileSync(
  new URL(
    '../../../../prisma/migrations/20261016081000_review_focus_pointer/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
suite('PostgreSQL review focus migration on temporary copies of the exact old table shapes', () => {
  async function oldFixture(client: Client) {
    for (const name of ['StudyProgress', 'StudySession', 'SessionItem', 'LookupRevision']) {
      await client.query(
        'CREATE TEMP TABLE "' +
          name +
          '" (LIKE public."' +
          name +
          '" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)',
      );
    }
    await client.query(
      'ALTER TABLE "StudyProgress" DROP COLUMN "reviewFocusSenseId", DROP COLUMN "reviewFocusRevision"',
    );
    await client.query(
      'CREATE TRIGGER "lookup_study_progress" AFTER INSERT OR UPDATE OR DELETE ON "StudyProgress" FOR EACH ROW EXECUTE FUNCTION nightstudy_lookup_collection_changed()',
    );
    await client.query(`INSERT INTO "StudyProgress"(id,"userId","wordId","fsrsJson","dueAt","firstLearnedAt","lastReviewAt",revision,"updatedAt")
      VALUES ('p','reader','word','{}',now(),now(),now(),2,now()),('other-p','other','word','{}',now(),now(),now(),1,now()),('unrated-p','reader','unrated','{}',now(),now(),now(),1,now())`);
    for (const [id, user, status, rev, rated, revealed, focus, word] of [
      ['old', 'reader', 'completed', 1, true, true, 'older-focus', 'word'],
      ['new', 'reader', 'cancelled', 2, true, true, 'accepted-focus', 'word'],
      ['future', 'reader', 'completed', 3, true, true, 'future-focus', 'word'],
      ['abandoned', 'reader', 'cancelled', 2, false, true, 'abandoned-focus', 'word'],
      ['unrevealed', 'reader', 'completed', 2, true, false, 'unrevealed-focus', 'word'],
      ['foreign', 'other', 'completed', 1, true, true, 'other-focus', 'word'],
      ['only-unrated', 'reader', 'cancelled', 1, false, true, 'unrated-focus', 'unrated'],
    ] as const) {
      await client.query(
        `INSERT INTO "StudySession"(id,"userId",mode,status,"createdAt","updatedAt") VALUES ($1,$2,'review',$3,$4,now())`,
        [id, user, status, id === 'old' ? new Date('2030-01-01') : new Date('2026-01-01')],
      );
      await client.query(
        `INSERT INTO "SessionItem"(id,"sessionId","wordId","focusSenseId",ordinal,"contentSnapshot","questionJson",rated,revealed,status,"progressRevision") VALUES ($1,$1,$2,$3,0,'{}','{}',$4,$5,$6,$7)`,
        [id, word, focus, rated, revealed, rated ? 'rated' : 'pending', rev],
      );
    }
  }
  const read = async (client: Client, table: string, minus = '') =>
    (
      await client.query(
        'SELECT (to_jsonb(t)' + minus + ') AS row FROM "' + table + '" t ORDER BY id',
      )
    ).rows;
  it('backfills only genuine accepted history while preserving all original columns, snapshots and lookup revisions', async () => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await oldFixture(client);
      const before = await read(client, 'StudyProgress'),
        snapshots = await read(client, 'SessionItem');
      const revisions = (await client.query('SELECT * FROM "LookupRevision" ORDER BY scope')).rows;
      await client.query(pointerMigration);
      expect(
        await read(client, 'StudyProgress', ` - 'reviewFocusSenseId' - 'reviewFocusRevision'`),
      ).toEqual(before);
      expect(await read(client, 'SessionItem')).toEqual(snapshots);
      expect((await client.query('SELECT * FROM "LookupRevision" ORDER BY scope')).rows).toEqual(
        revisions,
      );
      expect(
        (
          await client.query(
            'SELECT id,"reviewFocusSenseId","reviewFocusRevision" FROM "StudyProgress" ORDER BY id',
          )
        ).rows,
      ).toEqual([
        { id: 'other-p', reviewFocusSenseId: 'other-focus', reviewFocusRevision: 1 },
        { id: 'p', reviewFocusSenseId: 'accepted-focus', reviewFocusRevision: 2 },
        { id: 'unrated-p', reviewFocusSenseId: null, reviewFocusRevision: 0 },
      ]);
      await expect(
        client.query(`UPDATE "StudyProgress" SET "reviewFocusRevision"=3 WHERE id='p'`),
      ).rejects.toThrow('StudyProgress_review_focus_pair_check');
      expect(
        (
          await client.query(
            `SELECT tgenabled FROM pg_trigger WHERE tgrelid='"StudyProgress"'::regclass AND tgname='lookup_study_progress'`,
          )
        ).rows[0].tgenabled,
      ).toBe('O');
    } finally {
      await client.end();
    }
  });
  it('rolls the exact trigger state and all derived DDL back after a failure while it is disabled', async () => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await oldFixture(client);
      const before = await read(client, 'StudyProgress');
      await expect(
        client.query(
          pointerMigration.replace('WITH accepted AS (', 'SELECT 1/0;\nWITH accepted AS ('),
        ),
      ).rejects.toThrow('division by zero');
      await client.query('ROLLBACK');
      expect(await read(client, 'StudyProgress')).toEqual(before);
      expect(
        (
          await client.query(
            `SELECT tgenabled FROM pg_trigger WHERE tgrelid='"StudyProgress"'::regclass AND tgname='lookup_study_progress'`,
          )
        ).rows[0].tgenabled,
      ).toBe('O');
      const columns = (
        await client.query(
          `SELECT attname FROM pg_attribute WHERE attrelid='"StudyProgress"'::regclass AND NOT attisdropped AND attnum>0`,
        )
      ).rows.map((row) => row.attname);
      expect(columns).not.toContain('reviewFocusSenseId');
      expect(columns).not.toContain('reviewFocusRevision');
    } finally {
      await client.end();
    }
  });
  it('aborts if the expected trigger has already been disabled rather than changing its prior state', async () => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await oldFixture(client);
      await client.query('ALTER TABLE "StudyProgress" DISABLE TRIGGER "lookup_study_progress"');
      await expect(client.query(pointerMigration)).rejects.toThrow(
        'review_focus_expected_lookup_trigger_missing_or_changed',
      );
      await client.query('ROLLBACK');
      expect(
        (
          await client.query(
            `SELECT tgenabled FROM pg_trigger WHERE tgrelid='"StudyProgress"'::regclass AND tgname='lookup_study_progress'`,
          )
        ).rows[0].tgenabled,
      ).toBe('D');
      const columns = (
        await client.query(
          `SELECT attname FROM pg_attribute WHERE attrelid='"StudyProgress"'::regclass AND NOT attisdropped AND attnum>0`,
        )
      ).rows.map((row) => row.attname);
      expect(columns).not.toContain('reviewFocusSenseId');
    } finally {
      await client.end();
    }
  });
});
