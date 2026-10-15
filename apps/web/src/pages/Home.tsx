import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  BookOpen,
  GraduationCap,
  Search,
  Sparkles,
  RotateCcw,
  Settings2,
} from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { goalLabels, goalNames, type Book, type Goal } from '../lib/types';
import { Empty, ErrorNotice, Heading, Loading, Panel } from '../components/UI';
import { NightScene } from '../components/NightScene';
import { useBookPlan } from '../components/tasks/useBookPlan';
import { HomeLearning } from './HomeLearning';
import './mobile-content.css';

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
          className="book-card"
          key={book.id}
          disabled={!!busyId}
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
export function HomePage() {
  const { user, pending } = useApp();
  const planning = useBookPlan();
  const books = useRemote<{ items: Book[] }>('books', 'books');
  const plan = planning.query;
  const active = plan.data?.plan;
  const currentBook = books.data?.items.find((book) => book.id === active?.bookId);
  const availableBooks = books.data?.items.filter((book) => !book.isDemo) ?? [];
  const date = active?.localDate
    ? new Intl.DateTimeFormat('zh-CN', {
        month: 'long',
        day: 'numeric',
        weekday: 'long',
        timeZone: 'UTC',
      }).format(new Date(`${active.localDate}T12:00:00Z`))
    : new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(
        new Date(),
      );
  return (
    <div className="page mobile-home">
      <section className="mobile-home-stage" aria-label="今日学习">
        <div className="mobile-home-scene" aria-hidden="true">
          <NightScene />
        </div>
        <header className="mobile-home-top">
          <span>
            夜读英语 <small>NIGHT STUDY</small>
          </span>
          <span>{date}</span>
          <Link to={user ? '/me?section=preferences' : '/auth'} aria-label="我的学习偏好">
            <Settings2 size={19} />
          </Link>
        </header>
        <div className="mobile-home-intro">
          <span className="mobile-kicker">留一点安静，给自己。</span>
          <h1>
            在雨声里，
            <br />
            慢慢记住。
          </h1>
          <p>不赶进度，让今天的词留下来。</p>
        </div>
        <div className="mobile-home-session">
          <Link className="mobile-current-book" to="/books">
            <BookOpen size={18} />
            <span>
              <small>正在学习</small>
              <strong>{currentBook?.title ?? active?.bookTitle ?? '选择一本词书'}</strong>
            </span>
            <ArrowRight size={18} />
          </Link>
          {user && active ? (
            <>
              <div className="mobile-today-line">
                <span>今日已评价的不同词</span>
                <strong>
                  {active.completedUnique}
                  <small> / {active.dailyTotalGoal}</small>
                </strong>
              </div>
              <div
                className="mobile-home-progress"
                role="progressbar"
                aria-label="今日总词数进度"
                aria-valuemin={0}
                aria-valuemax={Math.max(active.dailyTotalGoal, active.completedUnique)}
                aria-valuenow={active.completedUnique}
              >
                <i
                  style={{
                    width: `${Math.min(100, (active.completedUnique / active.dailyTotalGoal) * 100)}%`,
                  }}
                />
              </div>
              <p className="mobile-home-counts">
                新学 {active.completedNew} · 复习 {active.completedReview} · 本组上限{' '}
                {active.groupSize} 词
              </p>
            </>
          ) : (
            <p className="mobile-home-counts">每天的总词数，包含新学与复习。登录后跨设备继续。</p>
          )}
          <div className="mobile-home-actions">
            <Link to={user ? '/learn?start=1' : '/auth'} className="mobile-study-action">
              <Sparkles size={23} />
              <span>
                <strong>{active?.activeTaskId ? '继续学习' : '新学'}</strong>
                <small>
                  {active ? `计划待新学 ${active.newRemaining} 词` : '从今天的一小组开始'}
                </small>
              </span>
              <ArrowRight size={17} />
            </Link>
            <Link to={user ? '/review?start=1' : '/auth'} className="mobile-study-action review">
              <RotateCcw size={23} />
              <span>
                <strong>复习</strong>
                <small>
                  {active ? `现在到期 ${active.dueNowCount} 词` : '在下一次回忆中留下来'}
                </small>
              </span>
              <ArrowRight size={17} />
            </Link>
          </div>
          <p className="mobile-home-rule">
            今日计划先复习，再学新词；同词只计一次。
            {pending > 0 ? ` ${pending} 条操作等待同步。` : ''}
          </p>
          {user && plan.isPending && <Loading text="正在读取今日计划…" />}
          <ErrorNotice error={plan.error} onRetry={() => void plan.refetch()} />
        </div>
      </section>
      <HomeLearning plan={active ?? null} />
      <div className="mobile-section-title">
        <div>
          <span className="tiny-label">选择你的方向</span>
          <h2>我的书架</h2>
        </div>
        <Link to="/books">
          全部词书 <ArrowRight size={15} />
        </Link>
      </div>
      <ErrorNotice error={books.error} onRetry={() => void books.refetch()} />
      {books.isPending ? (
        <Loading text="正在打开词书…" />
      ) : availableBooks.length ? (
        <BookGrid
          books={availableBooks.slice(0, 4)}
          onSelect={(id) => {
            const book = availableBooks.find((value) => value.id === id);
            if (book) planning.choose(book);
          }}
        />
      ) : (
        <Empty title="还没有可选词书" description="管理员发布学习内容后，词书会出现在这里。" />
      )}
      <div className="mobile-quick-links">
        <Link to="/books/mine">
          <BookOpen size={18} />
          我的词书
        </Link>
        <Link to="/books/import">
          <ArrowRight size={18} />
          导入词书
        </Link>
        <Link to="/content">
          <Search size={18} />
          内容中心
        </Link>
        <Link to={user ? '/assessment' : '/auth'}>
          <GraduationCap size={18} />
          了解我的水平
        </Link>
      </div>
      {planning.dialog}
    </div>
  );
}
export function BooksPage() {
  const planning = useBookPlan();
  const books = useRemote<{ items: Book[] }>('books', 'books');
  const [goal, setGoal] = useState<Goal | 'all'>('all');
  const [params, setParams] = useSearchParams();
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
    <div className="page">
      <Heading
        eyebrow="书架 · 选择你的方向"
        title={
          <>
            让遇见的词，<em>有一条路径。</em>
          </>
        }
        description="选择词书或词组本，再定每天总词数。先复习，后学新词；换书后，已安排的学习组仍可继续。"
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
      <div className="filter-row">
        <button className={goal === 'all' ? 'active' : ''} onClick={() => setGoal('all')}>
          全部方向
        </button>
        {goalNames.map((value) => (
          <button
            className={goal === value ? 'active' : ''}
            key={value}
            onClick={() => setGoal(value)}
          >
            {goalLabels[value]}
          </button>
        ))}
      </div>
      <p className="content-caption">
        同一个词在不同书中共享学习进度。书中进度包括学过和测验确认的词，导入熟词不会直接计入。
      </p>
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
