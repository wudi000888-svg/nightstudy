import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { createDatabase } from '../db.js';
import { HttpError, type RequestContext } from '../context.js';
import { registerContent } from './content.js';
import { registerLearningLibrary } from './learning-library.js';
import { registerPronunciation } from './pronunciation.js';
import { learningSenseBindingHash, learningSenseTextHash } from './learning-sense-integrity.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite(
  'PostgreSQL atomic meaning constraints, evidence invalidation and immutable learner snapshots',
  () => {
    if (!url) return;
    if (!new URL(url).pathname.endsWith('_test'))
      throw new Error('Atomic meaning integration requires an isolated _test database');
    const db = createDatabase(url);
    const prefix = `atomic-security-${randomUUID()}`,
      userId = `${prefix}-learner`;
    const wordIds: string[] = [];
    const context: RequestContext = {
      prisma: db,
      siteId: 'test-site',
      instanceId: 'test-instance',
      basePath: '',
      publicUrl: 'http://atomic.test',
      title: 'Atomic security fixture',
      fleetSecret: 'synthetic-atomic-test-secret'.repeat(3),
      registrationOpen: false,
      user: {
        id: userId,
        name: 'Synthetic learner',
        email: `${userId}@example.test`,
        role: 'user',
      },
    };
    let app: FastifyInstance;
    async function makeWord(tag: string, contentMetadata: Prisma.InputJsonObject = {}) {
      const wordId = `${prefix}-${tag}`,
        sourceSenseId = `${wordId}-source`,
        learningSenseId = `${wordId}-learning`,
        bindingId = `${wordId}-binding`;
      wordIds.push(wordId);
      const source = {
        id: sourceSenseId,
        wordId,
        pos: 'n.',
        definitionZh: '银行',
        definitionEn: 'an organization that keeps and lends money',
      };
      await db.word.create({
        data: {
          id: wordId,
          lemma: tag,
          normalizedLemma: wordId,
          phonetic: 'source-ipa',
          phoneticUs: 'us-ipa',
          phoneticUk: 'uk-ipa',
          phoneticSource: 'Original synthetic test metadata',
          contentVersion: 'source-fixture-v1',
          sourceRef: 'Original test fixture',
          senses: {
            create: {
              id: sourceSenseId,
              pos: source.pos,
              definitionZh: source.definitionZh,
              definitionEn: source.definitionEn,
              exampleEn: 'This source inline sentence is not a reviewed learning example.',
              exampleZh: '源句没有自动绑定到新义项。',
            },
          },
        },
      });
      const binding = {
        sourceSenseId,
        relation: 'exact',
        sourcePosSha256: learningSenseTextHash(source.pos),
        sourceDefinitionZhSha256: learningSenseTextHash(source.definitionZh),
        sourceDefinitionEnSha256: learningSenseTextHash(source.definitionEn),
      };
      const sense = {
        id: learningSenseId,
        wordId,
        pos: source.pos,
        definitionZh: source.definitionZh,
        definitionEn: source.definitionEn,
        contentVersion: 'atomic-fixture-v1',
        sourceBindings: [binding],
      };
      await db.learningSense.create({
        data: {
          id: learningSenseId,
          wordId,
          pos: sense.pos,
          definitionZh: sense.definitionZh,
          definitionEn: sense.definitionEn,
          contentVersion: sense.contentVersion,
          bindingHash: learningSenseBindingHash(sense),
          status: 'published',
          contentMetadata,
        },
      });
      await db.senseSourceBinding.create({
        data: { id: bindingId, wordId, learningSenseId, ...binding },
      });
      const exampleIds = [`${wordId}-account`, `${wordId}-loan`];
      await db.wordExample.createMany({
        data: [
          {
            id: exampleIds[0]!,
            wordId,
            learningSenseId,
            status: 'published',
            contextLabel: '办理账户',
            contentVersion: sense.contentVersion,
            exampleEn: 'She opened an account at the bank.',
            exampleZh: '她在这家银行开了一个账户。',
          },
          {
            id: exampleIds[1]!,
            wordId,
            learningSenseId,
            status: 'published',
            contextLabel: '申请贷款',
            contentVersion: sense.contentVersion,
            exampleEn: 'The bank approved her loan.',
            exampleZh: '银行批准了她的贷款。',
          },
          {
            id: `${wordId}-candidate`,
            wordId,
            status: 'candidate',
            exampleEn: 'A candidate must stay outside published meanings.',
            exampleZh: '候选句不能进入已发布义项。',
          },
        ],
      });
      return { wordId, sourceSenseId, learningSenseId, bindingId, exampleIds };
    }
    const request = (method: 'GET' | 'HEAD' | 'POST', route: string, payload?: unknown) =>
      app.inject({
        method,
        url: route,
        ...(payload === undefined
          ? {}
          : { payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }),
      });
    beforeAll(async () => {
      await db.user.create({
        data: {
          id: userId,
          name: 'Synthetic atomic security fixture',
          email: `${userId}@example.test`,
        },
      });
      app = Fastify();
      app.setErrorHandler((error, _request, reply) =>
        error instanceof HttpError
          ? reply.code(error.statusCode).send({ code: error.code })
          : reply.code(500).send({
              code: 'internal_error',
              message: error instanceof Error ? error.message : String(error),
            }),
      );
      await registerContent(app, async () => context);
      await registerLearningLibrary(app, async () => context);
      await registerPronunciation(app, async () => context);
      await app.ready();
    });
    afterAll(async () => {
      await app?.close();
      await db.user.deleteMany({ where: { id: userId } });
      await db.wordExample.deleteMany({ where: { wordId: { in: wordIds } } });
      await db.senseSourceBinding.deleteMany({ where: { wordId: { in: wordIds } } });
      await db.learningSense.deleteMany({ where: { wordId: { in: wordIds } } });
      await db.word.deleteMany({ where: { id: { in: wordIds } } });
      await db.$executeRaw`DELETE FROM "LookupRevision" WHERE scope=${'user:' + userId}`;
      await db.$disconnect();
    });
    it('serves only the explicitly bound examples and snapshots the exact meaning identity', async () => {
      const fixture = await makeWord('published');
      const response = await request('GET', `/words/${fixture.wordId}`);
      expect(response.statusCode, response.body).toBe(200);
      const dto = response.json().word;
      expect(dto.senses).toHaveLength(1);
      expect(dto.senses[0].examples.map((example: { id: string }) => example.id).sort()).toEqual(
        [...fixture.exampleIds].sort(),
      );
      expect(JSON.stringify(dto)).not.toContain('A candidate must stay');
      expect(JSON.stringify(dto)).not.toContain('This source inline sentence');
      const made = await request('POST', '/sentences', {
        sourceType: 'word-example',
        sourceId: fixture.exampleIds[0],
        wordId: fixture.wordId,
      });
      expect(made.statusCode, made.body).toBe(200);
      expect(made.json().sentence.metadata.meaning).toMatchObject({
        id: fixture.learningSenseId,
        contentVersion: 'atomic-fixture-v1',
      });
      expect(
        (
          await request('POST', '/sentences', {
            sourceType: 'word-example',
            sourceId: `${fixture.wordId}-candidate`,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await request('POST', '/sentences', {
            sourceType: 'sense',
            sourceId: fixture.sourceSenseId,
          })
        ).statusCode,
      ).toBe(400);
    });
    it('holds a meaning on any changed raw source bytes and leaves a previously saved sentence immutable', async () => {
      const fixture = await makeWord('source-drift');
      const saved = await request('POST', '/sentences', {
        sourceType: 'word-example',
        sourceId: fixture.exampleIds[0],
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const savedId = saved.json().sentence.id;
      const before = await db.librarySentence.findUniqueOrThrow({ where: { id: savedId } });
      const previousRevision = await db.$queryRaw<
        Array<{ revision: bigint }>
      >`SELECT revision FROM "LookupRevision" WHERE scope='catalog'`;
      await db.sense.update({
        where: { id: fixture.sourceSenseId },
        data: { definitionZh: '银行 ' },
      });
      expect(
        (await db.learningSense.findUniqueOrThrow({ where: { id: fixture.learningSenseId } }))
          .status,
      ).toBe('held');
      const afterRevision = await db.$queryRaw<
        Array<{ revision: bigint }>
      >`SELECT revision FROM "LookupRevision" WHERE scope='catalog'`;
      expect(afterRevision[0]!.revision).toBeGreaterThan(previousRevision[0]!.revision);
      expect(
        (await request('GET', `/sentences/status?wordId=${fixture.wordId}`)).json().items,
      ).toEqual([]);
      expect(
        (
          await request('POST', '/sentences', {
            sourceType: 'word-example',
            sourceId: fixture.exampleIds[0],
          })
        ).statusCode,
      ).toBe(404);
      expect(await db.librarySentence.findUniqueOrThrow({ where: { id: savedId } })).toEqual(
        before,
      );
      const read = await request('GET', `/sentences?wordId=${fixture.wordId}`);
      expect(read.json().items).toContainEqual(
        expect.objectContaining({
          id: savedId,
          exampleEn: before.exampleEn,
          exampleZh: before.exampleZh,
        }),
      );
      const word = (await request('GET', `/words/${fixture.wordId}`)).json().word;
      expect(
        word.senses.every(
          (sense: { kind: string; examples: unknown[] }) =>
            sense.kind === 'dictionary' && sense.examples.length === 0,
        ),
      ).toBe(true);
    });
    it('holds published meanings after source-binding updates and deletion', async () => {
      for (const mutation of ['update', 'delete']) {
        const fixture = await makeWord(`binding-${mutation}`);
        if (mutation === 'update')
          await db.senseSourceBinding.update({
            where: { id: fixture.bindingId },
            data: { relation: 'narrower' },
          });
        else await db.senseSourceBinding.delete({ where: { id: fixture.bindingId } });
        expect(
          (await db.learningSense.findUniqueOrThrow({ where: { id: fixture.learningSenseId } }))
            .status,
        ).toBe('held');
        expect(
          (await request('GET', `/sentences/status?wordId=${fixture.wordId}`)).json().items,
        ).toEqual([]);
        expect(
          (
            await request('POST', '/sentences', {
              sourceType: 'word-example',
              sourceId: fixture.exampleIds[0],
            })
          ).statusCode,
        ).toBe(404);
      }
    });
    it('rejects cross-word example and source bindings at the database boundary', async () => {
      const first = await makeWord('first-word'),
        second = await makeWord('second-word');
      await expect(
        db.wordExample.create({
          data: {
            id: `${prefix}-cross-example`,
            wordId: second.wordId,
            learningSenseId: first.learningSenseId,
            contentVersion: 'atomic-fixture-v1',
            status: 'published',
            contextLabel: 'Invalid fixture',
            exampleEn: 'An invalid cross-word example.',
            exampleZh: '错误的跨词绑定。',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      await expect(
        db.senseSourceBinding.create({
          data: {
            id: `${prefix}-cross-source`,
            wordId: second.wordId,
            learningSenseId: first.learningSenseId,
            sourceSenseId: second.sourceSenseId,
            relation: 'exact',
            sourcePosSha256: 'a'.repeat(64),
            sourceDefinitionZhSha256: 'b'.repeat(64),
            sourceDefinitionEnSha256: 'c'.repeat(64),
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      expect(await db.wordExample.count({ where: { id: `${prefix}-cross-example` } })).toBe(0);
      expect(await db.senseSourceBinding.count({ where: { id: `${prefix}-cross-source` } })).toBe(
        0,
      );
    });
    it('rejects cross-version examples and prevents automatic relabelling of older sentence versions', async () => {
      const fixture = await makeWord('version-boundary');
      await expect(
        db.wordExample.create({
          data: {
            id: `${fixture.wordId}-wrong-version`,
            wordId: fixture.wordId,
            learningSenseId: fixture.learningSenseId,
            contentVersion: 'atomic-fixture-v0',
            status: 'published',
            contextLabel: 'Old fixture version',
            exampleEn: 'An old example cannot become a new version automatically.',
            exampleZh: '旧例句不得自动成为新版本。',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      const before = await db.wordExample.findMany({
        where: { wordId: fixture.wordId },
        orderBy: { id: 'asc' },
      });
      await expect(
        db.learningSense.update({
          where: { id: fixture.learningSenseId },
          data: { contentVersion: 'atomic-fixture-v2' },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      expect(
        await db.wordExample.findMany({
          where: { wordId: fixture.wordId },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(before);
      expect(
        (await db.learningSense.findUniqueOrThrow({ where: { id: fixture.learningSenseId } }))
          .contentVersion,
      ).toBe('atomic-fixture-v1');
    });
    it('does not allow pronunciation metadata or GET/HEAD audio routes to bypass an incompatible-meaning flag', async () => {
      const fixture = await makeWord('heteronym', {
        pronunciation: { wordAudioCompatible: false },
      });
      await db.wordAudio.createMany({
        data: ['US', 'UK'].map((accent) => ({
          wordId: fixture.wordId,
          accent,
          kind: 'recorded',
          status: 'ready',
          sourceName: 'Original test metadata',
          sourceUrl: 'https://example.test/synthetic',
          license: 'MIT',
          attribution: 'Synthetic test only',
          fileKey: `files/${'d'.repeat(64)}.wav`,
          fileSha256: 'd'.repeat(64),
          mimeType: 'audio/wav',
        })),
      });
      const word = (await request('GET', `/words/${fixture.wordId}`)).json().word;
      expect(word).toMatchObject({
        pronunciationCompatible: false,
        phonetic: '',
        phoneticUs: '',
        phoneticUk: '',
        phonetics: [],
        audio: [],
      });
      const metadata = await request('GET', `/pronunciation/${fixture.wordId}`);
      expect(metadata.statusCode, metadata.body).toBe(200);
      expect(metadata.json().pronunciation).toMatchObject({
        pronunciationCompatible: false,
        phonetics: [],
        audio: [],
      });
      for (const method of ['GET', 'HEAD'] as const)
        for (const accent of ['US', 'UK']) {
          const denied = await request(method, `/pronunciation/${fixture.wordId}/audio/${accent}`);
          expect(denied.statusCode, denied.body).toBe(404);
          if (method === 'GET') expect(denied.json().code).toBe('audio_asset_unavailable');
        }
      await db.sense.update({
        where: { id: fixture.sourceSenseId },
        data: { definitionEn: 'Changed source bytes.' },
      });
      expect(
        (await db.learningSense.findUniqueOrThrow({ where: { id: fixture.learningSenseId } }))
          .status,
      ).toBe('held');
      expect((await request('GET', `/words/${fixture.wordId}`)).json().word).toMatchObject({
        pronunciationCompatible: false,
        audio: [],
        phonetics: [],
      });
      expect(
        (await request('GET', `/pronunciation/${fixture.wordId}`)).json().pronunciation,
      ).toMatchObject({ pronunciationCompatible: false, audio: [], phonetics: [] });
      expect((await request('GET', `/pronunciation/${fixture.wordId}/audio/US`)).statusCode).toBe(
        404,
      );
    });
  },
);
