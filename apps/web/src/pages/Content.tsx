import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BookOpen,
  Clock3,
  GraduationCap,
  Headphones,
  LibraryBig,
  Mic,
  NotebookPen,
  Quote,
  Search,
  Star,
  CheckCircle2,
  Layers,
  Upload,
} from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import type { LearningStats, LessonSummary } from '../lib/mobile-content-types';
import type { Book, PageInfo, Settings } from '../lib/types';
import { ErrorNotice } from '../components/UI';
import './mobile-content.css';
import './h5-home.css';
import './learning-refinement.css';

export function ContentPage() {
  const { user } = useApp();
  const stats = useRemote<LearningStats>('stats', 'stats', !!user);
  const settings = useRemote<{ settings: Settings }>('settings', 'me/settings', !!user);
  const books = useRemote<{ items: Book[] }>('books', 'books', !!user);
  const catalog = useRemote<{ items: LessonSummary[] }>('academy', 'academy', !!user);
  const library = useRemote<{ page: PageInfo }>(
    'library',
    'library/words?view=learning&limit=1',
    !!user,
  );
  const wordbook = useRemote<{ page: PageInfo }>(
    'wordbook-summary',
    'wordbook?status=active&limit=1',
    !!user,
  );
  const sentences = useRemote<{ page: PageInfo }>('sentences', 'sentences?limit=1', !!user);
  const notes = useRemote<{ page: PageInfo }>('notes', 'notes?limit=1', !!user);
  const current = books.data?.items.find(
    (book) => book.id === settings.data?.settings.currentBookId,
  );
  const tools = [
    { to: '/assessment', title: '水平测试', icon: GraduationCap },
    ...(catalog.data?.items.some((lesson) => lesson.category === 'reading')
      ? [{ to: '/academy?tab=reading', title: '短文阅读', icon: BookOpen }]
      : []),
    ...(catalog.data?.items.some(
      (lesson) => lesson.category === 'listening' && lesson.audioAvailable,
    )
      ? [{ to: '/academy?tab=listening', title: '听力练习', icon: Headphones }]
      : []),
    ...(catalog.data?.items.some(
      (lesson) => lesson.category === 'shadowing' && lesson.audioAvailable,
    )
      ? [{ to: '/academy?tab=shadowing', title: '句子跟读', icon: Mic }]
      : []),
  ];
  const groups = [
    {
      title: '学习记录',
      items: [
        {
          to: '/library?view=learning',
          title: '正在学习的词',
          icon: BookOpen,
          count: library.data?.page.total,
        },
        { to: '/library?view=recent', title: '近日已学', icon: Clock3, count: undefined },
        {
          to: '/library?view=learned',
          title: '全部已学',
          icon: LibraryBig,
          count: stats.data?.totalLearned,
        },
      ],
    },
    {
      title: '我的积累',
      items: [
        { to: '/wordbook', title: '生词本', icon: Star, count: wordbook.data?.page.total },
        { to: '/known', title: '熟词本', icon: CheckCircle2, count: stats.data?.knownClaimCount },
        { to: '/sentences', title: '句库', icon: Quote, count: sentences.data?.page.total },
        { to: '/notes', title: '笔记', icon: NotebookPen, count: notes.data?.page.total },
      ],
    },
    {
      title: '词库与导入',
      items: [
        { to: '/books', title: '词书', icon: BookOpen, count: undefined },
        { to: '/books?kind=phrases', title: '词组本', icon: Layers, count: undefined },
        { to: '/books/mine', title: '我的自定义词书', icon: LibraryBig, count: undefined },
        { to: '/books/import', title: '导入词书', icon: Upload, count: undefined },
      ],
    },
  ];
  return (
    <div className="page h5-content mobile-content-center content-refined">
      <Link to="/lookup" className="h5-content-search">
        <Search size={19} />
        <span>查找单词、词组与翻译</span>
        <ArrowRight size={17} />
      </Link>
      {!user && (
        <div className="mobile-login-banner">
          <span>登录后查看自己的学习内容。</span>
          <Link to="/auth">
            登录 / 注册 <ArrowRight size={15} />
          </Link>
        </div>
      )}
      <section className="content-purpose-section" aria-labelledby="content-practice-title">
        <h2 id="content-practice-title">练习工具</h2>
        <nav className="content-practice-tools" aria-label="练习工具">
          {tools.map(({ to, title, icon: Icon }) => (
            <Link to={user ? to : '/auth'} key={to}>
              <Icon size={22} />
              <span>{title}</span>
            </Link>
          ))}
        </nav>
      </section>
      <section className="content-purpose-section" aria-labelledby="content-current-title">
        <h2 id="content-current-title">当前内容</h2>
        <Link
          className="content-current-book h5-surface"
          to={
            !user
              ? '/auth'
              : current
                ? `/library?bookId=${encodeURIComponent(current.id)}&view=all`
                : '/books'
          }
        >
          <span className="content-current-symbol">
            <BookOpen size={24} />
          </span>
          <span>
            <strong>
              {current?.title ??
                (settings.isPending || books.isPending ? '正在读取当前词书…' : '选择一本词书')}
            </strong>
            <small>
              {current
                ? `已学 ${current.learnedCount.toLocaleString('zh-CN')} / ${current.wordCount.toLocaleString('zh-CN')} ${current.kind === 'phrases' ? '条词组' : '词'}`
                : '从一本适合自己的词书开始。'}
            </small>
          </span>
          <ArrowRight size={17} />
        </Link>
      </section>
      {groups.map(({ title, items }) => (
        <section className="content-purpose-section" key={title}>
          <h2>{title}</h2>
          <nav className="h5-list-group" aria-label={title}>
            {items.map(({ to, title: label, icon: Icon, count }) => (
              <Link
                className="h5-list-row"
                to={user || to === '/books' || to === '/books?kind=phrases' ? to : '/auth'}
                key={to}
              >
                <Icon size={21} />
                <span>{label}</span>
                {user && count !== undefined && <small>{count.toLocaleString('zh-CN')}</small>}
                <ArrowRight size={16} />
              </Link>
            ))}
          </nav>
        </section>
      ))}
      <ErrorNotice
        error={
          stats.error ||
          settings.error ||
          books.error ||
          catalog.error ||
          library.error ||
          wordbook.error ||
          sentences.error ||
          notes.error
        }
        onRetry={() => {
          void stats.refetch();
          void settings.refetch();
          void books.refetch();
          void catalog.refetch();
          void library.refetch();
          void wordbook.refetch();
          void sentences.refetch();
          void notes.refetch();
        }}
      />
    </div>
  );
}
