import { describe, expect, it } from 'vitest';
import { sessionDto, reservedWordIds, admitReservedCandidates } from './modules/study.js';
import { parseCsv, knownRows, csvCell } from './modules/known.js';
import { stratifiedSample } from './modules/assessment.js';
import { splitInterval, recallBins } from './modules/analytics.js';
import {
  mergedSeconds,
  freshCard,
  scheduler,
  ratingValues,
  hydrateCard,
  json,
} from './modules/shared.js';

describe('domain protocol invariants', () => {
  it('reserves each unlearned word once across current-day fixed groups', () => {
    const now = new Date('2026-10-14T10:00:00Z');
    const pending = [
      {
        bookId: 'daily',
        createdAt: now,
        items: [
          { wordId: 'rain', rated: false },
          { wordId: 'window', rated: false },
          { wordId: 'river', rated: true },
        ],
      },
      { bookId: 'cet4', createdAt: now, items: [{ wordId: 'rain', rated: false }] },
      {
        bookId: 'daily',
        createdAt: new Date('2026-10-13T10:00:00Z'),
        items: [{ wordId: 'yesterday', rated: false }],
      },
    ];
    expect([...reservedWordIds(new Set(['window']), pending, now, 'Asia/Shanghai')]).toEqual([
      'rain',
    ]);
  });
  it('limits newly issued distinct words while allowing a cross-book reserved word', () => {
    const candidates = [
      { wordId: 'rain' },
      { wordId: 'river' },
      { wordId: 'window' },
      { wordId: 'rain' },
    ];
    expect(admitReservedCandidates(candidates, 3, new Set(['rain']), 0)).toEqual([
      { wordId: 'rain' },
    ]);
    expect(admitReservedCandidates(candidates, 3, new Set(['rain']), 1)).toEqual([
      { wordId: 'rain' },
      { wordId: 'river' },
    ]);
  });
  it('does not disclose definition or practice answer before reveal', () => {
    const fixture = {
      id: 'session',
      bookId: 'daily',
      mode: 'learn',
      status: 'in_progress',
      phase: 'recall',
      cursor: 0,
      step: 'prompt',
      revision: 0,
      items: [
        {
          id: 'item',
          wordId: 'word',
          ordinal: 0,
          focusSenseId: null,
          revealed: false,
          rated: false,
          exerciseDone: false,
          status: 'pending',
          progressRevision: 0,
          contentSnapshot: {
            id: 'word',
            lemma: 'rain',
            phonetic: 'reɪn',
            senses: [{ definitionZh: '雨' }],
          },
          questionJson: { prompt: '请拼写', answer: 'rain' },
        },
      ],
    } as unknown as Parameters<typeof sessionDto>[0];
    expect(sessionDto(fixture).bookId).toBe('daily');
    expect(sessionDto(fixture).items[0]?.word).toEqual({
      id: 'word',
      lemma: 'rain',
      phonetic: 'reɪn',
    });
    expect(JSON.stringify(sessionDto(fixture))).not.toContain('definitionZh');
    fixture.items[0]!.revealed = true;
    expect(JSON.stringify(sessionDto(fixture))).toContain('definitionZh');
    fixture.phase = 'practice';
    expect(sessionDto(fixture).items[0]?.question).toEqual({
      id: 'spelling-item',
      type: 'spelling',
      prompt: '请拼写',
    });
    expect(JSON.stringify(sessionDto(fixture))).not.toContain('"answer"');
  });
  it('parses quoted multiline CSV and preserves Unicode input', () => {
    expect(parseCsv('lemma,note\r\n"rain","第一行\n第二行"\r\n"window","say ""hello"""')).toEqual([
      ['lemma', 'note'],
      ['rain', '第一行\n第二行'],
      ['window', 'say "hello"'],
    ]);
    expect(
      knownRows('json', '{"rows":[{"lemma":"rain","verified":true,"userId":"other"}]}'),
    ).toEqual([{ lemma: 'rain' }]);
    expect(() => parseCsv('lemma\n"rain')).toThrow();
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
  });
  it('samples each difficulty stratum deterministically without repeated words', () => {
    const words = Array.from({ length: 12 }, (_, n) => ({ id: String(n), difficulty: n % 3 }));
    const sample = stratifiedSample(words, 6, 'fixed-seed');
    expect(sample).toEqual(stratifiedSample(words, 6, 'fixed-seed'));
    expect(new Set(sample.map((w) => w.id)).size).toBe(6);
    expect(new Set(sample.map((w) => w.difficulty)).size).toBe(3);
  });
  it('splits midnight at a timezone boundary without per-second accumulation', () => {
    const split = splitInterval(
      new Date('2026-10-13T15:59:50Z'),
      new Date('2026-10-13T16:00:10Z'),
      'Asia/Shanghai',
    );
    expect(split.map((i) => [i.date, (i.endAt.getTime() - i.startAt.getTime()) / 1000])).toEqual([
      ['2026-10-13', 10],
      ['2026-10-14', 10],
    ]);
    expect(
      mergedSeconds([
        { startAt: new Date(0), endAt: new Date(20000) },
        { startAt: new Date(10000), endAt: new Date(30000) },
      ]),
    ).toBe(30);
  });
  it('keeps absence of observations separate from zero-percent feedback', () => {
    expect(recallBins([]).every((bin) => bin.count === 0 && bin.againRate === null)).toBe(true);
    const bins = recallBins([
      {
        beforeState: { last_review: '2026-10-13T00:00:00Z' },
        reviewedAt: new Date('2026-10-14T00:00:00Z'),
        rating: 'again',
      },
    ]);
    expect(bins[1]).toMatchObject({ count: 1, againRate: 1 });
  });
  it('runs real FSRS and produces a declining prediction after a real review', () => {
    const at = new Date('2026-10-14T00:00:00Z');
    const reviewed = scheduler.next(freshCard(at), at, ratingValues.good).card;
    const restored = hydrateCard(json(reviewed));
    expect(restored.reps).toBe(1);
    expect(restored.due.getTime()).toBeGreaterThan(at.getTime());
    expect(
      Number(scheduler.get_retrievability(restored, new Date(at.getTime() + 86400000), false)),
    ).toBeGreaterThan(
      Number(scheduler.get_retrievability(restored, new Date(at.getTime() + 30 * 86400000), false)),
    );
  });
});
