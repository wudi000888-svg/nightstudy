import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, GraduationCap, Search, Sparkles, Check } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { goalLabels, goalNames, type Book, type Goal } from '../lib/types';
import { Empty, ErrorNotice, Heading, Loading, Panel } from '../components/UI';
import { NightScene } from '../components/NightScene';
import { useBookPlan } from '../components/tasks/useBookPlan';
import { TaskOverview } from '../components/tasks/TaskOverview';

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
          词书与词组本 <ArrowRight size={15} />
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
            <p>先复习到期的词，再从选好的书里学新词。同一个词当天只计一次，换设备也可以继续。</p>
            <Link className="text-link" to="/auth">
              登录，制定自己的计划 <ArrowRight size={15} />
            </Link>
          </Panel>
        )
      )}
      <div className="section-heading compact">
        <div>
          <span className="eyebrow">从语境开始</span>
          <h2>选一本书，给积累一点方向。</h2>
        </div>
      </div>
      <p className="content-caption">
        从单词到常用词组，按照自己的节奏学习。也可以导入只属于你的词书。
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
            <strong>了解自己的词汇水平</strong>
            <small>做一组小测验，找到合适的起点。</small>
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
  const [kind, setKind] = useState<'all' | 'vocabulary' | 'phrases'>('all');
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
