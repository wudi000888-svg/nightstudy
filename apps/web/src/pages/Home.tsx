import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  BookOpen,
  Clock3,
  GraduationCap,
  RotateCcw,
  Search,
  Sparkles,
  Check,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useApp, useRemote } from '../AppContext';
import { post } from '../lib/api';
import { goalLabels, goalNames, type Book, type Goal, type Plan } from '../lib/types';
import { Empty, ErrorNotice, Heading, Loading, Panel } from '../components/UI';
import { NightScene } from '../components/NightScene';

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
            <span>{book.isDemo ? '夜读 · 原创示例' : '本站发布词书'}</span>
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
            {busyId === book.id ? '正在选择…' : '选择词书'}
            <ArrowRight size={15} />
          </span>
        </button>
      ))}
    </div>
  );
}
export function HomePage() {
  const { user, scope } = useApp();
  const navigate = useNavigate();
  const client = useQueryClient();
  const books = useRemote<{ items: Book[] }>('books', 'books');
  const plan = useRemote<{ plan: Plan }>('plan', 'study/plan', !!user);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const currentBook = books.data?.items.find((book) => book.id === plan.data?.plan.bookId);
  async function select(id: string) {
    if (!user) {
      navigate('/auth');
      return;
    }
    setBusyId(id);
    setError(null);
    try {
      await post(`books/${id}/select`, {});
      await client.invalidateQueries({ queryKey: [scope] });
      navigate('/learn');
    } catch (value) {
      setError(value);
    } finally {
      setBusyId('');
    }
  }
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
              {user ? '继续今晚学习' : '连接我的自习室'}
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
      <ErrorNotice error={error} />
      <ErrorNotice error={plan.error} onRetry={() => void plan.refetch()} />
      {user && plan.isPending && <Loading />}
      <div className="tonight-grid">
        <Panel className="today-plan">
          <div className="section-heading">
            <span className="tiny-label">今日计划</span>
            <span className="soft-badge">
              <Clock3 size={12} /> 轻量 · 专注
            </span>
          </div>
          <h3>
            {plan.data
              ? `先复习 ${plan.data.plan.dueCount} 个到期词，`
              : '从一点可持续的积累开始。'}
            {plan.data && (
              <>
                <br />
                {plan.data.plan.reservedNewCount > 0
                  ? `再完成 ${plan.data.plan.reservedNewCount} 个已安排新词。`
                  : `还可安排 ${plan.data.plan.newRemaining} 个新词。`}
              </>
            )}
          </h3>
          <p>
            {user
              ? `每组 ${plan.data?.plan.groupSize ?? '—'} 词，按你的本站进度继续。`
              : '学习、拼写和复习都有记录。登录后保存在你的账户里。'}
          </p>
          {plan.data && plan.data.plan.reservedNewCount > 0 && (
            <p>已有学习组待完成，另可安排 {plan.data.plan.newRemaining} 个新词。</p>
          )}
          <Link className="text-link" to={user ? '/learn' : '/auth'}>
            {plan.data?.plan.reservedNewCount ? '继续已安排学习组' : '开始这一组'}{' '}
            <ArrowRight size={15} />
          </Link>
        </Panel>
        <Panel className="metric">
          <span className="metric-icon sage">
            <RotateCcw size={20} />
          </span>
          <span>到期复习</span>
          <strong>
            {plan.data?.plan.dueCount ?? '—'}
            <small>词</small>
          </strong>
          <p>{user ? '按你的记忆安排' : '登录后读取真实记录'}</p>
        </Panel>
        <Panel className="metric">
          <span className="metric-icon blue">
            <GraduationCap size={20} />
          </span>
          <span>可再安排新词</span>
          <strong>
            {plan.data?.plan.newRemaining ?? '—'}
            <small>词</small>
          </strong>
          <p>
            {plan.data?.plan.reservedNewCount
              ? `另有 ${plan.data.plan.reservedNewCount} 词已安排待完成`
              : user
                ? '同词重复不计新学'
                : '从自己的计划开始'}
          </p>
        </Panel>
      </div>
      <div className="section-heading compact">
        <div>
          <span className="eyebrow">从语境开始</span>
          <h2>词书里的每一个词，都有来处。</h2>
        </div>
      </div>
      <p className="content-caption">
        {books.data?.items.every((book) => book.isDemo)
          ? '原创演示词书用于体验学习流程，并非完整考试词库。'
          : '词书按本站词库组织。释义与音标以各词条来源提供的内容为准。'}
      </p>
      <ErrorNotice error={books.error} onRetry={() => void books.refetch()} />
      {books.isPending ? (
        <Loading text="正在打开词书…" />
      ) : books.data?.items.length ? (
        <BookGrid
          books={books.data.items.slice(0, 4)}
          onSelect={(id) => void select(id)}
          busyId={busyId}
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
    </div>
  );
}
export function BooksPage() {
  const { user, scope } = useApp();
  const navigate = useNavigate();
  const client = useQueryClient();
  const books = useRemote<{ items: Book[] }>('books', 'books');
  const [goal, setGoal] = useState<Goal | 'all'>('all');
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState<unknown>(null);
  async function select(id: string) {
    if (!user) {
      navigate('/auth');
      return;
    }
    setBusyId(id);
    setError(null);
    try {
      await post(`books/${id}/select`, {});
      await client.invalidateQueries({ queryKey: [scope] });
      navigate('/learn');
    } catch (value) {
      setError(value);
    } finally {
      setBusyId('');
    }
  }
  return (
    <div className="page">
      <Heading
        eyebrow="词书 · 选择你的方向"
        title={
          <>
            让遇见的词，<em>有一条路径。</em>
          </>
        }
        description="词书决定新词来源。同一个词在本站不同词书间共享进度。"
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
        {books.data?.items.every((book) => book.isDemo)
          ? '原创演示词书用于体验学习流程，不代表完整考试词库或真实考试难度。'
          : '词书词数和覆盖进度来自本站记录。同词跨书共享学习进度，词条保留来源与许可。'}
      </p>
      <ErrorNotice error={error || books.error} />
      {books.isPending ? (
        <Loading />
      ) : (
        <BookGrid
          books={books.data?.items.filter((book) => goal === 'all' || book.goal === goal) ?? []}
          onSelect={(id) => void select(id)}
          busyId={busyId}
        />
      )}
      {books.data &&
        !books.data.items.filter((book) => goal === 'all' || book.goal === goal).length && (
          <Empty
            title="这个方向还没有已发布词书。"
            description="可以选择其他方向，或等待本站内容发布。"
          />
        )}
    </div>
  );
}
