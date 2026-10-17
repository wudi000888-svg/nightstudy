import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../db.js';
import { learningSenseBindingHash, learningSenseTextHash } from './learning-sense-integrity.js';
import { loadRecognitionPool } from './study-recognition-pool.js';
import { createRecognitionQuestion } from './study-recognition.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('bounded same-book grammatical recognition pools', () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith('_test')) throw new Error('test_database_required');
  const db = createDatabase(url),
    stem = 'pospool-' + randomUUID();
  const own = stem + '-owner',
    foreign = stem + '-foreign',
    book = stem + '-book';
  const ids: string[] = [];
  const include = {
    learningSenses: {
      include: { sourceBindings: { include: { sourceSense: true } }, examples: true },
    },
  };
  async function add(index: string, lemma: string, zh: string, pos: string, bookId = book) {
    const id = stem + '-' + index,
      sourceId = id + '-source',
      senseId = id + '-meaning';
    ids.push(id);
    await db.word.create({
      data: { id, lemma: lemma + ' ' + stem, normalizedLemma: lemma + ' ' + stem, goalTags: [] },
    });
    const source = await db.sense.create({
      data: {
        id: sourceId,
        wordId: id,
        pos,
        definitionZh: zh,
        definitionEn: 'Original test meaning for ' + lemma,
      },
    });
    const binding = {
      sourceSenseId: sourceId,
      relation: 'exact',
      sourcePosSha256: learningSenseTextHash(pos),
      sourceDefinitionZhSha256: learningSenseTextHash(zh),
      sourceDefinitionEnSha256: learningSenseTextHash(source.definitionEn),
    };
    const sense = {
      id: senseId,
      wordId: id,
      pos,
      definitionZh: zh,
      definitionEn: source.definitionEn,
      contentVersion: stem,
    };
    await db.learningSense.create({
      data: {
        ...sense,
        status: 'published',
        bindingHash: learningSenseBindingHash({ ...sense, sourceBindings: [binding] }),
      },
    });
    await db.senseSourceBinding.create({
      data: { ...binding, id: id + '-binding', wordId: id, learningSenseId: senseId },
    });
    await db.bookItem.create({
      data: { bookId, wordId: id, ordinal: ids.length, focusSenseId: senseId },
    });
    return id;
  }
  beforeAll(async () => {
    await db.user.createMany({
      data: [own, foreign].map((id) => ({
        id,
        email: id + '@example.test',
        name: 'Synthetic pool owner',
      })),
    });
    await db.book.createMany({
      data: [
        {
          id: book,
          slug: book,
          title: 'Synthetic pool',
          description: 'Original test fixture',
          goal: 'daily',
          ownerId: own,
        },
        {
          id: book + '-foreign',
          slug: book + '-foreign',
          title: 'Private foreign pool',
          description: 'Original test fixture',
          goal: 'daily',
          ownerId: foreign,
        },
      ],
    });
    for (let i = 0; i < 160; i++)
      await add('a-noun-' + String(i).padStart(3, '0'), 'object' + i, '合成名词' + i, 'n.');
    for (const [i, lemma, zh] of [
      ['0', 'under', '在某物下面'],
      ['1', 'around', '围绕某物'],
      ['2', 'despite', '尽管存在某种情况'],
      ['3', 'within', '在某个范围以内'],
    ])
      await add('z-preposition-' + i, lemma!, zh!, 'prep.');
    for (let i = 0; i < 3; i++)
      await add('b-private-' + i, 'secret' + i, '另一账户秘密内容' + i, 'prep.', book + '-foreign');
  }, 60000);
  afterAll(async () => {
    await db.book.deleteMany({ where: { id: { in: [book, book + '-foreign'] } } });
    await db.senseSourceBinding.deleteMany({ where: { wordId: { in: ids } } });
    await db.learningSense.deleteMany({ where: { wordId: { in: ids } } });
    await db.word.deleteMany({ where: { id: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: [own, foreign] } } });
    await db.$disconnect();
  });
  it('finds a rare grammatical class beyond 160 leading nouns without reading another private book', async () => {
    const target = await db.word.findUniqueOrThrow({
      where: { id: stem + '-z-preposition-0' },
      include,
    });
    const legacy = await db.word.findMany({
      where: {
        bookItems: { some: { bookId: book } },
        learningSenses: { some: { status: 'published' } },
      },
      orderBy: { id: 'asc' },
      take: 160,
      include,
    });
    expect(createRecognitionQuestion(target, target.id + '-meaning', legacy)).toBeNull();
    const pool = await loadRecognitionPool(db, book, [
      { word: target, focusId: target.id + '-meaning' },
    ]);
    expect(pool).toHaveLength(4);
    expect(
      pool.every((word) =>
        word.learningSenses?.every(
          (sense) =>
            !('examples' in sense) &&
            !('contentMetadata' in sense) &&
            sense.sourceBindings.every((binding) => !('contentMetadata' in binding.sourceSense)),
        ),
      ),
    ).toBe(true);
    const question = createRecognitionQuestion(target, target.id + '-meaning', pool)!;
    expect(question.options).toHaveLength(4);
    expect(JSON.stringify(question)).not.toContain('秘密');
  });
  it('does not widen a missing book scope to the site catalog', async () => {
    const target = await db.word.findUniqueOrThrow({
      where: { id: stem + '-z-preposition-0' },
      include,
    });
    const pool = await loadRecognitionPool(db, null, [
      { word: target, focusId: target.id + '-meaning' },
    ]);
    expect(pool.map((word) => word.id)).toEqual([target.id]);
    expect(createRecognitionQuestion(target, target.id + '-meaning', pool)).toBeNull();
  });
  it('does not query candidates for an unverified or unmatched focus', async () => {
    const target = await db.word.findUniqueOrThrow({
      where: { id: stem + '-z-preposition-0' },
      include,
    });
    expect(await loadRecognitionPool(db, book, [{ word: target, focusId: 'unbound' }])).toEqual([]);
  });
});
