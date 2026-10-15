import { useEffect, useId, useRef } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  Ellipsis,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import type { CommandResult, Rating, StudySession } from '../../lib/types';
import { Empty, IconActionHint, WordView } from '../UI';
import { StudyBookmark } from './StudyBookmark';
import { beforeAppBackEvent } from '../../lib/screen-lifecycle';

type Feedback = NonNullable<CommandResult['result']> & { position: number };
export interface StudySessionViewProps {
  session: StudySession;
  feedback?: Feedback;
  busy: boolean;
  waitingSync: boolean;
  answer: string;
  onAnswer: (value: string) => void;
  onAct: (action: 'reveal' | 'rate' | 'answer', rating?: Rating, answer?: string) => void;
  onState: (action: 'pause' | 'resume' | 'defer') => void;
  onRead: () => void;
  onBack: () => void;
  onNext: () => void;
  onFeedbackDone: () => void;
}
const ratings: { value: Rating; title: string; help: string }[] = [
  { value: 'again', title: '忘记了', help: '到期后再巩固' },
  { value: 'hard', title: '有点难', help: '回忆还不稳定' },
  { value: 'good', title: '记住了', help: '按安排继续' },
  { value: 'easy', title: '很轻松', help: '记忆更稳一点' },
];

export function StudySessionView({
  session,
  feedback,
  busy,
  waitingSync,
  answer,
  onAnswer,
  onAct,
  onState,
  onRead,
  onBack,
  onNext,
  onFeedbackDone,
}: StudySessionViewProps) {
  const item = session.items.find((row) => row.id === session.currentItemId);
  const rated = session.items.filter((row) => row.rated).length;
  const spelled = session.items.filter((row) => row.exerciseDone).length;
  const paused = session.status === 'paused';
  const completed = session.phase === 'completed';
  const spellingEnabled = session.spellingEnabled !== false;
  const spellingPhase = session.phase === 'practice' || !!feedback;
  const practice = !paused && !feedback && !completed && session.phase === 'practice';
  const phaseLabel = paused
    ? '已暂停'
    : feedback
      ? '拼写反馈'
      : completed
        ? '本组完成'
        : practice
          ? '拼写练习'
          : '回忆词义';
  const position = completed
    ? session.items.length
    : (feedback?.position ?? Math.min(session.items.length, session.cursor + 1));
  const progress = spellingPhase ? spelled : rated;
  const locked = busy || waitingSync;
  const formId = useId();
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      if (event.defaultPrevented || !menu.current?.open) return;
      event.preventDefault();
      menu.current.open = false;
      menu.current.querySelector('summary')?.focus();
    };
    window.addEventListener(beforeAppBackEvent, close);
    return () => window.removeEventListener(beforeAppBackEvent, close);
  }, []);
  return (
    <section className="study-session-view" aria-label="专注学习">
      <header className="study-focus-header">
        <IconActionHint label="退出学习，返回原页">
          <button
            type="button"
            className="study-focus-icon"
            aria-label="退出学习，返回原页"
            disabled={busy}
            onClick={onBack}
          >
            <ArrowLeft size={23} />
          </button>
        </IconActionHint>
        <div className="study-focus-title">
          <span>{session.bookTitle || '复习已学词'}</span>
          <strong>
            {phaseLabel}
            <span>
              {' '}
              {position} / {session.items.length}
            </span>
          </strong>
        </div>
        <details className="study-focus-menu" ref={menu}>
          <summary aria-label="学习操作">
            <Ellipsis size={23} />
          </summary>
          <div>
            <button type="button" disabled={busy} onClick={onRead}>
              <RefreshCw size={17} /> 读取最新进度
            </button>
            {session.status === 'in_progress' && (
              <button type="button" disabled={locked} onClick={() => onState('pause')}>
                <Pause size={17} /> 暂停这一组
              </button>
            )}
            {item?.revealed &&
              !practice &&
              !completed &&
              !paused &&
              ratings
                .filter((rating) => ['hard', 'easy'].includes(rating.value))
                .map((rating) => (
                  <button
                    type="button"
                    className={`study-rating-${rating.value}`}
                    key={rating.value}
                    disabled={locked}
                    onClick={() => {
                      if (menu.current) menu.current.open = false;
                      onAct('rate', rating.value);
                    }}
                  >
                    {rating.title}，{rating.help}
                  </button>
                ))}
            <p>
              本组已评价 {rated} 词 · {spellingEnabled ? `已拼写 ${spelled} 词` : '未安排拼写'}
            </p>
            {session.timeZone && (
              <p>
                {session.learningDate || ''} · {session.timeZone}
              </p>
            )}
          </div>
        </details>
      </header>
      <div
        className="study-focus-progress"
        role="progressbar"
        aria-label={spellingPhase ? '本组拼写进度' : '本组回忆评价进度'}
        aria-valuemin={0}
        aria-valuemax={Math.max(1, session.items.length)}
        aria-valuenow={progress}
      >
        <i
          style={{
            width: `${session.items.length ? Math.min(100, (progress / session.items.length) * 100) : 0}%`,
          }}
        />
      </div>
      <div className={`study-focus-scroll${practice ? ' study-spelling-scroll' : ''}`}>
        {paused ? (
          <div className="study-focus-state">
            <span className="study-state-symbol">
              <Pause size={27} />
            </span>
            <span className="study-eyebrow">进度已经留下</span>
            <h2>休息一下，回来继续。</h2>
            <p>同一组词和已提交的评价都保留，换设备也可以接着学。</p>
            {session.deferredUntil && <p>已延后，仍可随时主动恢复。</p>}
          </div>
        ) : feedback ? (
          <div
            className={`study-focus-state study-answer-feedback ${feedback.correct ? 'correct' : 'incorrect'}`}
            key={`feedback:${feedback.position}`}
          >
            <span className="study-state-symbol">
              {feedback.correct ? <Check size={28} /> : <RotateCcw size={26} />}
            </span>
            <span className="study-eyebrow">
              {feedback.correct ? '拼写正确' : '再把它看清一点'}
            </span>
            <h2 lang="en">{feedback.correctAnswer}</h2>
            <p>{feedback.explanation}</p>
          </div>
        ) : completed ? (
          <div className="study-focus-state study-group-complete">
            <span className="study-state-symbol">
              <CheckCircle2 size={34} />
            </span>
            <span className="study-eyebrow">这一组已经保存</span>
            <h2>又多记住了一点。</h2>
            <div className="study-complete-counts">
              <div>
                <strong>{rated}</strong>
                <span>词已评价</span>
              </div>
              {spellingEnabled && (
                <div>
                  <strong>{spelled}</strong>
                  <span>次拼写</span>
                </div>
              )}
            </div>
            {!spellingEnabled && <p>本组未安排拼写。</p>}
            <p>当天同一个词只计一次，重复巩固不额外占用每日目标。</p>
            <Link className="study-inline-link" to="/memory">
              看看我的记忆安排 <ArrowRight size={15} />
            </Link>
          </div>
        ) : practice && item ? (
          <div className="study-spelling-card" key={item.id}>
            <span className="study-eyebrow">把记得的词写出来</span>
            <h2>{item.question?.prompt || '题目暂未就绪，请读取最新进度。'}</h2>
            {item.question && (
              <form
                id={formId}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (answer.trim() && !locked) onAct('answer');
                }}
              >
                <label>
                  <span className="sr-only">你的拼写</span>
                  <input
                    aria-label="你的拼写"
                    value={answer}
                    onChange={(event) => onAnswer(event.target.value)}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    enterKeyHint="done"
                    disabled={locked}
                    placeholder="在这里写下单词"
                    autoFocus
                  />
                </label>
              </form>
            )}
            <p>想不起来也没关系，看清之后再记一次。</p>
          </div>
        ) : item ? (
          <div
            className={`study-learning-word${item.revealed ? ' is-revealed' : ''}`}
            key={item.id}
          >
            <span className="study-eyebrow">
              {item.revealed
                ? '在语境里确认它'
                : item.bucket === 'review'
                  ? '还记得这个词吗？'
                  : '先想一想它的意思'}
            </span>
            <WordView
              word={item.word}
              focusSenseId={item.focusSenseId}
              hideMeanings={!item.revealed}
              presentation="study"
              headerAction={<StudyBookmark key={item.wordId} word={item.word} />}
            />
            {!item.revealed && <p className="study-recall-hint">试着回忆词义，准备好了再揭晓。</p>}
          </div>
        ) : (
          <Empty
            title="这一组暂时没有可显示的词。"
            description="你的记录仍保留，可以读取最新进度。"
            action={
              <button className="button ghost" onClick={onRead}>
                读取最新进度
              </button>
            }
          />
        )}
      </div>
      <footer className="study-thumb-dock">
        {waitingSync ? (
          <p className="study-dock-status" role="status">
            这次操作正在等待同步，请先核对进度。
          </p>
        ) : null}
        {paused ? (
          <>
            <button
              className="study-main-action"
              disabled={locked}
              onClick={() => onState('resume')}
            >
              <Play size={18} /> 恢复这一组
            </button>
            <button
              className="study-secondary-action"
              disabled={locked}
              onClick={() => onState('defer')}
            >
              <Clock3 size={15} /> 延后24小时
            </button>
          </>
        ) : feedback ? (
          <button className="study-main-action" disabled={locked} onClick={onFeedbackDone}>
            继续 <ArrowRight size={18} />
          </button>
        ) : completed ? (
          <>
            <button className="study-main-action" disabled={locked} onClick={onNext}>
              继续今日任务 <ArrowRight size={18} />
            </button>
            <button className="study-secondary-action" disabled={busy} onClick={onBack}>
              返回原页
            </button>
          </>
        ) : practice && item?.question ? (
          <>
            <button
              className="study-main-action"
              type="submit"
              form={formId}
              disabled={locked || !answer.trim()}
            >
              {busy ? '正在核对…' : '核对答案'}
              <ArrowRight size={18} />
            </button>
            <button
              className="study-secondary-action"
              type="button"
              disabled={locked}
              onClick={() => onAct('answer', undefined, '')}
            >
              想不起来，查看答案
            </button>
          </>
        ) : item && !practice ? (
          !item.revealed ? (
            <button className="study-main-action" disabled={locked} onClick={() => onAct('reveal')}>
              {busy ? '正在揭晓…' : '看答案'}
              <ArrowRight size={18} />
            </button>
          ) : (
            <>
              <div className="study-rating-actions study-rating-primary">
                {ratings
                  .filter((rating) => ['again', 'good'].includes(rating.value))
                  .map((rating) => (
                    <button
                      type="button"
                      key={rating.value}
                      className={`study-rating-${rating.value}`}
                      disabled={locked}
                      aria-label={rating.value === 'again' ? '记错了，安排巩固' : '记住了，下一词'}
                      onClick={() => onAct('rate', rating.value)}
                    >
                      <strong>{rating.value === 'again' ? '记错了' : '下一词'}</strong>
                      <span>{rating.value === 'again' ? '安排巩固' : '确认记得并继续'}</span>
                    </button>
                  ))}
              </div>
            </>
          )
        ) : null}
        {busy && (
          <span className="sr-only" role="status">
            正在保存，请稍候。
          </span>
        )}
      </footer>
    </section>
  );
}
