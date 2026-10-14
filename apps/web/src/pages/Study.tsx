import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, CheckCircle2, RotateCcw } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { api, ApiError, newId, post } from '../lib/api';
import { command, flushCommands } from '../lib/outbox';
import type { CommandResult, Plan, Rating, StudySession } from '../lib/types';
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

export function StudyPage({ mode }: { mode: 'learn' | 'review' }) {
  const { user, scope } = useApp();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const plan = useRemote<{ plan: Plan }>('plan', 'study/plan', !!user && mode === 'learn');
  const saved = useRemote<{ items: StudySession[] }>('study-sessions', 'study/sessions', !!user);
  const unfinished = saved.data?.items.filter((value) => value.mode === mode) ?? [];
  const preferred = unfinished.find(
    (value) =>
      mode === 'review' || !plan.data?.plan.bookId || value.bookId === plan.data.plan.bookId,
  );
  const [session, setSession] = useState<StudySession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reason, setReason] = useState('');
  const [answer, setAnswer] = useState('');
  const [feedback, setFeedback] = useState<
    (NonNullable<CommandResult['result']> & { position: number }) | undefined
  >(undefined);
  async function start(resumeId?: string) {
    setBusy(true);
    setError(null);
    setReason('');
    setFeedback(undefined);
    try {
      let targetId = resumeId;
      if (!targetId) {
        const [existing, currentPlan] = await Promise.all([
          api<{ items: StudySession[] }>('study/sessions'),
          mode === 'learn' ? api<{ plan: Plan }>('study/plan') : Promise.resolve(null),
        ]);
        targetId = existing.items.find(
          (value) =>
            value.mode === mode &&
            (mode === 'review' ||
              !currentPlan?.plan.bookId ||
              value.bookId === currentPlan.plan.bookId),
        )?.id;
      }
      if (targetId && navigator.onLine) await flushCommands(scope).catch(() => {});
      const result = targetId
        ? await api<{ session: StudySession }>(`study/sessions/${targetId}`)
        : await post<{ session: StudySession | null; reason?: string }>('study/sessions', { mode });
      setSession(result.session);
      if ('reason' in result)
        setReason(
          (
            {
              daily_goal_complete:
                '今日暂时没有可再安排的新词额度。已有学习组可继续完成，也可以先复习到期词。',
              nothing_due: '现在没有到期词，按下一次安排再回来。',
              no_new_words:
                '当前词书暂时没有新的可安排词。可以继续已保存的学习组，或选择另一词书。',
            } as Record<string, string>
          )[result.reason ?? ''] ??
            result.reason ??
            '',
        );
      if (result.session) setParams({ session: result.session.id });
      void client.invalidateQueries({ queryKey: [scope] });
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  async function act(action: 'reveal' | 'rate' | 'answer', rating?: Rating, answerValue?: string) {
    if (!session || busy) return;
    const item = session.items.find((value) => value.id === session?.currentItemId);
    if (!item) return;
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
      setSession(result.session);
      if (result.result) setFeedback({ ...result.result, position: item.ordinal + 1 });
      setAnswer('');
      void client.invalidateQueries({ queryKey: [scope] });
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!session?.id || !user) return;
    const id = session.id;
    const synced = () => {
      api<{ session: StudySession }>(`study/sessions/${id}`)
        .then((value) => {
          setSession(value.session);
          setError(null);
        })
        .catch(setError);
    };
    window.addEventListener('nightstudy-synced', synced);
    return () => window.removeEventListener('nightstudy-synced', synced);
  }, [session?.id, user?.id]);
  const waitingSync = error instanceof ApiError && error.queued;
  if (!user)
    return (
      <div className="page">
        <Heading
          eyebrow={mode === 'review' ? '到期复习' : '今晚学习'}
          title="从一次自己的回忆开始。"
        />
        <LoginPrompt />
      </div>
    );
  const item = session?.items.find((value) => value.id === session?.currentItemId);
  const rated = session?.items.filter((value) => value.rated).length ?? 0;
  return (
    <div className="page study-page">
      <Heading
        eyebrow={mode === 'review' ? '到期复习 · 先回想，再看答案' : '今晚学习 · 一组一点'}
        title={
          mode === 'review' ? (
            <>
              把记忆，<em>再点亮一次。</em>
            </>
          ) : (
            <>
              让一个词，<em>真正留下来。</em>
            </>
          )
        }
        description="记忆评价由服务器安排下一次复习；拼写练习单独记录。"
        action={
          <Link to="/" className="button quiet">
            暂存并回自习室
          </Link>
        }
      />
      <ErrorNotice error={error} onRetry={session ? () => void start(session.id) : undefined} />
      {!session && (
        <ErrorNotice
          error={saved.error || plan.error}
          onRetry={() => {
            void saved.refetch();
            if (mode === 'learn') void plan.refetch();
          }}
        />
      )}
      {!session && (
        <Panel className="study-intro">
          <span className="eyebrow">{mode === 'review' ? '按你的到期安排' : '从当前词书继续'}</span>
          <h2>{mode === 'review' ? '先给旧词一点时间。' : '不赶进度，先完成这一组。'}</h2>
          <p>每张词卡、学习步骤与评价，都保存在你的本站账户。</p>
          {!!plan.data?.plan.reservedNewCount && (
            <Notice>
              已有 {plan.data.plan.reservedNewCount} 个新词安排待完成，先继续保存的学习组。
            </Notice>
          )}
          {reason && (
            <Notice>
              {reason === 'empty' ? '当前没有可安排的词。可以选择词书或稍后回来。' : reason}
            </Notice>
          )}
          <div className="action-row">
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void start(params.get('session') ?? undefined)}
            >
              {busy
                ? '正在准备…'
                : params.get('session')
                  ? '恢复已保存学习组'
                  : preferred
                    ? '继续已安排学习组'
                    : mode === 'review'
                      ? '打开到期队列'
                      : '开始这一组'}
              <ArrowRight size={16} />
            </button>
            <Link to="/books" className="button ghost">
              选择词书
            </Link>
          </div>
          {unfinished.length > 0 && (
            <div className="form-stack">
              <p>已保存的{mode === 'review' ? '复习' : '学习'}组</p>
              {unfinished.map((value) => (
                <button
                  key={value.id}
                  className="button ghost"
                  disabled={busy}
                  onClick={() => void start(value.id)}
                >
                  {mode === 'review'
                    ? '到期复习'
                    : value.bookId === plan.data?.plan.bookId
                      ? '当前词书'
                      : '其他词书'}
                  {' · '}
                  {value.items.filter((item) => item.rated).length} / {value.items.length} 词已评价
                  {' · '}
                  {value.phase === 'practice' ? '继续拼写' : '继续回忆'}
                  <ArrowRight size={15} />
                </button>
              ))}
            </div>
          )}
        </Panel>
      )}
      {busy && !session && <Loading />}
      {session && (
        <>
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
              {mode === 'review'
                ? '本站全部到期词'
                : session.bookId === plan.data?.plan.bookId
                  ? '当前词书'
                  : '已保存词书学习组'}
            </span>
          </div>
          {feedback ? (
            <Panel className={`exercise-feedback ${feedback.correct ? 'correct' : 'incorrect'}`}>
              <span className="eyebrow">
                {feedback.correct ? '这次拼写正确' : '把这个词再看清一点'}
              </span>
              <h2>{feedback.correctAnswer}</h2>
              <p>{feedback.explanation}</p>
              <button className="button primary" onClick={() => setFeedback(undefined)}>
                继续 <ArrowRight size={16} />
              </button>
            </Panel>
          ) : session.phase === 'completed' ? (
            <Panel className="session-summary">
              <CheckCircle2 size={40} />
              <span className="eyebrow">积累已经保存</span>
              <h2>这一组，已经留下来了。</h2>
              <p>
                完成 {rated} 个词的评价 ·{' '}
                {session.items.filter((value) => value.exerciseDone).length} 次拼写练习
              </p>
              <div className="action-row">
                <button className="button primary" disabled={busy} onClick={() => void start()}>
                  继续下一组 <ArrowRight size={16} />
                </button>
                <Link className="button ghost" to="/memory">
                  看我的记忆安排
                </Link>
              </div>
            </Panel>
          ) : item && session.phase === 'practice' ? (
            <Panel className="spelling-card">
              <span className="eyebrow">把词，再写出来</span>
              <h2>{item.question?.prompt || '当前练习题尚未就绪，请刷新这组。'}</h2>
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
                </form>
              )}
            </Panel>
          ) : item ? (
            <Panel className={`study-card ${item.revealed ? 'is-revealed' : ''}`}>
              <span className="eyebrow">
                {item.revealed ? '现在，在语境里确认' : '先回忆这个词的意思'}
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
                        { value: 'again', title: '忘记了', detail: '再给它一点时间' },
                        { value: 'hard', title: '有点难', detail: '回忆还不稳定' },
                        { value: 'good', title: '记住了', detail: '按计划继续' },
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
                  <p>每次评价只提交一次，下一次时间按本站真实进度计算。</p>
                </div>
              )}
            </Panel>
          ) : (
            <Empty
              title="这组暂时没有可显示的词。"
              description="记录仍保留，请重新读取服务器学习组。"
              action={
                <button className="button ghost" onClick={() => void start(session.id)}>
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
