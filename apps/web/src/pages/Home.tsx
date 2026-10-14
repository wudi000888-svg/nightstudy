import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, GraduationCap, Search, Sparkles, Check } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { goalLabels, goalNames, type Book, type Goal } from '../lib/types';
import { Empty, ErrorNotice, Heading, Loading, Panel } from '../components/UI';
import { NightScene } from '../components/NightScene';
import { useBookPlan } from '../components/tasks/useBookPlan';
import { TaskOverview } from '../components/tasks/TaskOverview';

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
            <span>{book.visibility === 'private' ? '我的私有词书' : '本站发布词书'}</span>
          </span>
          <span className="book-description">
            <span className="tiny-label">
              {book.wordCount} 词 · v{book.version}
            </span>
            <strong>{book.title}</strong>
            <small>{book.description}</small>
            <span className="book-progress">
              <i
                style={{
                  width: `${book.wordCount ? Math.min(100, (book.coveredCount / book.wordCount) * 100) : 0}%`,
                }}
              />
            </span>
            <small>
              已学 {book.learnedCount} · 已覆盖 {book.coveredCount} / {book.wordCount}
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
  const currentBook = books.data?.items.find((book) => book.id === plan.data?.plan.bookId);
  const availableBooks = books.data?.items.filter((book) => !book.isDemo) ?? [];
  const date = new Intl.DateTimeFormat('zh-CN', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date());
  return (
    <div className="page home-page">
      <section className="home-hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <i className="warm-dot" /> 雨夜自习室 · {date}
          </span>
          <h1>
            今晚，读懂
            <br />
            <em>一点英语。</em>
          </h1>
          <p>
            在安静里，查清一个词。
            <br />
            再让它在下一次回忆中，留下来。
          </p>
          <div className="hero-actions">
            <Link className="button primary" to={user ? '/learn' : '/auth'}>
              <GraduationCap size={18} />
              {user ? '查看今日任务' : '连接我的自习室'}
              <ArrowRight size={16} />
            </Link>
            <Link className="button ghost" to="/lookup">
              <Search size={17} />
              查一个词
            </Link>
          </div>
          <div className="hero-quote">
            <span>“</span>
            <p>
              不赶进度，先让今天的词留下来。
              <small>No rush. Let tonight’s words stay with you.</small>
            </p>
          </div>
        </div>
        <NightScene />
        <div className="scene-caption">
          <i /> 一盏灯，一点积累。
        </div>
      </section>
      <div className="section-heading">
        <div>
          <span className="eyebrow">今晚的方向</span>
          <h2>{currentBook?.title || '选择一本词书，开始这一晚。'}</h2>
        </div>
        <Link className="text-link" to="/books">
          全部词书 <ArrowRight size={15} />
        </Link>
      </div>
      <ErrorNotice error={plan.error} onRetry={() => void plan.refetch()} />
      {user && plan.isPending && <Loading />}
      {plan.data ? (
        <TaskOverview plan={plan.data.plan} pending={pending} compact />
      ) : (
        !user && (
          <Panel className="today-plan">
            <span className="tiny-label">给每一天一点可持续的积累</span>
            <h3>每天总词数，包含复习与新学。</h3>
            <p>
              先给到期词一点时间，再从选好的词书学新词。同一个词当天只计一次，计划与任务保存在你的本站账户。
            </p>
            <Link className="text-link" to="/auth">
              登录，制定自己的计划 <ArrowRight size={15} />
            </Link>
          </Panel>
        )
      )}
      <div className="section-heading compact">
        <div>
          <span className="eyebrow">从语境开始</span>
          <h2>词书里的每一个词，都有来处。</h2>
        </div>
      </div>
      <p className="content-caption">
        词书按本站词库组织，也可以导入自己的私有词书。释义与音标保留各词条来源。
      </p>
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
        <Empty title="这一页还没有词书。" description="管理员发布学习内容后，词书会出现在这里。" />
      )}
      <div className="discovery-grid">
        <Link to={user ? '/assessment' : '/auth'}>
          <Sparkles size={20} />
          <div>
            <strong>先了解你的词汇基线</strong>
            <small>测过的词与范围估计，分开看清楚。</small>
          </div>
          <ArrowRight size={17} />
        </Link>
        <Link to={user ? '/known' : '/auth'}>
          <Check size={20} />
          <div>
            <strong>把已熟悉的词带进来</strong>
            <small>导入熟词，保留低频抽查。</small>
          </div>
          <ArrowRight size={17} />
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
  return (
    <div className="page">
      <Heading
        eyebrow="词书 · 选择你的方向"
        title={
          <>
            让遇见的词，<em>有一条路径。</em>
          </>
        }
        description="选书后先确认每天总词数。新学从本书开始，复习覆盖本站全部已学词；切书保留已签发任务。"
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
      <div className="filter-row">
        <button className={goal === 'all' ? 'active' : ''} onClick={() => setGoal('all')}>
          全部
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
        公开词书词数和覆盖进度来自本站记录。同词跨书共享学习进度；自己的私有词书在“我的词书”管理。
      </p>
      <ErrorNotice error={books.error} onRetry={() => void books.refetch()} />
      {books.isPending ? (
        <Loading />
      ) : (
        <BookGrid
          books={
            books.data?.items.filter(
              (book) =>
                !book.isDemo &&
                book.visibility !== 'private' &&
                (goal === 'all' || book.goal === goal),
            ) ?? []
          }
          onSelect={(id) => {
            const book = books.data?.items.find((value) => value.id === id);
            if (book) planning.choose(book);
          }}
        />
      )}
      {books.data &&
        !books.data.items.filter(
          (book) =>
            !book.isDemo && book.visibility !== 'private' && (goal === 'all' || book.goal === goal),
        ).length && (
          <Empty
            title="这个方向还没有已发布词书。"
            description="可以选择其他方向，或导入自己的私有词书。"
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
