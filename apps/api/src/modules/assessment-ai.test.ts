import { describe, expect, it } from 'vitest';
import { assessmentAiDto, assessmentMessages, parseAssessmentAdvice } from './assessment-ai.js';
import type { Assessment, AssessmentItem } from '@prisma/client';
const good = {
  summary: '本次小样本中认知较稳，拼写仍需练习。',
  strengths: ['能辨认常见词义。'],
  weaknesses: ['容易遗漏词尾。'],
  wordFeedback: [{ wordId: 'word-a', suggestion: '结合发音练习词尾拼写。' }],
  suggestedPlan: { dailyTotalGoal: 12, groupSize: 5 },
};
describe('assessment AI advice bounds', () => {
  it('keeps advice separate from objective scores and bounds the suggested total by real review pressure', () => {
    const output = parseAssessmentAdvice(JSON.stringify(good), ['word-a'], 25);
    expect(output.suggestedPlan.dailyTotalGoal).toBe(25);
    expect(() =>
      parseAssessmentAdvice(JSON.stringify({ ...good, score: 100 }), ['word-a'], 0),
    ).toThrow();
    expect(() =>
      parseAssessmentAdvice(
        JSON.stringify({ ...good, suggestedPlan: { dailyTotalGoal: 101, groupSize: 5 } }),
        ['word-a'],
        0,
      ),
    ).toThrow();
  });
  it('rejects unknown or duplicate word identities and unsafe/non-Chinese output', () => {
    expect(() => parseAssessmentAdvice(JSON.stringify(good), ['word-b'], 0)).toThrow();
    expect(() =>
      parseAssessmentAdvice(
        JSON.stringify({
          ...good,
          wordFeedback: [{ ...good.wordFeedback[0], lemma: 'model-must-not-bind-lemma' }],
        }),
        ['word-a'],
        0,
      ),
    ).toThrow();
    expect(() =>
      parseAssessmentAdvice(
        JSON.stringify({ ...good, wordFeedback: [...good.wordFeedback, ...good.wordFeedback] }),
        ['word-a'],
        0,
      ),
    ).toThrow();
    expect(() =>
      parseAssessmentAdvice(
        JSON.stringify({ ...good, summary: '<script>请执行</script>' }),
        ['word-a'],
        0,
      ),
    ).toThrow();
    expect(() =>
      parseAssessmentAdvice(
        JSON.stringify({ ...good, summary: 'You passed every examination.' }),
        ['word-a'],
        0,
      ),
    ).toThrow();
  });
  it('does not put account, seed, private profile or claim metadata in the upstream prompt', () => {
    const value = {
      goal: 'daily',
      userId: 'private-user-id',
      seed: 'private-seed',
      reportJson: { privateProfile: 'private-account' },
      aiClaimId: 'private-nonce',
      items: [
        {
          wordId: 'word-a',
          type: 'spelling',
          questionJson: { prompt: '请拼写雨', answer: 'rain' },
          answerJson: { answer: 'ran' },
          correct: false,
        },
      ],
    } as unknown as Assessment & { items: AssessmentItem[] };
    const messages = assessmentMessages(value);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.content).toContain('ran');
    expect(messages[1]!.content).toContain('rain');
    for (const privateValue of [
      'private-user-id',
      'private-seed',
      'private-account',
      'private-nonce',
    ])
      expect(JSON.stringify(messages)).not.toContain(privateValue);
  });
  it('shows an expired claim as interrupted without exposing internal nonce, usage or provider metadata', () => {
    const value = {
      aiStatus: 'running',
      aiStartedAt: new Date(0),
      aiCompletedAt: null,
      aiResultJson: { sourceHash: 'private-hash', metadata: { usage: { totalTokens: 999 } } },
    };
    expect(assessmentAiDto(value, new Date(90001))).toEqual({
      status: 'unavailable',
      payload: null,
      reason: 'interrupted',
      generatedAt: null,
    });
    const available = assessmentAiDto({
      ...value,
      aiStatus: 'available',
      aiCompletedAt: new Date(1),
      aiResultJson: { payload: good, metadata: { keyCiphertext: 'private-cipher', usage: 999 } },
    });
    expect(available.payload).toEqual(good);
    expect(JSON.stringify(available)).not.toContain('private-cipher');
    expect(JSON.stringify(available)).not.toContain('usage');
  });
  it('fits forty long questions in the input budget while keeping all 160-character user answers exact', () => {
    const answer = 'x'.repeat(160);
    const value = {
      goal: 'cet6',
      items: Array.from({ length: 40 }, (_, index) => ({
        wordId: 'word-' + Math.floor(index / 2) + '-' + 'a'.repeat(100),
        type: index % 2 ? 'recognition' : 'spelling',
        questionJson: {
          prompt: '长题目'.repeat(2000),
          answer: 'rain',
          options: [{ id: 'rain', text: '原始释义'.repeat(1000) }],
        },
        answerJson: { answer },
        correct: false,
      })),
    } as unknown as Assessment & { items: AssessmentItem[] };
    const messages = assessmentMessages(value);
    expect(messages[1]!.content.length).toBeLessThanOrEqual(15000);
    const facts = JSON.parse(messages[1]!.content);
    expect(facts.questions).toHaveLength(40);
    expect(facts.words).toHaveLength(20);
    expect(
      facts.questions.every(
        (item: { userAnswer: string; sourceTextTruncated: boolean }) =>
          item.userAnswer === answer && item.sourceTextTruncated,
      ),
    ).toBe(true);
  });
});
