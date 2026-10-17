import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase } from '../db.js';
import { HttpError, type RequestContext } from '../context.js';
import { registerStudy } from './study.js';
import { registerLearningLibrary } from './learning-library.js';
import { learningSenseBindingHash, learningSenseTextHash } from './learning-sense-integrity.js';
import { freshCard, json, obj } from './shared.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('PostgreSQL durable recognition reveal without fabricated memory evidence', () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('recognition_requires_test_database');
  const db = createDatabase(url),
    stem = 'recognition-' + randomUUID(),
    own = stem + '-owner',
    other = stem + '-other',
    bookId = stem + '-book';
  const ids = Array.from({ length: 4 }, (_, i) => stem + '-word-' + i);
  const actors = [own, other];
  const ctx: RequestContext = {
    siteId: 'recognition-test',
    instanceId: stem,
    basePath: '',
    publicUrl: 'http://recognition.test',
    title: 'Recognition test',
    fleetSecret: 'synthetic-recognition-secret'.repeat(3),
    registrationOpen: false,
    prisma: db,
    user: { id: own, name: 'Test', email: own + '@example.test', role: 'user' },
  };
  let app: FastifyInstance;
  async function open() {
    const server = Fastify();
    server.setErrorHandler((error, _req, reply) => {
      if (error instanceof HttpError) reply.code(error.statusCode).send({ code: error.code });
      else reply.send(error);
    });
    await registerStudy(server, async () => ctx);
    await registerLearningLibrary(server, async () => ctx);
    await server.ready();
    return server;
  }
  const request = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown) =>
    app.inject({
      method,
      url: path,
      ...(payload === undefined
        ? {}
        : { payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }),
    });
  const good = async (method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown) => {
    const r = await request(method, path, payload);
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };
  beforeAll(async () => {
    for (const userId of [own, other])
      await db.user.create({
        data: { id: userId, email: userId + '@example.test', name: 'Synthetic recognition' },
      });
    const lemmas = ['bridge', 'window', 'mountain', 'ticket'],
      zh = ['桥梁', '窗户', '山峰', '票券'];
    for (let i = 0; i < ids.length; i++) {
      const wordId = ids[i]!,
        sourceId = wordId + '-source',
        senseId = wordId + '-meaning',
        definitionEn = 'An original test meaning ' + i;
      await db.word.create({
        data: {
          id: wordId,
          lemma: lemmas[i] + ' ' + stem,
          normalizedLemma: lemmas[i] + ' ' + stem,
          goalTags: ['daily'],
          contentVersion: stem,
        },
      });
      const source = await db.sense.create({
        data: { id: sourceId, wordId, pos: 'n.', definitionZh: zh[i]!, definitionEn },
      });
      const binding = {
        sourceSenseId: sourceId,
        relation: 'exact',
        sourcePosSha256: learningSenseTextHash(source.pos),
        sourceDefinitionZhSha256: learningSenseTextHash(source.definitionZh),
        sourceDefinitionEnSha256: learningSenseTextHash(source.definitionEn),
      };
      const sense = {
        id: senseId,
        wordId,
        pos: 'n.',
        definitionZh: zh[i]!,
        definitionEn,
        contentVersion: stem,
      };
      await db.learningSense.create({
        data: {
          ...sense,
          status: 'published',
          contentMetadata: {
            orthography: {
              displayLemma: (lemmas[i] + ' ' + stem).toUpperCase(),
              normalizedLemma: lemmas[i] + ' ' + stem,
              displayLemmaSha256: learningSenseTextHash((lemmas[i] + ' ' + stem).toUpperCase()),
              reviewer: 'Codex',
              decision: 'publish',
              expertCertified: false,
              reason: 'Synthetic explicit spelling review for a case-sensitive issued meaning.',
            },
          },
          bindingHash: learningSenseBindingHash({ ...sense, sourceBindings: [binding] }),
        },
      });
      await db.senseSourceBinding.create({
        data: { ...binding, id: senseId + '-binding', wordId, learningSenseId: senseId },
      });
    }
    await db.book.create({
      data: {
        id: bookId,
        slug: bookId,
        title: 'Synthetic meaning book',
        description: 'Test only',
        goal: 'daily',
        ownerId: own,
        items: {
          create: ids.map((wordId, ordinal) => ({
            wordId,
            ordinal,
            focusSenseId: wordId + '-meaning',
          })),
        },
      },
    });
    await db.userSettings.create({
      data: {
        userId: own,
        currentBookId: bookId,
        dailyTotalGoal: 4,
        dailyNewLimit: 4,
        groupSize: 1,
      },
    });
    await db.userLearningPreference.create({
      data: { userId: own, spellingEnabled: false, meaningChoiceEnabled: true },
    });
    app = await open();
  });
  afterAll(async () => {
    await app?.close();
    await db.user.deleteMany({ where: { id: { in: actors } } });
    await db.senseSourceBinding.deleteMany({ where: { wordId: { in: ids } } });
    await db.learningSense.deleteMany({ where: { wordId: { in: ids } } });
    await db.word.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });
  it('persists an issued choice across reload, preference edits and idempotent retry, without advancing progress until rating', async () => {
    let session = (
      await good('POST', '/study/sessions', { mode: 'learn', commandId: randomUUID(), bookId })
    ).session;
    const first = session.items[0],
      stored = await db.sessionItem.findUniqueOrThrow({ where: { id: first.id } }),
      hidden = obj(obj(stored.questionJson).recognition);
    expect(first.recognition.options).toHaveLength(4);
    expect(first.recognition.correctOptionId).toBeUndefined();
    expect(first.word.displayLemma).toBe(first.word.lemma.toUpperCase());
    expect(obj(stored.contentSnapshot).displayLemma).toBe(first.word.displayLemma);
    expect(first.word).not.toHaveProperty('senses');
    expect(JSON.stringify(first.word)).not.toContain('definitionZh');
    expect(JSON.stringify(first.word)).not.toContain('orthography');
    // A later editorial spelling change must not rewrite the already-issued focus.
    await db.learningSense.update({
      where: { id: first.focusSenseId },
      data: {
        contentMetadata: {
          orthography: {
            displayLemma: first.word.lemma,
            normalizedLemma: first.word.lemma,
            displayLemmaSha256: learningSenseTextHash(first.word.lemma),
            reviewer: 'Codex',
            decision: 'publish',
            expertCertified: false,
            reason: 'A later synthetic spelling revision must not change an issued question.',
          },
        },
      },
    });
    expect(
      (await good('GET', `/study/sessions/${session.id}`)).session.items[0].word.displayLemma,
    ).toBe(first.word.displayLemma);
    const chosen = first.recognition.options.find(
      (o: { id: string }) => o.id !== hidden.correctOptionId,
    ).id;
    const bad = await request('POST', `/study/sessions/${session.id}/commands`, {
      commandId: randomUUID(),
      itemId: first.id,
      action: 'reveal',
      recognitionOptionId: 'forged',
      expectedSessionRevision: session.revision,
    });
    expect(bad.statusCode).toBe(400);
    expect((await db.sessionItem.findUniqueOrThrow({ where: { id: first.id } })).revealed).toBe(
      false,
    );
    await good('PUT', '/learning-preferences', {
      expectedRevision: 0,
      meaningChoiceEnabled: false,
    });
    const body = {
      commandId: randomUUID(),
      itemId: first.id,
      action: 'reveal',
      recognitionOptionId: chosen,
      expectedSessionRevision: session.revision,
    };
    session = (await good('POST', `/study/sessions/${session.id}/commands`, body)).session;
    expect(session.items[0].recognition).toMatchObject({
      selectedOptionId: chosen,
      correctOptionId: hidden.correctOptionId,
    });
    expect(session.items[0].word.displayLemma).toBe(first.word.displayLemma);
    const retry = await good('POST', `/study/sessions/${session.id}/commands`, body);
    expect(retry.duplicate).toBe(true);
    expect(retry.session.revision).toBe(session.revision);
    expect(
      (
        await request('POST', `/study/sessions/${session.id}/commands`, {
          ...body,
          recognitionOptionId: hidden.correctOptionId,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request('POST', `/study/sessions/${session.id}/commands`, {
          ...body,
          commandId: randomUUID(),
          expectedSessionRevision: session.revision,
        })
      ).statusCode,
    ).toBe(409);
    expect(await db.studyProgress.count({ where: { userId: own } })).toBe(0);
    expect(await db.reviewLog.count({ where: { userId: own } })).toBe(0);
    expect((await good('GET', '/study/plan')).plan.completedUnique).toBe(0);
    await app.close();
    app = await open();
    const restored = (await good('GET', `/study/sessions/${session.id}`)).session;
    expect(restored.currentItemId).toBe(first.id);
    expect(restored.items[0].revealed).toBe(true);
    expect(restored.items[0].recognition.selectedOptionId).toBe(chosen);
    ctx.user = { ...ctx.user!, id: other };
    expect((await request('GET', `/study/sessions/${session.id}`)).statusCode).toBe(404);
    ctx.user = { ...ctx.user!, id: own };
    session = (
      await good('POST', `/study/sessions/${session.id}/commands`, {
        commandId: randomUUID(),
        itemId: first.id,
        action: 'rate',
        rating: 'good',
        expectedSessionRevision: restored.revision,
        expectedProgressRevision: first.progressRevision,
      })
    ).session;
    expect(await db.reviewLog.count({ where: { userId: own } })).toBe(1);
    expect((await good('GET', '/study/plan')).plan.completedUnique).toBe(1);
    const next = (
      await good('POST', '/study/sessions', { mode: 'learn', commandId: randomUUID(), bookId })
    ).session;
    expect(next.items[0].recognition).toBeUndefined();
    expect(next.learnRecallMode).toBe('recall');
  });
  async function anotherActor() {
    const userId = stem + '-actor-' + actors.length,
      selected = stem + '-book-' + actors.length;
    actors.push(userId);
    await db.user.create({
      data: { id: userId, name: 'Synthetic actor', email: userId + '@example.test' },
    });
    await db.book.create({
      data: {
        id: selected,
        slug: selected,
        title: 'Another synthetic book',
        description: 'Test only',
        goal: 'daily',
        ownerId: userId,
        items: {
          create: ids.map((wordId, ordinal) => ({
            wordId,
            ordinal,
            focusSenseId: wordId + '-meaning',
          })),
        },
      },
    });
    await db.userSettings.create({
      data: { userId, currentBookId: selected, dailyTotalGoal: 4, dailyNewLimit: 4, groupSize: 1 },
    });
    await db.userLearningPreference.create({
      data: { userId, meaningChoiceEnabled: true, spellingEnabled: false },
    });
    ctx.user = {
      id: userId,
      name: 'Synthetic actor',
      email: userId + '@example.test',
      role: 'user',
    };
    return { userId, bookId: selected };
  }
  it('issues Review and extra-review as recall even with recognition enabled', async () => {
    const actor = await anotherActor(),
      first = new Date(Date.now() - 86400000),
      due = new Date(Date.now() - 60000);
    for (const wordId of ids.slice(0, 2))
      await db.studyProgress.create({
        data: {
          userId: actor.userId,
          wordId,
          firstLearnedAt: first,
          lastReviewAt: first,
          dueAt: due,
          fsrsJson: json(freshCard(first)),
          revision: 1,
        },
      });
    const review = (
      await good('POST', '/study/sessions', { mode: 'review', commandId: randomUUID() })
    ).session;
    const extra = (
      await good('POST', '/study/sessions', { mode: 'extra-review', commandId: randomUUID() })
    ).session;
    for (const session of [review, extra]) {
      expect(session.items).toHaveLength(1);
      expect(session.items[0].bucket).toBe('review');
      expect(session.learnRecallMode).toBe('recall');
      expect(session.items[0].recognition).toBeUndefined();
    }
    expect(review.items[0].wordId).not.toBe(extra.items[0].wordId);
    expect(await db.reviewLog.count({ where: { userId: actor.userId } })).toBe(0);
  });
  it('holds a drifted meaning for new groups while preserving the already issued question', async () => {
    const actor = await anotherActor();
    const issued = (
      await good('POST', '/study/sessions', {
        mode: 'learn',
        commandId: randomUUID(),
        bookId: actor.bookId,
      })
    ).session;
    const before = issued.items[0].recognition;
    expect(before.options).toHaveLength(4);
    await db.sense.update({
      where: { id: ids[0] + '-source' },
      data: { definitionZh: '桥（测试修改）' },
    });
    const read = (await good('GET', `/study/sessions/${issued.id}`)).session;
    expect(read.items[0].recognition).toEqual(before);
    expect(read.items[0].revealed).toBe(false);
    const nextActor = await anotherActor();
    const next = (
      await good('POST', '/study/sessions', {
        mode: 'learn',
        commandId: randomUUID(),
        bookId: nextActor.bookId,
      })
    ).session;
    expect(next.items[0].wordId).toBe(ids[0]);
    expect(next.items[0].recognition).toBeUndefined();
  });
});
