import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createDatabase } from '../db.js';
import type { AppConfig } from '../config.js';
import { json, wordDto, wordInclude } from './shared.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('PostgreSQL bilingual catalog and read-only issued word supplementation', () => {
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Use an isolated _test database');
  const db = createDatabase(url),
    prefix = `word-content-it-${randomUUID()}`;
  const letters = prefix
    .replaceAll('-', '')
    .replace(/[0-9]/g, (digit) => String.fromCharCode(97 + Number(digit)));
  const wordId = `${prefix}-word`,
    conflictId = `${prefix}-conflict`,
    draftId = `${prefix}-draft`;
  const learner = `${prefix}-learner`,
    admin = `${prefix}-admin`,
    other = `${prefix}-other`;
  const bookId = `${prefix}-book`,
    packId = `${prefix}-bilingual-pack`;
  const lemma = `bilingual${letters}`,
    firstSense = `${wordId}-sense-0`,
    newSense = `${wordId}-new-sense`;
  const password = 'Bilingual-integration-2026!';
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-word-content-'));
  fs.writeFileSync(
    path.join(webRoot, 'index.html'),
    '<html><body>Original synthetic content test</body></html>',
  );
  const ip = `10.91.${Number.parseInt(prefix.slice(-2), 16) || 1}.1`;
  const cookies = new Map<string, string>();
  const rateKeys = new Set<string>();
  const markRateKeys = () => {
    for (const category of ['auth', 'api'])
      rateKeys.add(
        createHash('sha256')
          .update(`default:${ip}:${category}:${Math.floor(Date.now() / 60000)}`)
          .digest('hex'),
      );
  };
  let app: FastifyInstance,
    issuedId = '';
  const config: AppConfig = {
    sites: [
      {
        id: 'default',
        title: 'Original bilingual content integration',
        publicUrl: 'http://word-content.test',
        basePath: '',
        hosts: ['word-content.test'],
        databaseUrl: url,
        authSecret: 'word-content-integration-secret-'.repeat(3),
        bootstrapToken: 'unused-word-content-token-'.repeat(3),
        registrationOpen: true,
      },
    ],
    host: '127.0.0.1',
    port: 5198,
    production: false,
    webRoot,
    trustedProxy: [],
    poolSize: 5,
    maxSites: 2,
  };
  const request = (
    method: 'GET' | 'POST' | 'PATCH',
    route: string,
    body?: unknown,
    user: string | null = learner,
  ) => {
    markRateKeys();
    return app.inject({
      method,
      url: `/api/v2${route}`,
      remoteAddress: ip,
      headers: {
        host: 'word-content.test',
        ...(user ? { cookie: cookies.get(user) ?? '' } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  };
  const translated = {
    kind: 'machine-translation',
    sourceLanguage: 'zh',
    model: 'Original synthetic translation fixture; not a real model result',
    review: 'pending',
    sourceTextSha256: '0'.repeat(64),
    sourceUrl: 'https://example.test/original-translation-fixture',
    license: 'MIT',
  };
  const corpus = {
    kind: 'corpus',
    review: 'source',
    sourceUrl: 'https://example.test/original-paired-sentence-fixture',
    license: 'MIT',
    author: 'NightStudy original synthetic test fixture',
    sourceSentenceId: 'fixture-only',
  };
  beforeAll(async () => {
    expect((await db.siteState.findUniqueOrThrow({ where: { id: 'singleton' } })).siteId).toBe(
      'default',
    );
    const passwordHash = await hashPassword(password);
    for (const id of [learner, admin, other])
      await db.user.create({
        data: {
          id,
          name: 'Original content integration fixture',
          email: `${id}@example.test`,
          role: id === admin ? 'admin' : 'user',
          accounts: {
            create: {
              id: randomUUID(),
              accountId: id,
              providerId: 'credential',
              password: passwordHash,
            },
          },
        },
      });
    await db.word.create({
      data: {
        id: wordId,
        lemma,
        normalizedLemma: lemma,
        goalTags: ['daily'],
        sourceRef: 'Original synthetic source',
        contentVersion: 'original-fixture-v1',
        senses: {
          create: [
            {
              id: firstSense,
              pos: 'n.',
              definitionZh: '原始合成中文义一',
              exampleEn: 'Original English test usage.',
              ordinal: 0,
            },
            { id: `${wordId}-sense-1`, pos: 'n.', definitionZh: '原始合成中文义二', ordinal: 1 },
            { id: `${wordId}-sense-2`, pos: 'n.', definitionZh: '原始合成中文义三', ordinal: 2 },
            {
              id: `${wordId}-sense-3`,
              pos: 'n.',
              definitionZh: '',
              definitionEn: 'An independent original English test meaning.',
              ordinal: 3,
            },
          ],
        },
      },
    });
    for (const id of [conflictId, draftId])
      await db.word.create({
        data: {
          id,
          lemma: `${lemma}${id === draftId ? 'draft' : 'conflict'}`,
          normalizedLemma: `${lemma}${id === draftId ? 'draft' : 'conflict'}`,
          goalTags: [],
          sourceRef: 'Original synthetic source',
          contentVersion: 'original-fixture-v1',
          senses: {
            create: {
              id: `${id}-sense`,
              pos: 'n.',
              definitionZh: '旧合成中文义',
              exampleEn: 'Original preserved test sentence.',
            },
          },
        },
      });
    await db.book.create({
      data: {
        id: bookId,
        slug: bookId,
        ownerId: learner,
        title: 'Original bilingual test book',
        description: 'Synthetic integration content only',
        goal: 'daily',
        items: { create: { wordId, focusSenseId: firstSense, ordinal: 0 } },
      },
    });
    await db.userSettings.create({
      data: {
        userId: learner,
        currentBookId: bookId,
        dailyTotalGoal: 1,
        dailyNewLimit: 1,
        groupSize: 1,
      },
    });
    app = (await buildApp(config, false)).app;
    for (const id of [learner, admin, other]) {
      markRateKeys();
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        remoteAddress: ip,
        headers: { host: 'word-content.test', 'content-type': 'application/json' },
        payload: JSON.stringify({ email: `${id}@example.test`, password }),
      });
      expect(login.statusCode, login.body).toBe(200);
      const raw = login.headers['set-cookie'];
      cookies.set(
        id,
        (Array.isArray(raw) ? raw : [raw])
          .filter(Boolean)
          .map((value) => String(value).split(';')[0])
          .join('; '),
      );
    }
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await db.adminAuditLog.deleteMany({ where: { actorId: admin, targetId: wordId } });
    await db.rateBucket.deleteMany({ where: { key: { in: [...rateKeys] } } });
    await db.user.deleteMany({ where: { id: { in: [learner, admin, other] } } });
    await db.word.deleteMany({ where: { id: { in: [wordId, conflictId, draftId] } } });
    await db.contentPack.deleteMany({ where: { id: packId } });
    await db.$disconnect();
    fs.rmSync(webRoot, { recursive: true, force: true });
  }, 60000);
  it('keeps one precise summary meaning, preserves source details, and excludes derived pack counts', async () => {
    const summary = await request('GET', `/dictionary?q=${lemma}`, undefined, null);
    expect(summary.statusCode).toBe(200);
    const word = summary.json().items.find((item: { id: string }) => item.id === wordId);
    expect(word.definitionZh).toBe('原始合成中文义一');
    expect(word.definitionEn).toBe('');
    expect(word).not.toHaveProperty('senses');
    expect(word).not.toHaveProperty('contentCoverage');
    const sourceDetail = (await request('GET', `/words/${wordId}`, undefined, null)).json().word;
    expect(sourceDetail.senses).toHaveLength(4);
    expect(sourceDetail.senses.some((sense: { definitionEn: string }) => sense.definitionEn)).toBe(
      true,
    );
    const before = (await request('GET', '/dictionary/stats', undefined, null)).json()
      .declaredEntryCount;
    await db.contentPack.create({
      data: {
        id: packId,
        version: 'original-fixture-v1',
        status: 'ready',
        sourceUrl: 'https://example.test/original-bilingual-fixture',
        sha256: '0'.repeat(64),
        license: 'MIT',
        entryCount: 1,
        phoneticCount: 0,
        definitionZhCount: 1,
        definitionEnCount: 1,
        tagCounts: { kind: 'bilingual' },
      },
    });
    expect(
      (await request('GET', '/dictionary/stats', undefined, null)).json().declaredEntryCount,
    ).toBe(before);
  });
  it('supplements an old revealed session without leaking before reveal or rewriting snapshot, question, focus or memory', async () => {
    const created = await request('POST', '/study/sessions', {
      mode: 'daily',
      size: 1,
      commandId: randomUUID(),
    });
    expect(created.statusCode, created.body).toBe(200);
    let session = created.json().session;
    issuedId = session.id;
    const original = await db.sessionItem.findUniqueOrThrow({ where: { id: session.items[0].id } });
    await db.sense.update({
      where: { id: firstSense },
      data: {
        definitionEn: 'A synthetic translation of original Chinese meaning one.',
        exampleZh: '原英文测试用例的合成译文。',
        contentMetadata: { definitionEn: translated, exampleZh: translated, packId },
      },
    });
    await db.sense.create({
      data: {
        id: newSense,
        wordId,
        pos: 'v.',
        definitionZh: '',
        definitionEn: 'A newly published independent synthetic meaning.',
        ordinal: 4,
        contentMetadata: { definitionEn: { kind: 'dictionary', review: 'source' }, packId },
      },
    });
    await db.wordExample.create({
      data: {
        id: `${wordId}-usage-pair`,
        wordId,
        exampleEn: 'Original word-level English usage.',
        exampleZh: '原创词级中文用例。',
        contentMetadata: { exampleEn: corpus, exampleZh: corpus, packId },
      },
    });
    const hidden = await request('GET', `/study/sessions/${session.id}`);
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().session.items[0].word).not.toHaveProperty('senses');
    expect(hidden.json().session.items[0].word).not.toHaveProperty('examples');
    expect(hidden.body).not.toContain('machine-translation');
    const revealed = await request('POST', `/study/sessions/${session.id}/commands`, {
      action: 'reveal',
      commandId: randomUUID(),
      itemId: session.items[0].id,
      expectedSessionRevision: session.revision,
    });
    expect(revealed.statusCode, revealed.body).toBe(200);
    session = revealed.json().session;
    expect(session.items[0].focusSenseId).toBe(firstSense);
    // An issued dictionary meaning cannot acquire newly classified meanings or unbound usages.
    expect(session.items[0].word.senses[0]).toMatchObject({
      id: firstSense,
      definitionZh: '原始合成中文义一',
      definitionEn: '',
      examples: [],
    });
    expect(
      session.items[0].word.senses.some((sense: { id: string }) => sense.id === newSense),
    ).toBe(false);
    expect(session.items[0].word).not.toHaveProperty('examples');
    expect(session.items[0].word.contentView).toMatchObject({
      supplemented: false,
      snapshotVersion: 'original-fixture-v1',
    });
    const read = await request('GET', `/study/sessions/${session.id}`);
    expect(read.json().session.items[0].word).toEqual(session.items[0].word);
    const stored = await db.sessionItem.findUniqueOrThrow({ where: { id: original.id } });
    expect(stored.contentSnapshot).toEqual(original.contentSnapshot);
    expect(stored.questionJson).toEqual(original.questionJson);
    expect(stored.focusSenseId).toBe(original.focusSenseId);
    expect(await db.studyProgress.count({ where: { userId: learner } })).toBe(0);
    expect(await db.reviewLog.count({ where: { userId: learner } })).toBe(0);
    expect(
      (await request('GET', `/study/sessions/${session.id}`, undefined, other)).statusCode,
    ).toBe(404);
    const rated = await request('POST', `/study/sessions/${session.id}/commands`, {
      action: 'rate',
      rating: 'good',
      commandId: randomUUID(),
      itemId: original.id,
      expectedSessionRevision: session.revision,
      expectedProgressRevision: 0,
    });
    expect(rated.statusCode, rated.body).toBe(200);
    expect(rated.json().session.items[0].question.prompt).toBe(
      (original.questionJson as Record<string, unknown>).prompt,
    );
    const practice = rated.json().session;
    const answer = await request('POST', `/study/sessions/${session.id}/commands`, {
      action: 'answer',
      answer: lemma,
      commandId: randomUUID(),
      itemId: original.id,
      expectedSessionRevision: practice.revision,
    });
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json().result.correctAnswer).toBe(lemma);
    expect(await db.reviewLog.count({ where: { userId: learner } })).toBe(1);
    const progress = await db.studyProgress.findFirstOrThrow({
      where: { userId: learner, wordId },
    });
    await request('GET', `/study/sessions/${session.id}`);
    expect(await db.studyProgress.findUniqueOrThrow({ where: { id: progress.id } })).toEqual(
      progress,
    );
    const detail = (await request('GET', `/words/${wordId}`, undefined, null)).json().word;
    expect(detail.sources.some((source: { id: string }) => source.id === packId)).toBe(true);
    expect(detail.senses[0].exampleSource).toBeNull();
    expect(detail.examples).toEqual(session.items[0].word.examples);
    expect((await request('POST', '/wordbook', { wordId })).statusCode).toBe(200);
    const saved = (await request('GET', '/wordbook'))
      .json()
      .items.find((item: { wordId: string }) => item.wordId === wordId);
    expect(saved.word.definitionZh).toBe('原始合成中文义一');
    expect(saved.word.definitionEn).toBe(
      'A synthetic translation of original Chinese meaning one.',
    );
    expect(saved.word).not.toHaveProperty('contentCoverage');
    expect(saved.word).not.toHaveProperty('examples');
  });
  it('never mixes changed live meanings or draft supplementation into older revealed snapshots', async () => {
    for (const id of [conflictId, draftId]) {
      const word = await db.word.findUniqueOrThrow({ where: { id }, include: wordInclude });
      const old = await db.studySession.create({
        data: {
          userId: other,
          mode: 'learn',
          phase: 'recall',
          items: {
            create: {
              wordId: id,
              focusSenseId: `${id}-sense`,
              ordinal: 0,
              revealed: true,
              contentSnapshot: json(wordDto(word)),
              questionJson: {
                prompt: 'Preserved synthetic prompt',
                answer: word.lemma,
                explanation: 'Preserved synthetic explanation',
              },
            },
          },
        },
        include: { items: true },
      });
      await db.sense.update({
        where: { id: `${id}-sense` },
        data: {
          definitionZh: '新不同合成含义',
          definitionEn: 'Changed unrelated meaning.',
          exampleEn: 'A changed unrelated sentence.',
          exampleZh: '更改后的例句。',
          contentMetadata: { definitionEn: translated, exampleZh: translated, packId },
        },
      });
      if (id === draftId) await db.word.update({ where: { id }, data: { status: 'draft' } });
      const result = await request('GET', `/study/sessions/${old.id}`, undefined, other);
      expect(result.statusCode).toBe(200);
      expect(result.json().session.items[0].word.senses[0]).toMatchObject({
        definitionZh: '旧合成中文义',
        definitionEn: '',
        examples: [],
      });
      expect(result.body).not.toContain('Changed unrelated meaning.');
      expect(result.body).not.toContain('更改后的例句。');
      expect(
        (await db.sessionItem.findUniqueOrThrow({ where: { id: old.items[0]!.id } }))
          .contentSnapshot,
      ).toEqual(old.items[0]!.contentSnapshot);
    }
    expect((await request('GET', `/words/${draftId}`, undefined, null)).statusCode).toBe(404);
  });
  it('relabels only a manually edited field while retaining unrelated translation provenance and issued questions', async () => {
    const original = await db.sessionItem.findFirstOrThrow({ where: { sessionId: issuedId } });
    const edited = await request(
      'PATCH',
      `/admin/words/${wordId}`,
      {
        senseId: firstSense,
        definitionEn: 'Administrator-authored synthetic English meaning.',
        exampleZh: '原英文测试用例的合成译文。',
      },
      admin,
    );
    expect(edited.statusCode, edited.body).toBe(200);
    const sense = edited
      .json()
      .word.senses.find((entry: { id: string }) => entry.id === firstSense);
    expect(sense.contentMetadata).toMatchObject({
      definitionEn: { kind: 'site-authored', review: 'source' },
      exampleZh: translated,
      packId,
    });
    expect(sense.contentMetadata.definitionEn).not.toHaveProperty('model');
    expect(sense.contentMetadata.definitionEn).not.toHaveProperty('license');
    const result = await request('GET', `/study/sessions/${issuedId}`);
    expect(result.json().session.items[0].word.senses[0].definitionEn).toBe('');
    const stored = await db.sessionItem.findUniqueOrThrow({ where: { id: original.id } });
    expect(stored.contentSnapshot).toEqual(original.contentSnapshot);
    expect(stored.questionJson).toEqual(original.questionJson);
    expect(await db.reviewLog.count({ where: { userId: learner } })).toBe(1);
    // A legacy empty field can already have stale provenance from an earlier editor.
    await db.sense.update({ where: { id: firstSense }, data: { definitionEn: '' } });
    const cleared = await request(
      'PATCH',
      `/admin/words/${wordId}`,
      { senseId: firstSense, definitionEn: '' },
      admin,
    );
    expect(cleared.statusCode, cleared.body).toBe(200);
    const clearedSense = cleared
      .json()
      .word.senses.find((entry: { id: string }) => entry.id === firstSense);
    expect(clearedSense.definitionEn).toBe('');
    expect(clearedSense.contentMetadata).not.toHaveProperty('definitionEn');
    expect(clearedSense.contentMetadata.exampleZh).toEqual(translated);
    await db.sense.update({
      where: { id: firstSense },
      data: {
        contentMetadata: {
          ...clearedSense.contentMetadata,
          lexicalWarnings: [
            { code: 'source-meaning-unverified', message: '仅指旧中文来源。' },
            { code: 'source-spelling-unverified', message: '修改释义仍不能确认拼写。' },
          ],
        },
      },
    });
    const corrected = await request(
      'PATCH',
      `/admin/words/${wordId}`,
      { senseId: firstSense, definitionZh: '管理员修正后的合成中文义。' },
      admin,
    );
    expect(corrected.statusCode, corrected.body).toBe(200);
    const correctedSense = corrected
      .json()
      .word.senses.find((entry: { id: string }) => entry.id === firstSense);
    expect(correctedSense.contentMetadata.lexicalWarnings).toEqual([
      { code: 'source-spelling-unverified', message: '修改释义仍不能确认拼写。' },
    ]);
    expect(correctedSense.contentMetadata.definitionZh).toEqual({
      kind: 'site-authored',
      review: 'source',
    });
    expect(correctedSense.contentMetadata.exampleZh).toEqual(translated);
    expect(
      (await db.sessionItem.findUniqueOrThrow({ where: { id: original.id } })).contentSnapshot,
    ).toEqual(original.contentSnapshot);
    expect(await db.reviewLog.count({ where: { userId: learner } })).toBe(1);
  });
});
