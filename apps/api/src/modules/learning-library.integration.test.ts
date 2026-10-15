import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { hashPassword } from 'better-auth/crypto';
import { buildApp } from '../app.js';
import { createDatabase } from '../db.js';
import type { AppConfig } from '../config.js';
import { HttpError } from '../context.js';
import { registerLearningLibrary } from './learning-library.js';
import { registerAcademy } from './academy.js';
import { academyLessons, type AcademyLesson } from './academy-content.js';
const a = process.env.TEST_DATABASE_URL,
  b = process.env.TEST_DATABASE_URL_B;
const suite = a && b ? describe : describe.skip;
suite(
  'private learning library, preferences and independent academy practice in real PostgreSQL',
  () => {
    if (!a || !b) return;
    if (
      ![a, b].every((url) => new URL(url).pathname.endsWith('_test')) ||
      new URL(a).pathname === new URL(b).pathname
    )
      throw new Error('library_requires_two_distinct_test_databases');
    const dbA = createDatabase(a),
      dbB = createDatabase(b),
      prefix = `library-${randomUUID()}`;
    const first = `${prefix}-first`,
      second = `${prefix}-second`,
      actors = [first, second];
    const wordIds = Array.from({ length: 4 }, (_, index) => `${prefix}-word-${index}`),
      sourceIds = wordIds.map((id) => `${id}-example`);
    const password = 'Library-fixture-password-only-2026!';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-library-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<html>Library fixture</html>');
    const oldAudio = process.env.AUDIO_CACHE_DIR;
    const audioRoot = path.join(root, 'audio');
    fs.mkdirSync(path.join(audioRoot, 'files'), { recursive: true });
    // Tiny synthetic PCM fixture; no claim that this tone is speech or a human recording.
    const bytes = Buffer.alloc(44 + 256);
    bytes.write('RIFF');
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WAVE', 8);
    bytes.write('fmt ', 12);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(16000, 24);
    bytes.writeUInt32LE(32000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36);
    bytes.writeUInt32LE(256, 40);
    const audioSha = createHash('sha256').update(bytes).digest('hex'),
      audioFile = path.join(audioRoot, 'files', `${audioSha}.wav`);
    fs.writeFileSync(audioFile, bytes);
    const synthetic: AcademyLesson = {
      ...academyLessons.find((lesson) => lesson.category === 'listening')!,
      id: `${prefix}-listening`,
      listeningTargets: wordIds.map((_, index) => `${prefix}-target-${index}`),
    };
    const lessons = [
      ...academyLessons.filter((lesson) => lesson.category !== 'listening'),
      synthetic,
    ];
    let authA: Awaited<ReturnType<typeof buildApp>>, authB: Awaited<ReturnType<typeof buildApp>>;
    let apiA: FastifyInstance, replica: FastifyInstance, apiB: FastifyInstance;
    const cookies = new Map<string, string>();
    const deniedFetch = vi.fn(() =>
      Promise.reject(new Error('paid_or_external_network_forbidden')),
    );
    const cfg = (other = false): AppConfig => ({
      sites: [
        {
          id: 'default',
          title: 'Library fixture',
          publicUrl: other
            ? 'https://library-b.example/mobile'
            : 'https://library-a.example/mobile',
          basePath: '/mobile',
          hosts: [other ? 'library-b.example' : 'library-a.example'],
          databaseUrl: other ? b : a,
          authSecret: (other ? 'library-b-secret-' : 'library-a-secret-').repeat(5),
          bootstrapToken: 'library-unused-bootstrap-'.repeat(3),
          registrationOpen: true,
        },
      ],
      host: '127.0.0.1',
      port: 5198,
      production: false,
      webRoot: root,
      trustedProxy: [],
      poolSize: 5,
      maxSites: 2,
    });
    function request(
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      route: string,
      payload?: unknown,
      actor = first,
      other = false,
      alternate = false,
    ) {
      return (other ? apiB : alternate ? replica : apiA).inject({
        method,
        url: '/mobile/api/v2' + route,
        headers: {
          host: other ? 'library-b.example' : 'library-a.example',
          ...(cookies.get(`${other}:${actor}`)
            ? { cookie: cookies.get(`${other}:${actor}`)! }
            : {}),
          ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
    }
    const createApi = async (auth: Awaited<ReturnType<typeof buildApp>>) => {
      const app = Fastify();
      app.setErrorHandler((error, _req, reply) => {
        if (error instanceof HttpError)
          return reply.status(error.statusCode).send({
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          });
        return reply.status(500).send({ code: 'internal_error' });
      });
      await app.register(
        async (scope) => {
          await registerLearningLibrary(scope, (req) => auth.registry.context(req));
          await registerAcademy(scope, (req) => auth.registry.context(req), { lessons });
        },
        { prefix: '/mobile/api/v2' },
      );
      await app.ready();
      return app;
    };
    beforeAll(async () => {
      vi.stubGlobal('fetch', deniedFetch);
      process.env.AUDIO_CACHE_DIR = audioRoot;
      const hash = await hashPassword(password);
      for (const [db, users] of [
        [dbA, actors],
        [dbB, [first]],
      ] as const) {
        for (const userId of users)
          await db.user.create({
            data: {
              id: userId,
              email: `${userId}@example.test`,
              name: 'Library fixture',
              role: userId === second ? 'admin' : 'user',
              accounts: {
                create: {
                  id: `${userId}-account`,
                  accountId: userId,
                  providerId: 'credential',
                  password: hash,
                },
              },
            },
          });
      }
      for (const [index, wordId] of wordIds.entries())
        await dbA.word.create({
          data: {
            id: wordId,
            lemma: ['rain', 'water', 'quiet', 'window'][index]!,
            normalizedLemma: `${prefix}-target-${index}`,
            sourceRef: 'NightStudy synthetic fixture',
            senses: {
              create: {
                id: `${wordId}-sense`,
                pos: 'n.',
                definitionZh: '测试释义',
                definitionEn: 'Synthetic fixture definition',
                exampleEn: 'Rain fell beside the quiet station.',
                exampleZh: '安静的车站旁下起了雨。',
              },
            },
            examples: {
              create: {
                id: sourceIds[index]!,
                exampleEn: 'Rain fell beside the quiet station.',
                exampleZh: '安静的车站旁下起了雨。',
                contentMetadata: {
                  exampleEn: { kind: 'generated', license: 'MIT', author: 'NightStudy fixture' },
                },
              },
            },
            audio: {
              create: ['US', 'UK'].map((accent) => ({
                id: `${wordId}-audio-${accent}`,
                accent,
                kind: 'synthesized',
                status: 'ready',
                sourceName: 'Synthetic PCM test tone',
                sourceUrl: 'https://example.test/tone',
                license: 'MIT',
                attribution: 'Synthetic test fixture, not speech',
                fileKey: `files/${audioSha}.wav`,
                fileSha256: audioSha,
                mimeType: 'audio/wav',
              })),
            },
          },
        });
      authA = await buildApp(cfg(), false);
      authB = await buildApp(cfg(true), false);
      for (const [auth, users, other] of [
        [authA, actors, false],
        [authB, [first], true],
      ] as const)
        for (const actor of users) {
          const response = await auth.app.inject({
            method: 'POST',
            url: '/mobile/api/auth/sign-in/email',
            headers: {
              host: other ? 'library-b.example' : 'library-a.example',
              'content-type': 'application/json',
            },
            payload: JSON.stringify({ email: `${actor}@example.test`, password }),
          });
          expect(response.statusCode).toBe(200);
          const set = response.headers['set-cookie'];
          cookies.set(
            `${other}:${actor}`,
            (Array.isArray(set) ? set : [set])
              .filter(Boolean)
              .map((value) => String(value).split(';')[0])
              .join('; '),
          );
        }
      apiA = await createApi(authA);
      replica = await createApi(authA);
      apiB = await createApi(authB);
    }, 30000);
    afterAll(async () => {
      await Promise.all([
        apiA?.close(),
        replica?.close(),
        apiB?.close(),
        authA?.app.close(),
        authB?.app.close(),
      ]);
      await dbA.user.deleteMany({ where: { id: { in: actors } } });
      await dbB.user.deleteMany({ where: { id: first } });
      await dbA.word.deleteMany({
        where: { id: { in: wordIds }, normalizedLemma: { startsWith: prefix } },
      });
      await Promise.all([dbA.$disconnect(), dbB.$disconnect()]);
      if (oldAudio === undefined) delete process.env.AUDIO_CACHE_DIR;
      else process.env.AUDIO_CACHE_DIR = oldAudio;
      fs.rmSync(root, { recursive: true, force: true });
      expect(deniedFetch).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }, 30000);
    it('requires real authenticated realm sessions for every private resource', async () => {
      for (const route of [
        '/learning-preferences',
        '/library/words',
        '/sentences',
        `/sentences/status?wordId=${wordIds[0]}`,
        '/notes',
        '/academy',
        '/academy/attempts',
      ])
        expect((await request('GET', route, undefined, 'anonymous')).statusCode).toBe(401);
      const response = await apiB.inject({
        method: 'GET',
        url: '/mobile/api/v2/notes',
        headers: { host: 'library-b.example', cookie: cookies.get(`false:${first}`)! },
      });
      expect(response.statusCode).toBe(401);
    });
    it('reads preferences without writes, isolates revisions from daily settings, and allows exactly one first CAS writer', async () => {
      expect(await dbA.userLearningPreference.count({ where: { userId: first } })).toBe(0);
      const defaults = await request('GET', '/learning-preferences');
      expect(defaults.json().preferences).toMatchObject({
        theme: 'day',
        accent: 'us',
        fontScale: 1,
        revision: 0,
      });
      expect(await dbA.userLearningPreference.count({ where: { userId: first } })).toBe(0);
      const before = await dbA.userSettings.findUnique({ where: { userId: first } });
      const responses = await Promise.all([
        request('PUT', '/learning-preferences', { expectedRevision: 0, theme: 'night' }),
        request(
          'PUT',
          '/learning-preferences',
          { expectedRevision: 0, accent: 'uk' },
          first,
          false,
          true,
        ),
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect(await dbA.userLearningPreference.count({ where: { userId: first } })).toBe(1);
      expect(
        (await request('GET', '/learning-preferences', undefined, first, true)).json().preferences
          .revision,
      ).toBe(0);
      expect(await dbA.userSettings.findUnique({ where: { userId: first } })).toEqual(before);
      expect(
        (
          await request('PUT', '/learning-preferences', {
            expectedRevision: 1,
            fontScale: 1.1,
            reminderTime: '25:01',
          })
        ).statusCode,
      ).toBe(400);
    });
    it('collects only verified source snapshots, deduplicates concurrent saves, and preserves both source languages/attribution', async () => {
      const body = { sourceType: 'word-example', sourceId: sourceIds[0], wordId: wordIds[0] };
      const responses = await Promise.all([
        request('POST', '/sentences', body),
        request('POST', '/sentences', body, first, false, true),
      ]);
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      expect(responses.map((response) => response.json().duplicate).sort()).toEqual([false, true]);
      const sentence = responses[0]!.json().sentence;
      expect(sentence).toMatchObject({
        exampleEn: 'Rain fell beside the quiet station.',
        exampleZh: '安静的车站旁下起了雨。',
        metadata: { exampleEn: { author: 'NightStudy fixture', license: 'MIT' } },
      });
      expect(
        (await request('POST', '/sentences', { ...body, wordId: wordIds[1] })).statusCode,
      ).toBe(404);
      expect(
        (await request('POST', '/sentences', { ...body, exampleEn: 'fabricated' })).statusCode,
      ).toBe(400);
      await dbA.wordExample.update({
        where: { id: sourceIds[0] },
        data: { exampleEn: 'Rain covered the empty platform.' },
      });
      const read = await request('GET', '/sentences');
      expect(read.json().items[0].exampleEn).toBe(sentence.exampleEn);
      expect((await request('DELETE', `/sentences/${sentence.id}`, {}, second)).statusCode).toBe(
        404,
      );
      expect((await request('GET', '/sentences', undefined, second)).json().page.total).toBe(0);
      expect((await request('GET', '/sentences', undefined, first, true)).json().page.total).toBe(
        0,
      );
      expect(
        (
          await request('POST', '/sentences', {
            sourceType: 'sense',
            sourceId: `${wordIds[1]}-sense`,
          })
        ).statusCode,
      ).toBe(200);
    });
    it('paginates sentence ties without duplicates and binds cursors to user, query and realm instance', async () => {
      for (const index of [2, 3])
        expect(
          (
            await request('POST', '/sentences', {
              sourceType: 'word-example',
              sourceId: sourceIds[index],
            })
          ).statusCode,
        ).toBe(200);
      await dbA.librarySentence.updateMany({
        where: { userId: first },
        data: { createdAt: new Date('2026-01-01T00:00:00Z') },
      });
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const response = await request(
          'GET',
          '/sentences?limit=1' + (cursor ? '&cursor=' + cursor : ''),
        );
        expect(response.statusCode).toBe(200);
        for (const item of response.json().items) {
          expect(seen.has(item.id)).toBe(false);
          seen.add(item.id);
        }
        cursor = response.json().page.nextCursor;
        if (cursor) {
          expect(
            (await request('GET', '/sentences?limit=1&cursor=' + cursor, undefined, second))
              .statusCode,
          ).toBe(400);
          expect(
            (await request('GET', '/sentences?limit=1&cursor=' + cursor, undefined, first, true))
              .statusCode,
          ).toBe(400);
          expect(
            (await request('GET', '/sentences?limit=1&q=Rain&cursor=' + cursor)).statusCode,
          ).toBe(400);
        }
      } while (cursor);
      expect(seen.size).toBe(4);
    });
    it('returns exact current-source favorite states beyond the first list page without leaking another user or realm', async () => {
      const wordId = `${prefix}-status-word`,
        exampleIds = Array.from({ length: 52 }, (_, index) => `${wordId}-example-${index}`),
        senseId = `${wordId}-sense`,
        heldId = `${wordId}-held`,
        definitionZh = '不用于学习的测试源';
      const metadata = {
        exampleEn: { kind: 'generated', license: 'MIT', author: 'Status fixture' },
      };
      const text = {
        exampleEn: 'Rain gathered beside the station window.',
        exampleZh: '雨水聚在车站窗边。',
      };
      try {
        await dbA.word.create({
          data: {
            id: wordId,
            lemma: 'status fixture',
            normalizedLemma: wordId,
            sourceRef: 'NightStudy status fixture',
            examples: {
              create: [
                ...exampleIds.map((id, ordinal) => ({
                  id,
                  ordinal,
                  ...text,
                  contentMetadata: metadata,
                })),
                { id: `${wordId}-empty`, exampleEn: ' ', exampleZh: ' ' },
              ],
            },
            senses: {
              create: [
                { id: senseId, pos: 'n.', definitionZh: '测试源', ...text },
                {
                  id: heldId,
                  pos: 'n.',
                  definitionZh,
                  ...text,
                  contentMetadata: {
                    lexicalQuality: {
                      field: 'definitionZh',
                      excludeFromLearning: true,
                      sourceTextSha256: createHash('sha256').update(definitionZh).digest('hex'),
                    },
                  },
                },
              ],
            },
          },
        });
        // Same opaque word/source/user IDs in a separate database still cannot share favorites.
        await dbB.word.create({
          data: {
            id: wordId,
            lemma: 'status fixture',
            normalizedLemma: wordId,
            sourceRef: 'NightStudy status fixture',
            examples: { create: { id: exampleIds[0]!, ...text, contentMetadata: metadata } },
          },
        });
        const route = `/sentences/status?wordId=${wordId}`;
        const original = await request('POST', '/sentences', {
          sourceType: 'word-example',
          sourceId: exampleIds[0],
          wordId,
        });
        expect(original.statusCode).toBe(200);
        const originalSentence = original.json().sentence;
        const senseSaved = await request('POST', '/sentences', {
          sourceType: 'sense',
          sourceId: senseId,
        });
        expect(senseSaved.statusCode).toBe(200);
        await dbA.librarySentence.updateMany({
          where: { userId: first, wordId },
          data: { createdAt: new Date('2026-01-01T00:00:00Z') },
        });
        // Older source revisions are valid immutable library snapshots, not current identities.
        await dbA.librarySentence.createMany({
          data: Array.from({ length: 51 }, (_, index) => ({
            id: `${wordId}-historical-${index}`,
            userId: first,
            wordId,
            sourceType: 'word-example',
            sourceId: exampleIds[0]!,
            sourceHash: `${wordId}-historical-${index}`,
            exampleEn: `Historical fixture revision ${index}.`,
            exampleZh: '历史快照测试。',
            createdAt: new Date('2026-01-02T00:00:00Z'),
          })),
        });
        const page = await request('GET', `/sentences?wordId=${wordId}&limit=50`);
        expect(page.json().page).toMatchObject({ total: 53, hasMore: true });
        expect(
          page.json().items.some((row: { id: string }) => row.id === originalSentence.id),
        ).toBe(false);
        const beforeCount = await dbA.librarySentence.count({ where: { userId: first, wordId } });
        const status = await request('GET', route);
        expect(status.statusCode).toBe(200);
        expect(status.json().wordId).toBe(wordId);
        expect(status.json().items).toHaveLength(53);
        expect(status.json().items.filter((row: { saved: boolean }) => row.saved)).toHaveLength(2);
        expect(status.json().items).toContainEqual({
          sourceType: 'word-example',
          sourceId: exampleIds[0],
          saved: true,
          sentenceId: originalSentence.id,
        });
        expect(status.json().items).toContainEqual({
          sourceType: 'sense',
          sourceId: senseId,
          saved: true,
          sentenceId: senseSaved.json().sentence.id,
        });
        expect(
          status.json().items.some((row: { sourceId: string }) => row.sourceId === heldId),
        ).toBe(false);
        expect(await dbA.librarySentence.count({ where: { userId: first, wordId } })).toBe(
          beforeCount,
        );
        for (const [actor, other] of [
          [second, false],
          [first, true],
        ] as const) {
          const isolated = await request('GET', route, undefined, actor, other);
          expect(isolated.statusCode).toBe(200);
          expect(
            isolated
              .json()
              .items.every(
                (row: { saved: boolean; sentenceId: string | null }) =>
                  !row.saved && row.sentenceId === null,
              ),
          ).toBe(true);
        }
        expect((await request('GET', route, undefined, 'anonymous')).statusCode).toBe(401);
        expect((await request('GET', route + `&userId=${second}`)).statusCode).toBe(400);
        expect((await request('GET', '/sentences/status')).statusCode).toBe(400);
        expect((await request('GET', '/sentences/status?wordId=missing')).statusCode).toBe(404);
        expect(
          (await request('POST', '/sentences', { sourceType: 'sense', sourceId: heldId }))
            .statusCode,
        ).toBe(404);

        await dbA.wordExample.update({
          where: { id: exampleIds[0] },
          data: { exampleEn: 'Rain reached the open station window.' },
        });
        let changed = (await request('GET', route))
          .json()
          .items.find((row: { sourceId: string }) => row.sourceId === exampleIds[0]);
        expect(changed).toMatchObject({ saved: false, sentenceId: null });
        expect(
          await dbA.librarySentence.findUnique({ where: { id: originalSentence.id } }),
        ).toMatchObject(text);
        const fresh = await request('POST', '/sentences', {
          sourceType: 'word-example',
          sourceId: exampleIds[0],
        });
        expect(fresh.statusCode).toBe(200);
        expect(fresh.json().duplicate).toBe(false);
        expect(fresh.json().sentence.id).not.toBe(originalSentence.id);
        changed = (await request('GET', route))
          .json()
          .items.find((row: { sourceId: string }) => row.sourceId === exampleIds[0]);
        expect(changed).toMatchObject({ saved: true, sentenceId: fresh.json().sentence.id });
        await dbA.wordExample.update({
          where: { id: exampleIds[0] },
          data: {
            contentMetadata: {
              exampleEn: { ...metadata.exampleEn, author: 'Corrected fixture credit' },
            },
          },
        });
        expect(
          (await request('GET', route))
            .json()
            .items.find((row: { sourceId: string }) => row.sourceId === exampleIds[0]),
        ).toMatchObject({ saved: false, sentenceId: null });
        expect(
          (await request('DELETE', `/sentences/${senseSaved.json().sentence.id}`, {})).statusCode,
        ).toBe(200);
        expect(
          (await request('GET', route))
            .json()
            .items.find((row: { sourceId: string }) => row.sourceId === senseId),
        ).toMatchObject({ saved: false, sentenceId: null });
        await dbA.word.update({ where: { id: wordId }, data: { status: 'archived' } });
        expect((await request('GET', route)).statusCode).toBe(404);
      } finally {
        await dbA.librarySentence.deleteMany({ where: { userId: first, wordId } });
        await dbA.word.deleteMany({ where: { id: wordId, normalizedLemma: wordId } });
        await dbB.word.deleteMany({ where: { id: wordId, normalizedLemma: wordId } });
      }
    });
    it('rejects excessive source sets explicitly instead of returning misleading truncated favorite states', async () => {
      const wordId = `${prefix}-status-limit`;
      try {
        await dbA.word.create({
          data: { id: wordId, normalizedLemma: wordId, lemma: 'source limit fixture' },
        });
        await dbA.wordExample.createMany({
          data: Array.from({ length: 1001 }, (_, index) => ({
            id: `${wordId}-${index}`,
            wordId,
            exampleEn: 'Rain crossed the empty road.',
            exampleZh: '雨掠过空荡的道路。',
          })),
        });
        const response = await request('GET', `/sentences/status?wordId=${wordId}`);
        expect(response.statusCode).toBe(413);
        expect(response.json().code).toBe('sentence_sources_limit');
        expect(await dbA.librarySentence.count({ where: { userId: first, wordId } })).toBe(0);
      } finally {
        await dbA.word.deleteMany({ where: { id: wordId, normalizedLemma: wordId } });
      }
    });
    it('provides private note CRUD, stale edit/delete conflicts, plain text limits, and canonical published word validation', async () => {
      const made = await request('POST', '/notes', {
        title: 'Rain note',
        body: 'My own observation.',
        wordId: wordIds[0],
      });
      expect(made.statusCode).toBe(200);
      const note = made.json().note;
      expect((await request('GET', `/notes/${note.id}`, undefined, second)).statusCode).toBe(404);
      expect(
        (
          await request(
            'PATCH',
            `/notes/${note.id}`,
            { expectedRevision: 0, body: 'Private rewrite' },
            second,
          )
        ).statusCode,
      ).toBe(404);
      const updates = await Promise.all([
        request('PATCH', `/notes/${note.id}`, { expectedRevision: 0, body: 'First edit' }),
        request(
          'PATCH',
          `/notes/${note.id}`,
          { expectedRevision: 0, body: 'Other edit' },
          first,
          false,
          true,
        ),
      ]);
      expect(updates.map((row) => row.statusCode).sort()).toEqual([200, 409]);
      expect(
        (await request('DELETE', `/notes/${note.id}`, { expectedRevision: 0 })).statusCode,
      ).toBe(409);
      expect((await request('GET', '/notes?q=Rain')).json().page.total).toBe(1);
      expect(
        (await request('POST', '/notes', { title: 'x', body: 'x'.repeat(20001) })).statusCode,
      ).toBe(400);
      expect(
        (await request('POST', '/notes', { title: 'x', body: 'Own text', wordId: 'missing' }))
          .statusCode,
      ).toBe(404);
      expect(
        (await request('POST', '/notes', { title: 'x', body: 'Own text', userId: second }))
          .statusCode,
      ).toBe(400);
      expect(
        (await request('DELETE', `/notes/${note.id}`, { expectedRevision: 1 })).statusCode,
      ).toBe(200);
      expect((await request('GET', `/notes/${note.id}`)).statusCode).toBe(404);
    });
    it('enforces note quota under concurrent creation instead of overfilling the private collection', async () => {
      await dbA.libraryNote.createMany({
        data: Array.from({ length: 999 }, (_, i) => ({
          id: `${prefix}-quota-${i}`,
          userId: second,
          title: 'Quota fixture',
          body: 'Synthetic text',
        })),
      });
      const writes = await Promise.all([
        request('POST', '/notes', { title: 'Last', body: 'One slot' }, second),
        request('POST', '/notes', { title: 'Last other', body: 'Same slot' }, second, false, true),
      ]);
      expect(writes.map((row) => row.statusCode).sort()).toEqual([200, 429]);
      expect(await dbA.libraryNote.count({ where: { userId: second } })).toBe(1000);
    });
    it('reads the learning library from real progress and review evidence without counting saved words or another user', async () => {
      const now = new Date();
      await dbA.studyProgress.create({
        data: {
          userId: first,
          wordId: wordIds[0]!,
          firstLearnedAt: now,
          lastReviewAt: now,
          dueAt: now,
          fsrsJson: { state: 2, reps: 2 },
        },
      });
      await dbA.userWord.create({ data: { userId: first, wordId: wordIds[0]!, paused: true } });
      const learned = await request('GET', '/library/words?view=learned');
      expect(learned.json().items).toHaveLength(1);
      expect(learned.json().items[0]).toMatchObject({
        word: { id: wordIds[0] },
        reviewCount: 0,
        paused: true,
      });
      expect((await request('GET', '/library/words?view=learning')).json().page.total).toBe(0);
      expect((await request('GET', '/library/words?view=recent')).json().page.total).toBe(1);
      expect(
        (await request('GET', '/library/words?view=learned', undefined, second)).json().page.total,
      ).toBe(0);
    });
    it('uses fixed listening snapshots, hides answers, scores once on the server and keeps learning/FSRS untouched', async () => {
      const before = await dbA.studyProgress.findMany({ where: { userId: { in: actors } } }),
        reviewCount = await dbA.reviewLog.count({ where: { userId: { in: actors } } });
      const body = { commandId: randomUUID(), accent: 'uk' },
        created = await request('POST', `/academy/${synthetic.id}/attempts`, body);
      expect(created.statusCode, created.body).toBe(200);
      const attempt = created.json().attempt;
      expect(attempt.items).toHaveLength(4);
      expect(created.body).not.toContain('answerId');
      expect(created.body).not.toContain('answerText');
      expect(attempt.result).toBeNull();
      expect(
        (await request('POST', `/academy/${synthetic.id}/attempts`, body)).json(),
      ).toMatchObject({ duplicate: true, attempt: { id: attempt.id } });
      const stored = await dbA.academyAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      const secret = stored.itemsJson as { items: Array<{ id: string; answerId: string }> };
      const submit = {
        commandId: randomUUID(),
        expectedRevision: 0,
        answers: secret.items.map((item) => ({ itemId: item.id, answer: item.answerId })),
      };
      expect(
        (
          await request('POST', `/academy/attempts/${attempt.id}/submit`, {
            ...submit,
            answers: submit.answers.slice(1),
          })
        ).statusCode,
      ).toBe(400);
      const results = await Promise.all([
        request('POST', `/academy/attempts/${attempt.id}/submit`, submit),
        request('POST', `/academy/attempts/${attempt.id}/submit`, submit, first, false, true),
      ]);
      expect(results.map((row) => row.statusCode)).toEqual([200, 200]);
      expect(results.map((row) => row.json().duplicate).sort()).toEqual([false, true]);
      expect(results[0]!.json().attempt.result).toMatchObject({
        assessmentKind: 'objective-listening',
        score: 100,
        correct: 4,
        total: 4,
      });
      expect(
        (await dbA.academyAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).itemsJson,
      ).toEqual(stored.itemsJson);
      const another = await request('POST', `/academy/${synthetic.id}/attempts`, {
        commandId: randomUUID(),
        accent: 'us',
      });
      const anotherId = another.json().attempt.id as string;
      const anotherSnapshot = (
        await dbA.academyAttempt.findUniqueOrThrow({ where: { id: anotherId } })
      ).itemsJson as {
        items: Array<{ id: string; answerId: string; options: Array<{ id: string }> }>;
      };
      const partlyWrong = await request('POST', `/academy/attempts/${anotherId}/submit`, {
        commandId: randomUUID(),
        expectedRevision: 0,
        answers: anotherSnapshot.items.map((item, index) => ({
          itemId: item.id,
          answer:
            index === 0
              ? item.options.find((option) => option.id !== item.answerId)!.id
              : item.answerId,
        })),
      });
      expect(partlyWrong.json().attempt.result).toMatchObject({ score: 75, correct: 3, total: 4 });
      expect(partlyWrong.json().attempt.result.feedback[0].correct).toBe(false);
      expect(
        (
          await request('POST', `/academy/attempts/${attempt.id}/submit`, {
            ...submit,
            commandId: randomUUID(),
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (await request('GET', `/academy/attempts/${attempt.id}`, undefined, second)).statusCode,
      ).toBe(404);
      expect(
        (await request('GET', `/academy/attempts/${attempt.id}`, undefined, first, true))
          .statusCode,
      ).toBe(404);
      expect(await dbA.studyProgress.findMany({ where: { userId: { in: actors } } })).toEqual(
        before,
      );
      expect(await dbA.reviewLog.count({ where: { userId: { in: actors } } })).toBe(reviewCount);
      expect(await dbA.dailyPlan.count({ where: { userId: { in: actors } } })).toBe(0);
      expect(await dbA.autoKnownWord.count({ where: { userId: { in: actors } } })).toBe(0);
    });
    it('records reading/shadowing/topic completion without a score, preserves lesson snapshot, and refuses missing physical audio', async () => {
      for (const category of ['reading', 'shadowing', 'topic']) {
        const lesson = lessons.find((lesson) => lesson.category === category)!;
        const created = await request('POST', `/academy/${lesson.id}/attempts`, {
          commandId: randomUUID(),
          accent: 'us',
        });
        expect(created.statusCode).toBe(200);
        const attempt = created.json().attempt;
        expect(attempt.lesson.body).toEqual(lesson.body);
        const completed = await request('POST', `/academy/attempts/${attempt.id}/submit`, {
          commandId: randomUUID(),
          expectedRevision: 0,
        });
        expect(completed.json().attempt.result).toMatchObject({
          assessmentKind: 'completion-only',
          score: null,
          correct: null,
          total: null,
        });
        expect(
          (await request('GET', `/academy/${lesson.id}`)).json().lesson.completedAttempts,
        ).toBe(1);
      }
      const count = await dbA.academyAttempt.count({ where: { userId: first } });
      fs.rmSync(audioFile);
      try {
        const failed = await request('POST', `/academy/${synthetic.id}/attempts`, {
          commandId: randomUUID(),
          accent: 'us',
        });
        expect(failed.statusCode).toBe(503);
        expect(failed.json().code).toBe('academy_audio_not_ready');
        expect(await dbA.academyAttempt.count({ where: { userId: first } })).toBe(count);
      } finally {
        fs.writeFileSync(audioFile, bytes);
      }
      expect((await request('GET', '/academy/attempts?limit=1')).json().page.hasMore).toBe(true);
    });
  },
);
