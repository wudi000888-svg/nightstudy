import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, BookOpen, CalendarDays, ShieldCheck } from 'lucide-react';
import type { Book } from '../../lib/types';
import { useApp } from '../../AppContext';
import { api, ApiError, newId } from '../../lib/api';
import type { PlanPreviewResponse } from './types';
import { Dialog, ErrorNotice, Loading, Notice } from '../UI';
import './tasks.css';
import './plan-refinement.css';

export interface TaskPlanValues {
  dailyTotalGoal: number;
  groupSize: number;
  timeZone: string;
}

export function PlanConfirm({
  open,
  book,
  initial,
  issuedCount = 0,
  switchingBook = false,
  loading = false,
  error,
  onClose,
  onConfirm,
  onInitialRetry,
}: {
  open: boolean;
  book: Book | null;
  initial: TaskPlanValues | null;
  issuedCount?: number;
  switchingBook?: boolean;
  loading?: boolean;
  error?: unknown;
  onClose: () => void;
  onConfirm: (values: TaskPlanValues, revision: number, commandId: string) => Promise<void>;
  onInitialRetry?: () => void;
}) {
  const { scope } = useApp();
  const [draft, setDraft] = useState<TaskPlanValues | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [previewResult, setPreview] = useState<PlanPreviewResponse | null>(null);
  const [previewRequestKey, setPreviewRequestKey] = useState('');
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [refreshPreview, setRefreshPreview] = useState(0);
  const command = useRef<{ key: string; id: string } | null>(null);
  const confirming = useRef(false);
  const totalId = useId();
  const sourceId = useId();
  const draftKey = JSON.stringify([
    scope,
    book?.id,
    draft?.dailyTotalGoal,
    draft?.groupSize,
    draft?.timeZone,
  ]);
  const preview = previewRequestKey === draftKey ? previewResult : null;
  useEffect(() => {
    if (!open) {
      setDraft(null);
      setSubmitError(null);
      return;
    }
    if (!draft && initial) setDraft({ ...initial });
  }, [open, initial, draft]);
  useEffect(() => {
    let active = true;
    setPreview(null);
    setPreviewError(null);
    if (
      !open ||
      !book ||
      !draft ||
      !Number.isInteger(draft.dailyTotalGoal) ||
      draft.dailyTotalGoal < 1 ||
      draft.dailyTotalGoal > 100 ||
      !Number.isInteger(draft.groupSize) ||
      draft.groupSize < 1 ||
      draft.groupSize > 20 ||
      !draft.timeZone.trim()
    ) {
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({
        bookId: book.id,
        dailyTotalGoal: String(draft.dailyTotalGoal),
        groupSize: String(draft.groupSize),
        timeZone: draft.timeZone.trim(),
      });
      api<PlanPreviewResponse>(`study/plan/preview?${query}`)
        .then((value) => {
          if (active) {
            setPreviewRequestKey(draftKey);
            setPreview(value);
          }
        })
        .catch((value) => {
          if (active) setPreviewError(value);
        })
        .finally(() => {
          if (active) setPreviewLoading(false);
        });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    open,
    book?.id,
    draft?.dailyTotalGoal,
    draft?.groupSize,
    draft?.timeZone,
    scope,
    refreshPreview,
  ]);

  async function confirm() {
    if (!draft || !preview || busy || confirming.current || previewLoading) return;
    if (
      !Number.isInteger(draft.dailyTotalGoal) ||
      draft.dailyTotalGoal < 1 ||
      draft.dailyTotalGoal > 100
    ) {
      setSubmitError(new Error('每天总词数需为1到100的整数。'));
      return;
    }
    if (!Number.isInteger(draft.groupSize) || draft.groupSize < 1 || draft.groupSize > 20) {
      setSubmitError(new Error('每组词数需为1到20的整数。'));
      return;
    }
    setBusy(true);
    confirming.current = true;
    setSubmitError(null);
    try {
      const key = JSON.stringify({
        bookId: book?.id,
        ...draft,
        expectedRevision: preview.settingsRevision,
      });
      if (command.current?.key !== key) command.current = { key, id: newId() };
      await onConfirm(draft, preview.settingsRevision, command.current.id);
    } catch (value) {
      if (value instanceof ApiError && value.status === 409) {
        setSubmitError(new Error('计划已在其他设备更新。请核对刷新后的预览，再次确认。'));
        setRefreshPreview((current) => current + 1);
      } else setSubmitError(value);
    } finally {
      confirming.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="每日学习安排"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="task-plan-dialog">
        <div className="task-selected-book">
          <span className="task-book-icon">
            <BookOpen size={22} />
          </span>
          <div>
            <span className="tiny-label">学习词书</span>
            <strong>{book?.title ?? '保留当前词书'}</strong>
            {book && (
              <small>
                {book.wordCount.toLocaleString('zh-CN')} 词 · 已学{' '}
                {book.learnedCount.toLocaleString('zh-CN')} 词
              </small>
            )}
          </div>
        </div>
        <ErrorNotice
          error={error || submitError || previewError}
          onRetry={
            error
              ? onInitialRetry
              : previewError
                ? () => setRefreshPreview((current) => current + 1)
                : undefined
          }
        />
        {loading || !draft ? (
          <Loading text="正在读取你的当前计划…" />
        ) : (
          <form
            className="form-stack plan-refined-form"
            aria-busy={busy || previewLoading}
            onSubmit={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            <fieldset disabled={busy} className="plan-refined-fields">
              <div className="task-goal-field">
                <label className="field" htmlFor={totalId}>
                  自定义每日总词数
                  <span className="task-goal-input">
                    <input
                      id={totalId}
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      value={draft.dailyTotalGoal || ''}
                      onChange={(event) =>
                        setDraft({ ...draft, dailyTotalGoal: Number(event.target.value) })
                      }
                      aria-describedby={sourceId}
                      required
                    />
                    <span>词 / 天</span>
                  </span>
                </label>
                <div className="task-goal-presets" aria-label="选择每天总词数">
                  {[20, 30, 50, 80].map((count) => (
                    <button
                      key={count}
                      type="button"
                      className={draft.dailyTotalGoal === count ? 'selected' : ''}
                      aria-pressed={draft.dailyTotalGoal === count}
                      onClick={() => setDraft({ ...draft, dailyTotalGoal: count })}
                    >
                      {count} 词
                    </button>
                  ))}
                </div>
              </div>
              <details className="plan-refined-rules" id={sourceId}>
                <summary>
                  <CalendarDays size={17} /> 复习优先，剩余额度学新词
                </summary>
                <div>
                  <p>
                    总数包含复习和新学，同一个词当天只计一次。复习来自本站全部已学词；新词来自这本词书。
                  </p>
                  <p>超过今日目标的到期词会单独显示，不会悄悄消失。巩固与拼写继续计入同一个词。</p>
                  {!switchingBook && (
                    <p>
                      {issuedCount
                        ? `已有 ${issuedCount} 个词的任务保留。`
                        : '已有安排的任务保留。'}
                      调整目标只改变之后的安排，已提交的学习记录保留。
                    </p>
                  )}
                </div>
              </details>
              {previewLoading && <Loading text="正在按当前进度预览安排…" />}
              {preview && (
                <div className="task-preview-counts" aria-live="polite">
                  <div>
                    <span>计划复习</span>
                    <strong>{preview.preview.reviewPlanned}</strong>
                  </div>
                  <div>
                    <span>计划新学</span>
                    <strong>{preview.preview.newPlanned}</strong>
                  </div>
                  <div>
                    <span>今日剩余额度</span>
                    <strong>
                      {Math.max(0, draft.dailyTotalGoal - preview.preview.completedUnique)}
                    </strong>
                  </div>
                  <p>
                    今日已完成 {preview.preview.completedUnique} 词
                    {switchingBook
                      ? ` · 今日剩余额度 ${Math.max(0, draft.dailyTotalGoal - preview.preview.completedUnique)} 词，按新词书重新安排。`
                      : ` · 保留已安排 ${preview.preview.retainedAssignedCount} 词。`}
                    确认后按最新进度安排。
                  </p>
                  {preview.preview.unplannedOverdueCount > 0 && (
                    <p>
                      另有 {preview.preview.unplannedOverdueCount}{' '}
                      个逾期词暂未安排，可以在任务详情查看。
                    </p>
                  )}
                </div>
              )}
              <details className="plan-refined-advanced">
                <summary>
                  更多安排 <span>每组 {draft.groupSize} 词</span>
                </summary>
                <div className="form-columns">
                  <label className="field">
                    每组词数
                    <input
                      type="number"
                      min={1}
                      max={20}
                      step={1}
                      value={draft.groupSize || ''}
                      onChange={(event) =>
                        setDraft({ ...draft, groupSize: Number(event.target.value) })
                      }
                      required
                    />
                  </label>
                  <label className="field">
                    统计时区
                    <input
                      value={draft.timeZone}
                      onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })}
                      placeholder="Asia/Shanghai"
                      required
                    />
                  </label>
                </div>
                <p className="fine-print">
                  学习日每天当地04:00交接。改变统计时区从下个学习日生效，今日记录继续使用原时区。
                </p>
              </details>
              {preview?.preview.pendingTimeZone && (
                <Notice>
                  新时区 {preview.preview.pendingTimeZone} 将在下个学习日生效，今日仍按{' '}
                  {preview.preview.timeZone} 统计。
                </Notice>
              )}
              {switchingBook && (
                <div className="task-preserve-note" role="note">
                  <ShieldCheck size={17} />
                  <span>
                    确认后结束原词书全部未完成任务，按今日剩余额度重新安排。已学词、复习记录和今日已完成数保留。
                  </span>
                </div>
              )}
            </fieldset>
            <div className="action-row">
              <button
                className="button primary"
                type="submit"
                disabled={busy || previewLoading || !preview}
              >
                {busy ? '正在确认计划…' : '确认学习计划'}
                <ArrowRight size={16} />
              </button>
              <button className="button quiet" type="button" disabled={busy} onClick={onClose}>
                再考虑一下
              </button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
