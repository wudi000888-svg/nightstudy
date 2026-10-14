import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { AssessmentAnalysis, type AssessmentAnalysisResult } from '../pages/Assessment';

vi.hoisted(() => vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} }));
beforeAll(() => vi.stubGlobal('React', React));
afterAll(() => vi.unstubAllGlobals());

const result: AssessmentAnalysisResult = {
  status: 'available',
  payload: {
    summary: '识义比拼写更稳定，先巩固拼写。',
    strengths: ['能区分本次测试的主要含义。'],
    weaknesses: ['优先练习这次拼错的词。'],
    wordFeedback: [
      { wordId: 'private-canonical-id', lemma: 'rain', suggestion: '注意中间的 ai 顺序。' },
    ],
    suggestedPlan: { dailyTotalGoal: 30, groupSize: 5 },
  },
  reason: null,
  generatedAt: '2026-10-15T00:00:00Z',
};
function render(analysis: AssessmentAnalysisResult | undefined) {
  return renderToStaticMarkup(
    React.createElement(AssessmentAnalysis, {
      analysis,
      busy: false,
      onApply: vi.fn(),
      onRefresh: vi.fn(),
    }),
  );
}

it('shows learning advice and total-word plan without internal IDs or model/provider details', () => {
  const text = render(result);
  expect(text).toContain('识义比拼写更稳定');
  expect(text).toContain('rain · ');
  expect(text).toContain('注意中间的 ai 顺序');
  expect(text).toContain('每天总计 30 个词');
  expect(text).toContain('采用这份学习建议');
  expect(text).not.toContain('private-canonical-id');
  expect(text).not.toContain('2026-10-15');
});

it('keeps historical and disabled reports uncluttered', () => {
  expect(render(undefined)).toBe('');
  expect(render({ ...result, status: 'disabled', payload: null })).toBe('');
});

it('shows a read-only refresh while another request is running without an apply button', () => {
  const text = render({ ...result, status: 'pending', payload: null });
  expect(text).toContain('答题成绩已保存');
  expect(text).toContain('更新分析');
  expect(text).not.toContain('采用这份学习建议');
});

it('does not expose technical upstream failures or suggest a paid retry', () => {
  const text = render({
    ...result,
    status: 'unavailable',
    payload: null,
    reason: 'private-provider-diagnostic',
  });
  expect(text).toContain('答题成绩和基础学习建议已保留');
  expect(text).not.toContain('private-provider-diagnostic');
  expect(text).not.toContain('重试');
});

it('treats provider text as plain text and does not create nested dictionary triggers', () => {
  const text = render({
    ...result,
    payload: { ...result.payload!, summary: '<script>private()</script>' },
  });
  expect(text).toContain('&lt;script&gt;');
  expect(text).not.toContain('<script>');
  expect(text).not.toContain('word-token');
});
