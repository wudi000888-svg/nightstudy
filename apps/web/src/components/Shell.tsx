import {
  BookOpen,
  ChartNoAxesCombined,
  House,
  MoonStar,
  Search,
  UserRound,
  ShieldCheck,
  CloudUpload,
  Menu,
  X,
  GraduationCap,
  CheckCheck,
  Languages,
} from 'lucide-react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ActivityTimer } from './ActivityTimer';
import { useApp } from '../AppContext';

const links = [
  { path: '/', label: '自习室', icon: House },
  { path: '/books', label: '词书', icon: BookOpen },
  { path: '/learn', label: '今日任务', icon: GraduationCap },
  { path: '/lookup', label: '查词与生词本', icon: Search },
  { path: '/translate', label: '网页翻译', icon: Languages },
  { path: '/known', label: '熟词管理', icon: CheckCheck },
  { path: '/memory', label: '个人记忆', icon: ChartNoAxesCombined },
];
export function Shell() {
  const { site, user, pending, sync, syncNote } = useApp();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
    setMobileOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mobileOpen]);
  return (
    <div className="night-app">
      <ActivityTimer />
      <div className="ambient-orb" aria-hidden="true" />
      <aside id="room-sidebar" className={`sidebar ${mobileOpen ? 'open' : ''}`}>
        <Link className="brand" to="/" onClick={() => setMobileOpen(false)}>
          <span className="brand-icon">
            <MoonStar size={20} />
          </span>
          <span>
            {site.title || '夜读英语'}
            <small>一间安静的自习室</small>
          </span>
        </Link>
        <div className="room-status">
          <i /> 雨夜，自习中<span>{user ? '你的积累已连接本站' : '今晚，从一个词开始'}</span>
        </div>
        <nav className="side-nav" aria-label="主要导航">
          {links.map(({ path, label, icon: Icon }) => (
            <NavLink key={path} end={path === '/'} to={path} onClick={() => setMobileOpen(false)}>
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          {user?.role === 'admin' && (
            <NavLink to="/admin" onClick={() => setMobileOpen(false)}>
              <ShieldCheck size={17} /> 管理自习室
            </NavLink>
          )}
          <NavLink to={user ? '/me' : '/auth'} onClick={() => setMobileOpen(false)}>
            <span className="avatar">{user?.name?.slice(0, 1) || <UserRound size={17} />}</span>
            <span>
              {user?.name || '连接学习账户'}
              <small>{user ? '账户与学习设置' : '登录后，让记录跟着你'}</small>
            </span>
          </NavLink>
          <p>少一点赶路，多一点记住。</p>
        </div>
      </aside>
      <header className="mobile-top">
        <Link className="brand" to="/" onClick={() => setMobileOpen(false)}>
          <span className="brand-icon">
            <MoonStar size={18} />
          </span>
          {site.title}
        </Link>
        <button
          className="icon-button"
          aria-label={mobileOpen ? '关闭导航' : '打开导航'}
          aria-expanded={mobileOpen}
          aria-controls="room-sidebar"
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          {mobileOpen ? <X /> : <Menu />}
        </button>
      </header>
      {mobileOpen && (
        <button
          className="nav-backdrop"
          aria-label="关闭导航"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <main className="main-content">
        {!site.initialized && (
          <div className="setup-strip">
            自习室还没有管理员。<Link to="/setup">完成首次初始化 →</Link>
          </div>
        )}
        {pending > 0 && (
          <div className="sync-strip" role="status">
            <CloudUpload size={16} /> {pending} 条操作等待同步
            <button onClick={() => void sync()}>重试同步</button>
          </div>
        )}
        {syncNote && (
          <p className="sync-note" role="status">
            {syncNote}
          </p>
        )}
        <Outlet />
        <footer className="page-footer">
          <span>{site.title} · 开源自习室</span>
          <span>{site.version} · 本站独立学习空间</span>
        </footer>
      </main>
      <nav className="mobile-tabs" aria-label="移动导航">
        {[
          { path: '/', label: '自习室', icon: House },
          { path: '/learn', label: '任务', icon: GraduationCap },
          { path: '/books', label: '词书', icon: BookOpen },
          { path: '/lookup', label: '查词', icon: Search },
          { path: user ? '/me' : '/auth', label: '我的', icon: UserRound },
        ].map(({ path, label, icon: Icon }) => (
          <NavLink key={path} end={path === '/'} to={path}>
            <Icon size={18} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
