import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BookOpen,
  Clock3,
  GraduationCap,
  LibraryBig,
  NotebookPen,
  Quote,
  Search,
  Star,
  CheckCircle2,
  Layers,
  Upload,
} from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import type { LearningStats } from '../lib/mobile-content-types';
import type { PageInfo } from '../lib/types';
import { ErrorNotice } from '../components/UI';
import './mobile-content.css';
import './h5-home.css';

export function ContentPage() {
  const { user } = useApp();
  const stats = useRemote<LearningStats>('stats', 'stats', !!user);
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
  const groups = [
    [
      {
        to: '/library?view=learning',
        title: '正在学习',
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
    [
      { to: '/wordbook', title: '生词本', icon: Star, count: wordbook.data?.page.total },
      { to: '/known', title: '熟词本', icon: CheckCircle2, count: stats.data?.knownClaimCount },
      { to: '/sentences', title: '句库', icon: Quote, count: sentences.data?.page.total },
      { to: '/notes', title: '笔记', icon: NotebookPen, count: notes.data?.page.total },
    ],
  ];
  return (
    <div className="page h5-content mobile-content-center">
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
      {groups.map((items, index) => (
        <nav
          className="h5-list-group"
          aria-label={index === 0 ? '已学词汇' : '我的积累'}
          key={index}
        >
          {items.map(({ to, title, icon: Icon, count }) => (
            <Link className="h5-list-row" to={user ? to : '/auth'} key={to}>
              <Icon size={21} />
              <span>{title}</span>
              {user && count !== undefined && <small>{count.toLocaleString('zh-CN')}</small>}
              <ArrowRight size={16} />
            </Link>
          ))}
        </nav>
      ))}
      <ErrorNotice
        error={stats.error || library.error || wordbook.error || sentences.error || notes.error}
        onRetry={() => {
          void stats.refetch();
          void library.refetch();
          void wordbook.refetch();
          void sentences.refetch();
          void notes.refetch();
        }}
      />
      <nav className="h5-list-group" aria-label="更多学习内容">
        <Link className="h5-list-row" to="/books">
          <BookOpen size={21} />
          <span>词书</span>
          <ArrowRight size={16} />
        </Link>
        <Link className="h5-list-row" to="/books?kind=phrases">
          <Layers size={21} />
          <span>词组本</span>
          <ArrowRight size={16} />
        </Link>
        <Link className="h5-list-row" to={user ? '/books/mine' : '/auth'}>
          <LibraryBig size={21} />
          <span>我的自定义词书</span>
          <ArrowRight size={16} />
        </Link>
        <Link className="h5-list-row" to={user ? '/books/import' : '/auth'}>
          <Upload size={21} />
          <span>导入词书</span>
          <ArrowRight size={16} />
        </Link>
        <Link className="h5-list-row" to={user ? '/assessment' : '/auth'}>
          <GraduationCap size={21} />
          <span>词汇水平测试</span>
          <ArrowRight size={16} />
        </Link>
      </nav>
    </div>
  );
}
