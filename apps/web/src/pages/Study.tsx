import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Clock3, Pause, Play, RefreshCw, RotateCcw } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { api, ApiError, newId, post } from '../lib/api';
import { command, flushCommands } from '../lib/outbox';
import type { CommandResult, Rating, StudySession } from '../lib/types';
import {
  Empty,
  ErrorNotice,
  Heading,
  Loading,
  LoginPrompt,
  Notice,
  Panel,
  WordView,
} from '../components/UI';
import { TaskForecast, TaskOverview, taskDate, taskLabel } from '../components/tasks/TaskOverview';
import { TaskConflicts } from '../components/tasks/TaskConflicts';
import type {
  TaskForecastResponse,
  TaskListResponse,
  TaskPlanResponse,
  TaskStartResponse,
  TaskStateResponse,
} from '../components/tasks/types';

const reasons: Record<string, string> = {
  daily_goal_complete:
    '今日总词数已安排完。已有任务仍可完成，未安排的到期词保留在列表中，也可主动额外复习。',
  nothing_due: '现在没有需要安排的复习词。',
  planned_reviews_pending:
    '复习词已预留在今日总数中，尚未到期。请按下方时间回来，已签发任务和未安排逾期词继续保留。',
  no_new_words: '当前词书暂无可安排的新词；已学词的复习记录保留，可以选择另一本词书。',
  empty: '当前没有可安排的词，稍后到期的巩固词会继续显示。',
  no_book_selected: '请先选择一本词书并确认每日计划。',
  no_new_book: '请先选择一本词书并确认每日计划。',
};

export function StudyPage({ mode }: { mode: 'learn' | 'review' }) {
  const { user, scope, pending, sync, syncNote, conflicts, discardConflict } = useApp();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const plan = useRemote<TaskPlanResponse>('plan', 'study/plan', !!user);
  const saved = useRemote<TaskListResponse>(
    'study-tasks-active',
    'study/tasks?status=active&limit=50',
    !!user,
  );
  const forecast = useRemote<TaskForecastResponse>('study-forecast', 'study/forecast', !!user);
  const [historyCursor, setHistoryCursor] = useState('');
  const history = useRemote<TaskListResponse>(
    'study-tasks-history',
    `study/tasks?status=completed&limit=20${historyCursor ? `&cursor=${encodeURIComponent(historyCursor)}` : ''}`,
    !!user,
  );
  const [session, setSession] = useState<StudySession | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const lifetime = useRef(0);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const linkLoaded = useRef('');
  const startCommand = useRef<{ key: string; id: string } | null>(null);
  const stateCommand = useRef<{ key: string; id: string; deferUntil?: string } | null>(null);
  const initialScope = useRef(scope);
  const [error, setError] = useState<unknown>(null);
  const [reason, setReason] = useState('');
  const [answer, setAnswer] = useState('');
  const [feedback, setFeedback] = useState<
    (NonNullable<CommandResult['result']> & { position: number }) | undefined
  >();
  const unfinished = saved.data?.items ?? [];
  const preferred =
    unfinished.find((value) => value.id === plan.data?.plan.activeTaskId) ??
    unfinished.find((value) => value.status === 'in_progress') ??
    unfinished[0];
  const waitingSync = pending > 0 || (error instanceof ApiError && error.queued);

  function isCurrent(requestScope: string, requestLife: number) {
    return currentScope.current === requestScope && lifetime.current === requestLife;
  }

  useEffect(() => {
    lifetime.current++;
    setSession(null);
    setError(null);
    setReason('');
    setFeedback(undefined);
    setAnswer('');
    setHistoryCursor('');
    if (initialScope.current !== scope) {
      initialScope.current = scope;
      setParams({});
    }
    linkLoaded.current = '';
    startCommand.current = null;
    stateCommand.current = null;
    busyRef.current = false;
    setBusy(false);
    return () => {
      lifetime.current++;
    };
  }, [scope]);

  async function updateTask(target: StudySession, action: 'pause' | 'resume' | 'defer') {
    const key = JSON.stringify({
      sessionId: target.id,
      action,
      expectedSessionRevision: target.revision,
    });
    if (stateCommand.current?.key !== key)
      stateCommand.current = {
        key,
        id: newId(),
        ...(action === 'defer'
          ? { deferUntil: new Date(Date.now() + 24 * 3600000).toISOString() }
          : {}),
      };
    const body = {
      action,
      expectedSessionRevision: target.revision,
      ...(stateCommand.current.deferUntil ? { deferUntil: stateCommand.current.deferUntil } : {}),
    };
    return post<TaskStateResponse>(`study/tasks/${encodeURIComponent(target.id)}/state`, {
      ...body,
      commandId: stateCommand.current.id,
    });
  }
  async function start(resumeId?: string, extra = false) {
    if (busyRef.current || !user) return;
    const requestScope = scope,
      requestLife = lifetime.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setReason('');
    setFeedback(undefined);
    setAnswer('');
    try {
      if (navigator.onLine) {
        const flushed = await flushCommands(scope);
        if (flushed.pending)
          throw new Error('仍有学习操作等待同步。请先同步并核对已有任务，再安排或继续。');
        if (flushed.applied) await client.invalidateQueries({ queryKey: [scope] });
      } else if (pending) throw new Error('已有操作暂存等待联网同步，请保留当前记录。');
      if (!isCurrent(requestScope, requestLife)) return;
      let result: { session: StudySession | null; reason?: string };
      if (resumeId) {
        const read = await api<{ session: StudySession }>(
          `study/sessions/${encodeURIComponent(resumeId)}`,
        );
        if (!isCurrent(requestScope, requestLife)) return;
        result = read.session.status === 'paused' ? await updateTask(read.session, 'resume') : read;
      } else {
        const body = extra
          ? { mode: 'review', taskKind: 'extra-review' }
          : {
              mode: 'daily',
              ...(plan.data ? { expectedPlanRevision: plan.data.plan.revision } : {}),
            };
        const key = JSON.stringify(body);
        if (startCommand.current?.key !== key) startCommand.current = { key, id: newId() };
        result = await post<TaskStartResponse>('study/sessions', {
          ...body,
          commandId: startCommand.current.id,
        });
        startCommand.current = null;
      }
      if (!isCurrent(requestScope, requestLife)) return;
      setSession(result.session);
      setReason(
        result.reason
          ? (reasons[result.reason] ?? '当前暂无可安排任务，请刷新计划查看真实到期与剩余词数。')
          : '',
      );
      if (result.session) {
        linkLoaded.current = `${scope}:${result.session.id}`;
        setParams({ session: result.session.id });
      } else setParams({});
      void client.invalidateQueries({ queryKey: [scope] });
    } catch (value) {
      if (isCurrent(requestScope, requestLife)) {
        setError(value);
        void plan.refetch();
        void saved.refetch();
      }
    } finally {
      if (isCurrent(requestScope, requestLife)) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function changeState(action: 'pause' | 'resume' | 'defer') {
    if (!session || busyRef.current || waitingSync) return;
    const requestScope = scope,
      requestLife = lifetime.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await updateTask(session, action);
      if (!isCurrent(requestScope, requestLife)) return;
      setSession(result.session);
      setFeedback(undefined);
      setAnswer('');
      void client.invalidateQueries({ queryKey: [scope] });
    } catch (value) {
      if (isCurrent(requestScope, requestLife)) setError(value);
    } finally {
      if (isCurrent(requestScope, requestLife)) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function act(action: 'reveal' | 'rate' | 'answer', rating?: Rating, answerValue?: string) {
    if (!session || busyRef.current || waitingSync || session.status === 'paused') return;
    const item = session.items.find((value) => value.id === session.currentItemId);
    if (!item) return;
    const requestScope = scope,
      requestLife = lifetime.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await command<CommandResult>(scope, `study/sessions/${session.id}/commands`, {
        commandId: newId(),
        itemId: item.id,
        action,
        ...(rating ? { rating } : {}),
        ...(action === 'answer' ? { answer: (answerValue ?? answer).trim() } : {}),
        expectedSessionRevision: session.revision,
        expectedProgressRevision: item.progressRevision,
      });
      if (!isCurrent(requestScope, requestLife)) return;
      setSession(result.session);
      if (result.result) setFeedback({ ...result.result, position: item.ordinal + 1 });
      setAnswer('');
      void client.invalidateQueries({ queryKey: [scope] });
    } catch (value) {
      if (isCurrent(requestScope, requestLife)) setError(value);
    } finally {
      if (isCurrent(requestScope, requestLife)) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function readCurrent() {
    if (!session || busyRef.current) return;
    const requestScope = scope,
      requestLife = lifetime.current;
    setBusy(true);
    busyRef.current = true;
    try {
      const result = await api<{ session: StudySession }>(`study/sessions/${session.id}`);
      if (isCurrent(requestScope, requestLife)) {
        setSession((current) =>
          current?.id === result.session.id && current.revision <= result.session.revision
            ? result.session
            : current,
        );
        if (!pending) setError(null);
        setFeedback(undefined);
        setAnswer('');
      }
    } catch (value) {
      if (isCurrent(requestScope, requestLife)) setError(value);
    } finally {
      if (isCurrent(requestScope, requestLife)) {
        setBusy(false);
        busyRef.current = false;
      }
    }
  }
  async function readServerTask(sessionId: string) {
    if (busyRef.current) return;
    const requestScope = scope,
      requestLife = lifetime.current;
    setBusy(true);
    busyRef.current = true;
    try {
      const result = await api<{ session: StudySession }>(
        `study/sessions/${encodeURIComponent(sessionId)}`,
      );
      if (!isCurrent(requestScope, requestLife)) return;
      setSession(result.session);
      setFeedback(undefined);
      setAnswer('');
      setError(null);
      linkLoaded.current = `${scope}:${result.session.id}`;
      setParams({ session: result.session.id });
    } catch (value) {
      if (isCurrent(requestScope, requestLife)) setError(value);
      throw value;
    } finally {
      if (isCurrent(requestScope, requestLife)) {
        setBusy(false);
        busyRef.current = false;
      }
    }
  }
  useEffect(() => {
    const id = params.get('session');
    if (user && id && linkLoaded.current !== `${scope}:${id}`) {
      linkLoaded.current = `${scope}:${id}`;
      void start(id);
    }
  }, [params.get('session'), user?.id, scope]);
  useEffect(() => {
    if (!session?.id || !user) return;
    const id = session.id,
      requestScope = scope,
      requestLife = lifetime.current;
    const synced = () => {
      if (busyRef.current) return;
      api<{ session: StudySession }>(`study/sessions/${id}`)
        .then((value) => {
          if (isCurrent(requestScope, requestLife) && !busyRef.current) {
            setSession((current) =>
              current?.id === id && current.revision <= value.session.revision
                ? value.session
                : current,
            );
            setError(null);
            setFeedback(undefined);
          }
        })
        .catch((value) => {
          if (isCurrent(requestScope, requestLife)) setError(value);
        });
    };
    window.addEventListener('nightstudy-synced', synced);
    return () => window.removeEventListener('nightstudy-synced', synced);
  }, [session?.id, user?.id, scope]);
  function dashboard() {
    setSession(null);
    setFeedback(undefined);
    setParams({});
    setReason('');
  }

  if (!user)
    return (
      <div className="page">
        <Heading eyebrow="今日任务" title="让每一天，都有一点自己的积累。" />
        <LoginPrompt />
      </div>
    );
  const item = session?.items.find((value) => value.id === session.currentItemId);
  const rated = session?.items.filter((value) => value.rated).length ?? 0;
  const activePlan = plan.data?.plan;
  return (
    <div className="page study-page task-page">
      <Heading
        eyebrow="今日任务 · 先复习，再学新词"
        title={
          <>
            给今天，<em>一点记住的时间。</em>
          </>
        }
        description="每天总词数包含复习与新学。同词当天只计一次；到期巩固继续真实评价，拼写单独记录。"
        action={
          <Link to="/" className="button quiet">
            回自习室
          </Link>
        }
      />
      <ErrorNotice
        error={error}
        onRetry={
          session
            ? () => void readCurrent()
            : () => {
                void plan.refetch();
                void saved.refetch();
              }
        }
      />
      <TaskConflicts
        conflicts={conflicts}
        busy={busy}
        timeZone={activePlan?.timeZone}
        onRead={readServerTask}
        onDiscard={async (row) => {
          const requestScope = scope,
            requestLife = lifetime.current;
          await discardConflict(row.id);
          if (!isCurrent(requestScope, requestLife)) return;
          setError(null);
          if (row.sessionId) await readServerTask(row.sessionId);
          if (!isCurrent(requestScope, requestLife)) return;
          await client.invalidateQueries({ queryKey: [scope] });
        }}
      />
      {waitingSync && (
        <Panel className="task-sync-card">
          <Notice>有操作等待同步，尚未算作服务器完成。请先恢复连接并核对这一组。</Notice>
          <button className="button ghost" disabled={busy} onClick={() => void sync()}>
            同步暂存操作
          </button>
          {syncNote && <p className="fine-print">{syncNote}</p>}
        </Panel>
      )}
      {!session ? (
        <>
          {mode === 'review' && (
            <p className="content-caption">
              学习与到期复习已合并到今日任务。额外复习仍可主动安排，不改变每日总目标。
            </p>
          )}
          <ErrorNotice
            error={plan.error || saved.error}
            onRetry={() => {
              void plan.refetch();
              void saved.refetch();
            }}
          />
          {plan.isPending && <Loading />}
          {activePlan && (
            <TaskOverview
              plan={activePlan}
              pending={pending}
              canContinue={!busy && !waitingSync && !saved.isPending && !saved.error}
              onContinue={() => {
                if (preferred) void start(preferred.id);
                else void start();
              }}
            />
          )}
          <div className="task-source-note">
            <span>
              新学来源：<strong>{activePlan?.bookTitle ?? '尚未选择词书'}</strong>
            </span>
            <span>
              复习来源：<strong>本站全部已学词</strong>
            </span>
            <span>
              每组 {activePlan?.groupSize ?? '—'} 词 · {activePlan?.timeZone ?? '读取时区中'}
            </span>
          </div>
          {reason && <Notice>{reason}</Notice>}
          <div className="task-dashboard-actions">
            <button
              className="button primary"
              disabled={
                busy ||
                waitingSync ||
                plan.isPending ||
                saved.isPending ||
                !!plan.error ||
                !!saved.error
              }
              onClick={() => void start(preferred?.id)}
            >
              {busy ? '正在读取任务…' : preferred ? '继续已保存任务' : '安排下一组今日任务'}
              <ArrowRight size={16} />
            </button>
            <button
              className="button ghost"
              disabled={busy || waitingSync || plan.isPending}
              onClick={() => void start(undefined, true)}
            >
              <RotateCcw size={16} />
              额外复习
            </button>
            <Link className="button quiet" to="/books">
              选择词书与每日计划
            </Link>
            <Link className="button quiet" to="/me">
              调整总目标
            </Link>
          </div>
          {activePlan?.nextDueAt && (
            <p className="fine-print">
              下一批到期：{taskDate(activePlan.nextDueAt, true, activePlan.timeZone)}（
              {activePlan.timeZone}）。未到期的巩固词保留等待，不提前写入复习评价。
            </p>
          )}
          {!!unfinished.length && (
            <Panel className="task-history">
              <div className="section-heading">
                <div>
                  <span className="tiny-label">换设备也能继续</span>
                  <h2>已保存任务</h2>
                </div>
                <span className="fine-print">固定词卡与已提交评价保留</span>
              </div>
              <div className="task-history-list">
                {unfinished.map((value) => (
                  <div className="task-history-row" key={value.id}>
                    <div>
                      <strong>
                        {value.bookTitle ??
                          (value.mode === 'review' || value.taskKind === 'extra-review'
                            ? '全部已学词复习'
                            : '已保存词书')}{' '}
                        · {taskLabel(value)}
                      </strong>
                      <small>
                        {taskDate(value.learningDate ?? value.createdAt, false, value.timeZone)} ·
                        已评价 {value.items.filter((row) => row.rated).length}/{value.items.length}{' '}
                        · {value.timeZone ?? '设备当地时间'} ·{' '}
                        {value.status === 'paused'
                          ? value.deferredUntil
                            ? `延后至 ${taskDate(value.deferredUntil, true, value.timeZone)}`
                            : '已暂停'
                          : value.phase === 'practice'
                            ? '待拼写'
                            : '待回忆评价'}
                      </small>
                    </div>
                    <button
                      className="button ghost"
                      disabled={busy || waitingSync}
                      onClick={() => void start(value.id)}
                    >
                      <Play size={14} />
                      {value.status === 'paused' ? '恢复同一任务' : '跨端继续'}
                    </button>
                  </div>
                ))}
              </div>
            </Panel>
          )}
          <ErrorNotice error={forecast.error} onRetry={() => void forecast.refetch()} />
          {forecast.data && (
            <TaskForecast forecast={forecast.data} timeZone={activePlan?.timeZone} />
          )}
          <Panel className="task-history">
            <div className="section-heading">
              <div>
                <span className="tiny-label">每一点，都有记录</span>
                <h2>已完成任务</h2>
              </div>
              <span className="fine-print">按组保存，不等于当天去重词总数</span>
            </div>
            <ErrorNotice error={history.error} onRetry={() => void history.refetch()} />
            {history.isPending ? (
              <Loading />
            ) : history.data?.items.length ? (
              <div className="task-history-list">
                {history.data.items.map((value) => (
                  <div className="task-history-row" key={value.id}>
                    <div>
                      <strong>
                        {value.bookTitle ?? '全部已学词'} · {taskLabel(value)}
                      </strong>
                      <small>
                        {taskDate(value.completedAt ?? value.updatedAt, true, value.timeZone)} ·
                        已评价 {value.items.filter((row) => row.rated).length} 词 · 拼写{' '}
                        {value.items.filter((row) => row.exerciseDone).length} 次 ·{' '}
                        {value.timeZone ?? '设备当地时间'}
                      </small>
                    </div>
                    <button
                      className="button ghost"
                      disabled={busy || waitingSync}
                      onClick={() => void start(value.id)}
                    >
                      查看记录
                      <ArrowRight size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="fine-print">
                尚无完整完成的任务。已签发组会保留在上方，可继续完成巩固与拼写。
              </p>
            )}
            <div className="pagination-actions">
              <span className="fine-print">共 {history.data?.page.total ?? '—'} 组</span>
              {historyCursor && (
                <button className="button quiet" onClick={() => setHistoryCursor('')}>
                  返回最新
                </button>
              )}
              {history.data?.page.hasMore && history.data.page.nextCursor && (
                <button
                  className="button ghost"
                  onClick={() => setHistoryCursor(history.data!.page.nextCursor!)}
                >
                  更早的记录
                </button>
              )}
            </div>
          </Panel>
        </>
      ) : (
        <>
          <div className="task-runner-topline">
            <span className="soft-badge">
              {taskLabel(session)} · {session.bookTitle ?? '全部已学词'}
            </span>
            <div className="action-row">
              <button className="button quiet" disabled={busy} onClick={() => void readCurrent()}>
                <RefreshCw size={14} />
                刷新跨端进度
              </button>
              {session.status === 'in_progress' && (
                <button
                  className="button ghost"
                  disabled={busy || waitingSync}
                  onClick={() => void changeState('pause')}
                >
                  <Pause size={14} />
                  暂停
                </button>
              )}
              <button className="button quiet" disabled={busy} onClick={dashboard}>
                返回任务页
              </button>
            </div>
          </div>
          <p className="fine-print">
            任务时间显示：{session.timeZone ?? '当前设备时区'}。学习日保留签发时的日期。
          </p>
          <div className="study-meter">
            <span>
              {feedback
                ? '拼写反馈'
                : session.phase === 'practice'
                  ? '拼写练习'
                  : session.phase === 'completed'
                    ? '本组完成'
                    : '回忆与评价'}{' '}
              · {feedback?.position ?? Math.min(session.items.length, session.cursor + 1)} /{' '}
              {session.items.length}
            </span>
            <div>
              <i
                style={{
                  width: `${session.items.length ? (rated / session.items.length) * 100 : 0}%`,
                }}
              />
            </div>
            <span>
              本组新学 {session.items.filter((row) => row.bucket === 'new').length} · 复习{' '}
              {session.items.filter((row) => row.bucket === 'review').length}
            </span>
          </div>
          {session.status === 'paused' ? (
            <Panel className="study-intro">
              <span className="eyebrow">已保存这一组</span>
              <h2>先休息一下，回来接着读。</h2>
              <p>
                暂停保留词卡、已评价进度与今日预约，不改变真实到期时间。
                {session.deferredUntil
                  ? `已延后至 ${taskDate(session.deferredUntil, true, session.timeZone)}，也可主动提前恢复。`
                  : '换一台设备登录本站，也可恢复同一任务。'}
              </p>
              <div className="action-row">
                <button
                  className="button primary"
                  disabled={busy || waitingSync}
                  onClick={() => void changeState('resume')}
                >
                  <Play size={16} />
                  恢复这一组
                </button>
                <button
                  className="button ghost"
                  disabled={busy || waitingSync}
                  onClick={() => void changeState('defer')}
                >
                  <Clock3 size={16} />
                  延后24小时
                </button>
              </div>
            </Panel>
          ) : feedback ? (
            <Panel className={`exercise-feedback ${feedback.correct ? 'correct' : 'incorrect'}`}>
              <span className="eyebrow">
                {feedback.correct ? '这次拼写正确' : '把这个词再看清一点'}
              </span>
              <h2>{feedback.correctAnswer}</h2>
              <p>{feedback.explanation}</p>
              <button className="button primary" onClick={() => setFeedback(undefined)}>
                继续
                <ArrowRight size={16} />
              </button>
            </Panel>
          ) : session.phase === 'completed' ? (
            <Panel className="session-summary">
              <CheckCircle2 size={40} />
              <span className="eyebrow">这一组已经保存</span>
              <h2>把这一点积累，留给明天。</h2>
              <p>
                本组 {rated} 词已评价 · {session.items.filter((value) => value.exerciseDone).length}{' '}
                次拼写。当天去重进度请看今日任务页，巩固重评不会重复占总数。
              </p>
              <div className="action-row">
                <button
                  className="button primary"
                  disabled={busy || waitingSync}
                  onClick={() => void start()}
                >
                  继续今日任务
                  <ArrowRight size={16} />
                </button>
                <button className="button ghost" onClick={dashboard}>
                  查看进度与待办
                </button>
                <Link className="button quiet" to="/memory">
                  记忆安排
                </Link>
              </div>
            </Panel>
          ) : item && session.phase === 'practice' ? (
            <Panel className="spelling-card">
              <span className="eyebrow">把词，再写出来</span>
              <h2>{item.question?.prompt || '当前练习题尚未就绪，请刷新这一组。'}</h2>
              {item.question && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (answer.trim()) void act('answer');
                  }}
                >
                  <label className="field">
                    你的拼写
                    <input
                      key={item.id}
                      value={answer}
                      onChange={(event) => setAnswer(event.target.value)}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="写下目标词…"
                      autoFocus
                    />
                  </label>
                  <button
                    className="button primary"
                    disabled={busy || waitingSync || !answer.trim()}
                    type="submit"
                  >
                    {busy ? '正在核对…' : '核对答案'}
                    <ArrowRight size={16} />
                  </button>
                  <button
                    className="button quiet"
                    type="button"
                    disabled={busy || waitingSync}
                    onClick={() => void act('answer', undefined, '')}
                  >
                    想不起来，查看答案
                  </button>
                  <p className="fine-print">拼写单独记录，不再次写入FSRS或增加当天词数。</p>
                </form>
              )}
            </Panel>
          ) : item ? (
            <Panel className={`study-card ${item.revealed ? 'is-revealed' : ''}`}>
              <span className="eyebrow">
                {item.revealed
                  ? '现在，在语境里确认'
                  : item.bucket === 'review'
                    ? '先回忆这个已学词'
                    : '先回忆这个词的意思'}
              </span>
              <WordView
                word={item.word}
                focusSenseId={item.focusSenseId}
                hideMeanings={!item.revealed}
              />
              {!item.revealed ? (
                <div className="recall-area">
                  <RotateCcw size={22} />
                  <p>先默念你记得的词义和用法。</p>
                  <button
                    className="button primary"
                    disabled={busy || waitingSync}
                    onClick={() => void act('reveal')}
                  >
                    {busy ? '正在揭晓…' : '显示释义'}
                    <ArrowRight size={16} />
                  </button>
                </div>
              ) : (
                <div className="rating-area">
                  <span>这次记得怎么样？</span>
                  <div className="rating-grid">
                    {(
                      [
                        { value: 'again', title: '忘记了', detail: '到期后再巩固' },
                        { value: 'hard', title: '有点难', detail: '回忆还不稳定' },
                        { value: 'good', title: '记住了', detail: '按安排继续' },
                        { value: 'easy', title: '很轻松', detail: '记忆更稳一点' },
                      ] as const
                    ).map((value) => (
                      <button
                        key={value.value}
                        className={`rating-${value.value}`}
                        disabled={busy || waitingSync}
                        onClick={() => void act('rate', value.value)}
                      >
                        <strong>{value.title}</strong>
                        <small>{value.detail}</small>
                      </button>
                    ))}
                  </div>
                  <p>每次评分记录真实回忆；同词当日再次到期可继续巩固，但不重复占当天总数。</p>
                </div>
              )}
            </Panel>
          ) : (
            <Empty
              title="这组暂时没有可显示的词。"
              description="记录仍保留，请重新读取服务器任务。"
              action={
                <button className="button ghost" onClick={() => void readCurrent()}>
                  重新读取
                </button>
              }
            />
          )}
        </>
      )}
    </div>
  );
}
