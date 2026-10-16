import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../db.js';
import {
  countEligibleBookItems,
  countEligibleProgress,
  findEligibleBookItems,
  findEligibleProgress,
} from './learning-eligibility.js';
import { learningSenseBindingHash, learningSenseTextHash } from './learning-sense-integrity.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('learning eligibility uses real scoped PostgreSQL cursors', () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('eligibility_requires_test_database');
  const db = createDatabase(url);
  const prefix = 'eligibility-' + randomUUID();
  const userId = prefix + '-learner',
    bookId = prefix + '-book';
  const ids = Array.from(
    { length: 133 },
    (_, index) => prefix + '-' + String(index).padStart(3, '0'),
  );
  const now = new Date('2026-10-16T08:00:00Z');
  const expected = ids.slice(130);
  beforeAll(async () => {
    await db.user.create({
      data: { id: userId, email: prefix + '@example.test', name: 'Eligibility fixture' },
    });
    await db.book.create({
      data: {
        id: bookId,
        slug: bookId,
        title: 'Eligibility fixture',
        description: '',
        goal: 'daily',
        version: 'fixture',
      },
    });
    await db.word.createMany({
      data: ids.map((id) => ({ id, lemma: id, normalizedLemma: id, goalTags: [] })),
    });
    await db.sense.createMany({
      data: ids.map((id, index) => ({
        id: id + '-source',
        wordId: id,
        pos: 'n.',
        definitionZh: index < 65 ? '  ' : '测试词义',
        definitionEn: 'A synthetic fixture meaning.',
        contentMetadata:
          index >= 65 && index <= 131
            ? {
                lexicalQuality: {
                  excludeFromLearning: true,
                  field: 'definitionZh',
                  sourceTextSha256: learningSenseTextHash('测试词义'),
                },
              }
            : {},
      })),
    });
    const source = await db.sense.findUniqueOrThrow({ where: { id: ids[131]! + '-source' } });
    const binding = {
      id: prefix + '-binding',
      wordId: source.wordId,
      learningSenseId: prefix + '-meaning',
      sourceSenseId: source.id,
      relation: 'corrected-from',
      sourcePosSha256: learningSenseTextHash(source.pos),
      sourceDefinitionZhSha256: learningSenseTextHash(source.definitionZh),
      sourceDefinitionEnSha256: learningSenseTextHash(source.definitionEn),
    };
    const meaning = {
      id: prefix + '-meaning',
      wordId: source.wordId,
      pos: 'n.',
      definitionZh: '经过审核的测试学习义',
      definitionEn: 'A reviewed synthetic fixture meaning.',
      contentVersion: 'fixture-v1',
      sourceBindings: [binding],
    };
    const { sourceBindings: _bindings, ...record } = meaning;
    await db.learningSense.create({
      data: { ...record, status: 'published', bindingHash: learningSenseBindingHash(meaning) },
    });
    await db.senseSourceBinding.create({ data: binding });
    // Index 130 has the same valid raw content as 132; only 65..129 stay excluded.
    await db.sense.update({ where: { id: ids[130]! + '-source' }, data: { contentMetadata: {} } });
    await db.studyProgress.createMany({
      data: ids.map((wordId, index) => ({
        userId,
        wordId,
        fsrsJson: {},
        firstLearnedAt: now,
        dueAt: new Date(now.getTime() + index * 1000),
      })),
    });
    await db.bookItem.createMany({
      data: ids.map((wordId, ordinal) => ({
        bookId,
        wordId,
        ordinal,
        focusSenseId: ordinal === 131 ? wordId + '-source' : null,
      })),
    });
  });
  afterAll(async () => {
    await db.user.deleteMany({ where: { id: userId } });
    await db.book.deleteMany({ where: { id: bookId } });
    await db.senseSourceBinding.deleteMany({ where: { wordId: { in: ids } } });
    await db.learningSense.deleteMany({ where: { wordId: { in: ids } } });
    await db.word.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });
  it('skips more than 128 unusable candidates and fills both ordered progress and book limits', async () => {
    const progressWhere = { userId, word: { status: 'published' } };
    const due = await findEligibleProgress(
      db,
      progressWhere,
      [{ dueAt: 'asc' }, { wordId: 'asc' }],
      2,
    );
    expect(due.map((row) => row.wordId)).toEqual(expected.slice(0, 2));
    expect(await countEligibleProgress(db, progressWhere)).toBe(3);
    const bookWhere = { AND: [{ bookId }, { word: { status: 'published' } }] };
    const bookRows = await findEligibleBookItems(db, bookWhere, { ordinal: 'asc' }, 3);
    expect(bookRows.map((row) => row.wordId)).toEqual(expected);
    expect(bookRows[1]!.focusSenseId).toBe(ids[131]! + '-source');
    expect(await countEligibleBookItems(db, bookWhere)).toBe(3);
    expect(due[1]!.word.learningSenses).toHaveLength(1);
    expect(due[1]!.word).not.toHaveProperty('audio');
    expect(due[1]!.word.learningSenses[0]).not.toHaveProperty('examples');
    expect(due[1]!.word.senses[0]).not.toHaveProperty('exampleEn');
  });
});
