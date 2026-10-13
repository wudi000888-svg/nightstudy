import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Sparkles } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useApp, useRemote } from '../AppContext';
import { newId, post } from '../lib/api';
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
  suggestedPlan: { dailyNewLimit: number; groupSize: number };
  byStratum: unknown;
}
export function AssessmentPage() {
  const { user, scope } = useApp();
  const client = useQueryClient();
  const [goal, setGoal] = useState<Goal>('daily');
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const savedSettings = useRemote<{ settings: Settings }>('settings', 'me/settings', !!user);
  useEffect(() => {
    if (savedSettings.data && !assessment) setGoal(savedSettings.data.settings.goal);
  }, [savedSettings.data]);
  async function start() {
    setBusy(true);
    setError(null);
    setNotice('');
    setReport(null);
    try {
      const result = await post<{ assessment: Assessment }>('assessments', { goal, size: 8 });
      setAssessment(result.assessment);
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  async function submit(value: string) {
    const item = assessment?.items.find((row) => row.id === assessment?.currentItemId);
    if (!assessment || !item) return;
    setBusy(true);
    setError(null);
    try {
      const data = await post<{ accepted: boolean; assessment: Assessment }>(
        `assessments/${assessment.id}/answers`,
        { commandId: newId(), itemId: item.id, answer: value },
      );
      setAssessment(data.assessment);
      setAnswer('');
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  async function finish() {
    if (!assessment) return;
    setBusy(true);
    setError(null);
    try {
      const data = await post<{ report: Report }>(`assessments/${assessment.id}/finish`, {});
      setReport(data.report);
      void client.invalidateQueries({ queryKey: [scope] });
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  async function applyPlan() {
    if (!report) return;
    setBusy(true);
    setError(null);
    try {
      await post(
        'me/settings',
        {
          goal,
          dailyNewLimit: report.suggestedPlan.dailyNewLimit,
          groupSize: report.suggestedPlan.groupSize,
        },
        'PATCH',
      );
      void client.invalidateQueries({ queryKey: [scope] });
      setNotice('推荐计划已保存。结果只确认实测的词，不代表整个目标词表都已掌握。');
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
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
        description="识义、语境与拼写是不同的能力。测过的词和目标范围估计，分开记录。"
      />
      <ErrorNotice error={error} />
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
          <p>
            建议每天 {report.suggestedPlan.dailyNewLimit} 个新词、每组{' '}
            {report.suggestedPlan.groupSize} 词。熟词降低额外曝光，仍保留抽查。
          </p>
          <div className="action-row">
            <button className="button primary" disabled={busy} onClick={() => void applyPlan()}>
              采用推荐计划 <ArrowRight size={16} />
            </button>
            <Link className="button ghost" to="/learn">
              回到学习
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
                <button className="button primary" disabled={busy} onClick={() => void finish()}>
                  查看基线结果 <ArrowRight size={16} />
                </button>
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
          <p>按目标词汇范围抽样，先测拼写再识义，避免答案提示影响判断。</p>
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
            <div className="test-note">
              <strong>分层与实测分开</strong>
              <small>不把抽样结果当成逐词掌握。</small>
            </div>
          </div>
          <button className="button primary" disabled={busy} onClick={() => void start()}>
            {busy ? '正在准备题目…' : '开始词汇基线'}
            <ArrowRight size={16} />
          </button>
        </Panel>
      )}
    </div>
  );
}
