import { ArrowLeft, ChevronDown, CloudUpload, Languages, Search, X } from 'lucide-react';
import { Link, useLocation, type Location } from 'react-router-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityTimer } from './ActivityTimer';
import { useApp } from '../AppContext';
import { useLearningPreferences } from '../LearningPreferences';
import { isStudyPath, navigationGroup, navigationTitle } from '../lib/navigation';
import { useAppNavigation } from './AppNavigation';
import './h5-shell.css';

export function H5ScreenHeader({ location }: { location: Location }) {
  const navigation = useAppNavigation();
  const isAdmin = navigationGroup(location.pathname) === 'admin';
  const isAuth = location.pathname.startsWith('/auth') || location.pathname === '/setup';
  return (
    <header className="h5-cover-header">
      <button
        className="h5-close-screen icon-button"
        onClick={navigation.closeModule}
        aria-label="关闭当前模块，回到首页"
        title="关闭当前模块，回到首页"
      >
        <ChevronDown size={24} aria-hidden="true" />
      </button>
      <div className="h5-cover-heading">
        {navigation.canGoBack && (
          <button
            className="icon-button h5-inner-back"
            onClick={navigation.goBack}
            aria-label="返回模块上一页"
            title="返回模块上一页"
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
        )}
        <h1>{navigationTitle(location.pathname)}</h1>
      </div>
      {!isAdmin && !isAuth && location.pathname !== '/lookup' ? (
        <Link className="icon-button" to="/lookup" aria-label="查词" title="查词">
          <Search size={21} aria-hidden="true" />
        </Link>
      ) : location.pathname === '/lookup' ? (
        <Link className="icon-button" to="/translate" aria-label="网页翻译" title="网页翻译">
          <Languages size={21} aria-hidden="true" />
        </Link>
      ) : (
        <span className="h5-header-spacer" />
      )}
    </header>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { site, user, scope, pending, conflicts, sync, syncNote } = useApp();
  const appearance = useLearningPreferences();
  const location = useLocation();
  const navigation = useAppNavigation();
  const area = navigationGroup(location.pathname);
  const home = location.pathname === '/';
  const focus = isStudyPath(location.pathname);
  const isAdmin = area === 'admin';
  const isAuth = location.pathname.startsWith('/auth') || location.pathname === '/setup';
  const [showSyncNote, setShowSyncNote] = useState(false);
  const [reminder, setReminder] = useState(false);
  const reminderStamp = useRef('');
  const root = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLDivElement>(null);
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
        `${status.current?.getBoundingClientRect().height ?? 0}px`,
      );
    update();
    if (!status.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(status.current);
    return () => observer.disconnect();
  }, [focus, pending, showSyncNote, syncNote, reminder]);
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
  useEffect(() => {
    if (home || focus) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      navigation.goBack();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [location.key]);
  return (
    <div
      ref={root}
      className={`night-app app-shell h5-app ${focus ? 'app-shell-focus h5-study-shell' : ''} ${home ? 'h5-home-shell' : 'h5-cover-shell'} ${isAdmin ? 'app-shell-admin' : ''} ${isAuth ? 'app-shell-auth' : ''}`}
      data-section={area}
      data-active-screen={location.pathname}
    >
      <a className="skip-link" href="#main-content">
        跳到正文
      </a>
      <ActivityTimer />
      <main id="main-content" className="main-content h5-main-content">
        <div ref={status} className="shell-status-region h5-status-region">
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
          {reminder && !focus && (
            <div className="learning-reminder" role="status">
              <span>到学习时间了，读几个词再休息。</span>
              <Link to="/learn?start=1">开始学习</Link>
              <button
                className="icon-button"
                aria-label="关闭本次提醒"
                onClick={() => setReminder(false)}
              >
                <X size={17} />
              </button>
            </div>
          )}
        </div>
        {children}
      </main>
    </div>
  );
}
