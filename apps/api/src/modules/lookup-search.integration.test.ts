import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase } from '../db.js';
import { HttpError, type RequestContext } from '../context.js';
import { registerContent } from './content.js';
import { learningSenseBindingHash, learningSenseTextHash } from './learning-sense-integrity.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite(
  'PostgreSQL literal lookup, indexed typo suggestions, global keysets and scope revisions',
  () => {
    if (!url) return;
    if (!new URL(url).pathname.endsWith('_test'))
      throw new Error('Lookup integration requires an isolated _test database');
    const db = createDatabase(url);
    const run = randomUUID()
      .replaceAll('-', '')
      .slice(0, 8)
      .replace(/[0-9]/g, (digit) => String.fromCharCode(97 + Number(digit)));
    const stem = `lookup${run}`;
    const userIds = [`${stem}-owner`, `${stem}-other`];
    const lemmas = [
      stem,
      ...Array.from({ length: 9 }, (_, i) => `${stem}${String.fromCharCode(97 + i)}`),
      ...Array.from({ length: 8 }, (_, i) => `${String.fromCharCode(97 + i)}${stem}`),
      `${stem}%literal`,
      `${stem}_literal`,
      `${stem}\\literal`,
    ];
    const words = lemmas.map((lemma, i) => ({
      id: `${stem}-word-${String(i).padStart(2, '0')}`,
      lemma,
      normalizedLemma: lemma,
    }));
    const own = userIds[0]!,
      other = userIds[1]!;
    const context: RequestContext = {
      siteId: 'test-site',
      instanceId: 'lookup-test-instance',
      basePath: '',
      publicUrl: 'http://lookup.test',
      title: 'Lookup test',
      fleetSecret: 'synthetic-lookup-secret'.repeat(3),
      registrationOpen: false,
      prisma: db,
      user: { id: own, name: 'Test', email: `${own}@example.test`, role: 'user' },
    };
    let app: FastifyInstance,
      createdSystem = false,
      systemId = '';
    const request = (route: string) => app.inject({ method: 'GET', url: route });
    const get = async (route: string) => {
      const response = await request(route);
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    const collect = async (route: string) => {
      const items: Array<{ id: string; lemma: string; wordId?: string; word?: { lemma: string } }> =
        [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const page = await get(
          `${route}&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        items.push(...page.items);
        if (!page.page.hasMore) {
          expect(page.page.nextCursor).toBeNull();
          return items;
        }
        cursor = page.page.nextCursor;
        expect(cursor).toBeTruthy();
      }
      throw new Error('Unbounded pagination');
    };
    beforeAll(async () => {
      for (const id of userIds)
        await db.user.create({
          data: { id, name: 'Original lookup test fixture', email: `${id}@example.test` },
        });
      await db.word.createMany({
        data: words.map((word) => ({
          ...word,
          sourceRef: 'Original lookup integration fixture',
          contentVersion: 'test-only',
        })),
      });
      await db.sense.createMany({
        data: words.map((word) => ({
          id: `${word.id}-source`,
          wordId: word.id,
          pos: 'n.',
          definitionZh: '词形检索测试',
          definitionEn: 'An original lookup fixture.',
        })),
      });
      const sourceBindings = [
        {
          sourceSenseId: `${words[0]!.id}-source`,
          relation: 'exact',
          sourcePosSha256: learningSenseTextHash('n.'),
          sourceDefinitionZhSha256: learningSenseTextHash('词形检索测试'),
          sourceDefinitionEnSha256: learningSenseTextHash('An original lookup fixture.'),
        },
      ];
      const meaning = {
        id: `${words[0]!.id}-learning`,
        wordId: words[0]!.id,
        pos: 'v.',
        definitionZh: '已审核义项摘要',
        definitionEn: 'A reviewed atomic definition.',
        status: 'published',
        contentVersion: 'test-only',
      };
      await db.learningSense.create({
        data: { ...meaning, bindingHash: learningSenseBindingHash({ ...meaning, sourceBindings }) },
      });
      await db.senseSourceBinding.create({
        data: {
          id: `${stem}-binding`,
          wordId: words[0]!.id,
          learningSenseId: meaning.id,
          ...sourceBindings[0]!,
        },
      });
      await db.userWord.createMany({
        data: words.map((word, i) => ({
          id: `${stem}-saved-${String(i).padStart(2, '0')}`,
          userId: own,
          wordId: word.id,
          note: `private-${i}`,
          updatedAt: new Date(i < 4 ? '2024-01-01T00:00:00Z' : '2024-02-01T00:00:00Z'),
        })),
      });
      await db.userWord.create({
        data: { userId: other, wordId: words[0]!.id, note: 'Other account private note' },
      });
      const system = await db.word.findUnique({
        where: { normalizedLemma: 'system' },
        select: { id: true },
      });
      if (system) systemId = system.id;
      else {
        systemId = `${stem}-system`;
        createdSystem = true;
        await db.word.create({
          data: {
            id: systemId,
            lemma: 'system',
            normalizedLemma: 'system',
            sourceRef: 'Original lookup integration fixture',
          },
        });
      }
      app = Fastify();
      app.setErrorHandler((error, _request, reply) => {
        if (error instanceof HttpError)
          return reply.code(error.statusCode).send({ code: error.code, message: error.message });
        return reply.code(500).send({
          code: 'internal_error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
      await registerContent(app, async () => context);
      await app.ready();
    }, 60000);
    afterAll(async () => {
      await app?.close();
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      await db.senseSourceBinding.deleteMany({
        where: { wordId: { in: words.map((word) => word.id) } },
      });
      await db.learningSense.deleteMany({
        where: { wordId: { in: words.map((word) => word.id) } },
      });
      await db.word.deleteMany({
        where: {
          id: { in: [...words.map((word) => word.id), ...(createdSystem ? [systemId] : [])] },
        },
      });
      await db.$executeRaw`DELETE FROM "LookupRevision" WHERE scope IN (${`user:${own}`}, ${`user:${other}`})`;
      await db.$disconnect();
    }, 60000);
    it('separates exact, prefix and contains with literal wildcard characters and normalized fullwidth/case input', async () => {
      const smart = await get(`/dictionary?q=${stem}`);
      expect(smart.items[0]).toMatchObject({
        id: words[0]!.id,
        pos: ['v.'],
        definitionZh: '已审核义项摘要',
        matchType: 'exact',
      });
      expect(smart.items[0]).not.toHaveProperty('senses');
      expect(smart.items[0]).not.toHaveProperty('audio');
      expect(smart.page.total).toBe(words.length);
      const prefix = await get(`/dictionary?q=${stem}&match=prefix`);
      expect(prefix.page.total).toBe(13);
      const contains = await get(`/dictionary?q=${stem}&match=contains`);
      expect(contains.page.total).toBe(words.length);
      const exact = await get(`/dictionary?q=${stem}&match=exact`);
      expect(exact.items.map((word: { id: string }) => word.id)).toEqual([words[0]!.id]);
      const fullwidth = stem
        .toUpperCase()
        .split('')
        .map((char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0))
        .join('');
      expect(
        (await get(`/dictionary?q=${encodeURIComponent(fullwidth)}&match=exact`)).items[0].id,
      ).toBe(words[0]!.id);
      for (const punctuation of ['%', '_', '\\']) {
        const value = await get(
          `/dictionary?q=${encodeURIComponent(stem + punctuation)}&match=contains`,
        );
        expect(value.page.total).toBe(1);
        expect(value.items[0].normalizedLemma).toContain(stem + punctuation);
      }
      expect((await request('/dictionary?q=sy&match=contains')).statusCode).toBe(400);
      expect((await request('/dictionary?q=%25__&match=contains')).statusCode).toBe(400);
      expect((await get('/dictionary')).page.total).toBe(0);
      expect((await get('/wordbook?match=contains')).page.total).toBe(words.length);
      for (const route of ['/dictionary?q=%00', '/wordbook?q=sys%00tem']) {
        const rejected = await request(route);
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json().code).toBe('invalid_input');
      }
      for (const text of ['a--', '%_\\', 'a b', ' a  b ']) {
        const encoded = encodeURIComponent(text);
        expect((await get(`/dictionary?q=${encoded}`)).query.effectiveMatch).toBe('prefix');
        expect((await request(`/dictionary?q=${encoded}&match=contains`)).statusCode).toBe(400);
      }
    });
    it('sorts the complete matching set globally across more than three pages in both directions', async () => {
      for (const sort of ['az', 'za']) {
        const result = await collect(`/dictionary?q=${stem}&sort=${sort}`);
        const expected = [...lemmas].sort();
        if (sort === 'za') expected.reverse();
        expect(result.map((word) => word.lemma)).toEqual(expected);
        expect(new Set(result.map((word) => word.id)).size).toBe(words.length);
      }
      const ranked = await collect(`/dictionary?q=${stem}&sort=relevance`);
      expect(ranked[0]!.lemma).toBe(stem);
      const prefixes = ranked.slice(1, 13).map((word) => word.lemma);
      expect(prefixes.every((lemma) => lemma.startsWith(stem))).toBe(true);
      expect(ranked.slice(13).every((word) => !word.lemma.startsWith(stem))).toBe(true);
    });
    it('keeps typo suggestions separate and scopes private suggestions to the authenticated collection', async () => {
      const result = await get('/dictionary?q=systme');
      expect(result.items).toEqual([]);
      expect(result.page.total).toBe(0);
      expect(result.suggestions).toContainEqual({
        id: systemId,
        lemma: 'system',
        matchType: 'spelling',
      });
      expect((await get('/wordbook?q=systme')).suggestions).toEqual([]);
      await db.userWord.create({ data: { userId: own, wordId: systemId } });
      expect((await get('/wordbook?q=systme')).suggestions).toContainEqual({
        id: systemId,
        lemma: 'system',
        matchType: 'spelling',
      });
      await db.userWord.deleteMany({ where: { userId: own, wordId: systemId } });
    });
    it('searches only the current account and uses stable update keys rather than an invented saved date', async () => {
      const all = await get('/wordbook');
      expect(all.items).toHaveLength(words.length);
      expect(all.query.sort).toBe('updated-desc');
      expect(all.items[0]).toMatchObject({
        id: `${stem}-saved-20`,
        note: 'private-20',
        updatedAt: '2024-02-01T00:00:00.000Z',
      });
      expect(all.items[0]).not.toHaveProperty('savedAt');
      expect(
        (await collect(`/wordbook?q=${stem}&sort=za`)).map((item) => item.word!.lemma),
      ).toEqual([...lemmas].sort().reverse());
      context.user = { ...context.user!, id: other };
      const theirs = await get(`/wordbook?q=${stem}`);
      expect(theirs.page.total).toBe(1);
      expect(theirs.items[0].note).toBe('Other account private note');
      context.user = { ...context.user, id: own };
    });
    it('rejects forged/expired/wrong-query/account/site/instance cursors without exposing rows', async () => {
      const first = await get(`/dictionary?q=${stem}&limit=1`);
      const cursor = first.page.nextCursor;
      const next = `/dictionary?q=${stem}&limit=1&cursor=${encodeURIComponent(cursor)}`;
      for (const changed of [
        next.replace('q=' + stem, 'q=another'),
        next + '&sort=az',
        next + '&match=prefix',
        next.replace(cursor, 'invalid'),
      ])
        expect((await request(changed)).statusCode).toBe(400);
      for (const field of ['siteId', 'instanceId', 'basePath'] as const) {
        const old = context[field];
        context[field] = 'another';
        expect((await request(next)).statusCode).toBe(400);
        context[field] = old;
      }
      context.user = { ...context.user!, id: other };
      expect((await request(next)).statusCode).toBe(400);
      context.user = { ...context.user, id: own };
      const privateFirst = await get('/wordbook?limit=1');
      expect(
        (
          await request(
            `/wordbook?status=all&cursor=${encodeURIComponent(privateFirst.page.nextCursor)}`,
          )
        ).statusCode,
      ).toBe(400);
    });
    it('invalidates cursors after collection edits, deletion/re-addition, and published content changes', async () => {
      const first = await get('/wordbook?limit=1');
      await db.userWord.update({
        where: { userId_wordId: { userId: own, wordId: words[0]!.id } },
        data: { note: 'changed note' },
      });
      let changed = await request(`/wordbook?cursor=${encodeURIComponent(first.page.nextCursor)}`);
      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe('list_changed');
      const again = await get('/wordbook?limit=1');
      await db.userWord.deleteMany({ where: { userId: own, wordId: words[1]!.id } });
      await db.userWord.create({ data: { userId: own, wordId: words[1]!.id } });
      changed = await request(`/wordbook?cursor=${encodeURIComponent(again.page.nextCursor)}`);
      expect(changed.statusCode).toBe(409);
      const catalog = await get(`/dictionary?q=${stem}&limit=1`);
      await db.sense.update({
        where: { id: `${words[2]!.id}-source` },
        data: { definitionZh: '公开摘要已更新' },
      });
      changed = await request(
        `/dictionary?q=${stem}&limit=1&cursor=${encodeURIComponent(catalog.page.nextCursor)}`,
      );
      expect(changed.statusCode).toBe(409);
      context.user = null;
      expect((await request('/wordbook')).statusCode).toBe(401);
      const publicPage = await get(`/dictionary?q=${stem}`);
      expect(
        publicPage.items.every(
          (word: { collection: { inWordbook: boolean } }) => !word.collection.inWordbook,
        ),
      ).toBe(true);
      context.user = { id: own, name: 'Test', email: `${own}@example.test`, role: 'user' };
    });
  },
);
