import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, BookOpen, CalendarDays, ShieldCheck } from 'lucide-react';
import type { Book } from '../../lib/types';
import { useApp } from '../../AppContext';
import { api, ApiError, newId } from '../../lib/api';
import type { PlanPreviewResponse } from './types';
import { Dialog, ErrorNotice, Loading, Notice } from '../UI';
import './tasks.css';

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
  const [preview, setPreview] = useState<PlanPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [refreshPreview, setRefreshPreview] = useState(0);
  const command = useRef<{ key: string; id: string } | null>(null);
  const totalId = useId();
  const sourceId = useId();
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
          if (active) setPreview(value);
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
    if (!draft || !preview || busy || previewLoading) return;
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
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="给这本词书，留一点每天的时间。"
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
            <span className="tiny-label">新学词来源</span>
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
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            <div className="task-goal-field">
              <label className="field" htmlFor={totalId}>
                每天总词数
                <span className="task-goal-input">
                  <input
                    id={totalId}
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={draft.dailyTotalGoal}
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
                    onClick={() => setDraft({ ...draft, dailyTotalGoal: count })}
                  >
                    {count}
                  </button>
                ))}
              </div>
            </div>
            <div className="task-plan-explanation" id={sourceId}>
              <CalendarDays size={18} />
              <div>
                <strong>先复习，再用余量学新词</strong>
                <p>
                  总数包含复习和新学，同一个词当天只计一次。复习来自本站全部已学词；新词来自这本词书。
                </p>
                <p>超过今日目标的到期词会单独显示，不会悄悄消失。巩固与拼写继续计入同一个词。</p>
              </div>
            </div>
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
                  <span>未安排逾期</span>
                  <strong>{preview.preview.unplannedOverdueCount}</strong>
                </div>
                <p>
                  今日已完成 {preview.preview.completedUnique} 词 · 保留已安排{' '}
                  {preview.preview.retainedAssignedCount}{' '}
                  词。预览不会签发任务，最终以确认时的进度为准。
                </p>
              </div>
            )}
            <div className="form-columns">
              <label className="field">
                每组词数
                <input
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={draft.groupSize}
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
            {preview?.preview.pendingTimeZone && (
              <Notice>
                新时区 {preview.preview.pendingTimeZone} 将在下个学习日生效，今日仍按{' '}
                {preview.preview.timeZone} 统计。
              </Notice>
            )}
            <div className="task-preserve-note">
              <ShieldCheck size={17} />
              <span>
                {issuedCount
                  ? `已有 ${issuedCount} 个词的任务保留。`
                  : '已有签发任务与学习记录保留。'}
                改变目标或切换词书，只调整之后的安排。
              </span>
            </div>
            <div className="action-row">
              <button
                className="button primary"
                type="submit"
                disabled={busy || previewLoading || !preview}
              >
                {busy ? '正在确认计划…' : '确认计划，进入今日任务'}
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
