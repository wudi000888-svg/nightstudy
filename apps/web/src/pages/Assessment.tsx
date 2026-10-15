import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, Sparkles } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useApp, useRemote } from '../AppContext';
import { api, ApiError, post } from '../lib/api';
import { AssessmentAnswerSender } from '../lib/assessment-answers';
import { goalLabels, goalNames, type Goal, type Question, type Settings } from '../lib/types';
import { Empty, ErrorNotice, Heading, LoginPrompt, Notice, Panel } from '../components/UI';
interface AssessmentItem {
  id: string;
  type: string;
  ordinal: number;
  answered: boolean;
  question?: Question;
}
interface Assessment {
  id: string;
  goal: Goal;
  status: string;
  version: string;
  currentItemId: string | null;
  items: AssessmentItem[];
}
interface Report {
  sampledWords: number;
  totalCandidates: number;
  accuracy: { recognition: number | null; spelling: number | null };
  confidence: string;
  verifiedWordIds: string[];
  suggestedPlan: {
    dailyTotalGoal?: number;
    newWordSuggestion?: number;
    reviewPressure?: number;
    countBasis?: 'daily-unique-words';
    dailyNewLimit?: number;
    groupSize: number;
  };
  byStratum: unknown;
  aiAnalysis?: AssessmentAnalysisResult;
}
export interface AssessmentAnalysisResult {
  status: 'available' | 'unavailable' | 'disabled' | 'pending';
  payload: {
    summary: string;
    strengths: string[];
    weaknesses: string[];
    wordFeedback: { wordId: string; lemma?: string; suggestion: string }[];
    suggestedPlan: { dailyTotalGoal: number; groupSize: number };
  } | null;
  reason: string | null;
  generatedAt: string | null;
}
export interface AssessmentAiCapabilities {
  aiAvailable: boolean;
  aiServiceName: string;
  aiServiceOrigin: string | null;
  aiConfigurationRevision: string | null;
}
interface AssessmentAiConsent {
  seen: boolean;
  checked: boolean;
  revision: string | null;
}
function assessmentAiRevision(service: AssessmentAiCapabilities | undefined) {
  const revision = service?.aiConfigurationRevision;
  return service?.aiAvailable && typeof revision === 'string' && revision.trim() ? revision : null;
}
export function assessmentAiConsentForCapabilities(
  consent: AssessmentAiConsent,
  service: AssessmentAiCapabilities | undefined,
): AssessmentAiConsent {
  if (!service) return consent;
  const revision = assessmentAiRevision(service);
  if (!consent.seen) return { seen: true, checked: !!revision, revision };
  return revision === consent.revision ? consent : { seen: true, checked: false, revision };
}
export function assessmentFinishRequest(
  service: AssessmentAiCapabilities | undefined,
  consent: AssessmentAiConsent,
  hasBaseReport = false,
): { useAi: false } | { useAi: true; expectedAiConfigurationRevision: string } {
  const revision = assessmentAiRevision(service);
  return !hasBaseReport && consent.checked && revision && consent.revision === revision
    ? { useAi: true, expectedAiConfigurationRevision: revision }
    : { useAi: false };
}
export function AssessmentServiceDisclosure({ service }: { service: AssessmentAiCapabilities }) {
  let origin: string | null = null;
  try {
    const url = new URL(service.aiServiceOrigin ?? '');
    if (['https:', 'http:'].includes(url.protocol)) origin = url.origin;
  } catch {
    /* Historical capabilities may not contain an origin. */
  }
  return (
    <small className="fine-print">
      由 {service.aiServiceName?.trim() || '本站 AI 服务'}
      {origin ? `（${origin}）` : ''} 分析本次目标、题目与答案，不包含账户身份。
    </small>
  );
}

export function AssessmentAnalysis({
  analysis,
  busy,
  onApply,
  onRefresh,
}: {
  analysis: AssessmentAnalysisResult | undefined;
  busy: boolean;
  onApply: () => void;
  onRefresh: () => void;
}) {
  if (!analysis || analysis.status === 'disabled') return null;
  if (analysis.status === 'pending')
    return (
      <div className="management-card management-list" role="status">
        <strong>正在分析学习情况…</strong>
        <p>答题成绩已保存，可以先查看。分析完成后更新这份报告。</p>
        <button className="button quiet" disabled={busy} onClick={onRefresh}>
          更新分析
        </button>
      </div>
    );
  if (analysis.status !== 'available' || !analysis.payload)
    return <p className="fine-print">本次智能分析暂不可用，答题成绩和基础学习建议已保留。</p>;
  const result = analysis.payload;
  return (
    <div className="management-card management-list">
      <div className="panel-title">
        <Sparkles size={18} />
        <h3>学习分析</h3>
      </div>
      <p>{result.summary}</p>
      {result.strengths.length > 0 && (
        <div>
          <strong>已经做得不错</strong>
          <ul>
            {result.strengths.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </div>
      )}
      {result.weaknesses.length > 0 && (
        <div>
          <strong>接下来重点练习</strong>
          <ul>
            {result.weaknesses.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </div>
      )}
      {result.wordFeedback.length > 0 && (
        <div>
          <strong>本次答题建议</strong>
          <ul>
            {result.wordFeedback.map((item, index) => (
              <li key={`${item.wordId}:${index}`}>
                {item.lemma && <strong lang="en">{item.lemma} · </strong>}
                {item.suggestion}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p>
        建议每天总计 {result.suggestedPlan.dailyTotalGoal} 个词，每组{' '}
        {result.suggestedPlan.groupSize} 词，先复习再新学。
      </p>
      <p className="fine-print">结合本次答案的辅助建议，熟练度仍由实际学习与复习积累。</p>
      <button className="button ghost" disabled={busy} onClick={onApply}>
        采用这份学习建议 <ArrowRight size={16} />
      </button>
    </div>
  );
}

export function AssessmentPage() {
  const { user, scope } = useApp();
  if (!user)
    return (
      <div className="page">
        <LoginPrompt />
      </div>
    );
  return <AssessmentContent key={scope} />;
}

function AssessmentContent() {
  const { user, scope } = useApp();
  const client = useQueryClient();
  const [goal, setGoal] = useState<Goal>('daily');
  const [size, setSize] = useState(12);
  const [aiConsent, setAiConsent] = useState<AssessmentAiConsent>({
    seen: false,
    checked: true,
    revision: null,
  });
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const running = useRef(false);
  const baseReportReady = useRef(false);
  const answers = useRef<AssessmentAnswerSender<Assessment> | null>(null);
  answers.current ??= new AssessmentAnswerSender<Assessment>();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const savedSettings = useRemote<{ settings: Settings }>('settings', 'me/settings', !!user);
  const capabilities = useRemote<AssessmentAiCapabilities>(
    'assessment-capabilities',
    'assessments/capabilities',
    !!user,
  );
  const aiRevision = assessmentAiRevision(capabilities.data);
  const aiConsentActive = assessmentFinishRequest(capabilities.data, aiConsent).useAi;
  useEffect(() => {
    setAiConsent((current) => assessmentAiConsentForCapabilities(current, capabilities.data));
  }, [capabilities.data?.aiAvailable, capabilities.data?.aiConfigurationRevision]);
  useEffect(() => {
    if (savedSettings.data && !assessment) setGoal(savedSettings.data.settings.goal);
  }, [savedSettings.data]);
  async function start() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setNotice('');
    setReport(null);
    try {
      const result = await post<{ assessment: Assessment }>('assessments', { goal, size });
      if (active.current) {
        baseReportReady.current = false;
        answers.current?.reset();
        setAssessment(result.assessment);
      }
    } catch (value) {
      if (active.current) setError(value);
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function submit(value: string) {
    const item = assessment?.items.find((row) => row.id === assessment?.currentItemId);
    if (!assessment || !item || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const data = await answers.current!.send(assessment.id, item.id, value);
      if (active.current) {
        setAssessment(data.assessment);
        setAnswer('');
      }
    } catch (value) {
      if (!active.current) return;
      if (value instanceof ApiError && value.code === 'assessment_item_not_current') {
        try {
          const fresh = await api<{ assessment: Assessment; report?: Report }>(
            `assessments/${assessment.id}`,
          );
          if (active.current) {
            answers.current?.reset();
            setAssessment(fresh.assessment);
            setAnswer('');
            if (fresh.report) {
              baseReportReady.current = true;
              setReport(fresh.report);
            }
            setNotice('答题进度已更新，请从当前题目继续。');
          }
        } catch (readError) {
          if (active.current) setError(readError);
        }
      } else setError(value);
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function finish() {
    if (!assessment || running.current || baseReportReady.current || report) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const data = await post<{ report: Report }>(
        `assessments/${assessment.id}/finish`,
        assessmentFinishRequest(capabilities.data, aiConsent, baseReportReady.current || !!report),
      );
      if (!active.current) return;
      baseReportReady.current = true;
      setReport(data.report);
      void client.invalidateQueries({ queryKey: [scope] });
    } catch (value) {
      if (active.current) setError(value);
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function refreshReport() {
    if (!assessment || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ assessment: Assessment; report?: Report }>(
        `assessments/${assessment.id}`,
      );
      if (active.current) {
        answers.current?.reset();
        setAssessment(data.assessment);
        setAnswer('');
        if (data.report) {
          baseReportReady.current = true;
          setReport(data.report);
        }
      }
    } catch (value) {
      if (active.current) setError(value);
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function applyPlan(plan = report?.suggestedPlan) {
    if (!plan || typeof plan.dailyTotalGoal !== 'number' || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await post(
        'me/settings',
        {
          goal: assessment?.goal ?? goal,
          dailyTotalGoal: plan.dailyTotalGoal,
          ...(savedSettings.data ? { expectedRevision: savedSettings.data.settings.revision } : {}),
          groupSize: plan.groupSize,
        },
        'PATCH',
      );
      if (!active.current) return;
      void client.invalidateQueries({ queryKey: [scope] });
      setNotice(
        '推荐每日总词数已保存，已签发任务保留。结果只确认实测词，不代表整个目标词表都已掌握。',
      );
    } catch (value) {
      if (active.current) setError(value);
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }
  if (!user)
    return (
      <div className="page">
        <LoginPrompt />
      </div>
    );
  const item = assessment?.items.find((value) => value.id === assessment?.currentItemId);
  const answered = assessment?.items.filter((value) => value.answered).length ?? 0;
  return (
    <div className="page assessment-page">
      <Heading
        eyebrow="词汇基线 · 先了解自己"
        title={
          <>
            熟悉到哪一步，<em>慢慢看清楚。</em>
          </>
        }
        description="从识义和拼写了解自己的熟悉度，找到下一步的学习重点。"
      />
      <ErrorNotice error={error} />
      {!!error && assessment && (
        <button className="button quiet" disabled={busy} onClick={() => void refreshReport()}>
          读取最新答题进度
        </button>
      )}
      {notice && <Notice>{notice}</Notice>}
      {report ? (
        <Panel className="assessment-result">
          <CheckCircle2 size={36} />
          <span className="eyebrow">这一组基线已保存</span>
          <h2>你的词汇基线</h2>
          <div className="result-metrics">
            <div>
              <span>实测词</span>
              <strong>
                {report.sampledWords}
                <small> / {report.totalCandidates}</small>
              </strong>
            </div>
            <div>
              <span>识义正确率</span>
              <strong>
                {report.accuracy.recognition === null
                  ? '—'
                  : `${Math.round(report.accuracy.recognition * 100)}%`}
              </strong>
            </div>
            <div>
              <span>拼写正确率</span>
              <strong>
                {report.accuracy.spelling === null
                  ? '—'
                  : `${Math.round(report.accuracy.spelling * 100)}%`}
              </strong>
            </div>
            <div>
              <span>客观确认熟词</span>
              <strong>{report.verifiedWordIds.length}</strong>
            </div>
          </div>
          <Notice>这是本次抽样的有限基线，不是完整考试水平或全词表掌握证明。</Notice>
          <AssessmentAnalysis
            analysis={report.aiAnalysis}
            busy={busy || savedSettings.isPending}
            onApply={() => void applyPlan(report.aiAnalysis?.payload?.suggestedPlan)}
            onRefresh={() => void refreshReport()}
          />
          <p>
            {typeof report.suggestedPlan.dailyTotalGoal === 'number' ? (
              <>
                建议每天总计 {report.suggestedPlan.dailyTotalGoal} 个不同词（复习 + 新学），每组{' '}
                {report.suggestedPlan.groupSize} 词。当前复习压力{' '}
                {report.suggestedPlan.reviewPressure ?? '—'} 词，新学建议{' '}
                {report.suggestedPlan.newWordSuggestion ?? '—'}{' '}
                词；最终按真实到期词与今日已签发任务分配。
              </>
            ) : (
              <>
                这份历史报告只记录新学建议 {report.suggestedPlan.dailyNewLimit ?? '—'}{' '}
                词，不代表每天总词数。请到今日任务重新确认总量计划。
              </>
            )}
          </p>
          <div className="action-row">
            {typeof report.suggestedPlan.dailyTotalGoal === 'number' && (
              <button
                className="button primary"
                disabled={busy || savedSettings.isPending}
                onClick={() => void applyPlan()}
              >
                采用每日总量建议 <ArrowRight size={16} />
              </button>
            )}
            <Link className="button ghost" to="/learn">
              查看今日任务与计划
            </Link>
            <button
              className="button quiet"
              disabled={busy}
              onClick={() => {
                setAssessment(null);
                setReport(null);
              }}
            >
              重新选择目标
            </button>
          </div>
        </Panel>
      ) : assessment ? (
        <Panel className="assessment-card">
          <div className="study-meter">
            <span>
              {goalLabels[assessment.goal]} · {answered} / {assessment.items.length} 题
            </span>
            <div>
              <i
                style={{
                  width: `${assessment.items.length ? (answered / assessment.items.length) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
          {item?.question ? (
            <>
              <span className="eyebrow">
                {item.question.type === 'spelling' ? '主动拼写' : '释义识别'}
              </span>
              <h2>{item.question.prompt}</h2>
              {item.question.options?.length ? (
                <div className="answer-options">
                  {item.question.options.map((option) => (
                    <button key={option.id} disabled={busy} onClick={() => void submit(option.id)}>
                      {option.text}
                      <ArrowRight size={16} />
                    </button>
                  ))}
                  <button
                    className="unknown-option"
                    disabled={busy}
                    onClick={() => void submit('')}
                  >
                    暂时不认识
                  </button>
                </div>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (answer.trim()) void submit(answer.trim());
                  }}
                >
                  <label className="field">
                    你的答案
                    <input
                      value={answer}
                      onChange={(event) => setAnswer(event.target.value)}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="写下你想到的词"
                      autoFocus
                    />
                  </label>
                  <div className="action-row">
                    <button className="button primary" disabled={busy || !answer.trim()}>
                      保存，下一题 <ArrowRight size={16} />
                    </button>
                    <button
                      type="button"
                      className="button quiet"
                      disabled={busy}
                      onClick={() => void submit('')}
                    >
                      暂时不认识
                    </button>
                  </div>
                </form>
              )}
              <p className="fine-print">整组完成后查看结果，答题过程不提前显示正确答案。</p>
            </>
          ) : (
            <Empty
              title="这一组题目已经完成。"
              description="提交后查看实测结果与建议计划。"
              action={
                <div className="form-stack">
                  {capabilities.data && aiRevision && (
                    <label className="field assessment-ai-choice">
                      <span>
                        <input
                          type="checkbox"
                          checked={aiConsentActive}
                          disabled={busy}
                          onChange={(event) =>
                            setAiConsent({
                              seen: true,
                              checked: event.target.checked,
                              revision: aiRevision,
                            })
                          }
                        />{' '}
                        完成后分析学习情况
                      </span>
                      <AssessmentServiceDisclosure service={capabilities.data} />
                    </label>
                  )}
                  <button className="button primary" disabled={busy} onClick={() => void finish()}>
                    {busy ? '正在整理成绩与学习分析…' : '查看基线结果'} <ArrowRight size={16} />
                  </button>
                </div>
              }
            />
          )}
        </Panel>
      ) : (
        <Panel className="assessment-intro">
          <span className="feature-icon">
            <Sparkles size={28} />
          </span>
          <h2>从目标开始，了解一点自己的熟悉度。</h2>
          <p>
            按目标词汇范围抽样，先测拼写再识义，避免答案提示影响判断。样本越多，越能看清薄弱点。
          </p>
          <div className="form-columns">
            <label className="field">
              这次的目标
              <select value={goal} onChange={(event) => setGoal(event.target.value as Goal)}>
                {goalNames.map((value) => (
                  <option key={value} value={value}>
                    {goalLabels[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              测试长度
              <select value={size} onChange={(event) => setSize(Number(event.target.value))}>
                <option value={8}>快速了解 · 8 词 / 16 题</option>
                <option value={12}>常规测试 · 12 词 / 24 题</option>
                <option value={20}>细致测试 · 20 词 / 40 题</option>
              </select>
            </label>
          </div>
          {capabilities.data && aiRevision && (
            <label className="field assessment-ai-choice">
              <span>
                <input
                  type="checkbox"
                  checked={aiConsentActive}
                  onChange={(event) =>
                    setAiConsent({
                      seen: true,
                      checked: event.target.checked,
                      revision: aiRevision,
                    })
                  }
                />{' '}
                完成后分析学习情况
              </span>
              <AssessmentServiceDisclosure service={capabilities.data} />
            </label>
          )}
          <button className="button primary" disabled={busy} onClick={() => void start()}>
            {busy ? '正在准备题目…' : '开始词汇基线'}
            <ArrowRight size={16} />
          </button>
        </Panel>
      )}
    </div>
  );
}
