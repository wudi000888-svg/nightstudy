import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BookOpen,
  Clock3,
  GraduationCap,
  Headphones,
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

export function ContentPage() {
  const { user } = useApp();
  const stats = useRemote<LearningStats>('stats', 'stats', !!user);
  const library = useRemote<{ page: PageInfo }>(
    'library',
    'library/words?view=learning&limit=1',
    !!user,
  );
  const sentences = useRemote<{ page: PageInfo }>('sentences', 'sentences?limit=1', !!user);
  const notes = useRemote<{ page: PageInfo }>('notes', 'notes?limit=1', !!user);
  const personal = [
    {
      to: '/library?view=learning',
      title: '正在学习',
      description: '继续积累中的词',
      icon: BookOpen,
      count: library.data?.page.total,
    },
    {
      to: '/library?view=recent',
      title: '最近学习',
      description: '近30天的真实练习',
      icon: Clock3,
    },
    {
      to: '/library?view=learned',
      title: '全部已学',
      description: '每个学过的词',
      icon: LibraryBig,
      count: stats.data?.totalLearned,
    },
    { to: '/wordbook', title: '生词本', description: '正在巩固与已巩固收藏', icon: Star },
    { to: '/known', title: '熟词本', description: '熟词来源与低频抽查', icon: CheckCircle2 },
    {
      to: '/sentences',
      title: '我的句库',
      description: '收藏的真实双语例句',
      icon: Quote,
      count: sentences.data?.page.total,
    },
    {
      to: '/notes',
      title: '学习笔记',
      description: '记下自己的理解',
      icon: NotebookPen,
      count: notes.data?.page.total,
    },
  ];
  return (
    <div className="page mobile-content-center">
      <header className="mobile-content-heading">
        <span className="mobile-kicker">MY LEARNING SPACE</span>
        <h1>内容</h1>
        <p>把遇见的词、句子和自己的理解，放在一起。</p>
      </header>
      {!user && (
        <div className="mobile-login-banner">
          <span>登录后拥有自己的词库、句库与笔记。</span>
          <Link to="/auth">
            登录 / 注册 <ArrowRight size={15} />
          </Link>
        </div>
      )}
      <h2 className="mobile-group-heading">我的积累</h2>
      <nav className="mobile-content-grid" aria-label="我的学习内容">
        {personal.map(({ to, title, description, icon: Icon, count }) => (
          <Link to={user ? to : '/auth'} key={to}>
            <span className="mobile-entry-icon">
              <Icon size={23} />
            </span>
            <span>
              <strong>
                {title}
                {count !== undefined && <small className="mobile-entry-count">{count}</small>}
              </strong>
              <small>{description}</small>
            </span>
            <ArrowRight size={16} />
          </Link>
        ))}
      </nav>
      <ErrorNotice
        error={stats.error || library.error || sentences.error || notes.error}
        onRetry={() => {
          void stats.refetch();
          void library.refetch();
          void sentences.refetch();
          void notes.refetch();
        }}
      />
      <h2 className="mobile-group-heading">换一种方式学习</h2>
      <nav className="mobile-content-grid" aria-label="学习工具">
        <Link to="/books">
          <span className="mobile-entry-icon">
            <BookOpen size={23} />
          </span>
          <span>
            <strong>词书</strong>
            <small>选择方向，再确认每天的计划</small>
          </span>
          <ArrowRight size={16} />
        </Link>
        <Link to="/books?kind=phrases">
          <span className="mobile-entry-icon">
            <Layers size={23} />
          </span>
          <span>
            <strong>词组本</strong>
            <small>把常用表达放进语境</small>
          </span>
          <ArrowRight size={16} />
        </Link>
        <Link to="/academy">
          <span className="mobile-entry-icon">
            <Headphones size={23} />
          </span>
          <span>
            <strong>英语学堂</strong>
            <small>听力、跟读、短文与专题练习</small>
          </span>
          <ArrowRight size={16} />
        </Link>
        <Link to={user ? '/assessment' : '/auth'}>
          <span className="mobile-entry-icon">
            <GraduationCap size={23} />
          </span>
          <span>
            <strong>词汇水平测试</strong>
            <small>用一组小测验了解起点</small>
          </span>
          <ArrowRight size={16} />
        </Link>
        <Link to="/lookup">
          <span className="mobile-entry-icon">
            <Search size={23} />
          </span>
          <span>
            <strong>查词与翻译</strong>
            <small>查释义、发音和具体用法</small>
          </span>
          <ArrowRight size={16} />
        </Link>
        <Link to={user ? '/books/import' : '/auth'}>
          <span className="mobile-entry-icon">
            <Upload size={23} />
          </span>
          <span>
            <strong>导入自己的词书</strong>
            <small>从日常读到的内容开始</small>
          </span>
          <ArrowRight size={16} />
        </Link>
      </nav>
    </div>
  );
}
