import {
  ArrowLeft,
  BookOpen,
  CloudUpload,
  Layers,
  MoonStar,
  Search,
  ShieldCheck,
  Sun,
  UserRound,
  X,
} from 'lucide-react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { ActivityTimer } from './ActivityTimer';
import { useApp } from '../AppContext';
import { useLearningPreferences } from '../LearningPreferences';
import { isStudyPath, navigationGroup, navigationTitle } from '../lib/navigation';

export function Shell() {
  const { site, user, scope, pending, conflicts, sync, syncNote } = useApp();
  const appearance = useLearningPreferences();
  const location = useLocation();
  const navigate = useNavigate();
  const area = navigationGroup(location.pathname);
  const [sessionFocus, setSessionFocus] = useState(false);
  const [showSyncNote, setShowSyncNote] = useState(false);
  const [themeNote, setThemeNote] = useState('');
  const [reminder, setReminder] = useState(false);
  const reminderStamp = useRef('');
  const root = useRef<HTMLDivElement>(null);
  const focusStatus = useRef<HTMLDivElement>(null);
  const focus =
    isStudyPath(location.pathname) &&
    (sessionFocus || !!new URLSearchParams(location.search).get('session'));
  const isAdmin = area === 'admin';
  const isAuth = location.pathname.startsWith('/auth') || location.pathname === '/setup';
  const landing = ['/', '/content', '/me'].includes(location.pathname);
  useEffect(() => {
    window.scrollTo(0, 0);
    if (!isStudyPath(location.pathname)) setSessionFocus(false);
  }, [location.pathname]);
  useEffect(() => {
    const change = (event: Event) =>
      setSessionFocus((event as CustomEvent<{ active: boolean }>).detail?.active === true);
    window.addEventListener('nightstudy-study-focus', change);
    return () => window.removeEventListener('nightstudy-study-focus', change);
  }, []);
  useEffect(() => {
    setShowSyncNote(!!syncNote);
    if (!syncNote || pending || conflicts.length) return;
    const timer = window.setTimeout(() => setShowSyncNote(false), 6500);
    return () => window.clearTimeout(timer);
  }, [syncNote, pending, conflicts.length]);
  useEffect(() => {
    const update = () =>
      root.current?.style.setProperty(
        '--study-shell-offset',
        `${focusStatus.current?.getBoundingClientRect().height ?? 0}px`,
      );
    update();
    if (!focusStatus.current) return;
    const observer = new ResizeObserver(update);
    observer.observe(focusStatus.current);
    return () => observer.disconnect();
  }, [focus, pending, showSyncNote, syncNote]);
  useEffect(() => {
    if (!focus) return;
    const viewport = window.visualViewport;
    const update = () =>
      root.current?.style.setProperty(
        '--study-app-height',
        `${viewport?.height ?? window.innerHeight}px`,
      );
    update();
    viewport?.addEventListener('resize', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
      root.current?.style.removeProperty('--study-app-height');
    };
  }, [focus]);
  useEffect(() => {
    setReminder(false);
    reminderStamp.current = '';
  }, [scope]);
  useEffect(() => {
    if (!user || !appearance.preferences.reminderEnabled) return;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const stamp = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}:${time}`;
      if (time === appearance.preferences.reminderTime && reminderStamp.current !== stamp) {
        reminderStamp.current = stamp;
        setReminder(true);
      }
    };
    check();
    const timer = window.setInterval(check, 30000);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [scope, !!user, appearance.preferences.reminderEnabled, appearance.preferences.reminderTime]);
  const links = [
    { to: '/', group: 'learning', label: '学习', Icon: BookOpen },
    { to: '/content', group: 'content', label: '内容', Icon: Layers },
    { to: user ? '/me' : '/auth', group: 'account', label: '我的', Icon: UserRound },
  ];
  const navItems = () =>
    links.map(({ to, group, label, Icon }) => (
      <Link key={group} to={to} aria-current={area === group ? 'page' : undefined}>
        <Icon size={19} aria-hidden="true" />
        <span>{label}</span>
      </Link>
    ));
  function back() {
    if (Number(window.history.state?.idx ?? 0) > 0) navigate(-1);
    else navigate(isAdmin || area === 'account' ? '/me' : '/content');
  }
  async function toggleTheme() {
    const ok = await appearance.savePreferences({
      theme: document.documentElement.dataset.theme === 'night' ? 'day' : 'night',
    });
    setThemeNote(ok ? '' : '外观未保存，请在学习偏好中重试。');
  }
  return (
    <div
      ref={root}
      className={`night-app app-shell ${focus ? 'app-shell-focus' : ''} ${isAdmin ? 'app-shell-admin' : ''} ${isAuth ? 'app-shell-auth' : ''}`}
      data-section={area}
    >
      <a className="skip-link" href="#main-content">
        跳到正文
      </a>
      <ActivityTimer />
      {!focus && (
        <header className="desktop-header">
          <Link className="compact-brand" to="/">
            <MoonStar size={23} aria-hidden="true" />
            <span>{site.title || '夜读英语'}</span>
          </Link>
          {isAdmin ? (
            <Link className="desktop-return" to="/me">
              <ArrowLeft size={17} />
              返回学习
            </Link>
          ) : (
            <nav aria-label="主要导航">{navItems()}</nav>
          )}
          <div className="desktop-tools">
            {!isAdmin && (
              <Link className="icon-button" to="/lookup" aria-label="查词">
                <Search size={19} />
              </Link>
            )}
            <button
              className="icon-button appearance-toggle"
              onClick={() => void toggleTheme()}
              disabled={appearance.saving || (!!user && !appearance.loaded)}
              aria-label="切换浅色与夜读主题"
            >
              <Sun className="day-theme-icon" size={19} />
              <MoonStar className="night-theme-icon" size={19} />
            </button>
            {user?.role === 'admin' && !isAdmin && (
              <Link className="icon-button" to="/admin" aria-label="管理自习室">
                <ShieldCheck size={19} />
              </Link>
            )}
          </div>
        </header>
      )}
      {!focus && !landing && (
        <header className="mobile-page-header">
          <button className="icon-button" onClick={back} aria-label="返回上一页">
            <ArrowLeft size={21} />
          </button>
          <span>{navigationTitle(location.pathname)}</span>
          {isAdmin ? (
            <Link className="icon-button" to="/me" aria-label="返回我的">
              <UserRound size={20} />
            </Link>
          ) : (
            <Link className="icon-button" to="/lookup" aria-label="查词">
              <Search size={20} />
            </Link>
          )}
        </header>
      )}
      <main id="main-content" className="main-content">
        <div ref={focusStatus} className="shell-status-region">
          {!site.initialized && (
            <div className="setup-strip">
              自习室还没有管理员。<Link to="/setup">完成首次初始化</Link>
            </div>
          )}
          {pending > 0 && (
            <div className="sync-strip" role="status">
              <CloudUpload size={16} />
              {pending} 条操作待同步<button onClick={() => void sync()}>重试</button>
            </div>
          )}
          {showSyncNote && syncNote && (
            <p className="sync-note" role="status">
              {syncNote}
            </p>
          )}
        </div>
        {themeNote && (
          <p className="notice" role="status">
            {themeNote}
            <Link to="/me?section=preferences">学习偏好</Link>
          </p>
        )}
        {reminder && !focus && (
          <div className="learning-reminder" role="status">
            <span>到学习时间了，读几个词再休息。</span>
            <Link to="/learn">开始学习</Link>
            <button
              className="icon-button"
              aria-label="关闭本次提醒"
              onClick={() => setReminder(false)}
            >
              <X size={17} />
            </button>
          </div>
        )}
        <Outlet />
      </main>
      {!focus && !isAdmin && !isAuth && (
        <nav className="mobile-primary-nav" aria-label="移动导航">
          {navItems()}
        </nav>
      )}
    </div>
  );
}
