import { describe, expect, it } from 'vitest';
import { suggestedPlan } from './assessment.js';

describe('assessment recommendations include review pressure', () => {
  it('distinguishes suggested new words from a daily total target', () => {
    expect(suggestedPlan(0.9, 0.9, 32)).toMatchObject({
      newWordSuggestion: 12,
      reviewPressure: 32,
      dailyTotalGoal: 44,
      countBasis: 'daily-unique-words',
    });
  });
  it('caps a heavy review backlog without concealing its size', () => {
    expect(suggestedPlan(0.2, 0.2, 140)).toMatchObject({
      newWordSuggestion: 8,
      reviewPressure: 140,
      dailyTotalGoal: 100,
    });
  });
  it('keeps a low-data diagnostic separate from a promise of mastery', () => {
    expect(suggestedPlan(0, 0)).toMatchObject({
      dailyTotalGoal: 20,
      newWordSuggestion: 8,
      reviewPressure: 0,
    });
  });
});
