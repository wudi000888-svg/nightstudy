import { useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  BookOpen,
  GraduationCap,
  MoonStar,
  CalendarDays,
  Check,
  PanelsTopLeft,
  ChartNoAxesCombined,
} from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { goalLabels, goalNames, type Book, type Goal } from '../lib/types';
import { Empty, ErrorNotice, Heading, Loading, Panel } from '../components/UI';
import { useAppNavigation } from '../components/AppNavigation';
import type { H5HomeSummary, H5HomeEntry } from '../lib/h5-home-types';
import { useScreenActive } from '../lib/screen-lifecycle';
import { useBookPlan } from '../components/tasks/useBookPlan';
import { SiteHomeAtmosphere } from '../components/HomeAtmosphere';
import './h5-home.css';
import './mobile-content.css';
import './home-refinement.css';

export function bookKindLabel(book: Pick<Book, 'kind'>) {
  return book.kind === 'phrases' ? '词组本' : '词书';
}
export function bookReadingDescription(book: Book) {
  if (book.visibility !== 'private' && book.id.startsWith('content-ecdict-'))
    return `${goalLabels[book.goal]}词汇，按自己的每日计划逐步学习。`;
  if (
    book.visibility !== 'private' &&
    book.kind === 'phrases' &&
    book.id.startsWith('content-phrase-books-')
  )
    return '在常用搭配和例句里学习英语表达，供考试方向练习参考。';
  return book.description;
}
export function BookGrid({
  books,
  onSelect,
  busyId,
}: {
  books: Book[];
  onSelect: (id: string) => void;
  busyId?: string;
}) {
  return (
    <div className="book-grid">
      {books.map((book, index) => (
        <button
          type="button"
          className="book-card"
          key={book.id}
          disabled={!!busyId}
          aria-busy={busyId === book.id}
          onClick={() => onSelect(book.id)}
        >
          <span className={`book-cover cover-${index % 4}`}>
            <BookOpen size={26} />
            <strong>{goalLabels[book.goal]}</strong>
            <span>
              {book.visibility === 'private' ? `我的${bookKindLabel(book)}` : bookKindLabel(book)}
            </span>
          </span>
          <span className="book-description">
            <span className="tiny-label">
              {book.wordCount} {book.kind === 'phrases' ? '条词组' : '个单词'}
            </span>
            <strong>{book.title}</strong>
            <small>{bookReadingDescription(book)}</small>
            <span className="book-progress">
              <i
                style={{
                  width: `${book.wordCount ? Math.min(100, (book.coveredCount / book.wordCount) * 100) : 0}%`,
                }}
              />
            </span>
            <small>
              已学 {book.learnedCount} · 进度 {book.coveredCount} / {book.wordCount}
            </small>
          </span>
          <span className="book-action">
            {busyId === book.id ? '正在确认…' : '选择并制定计划'}
            <ArrowRight size={15} />
          </span>
        </button>
      ))}
    </div>
  );
}
const homeEntryText = {
  setup: '选择词书',
  resume: '继续这一组',
  ready: '开始',
  waiting: '稍后继续',
  review_first: '先复习，再学新词',
  other_task: '继续当前任务',
  complete: '今日完成',
  empty: '暂时没有待学词',
} as const;

export function homeEntryDestination(entry: H5HomeEntry, mode: 'learn' | 'review') {
  if (entry.sessionId && ['resume', 'other_task', 'review_first'].includes(entry.state))
    return entry.sessionRoute
      ? `/${entry.sessionRoute}?session=${encodeURIComponent(entry.sessionId)}`
      : '/learning?section=tasks';
  if (entry.state === 'setup') return '/books';
  if (entry.state === 'review_first') return '/review?start=1';
  if (entry.state === 'ready') return `/${mode}?start=1`;
  return entry.state === 'complete' ? '/learning?section=results' : '/learning?section=tasks';
}

export function HomePage() {
  const { user, pending, conflicts } = useApp();
  const active = useScreenActive();
  const { openModule } = useAppNavigation();
  const navigate = useNavigate();
  const home = useRemote<H5HomeSummary>('app-home', 'app/home', !!user);
  const summary = home.data;
  useEffect(() => {
    if (!active || !summary) return;
    // A fresh query cache can still cross the server's learning-day/due boundary
    // while another retained screen is open. Reconcile that snapshot immediately.
    const snapshotTime = new Date(summary.asOf).getTime();
    const times = [summary.endsAt, summary.learn.availableAt, summary.review.availableAt]
      .filter((value): value is string => !!value)
      .map((value) => new Date(value).getTime())
      .filter((value) => value > snapshotTime);
    if (!times.length) return;
    if (Math.min(...times) <= Date.now()) {
      void home.refetch();
      return;
    }
    const timeout = window.setTimeout(
      () => void home.refetch(),
      Math.min(2147483647, Math.max(1000, Math.min(...times) - Date.now() + 100)),
    );
    return () => window.clearTimeout(timeout);
  }, [summary?.asOf, active]);
  const date = summary?.localDate ? new Date(`${summary.localDate}T12:00:00Z`) : new Date();
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    ...(summary ? { timeZone: 'UTC' } : {}),
  }).format(date);
  const blocked = pending > 0 || !!conflicts?.length;
  const openStudy = (mode: 'learn' | 'review') => {
    if (user && home.isFetching) return;
    if (!user) {
      navigate(`/auth?next=${encodeURIComponent(`/${mode}?start=1`)}`);
      return;
    }
    if (blocked) {
      navigate('/learning?section=tasks');
      return;
    }
    const entry = summary?.[mode];
    if (entry) navigate(homeEntryDestination(entry, mode));
  };
  return (
    <section className="h5-home" aria-label="学习首页">
      <SiteHomeAtmosphere />
      <button
        type="button"
        className="h5-home-avatar"
        aria-label="个人中心"
        title="个人中心"
        onClick={() => (user ? openModule('account') : navigate('/auth'))}
      >
        {user?.name ? <span>{Array.from(user.name)[0]}</span> : <MoonStar size={25} />}
      </button>
      <button
        type="button"
        className={`h5-home-checkin${summary?.checkedIn ? ' is-checked' : ''}`}
        aria-label={summary?.checkedIn ? '今日已签到，查看学习日历' : '查看签到与学习日历'}
        onClick={() =>
          navigate(
            user ? '/learning?section=calendar' : '/auth?next=%2Flearning%3Fsection%3Dcalendar',
          )
        }
      >
        {summary?.checkedIn ? <Check size={28} /> : <CalendarDays size={28} />}
        <strong>{summary?.checkedIn ? '已签到' : '签到'}</strong>
        <span>{dateLabel}</span>
      </button>
      <div className="h5-home-study-actions">
        {(['learn', 'review'] as const).map((mode) => {
          const entry = summary?.[mode];
          const label = mode === 'learn' ? 'Learn' : 'Review';
          const detail = !user
            ? mode === 'learn'
              ? '登录开始学习'
              : '登录查看复习'
            : blocked
              ? '记录待同步'
              : home.isFetching
                ? '正在更新…'
                : entry
                  ? entry.state === 'other_task'
                    ? entry.sessionKind === 'new'
                      ? mode === 'review' && entry.count === 0
                        ? '暂无复习，先完成新学'
                        : '先完成当前新学'
                      : entry.sessionKind === 'review'
                        ? '先完成当前复习'
                        : '先完成当前学习组'
                    : entry.state === 'resume' && entry.sessionKind === 'mixed'
                      ? '继续当前学习组'
                      : homeEntryText[entry.state]
                  : home.error
                    ? '重新连接'
                    : '正在读取…';
          return (
            <button
              type="button"
              key={mode}
              className={`h5-home-study h5-home-${mode}`}
              disabled={!!user && (home.isFetching || (!summary && !home.error))}
              aria-busy={!!user && home.isFetching}
              aria-label={`${label}，${detail}${user && entry ? `，${entry.count}词` : ''}`}
              data-entry-state={blocked ? 'sync' : (entry?.state ?? (!user ? 'guest' : 'loading'))}
              onClick={() => (home.error && !summary ? void home.refetch() : openStudy(mode))}
            >
              <strong>{label}</strong>
              {user ? (
                <span className="h5-home-count">
                  <span>{entry?.count ?? '—'}</span>
                  {entry && <small>词</small>}
                </span>
              ) : (
                <span className="h5-home-guest-note">
                  {mode === 'learn' ? '遇见新的表达' : '让记忆更清晰'}
                </span>
              )}
              <small>{detail}</small>
              {entry &&
                ['resume', 'other_task'].includes(entry.state) &&
                !home.isFetching &&
                !blocked && (
                  <ArrowRight className="h5-home-continue-mark" size={18} aria-hidden="true" />
                )}
            </button>
          );
        })}
      </div>
      <div className="h5-home-status" aria-live="polite">
        {blocked
          ? conflicts?.length
            ? conflicts.some((row) => row.code === 'task_cancelled')
              ? '原任务已结束，未保存操作请到任务页逐条处理'
              : '进度有更新，请先核对'
            : `${pending} 条记录等待同步`
          : home.error
            ? '暂时无法连接，点击学习按钮重试'
            : summary?.dailyGoalComplete
              ? '今天的目标已完成'
              : null}
      </div>
      <nav className="h5-home-modules" aria-label="首页功能">
        <button
          type="button"
          aria-label="英语学堂"
          title="英语学堂"
          onClick={() => openModule('academy')}
        >
          <GraduationCap size={28} />
          <span className="h5-home-module-label" role="tooltip">
            英语学堂
          </span>
        </button>
        <button
          type="button"
          aria-label="我的内容"
          title="我的内容"
          onClick={() => openModule('content')}
        >
          <PanelsTopLeft size={27} />
          <span className="h5-home-module-label" role="tooltip">
            我的内容
          </span>
        </button>
        <button
          type="button"
          aria-label="我的学习"
          title="我的学习"
          onClick={() => openModule('learning')}
        >
          <ChartNoAxesCombined size={27} />
          <span className="h5-home-module-label" role="tooltip">
            我的学习
          </span>
        </button>
      </nav>
    </section>
  );
}
export function BooksPage() {
  const planning = useBookPlan();
  const books = useRemote<{ items: Book[] }>('books', 'books');
  const [params, setParams] = useSearchParams();
  const goalParam = params.get('goal');
  const goal = goalNames.includes(goalParam as Goal) ? (goalParam as Goal) : 'all';
  const setGoal = (value: Goal | 'all') => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete('goal');
    else next.set('goal', value);
    setParams(next);
  };
  const kind =
    params.get('kind') === 'phrases'
      ? 'phrases'
      : params.get('kind') === 'vocabulary'
        ? 'vocabulary'
        : 'all';
  const setKind = (value: 'all' | 'vocabulary' | 'phrases') => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete('kind');
    else next.set('kind', value);
    setParams(next);
  };
  const filteredBooks =
    books.data?.items.filter(
      (book) =>
        !book.isDemo &&
        book.visibility !== 'private' &&
        (goal === 'all' || book.goal === goal) &&
        (kind === 'all' || (book.kind ?? 'vocabulary') === kind),
    ) ?? [];
  return (
    <div className="page books-page">
      <Heading
        eyebrow="词汇与词组"
        title="选择词书"
        description="按学习目标选书，再设置每日总词数。换书会结束原来的未完成任务，保留已学记录与今日完成数。"
        action={
          <div className="action-row">
            <Link className="button ghost" to="/books/mine">
              我的词书
            </Link>
            <Link className="button primary" to="/books/import">
              导入自定义词书
            </Link>
          </div>
        }
      />
      <div className="tab-row" aria-label="书架类型">
        {(
          [
            ['all', '全部'],
            ['vocabulary', '词书'],
            ['phrases', '词组本'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={kind === value ? 'active' : ''}
            aria-pressed={kind === value}
            onClick={() => setKind(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="filter-row" aria-label="学习目标">
        <button
          className={goal === 'all' ? 'active' : ''}
          aria-pressed={goal === 'all'}
          onClick={() => setGoal('all')}
        >
          全部方向
        </button>
        {goalNames.map((value) => (
          <button
            className={goal === value ? 'active' : ''}
            aria-pressed={goal === value}
            key={value}
            onClick={() => setGoal(value)}
          >
            {goalLabels[value]}
          </button>
        ))}
      </div>
      <p className="content-caption">同一个词在不同书中共享学习进度。</p>
      {books.data && (
        <p className="book-result-count" role="status">
          {goal === 'all' ? '全部方向' : goalLabels[goal]} · {filteredBooks.length} 本可选
        </p>
      )}
      <ErrorNotice error={books.error} onRetry={() => void books.refetch()} />
      {books.isPending ? (
        <Loading />
      ) : (
        <BookGrid
          books={filteredBooks}
          onSelect={(id) => {
            const book = books.data?.items.find((value) => value.id === id);
            if (book) planning.choose(book);
          }}
        />
      )}
      {books.data && !filteredBooks.length && (
        <Empty
          title={`这个方向还没有${kind === 'phrases' ? '词组本' : kind === 'vocabulary' ? '词书' : '可选的书'}。`}
          description="可以选择其他方向，或导入自己的词书。"
          action={
            <Link className="button ghost" to="/books/import">
              导入自定义词书
            </Link>
          }
        />
      )}
      {planning.dialog}
    </div>
  );
}
