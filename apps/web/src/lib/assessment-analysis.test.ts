import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  AssessmentAnalysis,
  AssessmentServiceDisclosure,
  assessmentAiConsentForCapabilities,
  assessmentFinishRequest,
  type AssessmentAnalysisResult,
  type AssessmentAiCapabilities,
} from '../pages/Assessment';

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

it('identifies the saved analysis service with only its origin, without fixed DeepSeek wording or credential/path data', () => {
  const markup = renderToStaticMarkup(
    React.createElement(AssessmentServiceDisclosure, {
      service: {
        aiAvailable: true,
        aiServiceName: '本站自定义服务',
        aiServiceOrigin: 'https://user:private-secret@provider.example.test/api/v1?key=private-key',
        aiConfigurationRevision: 'opaque-consent-revision',
      },
    }),
  );
  expect(markup).toContain('本站自定义服务');
  expect(markup).toContain('https://provider.example.test');
  expect(markup).not.toContain('DeepSeek');
  expect(markup).not.toContain('private-secret');
  expect(markup).not.toContain('private-key');
  expect(markup).not.toContain('/api/v1');
  expect(markup).not.toContain('opaque-consent-revision');
  expect(markup).not.toContain('word-token');
});

it('keeps an unavailable service origin honest and renders its name as plain text', () => {
  const markup = renderToStaticMarkup(
    React.createElement(AssessmentServiceDisclosure, {
      service: {
        aiAvailable: true,
        aiServiceName: '<script>service</script>',
        aiServiceOrigin: null,
        aiConfigurationRevision: null,
      },
    }),
  );
  expect(markup).toContain('&lt;script&gt;service&lt;/script&gt;');
  expect(markup).not.toContain('<script>');
  expect(markup).not.toContain('https://');
});

const service: AssessmentAiCapabilities = {
  aiAvailable: true,
  aiServiceName: '本站 AI 服务',
  aiServiceOrigin: 'https://provider.example.test',
  aiConfigurationRevision: 'opaque-old-revision',
};
const initialConsent = { seen: false, checked: true, revision: null };

it('binds the initial displayed service to its exact opaque revision and sends it with consent', () => {
  expect(assessmentFinishRequest(undefined, initialConsent)).toEqual({ useAi: false });
  const consent = assessmentAiConsentForCapabilities(initialConsent, service);
  expect(consent).toEqual({ seen: true, checked: true, revision: 'opaque-old-revision' });
  expect(assessmentFinishRequest(service, consent)).toEqual({
    useAi: true,
    expectedAiConfigurationRevision: 'opaque-old-revision',
  });
});

it('invalidates old consent immediately when the service changes, before any effect or new request', () => {
  const consent = assessmentAiConsentForCapabilities(initialConsent, service);
  const changed = { ...service, aiConfigurationRevision: 'opaque-new-revision' };
  expect(assessmentFinishRequest(changed, consent)).toEqual({ useAi: false });
  const updated = assessmentAiConsentForCapabilities(consent, changed);
  expect(updated.checked).toBe(false);
  expect(assessmentFinishRequest(changed, updated)).toEqual({ useAi: false });
  expect(assessmentFinishRequest(changed, { ...updated, checked: true })).toEqual({
    useAi: true,
    expectedAiConfigurationRevision: 'opaque-new-revision',
  });
});

it('does not renew unchecked consent on refetch, a missing revision, or a newly available service', () => {
  const consent = assessmentAiConsentForCapabilities(initialConsent, service);
  const unchecked = { ...consent, checked: false };
  expect(assessmentAiConsentForCapabilities(unchecked, { ...service })).toBe(unchecked);
  expect(assessmentFinishRequest(service, unchecked)).toEqual({ useAi: false });
  for (const revision of [null, '', '   ']) {
    const unavailable = { ...service, aiConfigurationRevision: revision };
    expect(assessmentFinishRequest(unavailable, consent)).toEqual({ useAi: false });
    const updated = assessmentAiConsentForCapabilities(consent, unavailable);
    expect(updated.checked).toBe(false);
    expect(assessmentAiConsentForCapabilities(updated, service).checked).toBe(false);
  }
  const unavailable = { ...service, aiAvailable: false, aiConfigurationRevision: null };
  const first = assessmentAiConsentForCapabilities(initialConsent, unavailable);
  expect(assessmentAiConsentForCapabilities(first, service).checked).toBe(false);
});

it('keeps an existing base report read-only even when consent remains checked', () => {
  const consent = assessmentAiConsentForCapabilities(initialConsent, service);
  expect(assessmentFinishRequest(service, consent, true)).toEqual({ useAi: false });
});
