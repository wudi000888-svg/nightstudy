import { describe, expect, it } from 'vitest';
import { evaluateFamiliarity, type FamiliarityEvidence } from './familiarity-policy.js';

const log = (day: number, extra: Partial<FamiliarityEvidence> = {}): FamiliarityEvidence => ({
  rating: 'good',
  reviewedAt: new Date(`2026-05-${String(day).padStart(2, '0')}T12:00:00Z`),
  wasNew: false,
  afterReps: day,
  learningDayKey: `day-${day}`,
  ...extra,
});
describe('accepted-review collection policy', () => {
  it('requires Review state, real stability and three/five different successful review days', () => {
    expect(
      evaluateFamiliarity({ state: 2, stability: 14 }, [log(1), log(2), log(3)]).graduate,
    ).toBe(true);
    expect(
      evaluateFamiliarity(
        { state: 2, stability: 90 },
        [1, 2, 3, 4, 5].map((day) => log(day)),
      ).automaticKnown,
    ).toBe(true);
    for (const state of [0, 1, 3])
      expect(
        evaluateFamiliarity(
          { state, stability: 100 },
          [1, 2, 3, 4, 5].map((day) => log(day)),
        ).graduate,
      ).toBe(false);
    for (const stability of [13.999, NaN, Infinity, '90'])
      expect(
        evaluateFamiliarity(
          { state: 2, stability },
          [1, 2, 3, 4, 5].map((day) => log(day)),
        ).graduate,
      ).toBe(false);
  });
  it('does not count first learning, hard ratings or repeated ratings in one learning day', () => {
    const logs = [
      log(1, { wasNew: true }),
      log(2, { rating: 'hard' }),
      log(3),
      log(4, { learningDayKey: 'day-3' }),
      log(5, { learningDayKey: 'day-3' }),
    ];
    expect(evaluateFamiliarity({ state: 2, stability: 200 }, logs)).toEqual({
      successfulReviewDays: 1,
      graduate: false,
      automaticKnown: false,
    });
  });
  it('resets success evidence after Again and orders same-timestamp accepted ratings by FSRS reps', () => {
    const at = new Date('2026-05-04T12:00:00Z');
    const logs = [
      log(1),
      log(2),
      log(3),
      log(4, { rating: 'again', reviewedAt: at }),
      log(5, { reviewedAt: at }),
      log(6),
      log(7),
    ];
    expect(evaluateFamiliarity({ state: 2, stability: 90 }, logs)).toEqual({
      successfulReviewDays: 3,
      graduate: true,
      automaticKnown: false,
    });
  });
  it('handles legacy evidence conservatively when FSRS reps are absent and never mutates input', () => {
    const logs = [
      log(1, { afterReps: null }),
      log(2, { rating: 'again', afterReps: null }),
      log(3, { afterReps: null }),
      log(4, { afterReps: null }),
    ];
    const before = JSON.stringify(logs);
    expect(evaluateFamiliarity({ state: 2, stability: 100 }, logs).successfulReviewDays).toBe(2);
    expect(JSON.stringify(logs)).toBe(before);
  });
});
