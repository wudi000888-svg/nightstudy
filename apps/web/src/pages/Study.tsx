import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowRight, Play, RotateCcw } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { api, ApiError, newId, post } from '../lib/api';
import { command, flushCommands } from '../lib/outbox';
import { linkStudySession } from '../lib/study-navigation';
import {
  bookChangedEvent,
  learningGeneration,
  mergeStudySession,
  resumableTasks,
} from '../lib/learning-state';
import type { CommandResult, Rating, StudySession } from '../lib/types';
import { Empty, ErrorNotice, Heading, Loading, LoginPrompt, Notice, Panel } from '../components/UI';
import { StudySessionView } from '../components/study/StudySessionView';
import { useStudyViewport } from '../components/study/useStudyViewport';
import { useQuickStudyStart } from '../components/study/useQuickStudyStart';
import { useAppNavigation } from '../components/AppNavigation';
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
    '复习词已预留在今日总数中，尚未到期。请按下方时间回来，已安排的学习组和未安排逾期词继续保留。',
  no_new_words: '当前词书暂无可安排的新词；已学词的复习记录保留，可以选择另一本词书。',
  empty: '当前没有可安排的词，稍后到期的巩固词会继续显示。',
  no_book_selected: '请先选择一本词书并确认每日计划。',
  no_new_book: '请先选择一本词书并确认每日计划。',
};

export function StudyPage({ mode }: { mode: 'learn' | 'review' }) {
  const navigation = useAppNavigation();
  const { user, scope, pending, sync, syncNote, conflicts, discardConflict } = useApp();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const shortcutLocation = useRef<{ key: string; pathname: string; search: string } | null>(null);
  const route = useRef({ key: location.key, requestKey: location.key });
  if (route.current.key !== location.key) {
    // Consuming our own start=1 intent is the same request; browser POP is a new intent.
    const ownShortcut = shortcutLocation.current;
    route.current = {
      key: location.key,
      requestKey:
        ownShortcut?.key === route.current.key &&
        ownShortcut.pathname === location.pathname &&
        ownShortcut.search === location.search
          ? route.current.requestKey
          : location.key,
    };
    shortcutLocation.current = null;
  }
  const plan = useRemote<TaskPlanResponse>('plan', 'study/plan', !!user);
  const saved = useRemote<TaskListResponse>(
    'study-tasks-active',
    'study/tasks?status=active&limit=50',
    !!user,
  );
  const forecast = useRemote<TaskForecastResponse>('study-forecast', 'study/forecast', !!user);
  const [historyCursor, setHistoryCursor] = useState('');
  const [historyStatus, setHistoryStatus] = useState<'completed' | 'cancelled'>('completed');
  const history = useRemote<TaskListResponse>(
    'study-tasks-history',
    `study/tasks?status=${historyStatus}&limit=20${historyCursor ? `&cursor=${encodeURIComponent(historyCursor)}` : ''}`,
    !!user,
  );
  const [storedSession, setSession] = useState<StudySession | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const lifetime = useRef(0);
  const selectionGeneration = useRef(learningGeneration(scope));
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const linkLoaded = useRef('');
  const startCommand = useRef<{ key: string; id: string } | null>(null);
  const stateCommand = useRef<{ key: string; id: string; deferUntil?: string } | null>(null);
  const initialScope = useRef(scope);
  const session = initialScope.current === scope ? storedSession : null;
  const [error, setError] = useState<unknown>(null);
  const [reason, setReason] = useState('');
  const [answer, setAnswer] = useState('');
  const [feedback, setFeedback] = useState<
    (NonNullable<CommandResult['result']> & { position: number }) | undefined
  >();
  const unfinished = (saved.data?.items ?? []).filter((value) =>
    ['in_progress', 'paused'].includes(value.status),
  );
  const resumable = resumableTasks(unfinished, mode, plan.data?.plan.bookId);
  const preferred =
    resumable.find((value) => value.id === plan.data?.plan.activeTaskId) ??
    resumable.find((value) => value.status === 'in_progress') ??
    resumable[0];
  const waitingSync = pending > 0 || (error instanceof ApiError && error.queued);
  const focusActive = !!session && !!user;
  const viewportHeight = useStudyViewport(focusActive);
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('nightstudy-study-focus', { detail: { active: focusActive } }),
    );
  }, [focusActive]);
  useEffect(
    () => () => {
      window.dispatchEvent(
        new CustomEvent('nightstudy-study-focus', { detail: { active: false } }),
      );
    },
    [],
  );

  function isCurrent(requestScope: string, requestLife: number, requestKey: string) {
    return (
      currentScope.current === requestScope &&
      lifetime.current === requestLife &&
      route.current.requestKey === requestKey &&
      selectionGeneration.current === learningGeneration(requestScope)
    );
  }

  function refreshAccepted(requestScope: string) {
    if (currentScope.current !== requestScope) return;
    void client.invalidateQueries({ queryKey: [requestScope] });
    window.dispatchEvent(new CustomEvent('nightstudy-synced', { detail: { scope: requestScope } }));
  }

  useEffect(() => {
    lifetime.current++;
    selectionGeneration.current = learningGeneration(scope);
    setSession(null);
    setError(null);
    setReason('');
    setFeedback(undefined);
    setAnswer('');
    setHistoryCursor('');
    setHistoryStatus('completed');
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

  function clearSession() {
    lifetime.current++;
    selectionGeneration.current = learningGeneration(scope);
    setSession(null);
    setFeedback(undefined);
    setAnswer('');
    setError(null);
    setReason('');
    linkLoaded.current = '';
    startCommand.current = null;
    stateCommand.current = null;
    busyRef.current = false;
    setBusy(false);
  }
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ scope: string }>).detail.scope !== scope) return;
      clearSession();
      setParams({}, { replace: true });
    };
    window.addEventListener(bookChangedEvent, changed);
    return () => window.removeEventListener(bookChangedEvent, changed);
  }, [scope, setParams]);

  function showTaskError(
    value: unknown,
    id: string | undefined,
    requestLife: number,
    requestKey: string,
  ) {
    setError(value);
    if (!(value instanceof ApiError) || value.code !== 'task_cancelled' || !id) return;
    setSession((current) =>
      current?.id === id ? { ...current, status: 'cancelled', currentItemId: null } : current,
    );
    void api<{ session: StudySession }>(`study/sessions/${encodeURIComponent(id)}`)
      .then(({ session: latest }) => {
        if (!isCurrent(scope, requestLife, requestKey)) return;
        setSession((current) => mergeStudySession(current, latest));
        setFeedback(undefined);
        setAnswer('');
      })
      .catch(() => {});
    void client.invalidateQueries({ queryKey: [scope] });
  }

  async function updateTask(target: StudySession, action: 'pause' | 'resume' | 'defer') {
    if (target.status === 'cancelled')
      throw new ApiError(409, '这组任务已结束，请查看当前任务。', 'task_cancelled');
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
    lifetime.current++;
    const requestScope = scope,
      requestLife = lifetime.current,
      requestKey = route.current.requestKey;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setReason('');
    setFeedback(undefined);
    setAnswer('');
    try {
      if (navigator.onLine) {
        const flushed = await flushCommands(scope, () =>
          isCurrent(requestScope, requestLife, requestKey),
        );
        if (flushed.pending)
          throw new Error('仍有学习操作等待同步。请先同步并核对已有任务，再安排或继续。');
        if (flushed.applied) await client.invalidateQueries({ queryKey: [scope] });
      } else if (pending) throw new Error('已有操作暂存等待联网同步，请保留当前记录。');
      if (!isCurrent(requestScope, requestLife, requestKey)) return;
      let result: { session: StudySession | null; reason?: string };
      if (resumeId) {
        const read = await api<{ session: StudySession }>(
          `study/sessions/${encodeURIComponent(resumeId)}`,
        );
        if (!isCurrent(requestScope, requestLife, requestKey)) return;
        result = read.session.status === 'paused' ? await updateTask(read.session, 'resume') : read;
      } else {
        const body = extra
          ? { mode: 'review', taskKind: 'extra-review' }
          : {
              mode: mode === 'review' ? 'review' : 'daily',
              ...(plan.data?.plan.bookId ? { bookId: plan.data.plan.bookId } : {}),
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
      if (!isCurrent(requestScope, requestLife, requestKey)) {
        refreshAccepted(requestScope);
        return;
      }
      setSession((current) => (result.session ? mergeStudySession(current, result.session) : null));
      setReason(
        result.reason
          ? (reasons[result.reason] ?? '当前暂无可安排任务，请刷新计划查看真实到期与剩余词数。')
          : '',
      );
      linkLoaded.current = result.session ? `${scope}:${result.session.id}` : '';
      linkStudySession(params, result.session?.id ?? null, (next) =>
        setParams(next, { replace: true }),
      );
      void client.invalidateQueries({ queryKey: [scope] });
    } catch (value) {
      if (isCurrent(requestScope, requestLife, requestKey)) {
        showTaskError(value, resumeId, requestLife, requestKey);
        void plan.refetch();
        void saved.refetch();
      }
    } finally {
      if (isCurrent(requestScope, requestLife, requestKey)) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function changeState(action: 'pause' | 'resume' | 'defer') {
    if (!session || session.status === 'cancelled' || busyRef.current || waitingSync) return;
    lifetime.current++;
    const requestScope = scope,
      requestLife = lifetime.current,
      requestKey = route.current.requestKey;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await updateTask(session, action);
      if (!isCurrent(requestScope, requestLife, requestKey)) {
        refreshAccepted(requestScope);
        return;
      }
      setSession((current) => mergeStudySession(current, result.session));
      setFeedback(undefined);
      setAnswer('');
      void client.invalidateQueries({ queryKey: [scope] });
    } catch (value) {
      if (isCurrent(requestScope, requestLife, requestKey))
        showTaskError(value, session.id, requestLife, requestKey);
    } finally {
      if (isCurrent(requestScope, requestLife, requestKey)) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function act(
    action: 'reveal' | 'rate' | 'answer',
    rating?: Rating,
    answerValue?: string,
    recognitionOptionId?: string,
  ) {
    if (!session || busyRef.current || waitingSync || session.status !== 'in_progress') return;
    const item = session.items.find((value) => value.id === session.currentItemId);
    if (!item) return;
    lifetime.current++;
    const requestScope = scope,
      requestLife = lifetime.current,
      requestKey = route.current.requestKey;
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
        ...(action === 'reveal' && recognitionOptionId ? { recognitionOptionId } : {}),
        expectedSessionRevision: session.revision,
        expectedProgressRevision: item.progressRevision,
      });
      if (!isCurrent(requestScope, requestLife, requestKey)) {
        refreshAccepted(requestScope);
        return;
      }
      setSession((current) => mergeStudySession(current, result.session));
      if (result.session.status === 'cancelled') setFeedback(undefined);
      else if (result.result) setFeedback({ ...result.result, position: item.ordinal + 1 });
      setAnswer('');
      void client.invalidateQueries({ queryKey: [scope] });
    } catch (value) {
      if (isCurrent(requestScope, requestLife, requestKey))
        showTaskError(value, session.id, requestLife, requestKey);
    } finally {
      if (isCurrent(requestScope, requestLife, requestKey)) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function readCurrent() {
    if (!session || busyRef.current) return;
    lifetime.current++;
    const requestScope = scope,
      requestLife = lifetime.current,
      requestKey = route.current.requestKey;
    setBusy(true);
    busyRef.current = true;
    try {
      const result = await api<{ session: StudySession }>(`study/sessions/${session.id}`);
      if (isCurrent(requestScope, requestLife, requestKey)) {
        setSession((current) =>
          current?.id === result.session.id ? mergeStudySession(current, result.session) : current,
        );
        if (!pending) setError(null);
        setFeedback(undefined);
        setAnswer('');
      }
    } catch (value) {
      if (isCurrent(requestScope, requestLife, requestKey)) setError(value);
    } finally {
      if (isCurrent(requestScope, requestLife, requestKey)) {
        setBusy(false);
        busyRef.current = false;
      }
    }
  }
  async function readServerTask(sessionId: string) {
    if (busyRef.current) return;
    lifetime.current++;
    const requestScope = scope,
      requestLife = lifetime.current,
      requestKey = route.current.requestKey;
    setBusy(true);
    busyRef.current = true;
    try {
      const result = await api<{ session: StudySession }>(
        `study/sessions/${encodeURIComponent(sessionId)}`,
      );
      if (!isCurrent(requestScope, requestLife, requestKey)) return;
      setSession((current) => mergeStudySession(current, result.session));
      setFeedback(undefined);
      setAnswer('');
      setError(null);
      linkLoaded.current = `${scope}:${result.session.id}`;
      linkStudySession(params, result.session.id, setParams);
    } catch (value) {
      if (isCurrent(requestScope, requestLife, requestKey)) setError(value);
      throw value;
    } finally {
      if (isCurrent(requestScope, requestLife, requestKey)) {
        setBusy(false);
        busyRef.current = false;
      }
    }
  }
  useEffect(() => {
    if (route.current.requestKey !== location.key) return;
    busyRef.current = false;
    setBusy(false);
    // An accepted operation may have completed after this navigation. Read its
    // server snapshot rather than leaving an old card, without clearing a new URL's focus.
    if (session?.id && params.get('session') === session.id) void readCurrent();
  }, [location.key]);
  useEffect(() => {
    const id = params.get('session');
    if (user && id && linkLoaded.current !== `${scope}:${id}`) {
      clearSession();
      linkLoaded.current = `${scope}:${id}`;
      void readServerTask(id).catch(() => {});
    } else if (!id && linkLoaded.current) {
      clearSession();
    }
  }, [params.get('session'), user?.id, scope]);
  useEffect(() => {
    if (!session?.id || !user) return;
    const id = session.id;
    const synced = (event?: Event) => {
      if (
        event &&
        'detail' in event &&
        (event as CustomEvent<{ scope?: string }>).detail?.scope &&
        (event as CustomEvent<{ scope?: string }>).detail.scope !== scope
      )
        return;
      if (busyRef.current) return;
      const requestScope = scope,
        requestLife = lifetime.current,
        requestKey = route.current.requestKey;
      api<{ session: StudySession }>(`study/sessions/${id}`)
        .then((value) => {
          if (isCurrent(requestScope, requestLife, requestKey) && !busyRef.current) {
            setSession((current) =>
              current?.id === id ? mergeStudySession(current, value.session) : current,
            );
            setError(null);
            setFeedback(undefined);
          }
        })
        .catch((value) => {
          if (isCurrent(requestScope, requestLife, requestKey)) setError(value);
        });
    };
    window.addEventListener('nightstudy-synced', synced);
    window.addEventListener('focus', synced);
    const visible = () => {
      if (document.visibilityState === 'visible') synced();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('nightstudy-synced', synced);
      window.removeEventListener('focus', synced);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [session?.id, user?.id, scope]);
  const shortcutRequested = params.get('start') === '1';
  useQuickStudyStart({
    scope,
    requested: shortcutRequested,
    ready:
      !!user &&
      !!plan.data &&
      !!saved.data &&
      !plan.isPending &&
      !saved.isPending &&
      !plan.isFetching &&
      !saved.isFetching,
    blocked:
      !!session || !!params.get('session') || busy || waitingSync || !!plan.error || !!saved.error,
    resumeId: preferred?.id,
    consume: () => {
      const next = new URLSearchParams(params);
      next.delete('start');
      shortcutLocation.current = {
        key: location.key,
        pathname: location.pathname,
        search: next.size ? `?${next}` : '',
      };
      setParams(next, { replace: true });
    },
    start,
  });
  const openingShortcut =
    !session &&
    (busy ||
      (shortcutRequested &&
        !params.get('session') &&
        !error &&
        !plan.error &&
        !saved.error &&
        !waitingSync));
  function dashboard() {
    navigation.goBack();
  }

  if (!user)
    return (
      <div className="page">
        <Heading eyebrow="学习账户" title="登录后继续学习" />
        <LoginPrompt />
      </div>
    );
  const activePlan = plan.data?.plan;
  return (
    <div
      className={`page study-page task-page${session ? ' study-focus-active' : ''}`}
      style={
        viewportHeight
          ? ({ '--study-viewport-height': `${viewportHeight}px` } as CSSProperties)
          : undefined
      }
    >
      {!session && !openingShortcut && (
        <Heading
          eyebrow="先复习，再学新词"
          title="今日学习"
          description="先复习，再学新词。"
          action={
            <Link to="/" className="button quiet">
              回自习室
            </Link>
          }
        />
      )}
      <div className={session ? 'study-focus-notices' : undefined}>
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
              requestLife = lifetime.current,
              requestKey = route.current.requestKey;
            await discardConflict(row.id);
            if (!isCurrent(requestScope, requestLife, requestKey)) return;
            setError(null);
            if (row.sessionId) await readServerTask(row.sessionId);
            if (!isCurrent(requestScope, requestLife, requestKey)) return;
            await client.invalidateQueries({ queryKey: [scope] });
          }}
        />
        {waitingSync && (
          <Panel className="task-sync-card">
            <Notice>
              {conflicts.some((row) => row.code === 'task_cancelled')
                ? '原任务已在切书后结束，已保存记录保留。未保存的本地操作需要在上方逐条确认处理，才能开始新任务。'
                : '有操作等待同步，联网后会继续保存。请先恢复连接并核对这一组。'}
            </Notice>
            <button className="button ghost" disabled={busy} onClick={() => void sync()}>
              同步暂存操作
            </button>
            {syncNote && <p className="fine-print">{syncNote}</p>}
          </Panel>
        )}
      </div>
      {!session ? (
        openingShortcut ? (
          <Loading text="正在继续今日学习…" />
        ) : (
          <>
            {mode === 'review' && (
              <p className="content-caption">
                这里仅安排到期复习，仍计入今日总目标。额外复习可以主动安排。
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
                canContinue={
                  !busy &&
                  !waitingSync &&
                  !plan.isFetching &&
                  !saved.isFetching &&
                  !saved.isPending &&
                  !saved.error
                }
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
                  plan.isFetching ||
                  saved.isPending ||
                  saved.isFetching ||
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
                disabled={
                  busy || waitingSync || plan.isPending || plan.isFetching || saved.isFetching
                }
                onClick={() => void start(undefined, true)}
              >
                <RotateCcw size={16} />
                额外复习
              </button>
              <Link className="button quiet" to="/books">
                选择词书与每日计划
              </Link>
              <Link className="button quiet" to="/learning">
                调整总目标
              </Link>
            </div>
            {activePlan?.nextDueAt && (
              <p className="fine-print">
                下一批到期：{taskDate(activePlan.nextDueAt, true, activePlan.timeZone)}（
                {activePlan.timeZone}）。未到期的巩固词保留等待，到期后再继续复习。
              </p>
            )}
            {!!unfinished.length && (
              <Panel className="task-history">
                <div className="section-heading">
                  <div>
                    <span className="tiny-label">换设备也能继续</span>
                    <h2>已保存任务</h2>
                  </div>
                  <span className="fine-print">词卡与学习进度会为你保留</span>
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
                          已评价 {value.items.filter((row) => row.rated).length}/
                          {value.items.length} · {value.timeZone ?? '设备当地时间'} ·{' '}
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
                  <h2>任务记录</h2>
                </div>
                <span className="fine-print">按组保存，不等于当天去重词总数</span>
              </div>
              <div className="action-row" role="group" aria-label="任务记录状态">
                {(['completed', 'cancelled'] as const).map((status) => (
                  <button
                    type="button"
                    key={status}
                    className="button quiet"
                    aria-pressed={historyStatus === status}
                    onClick={() => {
                      setHistoryStatus(status);
                      setHistoryCursor('');
                    }}
                  >
                    {status === 'completed' ? '已完成' : '换书后结束'}
                  </button>
                ))}
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
                          {value.status === 'cancelled' ? '换书后已结束 · ' : '已完成 · '}
                          {taskDate(value.completedAt ?? value.updatedAt, true, value.timeZone)} ·
                          已评价 {value.items.filter((row) => row.rated).length} 词 · 拼写{' '}
                          {value.items.filter((row) => row.exerciseDone).length} 次 ·{' '}
                          {value.timeZone ?? '设备当地时间'}
                        </small>
                      </div>
                      <button
                        className="button ghost"
                        disabled={busy}
                        onClick={() => void readServerTask(value.id).catch(() => {})}
                      >
                        查看记录
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="fine-print">
                  {historyStatus === 'completed'
                    ? '还没有已完成的学习组。当前未完成任务显示在上方。'
                    : '还没有因切换词书而结束的任务。已提交的学习记录始终保留。'}
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
        )
      ) : (
        <StudySessionView
          session={session}
          feedback={feedback}
          busy={busy}
          waitingSync={waitingSync}
          answer={answer}
          onAnswer={setAnswer}
          onAct={(action, rating, value, recognitionOptionId) =>
            void act(action, rating, value, recognitionOptionId)
          }
          onState={(action) => void changeState(action)}
          onRead={() => void readCurrent()}
          onBack={dashboard}
          onTasks={() => {
            clearSession();
            setParams({}, { replace: true });
            void client.invalidateQueries({ queryKey: [scope] });
          }}
          onNext={() => void start()}
          onFeedbackDone={() => setFeedback(undefined)}
        />
      )}
    </div>
  );
}
