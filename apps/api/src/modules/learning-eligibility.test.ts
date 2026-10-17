import { describe, expect, it, vi } from 'vitest';
import type { Sense } from '@prisma/client';
import {
  countEligibleBookItems,
  countEligibleProgress,
  createLearningEligibilityCache,
  findEligibleBookItems,
  findEligibleProgress,
  hasLearningContent,
  learningEligibilitySelect,
  type EligibleBookItem,
  type EligibleProgress,
  type LearningEligibilityWord,
} from './learning-eligibility.js';
import { selectWordLearningSense, type Db, type WordWithSenses } from './shared.js';
import * as shared from './shared.js';
import { learningSenseBindingHash, learningSenseTextHash } from './learning-sense-integrity.js';

const now = new Date('2026-10-16T08:00:00Z');
function source(wordId: string, zh = '银行', excluded = false): Sense {
  return {
    id: wordId + '-source',
    wordId,
    pos: 'n.',
    definitionZh: zh,
    definitionEn: 'A place where money is kept.',
    ordinal: 0,
    exampleEn: '',
    exampleZh: '',
    contentMetadata: excluded
      ? {
          lexicalQuality: {
            excludeFromLearning: true,
            field: 'definitionZh',
            sourceTextSha256: learningSenseTextHash(zh),
          },
        }
      : {},
  };
}
function word(id: string, zh = '银行', excluded = false): LearningEligibilityWord {
  return { id, senses: [source(id, zh, excluded)], learningSenses: [] };
}
function atomicOnly(id = 'atomic'): LearningEligibilityWord {
  const raw = source(id, '  ', true);
  const binding = {
    id: id + '-binding',
    wordId: id,
    learningSenseId: id + '-meaning',
    sourceSenseId: raw.id,
    relation: 'corrected-from',
    sourcePosSha256: learningSenseTextHash(raw.pos),
    sourceDefinitionZhSha256: learningSenseTextHash(raw.definitionZh),
    sourceDefinitionEnSha256: learningSenseTextHash(raw.definitionEn),
    contentMetadata: {},
    sourceSense: raw,
  };
  const meaning = {
    id: id + '-meaning',
    wordId: id,
    pos: 'n.',
    definitionZh: '银行',
    definitionEn: 'A business that keeps and lends money.',
    contentVersion: 'fixture-v1',
    sourceBindings: [binding],
    status: 'published',
    ordinal: 0,
    contentMetadata: {},
  };
  return {
    id,
    senses: [raw],
    learningSenses: [{ ...meaning, bindingHash: learningSenseBindingHash(meaning) }],
  };
}
function fullWord(value: LearningEligibilityWord): WordWithSenses {
  const complete = (s: LearningEligibilityWord['senses'][number]): Sense => ({
    ...s,
    ordinal: 0,
    exampleEn: '',
    exampleZh: '',
  });
  return {
    ...value,
    lemma: value.id,
    normalizedLemma: value.id,
    phonetic: '',
    phoneticUs: '',
    phoneticUk: '',
    phoneticSource: '',
    goalTags: [],
    difficulty: 1,
    status: 'published',
    sourceRef: 'test',
    contentVersion: 'fixture-v1',
    createdAt: now,
    updatedAt: now,
    senses: value.senses.map(complete),
    learningSenses: value.learningSenses.map((s) => ({
      ...s,
      examples: [],
      sourceBindings: s.sourceBindings.map((b) => ({ ...b, sourceSense: complete(b.sourceSense) })),
    })),
  };
}
function progress(id: string, content: LearningEligibilityWord): EligibleProgress {
  return {
    id,
    userId: 'learner',
    wordId: content.id,
    word: content,
    fsrsJson: {},
    dueAt: now,
    lastReviewAt: now,
    firstLearnedAt: now,
    revision: 0,
    reviewFocusSenseId: null,
    reviewFocusRevision: 0,
    algorithmVersion: 'fixture',
    paramVersion: 'fixture',
    updatedAt: now,
  };
}
function bookItem(id: string, content: LearningEligibilityWord, ordinal: number): EligibleBookItem {
  return { id, bookId: 'book', wordId: content.id, word: content, focusSenseId: null, ordinal };
}
function fakeDatabase<T extends { id: string }>(rows: T[]) {
  const findMany = vi.fn(
    async ({ cursor, skip, take }: { cursor?: { id: string }; skip?: number; take: number }) => {
      const start = cursor ? rows.findIndex((row) => row.id === cursor.id) + (skip ?? 0) : 0;
      return rows.slice(start, start + take);
    },
  );
  return { db: { studyProgress: { findMany }, bookItem: { findMany } } as unknown as Db, findMany };
}

describe('minimal learning content eligibility', () => {
  it('passes every book focus to the exact shared selector, including its fallback policy', async () => {
    const content = word('focus');
    const excluded = source('focus', '不得单独用于学习的旧义', true);
    excluded.id = 'focus-excluded';
    content.senses.push(excluded);
    const rows = [bookItem('one', content, 0), bookItem('two', content, 1)];
    rows[0]!.focusSenseId = 'focus-source';
    rows[1]!.focusSenseId = 'focus-excluded';
    const { db } = fakeDatabase(rows);
    const spy = vi.spyOn(shared, 'selectWordLearningSense');
    try {
      expect((await findEligibleBookItems(db, { bookId: 'book' })).map((row) => row.id)).toEqual([
        'one',
        'two',
      ]);
      expect(spy.mock.calls.map((call) => call[1])).toEqual(['focus-source', 'focus-excluded']);
      expect(await countEligibleBookItems(db, { bookId: 'book' })).toBe(2);
      expect(spy.mock.calls.slice(2).map((call) => call[1])).toEqual([
        'focus-source',
        'focus-excluded',
      ]);
      expect(selectWordLearningSense(fullWord(content), 'focus-excluded')?.id).toBe('focus-source');
    } finally {
      spy.mockRestore();
    }
  });
  it('matches the actual issued-word selector for raw text, excluded content, atomic-only and source drift', () => {
    const atomic = atomicOnly();
    const held = structuredClone(atomic);
    held.learningSenses[0]!.status = 'held';
    const drift = structuredClone(atomic);
    drift.learningSenses[0]!.sourceBindings[0]!.sourceSense.pos = 'v.';
    const badHash = structuredClone(atomic);
    badHash.learningSenses[0]!.bindingHash = '0'.repeat(64);
    const fixtures = [
      word('good'),
      word('blank', '  '),
      word('excluded', '银行', true),
      atomic,
      held,
      drift,
      badHash,
    ];
    expect(fixtures.map((word) => hasLearningContent(word))).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
    for (const item of fixtures)
      expect(hasLearningContent(item)).toBe(Boolean(selectWordLearningSense(fullWord(item))));
  });
  it('does not project examples, audio, or collocations for eligibility', () => {
    const projection = JSON.stringify(learningEligibilitySelect);
    for (const name of ['examples', 'exampleEn', 'exampleZh', 'audio', 'collocations'])
      expect(projection).not.toContain('"' + name + '"');
    expect(learningEligibilitySelect.learningSenses.where.status).toBe('published');
  });
});

describe('scoped candidate scanning', () => {
  it('fills a progress limit after more than one page of ineligible front entries', async () => {
    const rows = Array.from({ length: 130 }, (_, i) => progress('bad-' + i, word('bad-' + i, ' ')));
    rows.push(...[0, 1, 2].map((i) => progress('good-' + i, word('good-' + i))));
    const { db, findMany } = fakeDatabase(rows);
    const where = { userId: 'learner', dueAt: { lte: now } };
    const result = await findEligibleProgress(db, where, [{ dueAt: 'asc' }, { wordId: 'asc' }], 2);
    expect(result.map((row) => row.id)).toEqual(['good-0', 'good-1']);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[0]![0]).toMatchObject({ where, take: 128 });
    expect(findMany.mock.calls[1]![0]).toMatchObject({
      cursor: { id: 'bad-127' },
      skip: 1,
      orderBy: [{ dueAt: 'asc' }, { wordId: 'asc' }, { id: 'asc' }],
    });
  });
  it('fills and counts only a fixed book and accepts a valid atomic meaning without a usable raw definition', async () => {
    const rows = Array.from({ length: 130 }, (_, i) =>
      bookItem('bad-' + i, word('bad-' + i, '银行', true), i),
    );
    rows.push(bookItem('one', atomicOnly(), 130), bookItem('two', word('two'), 131));
    const { db } = fakeDatabase(rows);
    const where = { AND: [{ bookId: 'book' }, { word: { status: 'published' } }] };
    expect(
      (await findEligibleBookItems(db, where, { ordinal: 'asc' }, 2)).map((row) => row.id),
    ).toEqual(['one', 'two']);
    expect(await countEligibleBookItems(db, where)).toBe(2);
  });
  it('returns zero without database queries for an exhausted limit and rejects invalid limits', async () => {
    const { db, findMany } = fakeDatabase([]);
    expect(await findEligibleProgress(db, { userId: 'learner' }, { id: 'asc' }, 0)).toEqual([]);
    expect(await findEligibleBookItems(db, { bookId: 'book' }, { id: 'asc' }, 0)).toEqual([]);
    for (const limit of [-1, 0.5, NaN, Infinity])
      await expect(
        findEligibleProgress(db, { userId: 'learner' }, { id: 'asc' }, limit),
      ).rejects.toThrow('invalid_limit');
    expect(findMany).not.toHaveBeenCalled();
  });
  it('refuses unscoped, OR-only, or broad filter scans instead of searching the whole dictionary', async () => {
    const { db, findMany } = fakeDatabase([]);
    for (const where of [{}, { OR: [{ userId: 'learner' }, {}] }, { userId: { in: ['learner'] } }])
      await expect(findEligibleProgress(db, where, { id: 'asc' })).rejects.toThrow(
        'requires_fixed_userId',
      );
    for (const where of [{}, { OR: [{ bookId: 'book' }, {}] }])
      await expect(countEligibleBookItems(db, where)).rejects.toThrow('requires_fixed_bookId');
    expect(findMany).not.toHaveBeenCalled();
  });
  it('memoizes repeated counts only when explicitly supplied the same operation cache and database', async () => {
    const first = fakeDatabase([progress('good', word('good'))]);
    const second = fakeDatabase([progress('bad', word('bad', ' '))]);
    const cache = createLearningEligibilityCache();
    expect(await countEligibleProgress(first.db, { userId: 'learner' }, cache)).toBe(1);
    expect(await countEligibleProgress(first.db, { userId: 'learner' }, cache)).toBe(1);
    expect(first.findMany).toHaveBeenCalledTimes(1);
    expect(await countEligibleProgress(second.db, { userId: 'learner' }, cache)).toBe(0);
    expect(second.findMany).toHaveBeenCalledTimes(1);
  });
});
