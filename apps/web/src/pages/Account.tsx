import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, LogOut, ShieldCheck, UserRound, LockKeyhole, Settings2 } from 'lucide-react';
import { useApp } from '../AppContext';
import { auth, post, setup } from '../lib/api';
import { Empty, ErrorNotice, Heading, LoginPrompt, Notice, Panel } from '../components/UI';
import './mobile-content.css';
import './h5-home.css';

export function authReturnPath(next: string | null) {
  if (!next?.startsWith('/') || next.startsWith('//')) return '/';
  try {
    const target = new URL(next, 'https://nightstudy.invalid');
    if (
      target.origin !== 'https://nightstudy.invalid' ||
      !/^\/(?:learn|review|learning|books(?:\/(?:mine|import))?)$/.test(target.pathname)
    )
      return '/';
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return '/';
  }
}

export function AuthPage() {
  const { site, user, refresh } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit() {
    setError(null);
    if (mode === 'register' && password !== confirm) {
      setError(new Error('两次输入的密码不一致。'));
      return;
    }
    setBusy(true);
    try {
      const identifier = email.trim();
      if (mode === 'register') {
        await auth('sign-up/email', { name, email: identifier, password });
      } else if (identifier.includes('@')) {
        await auth('sign-in/email', { email: identifier, password });
      } else {
        await auth('sign-in/username', { username: identifier, password });
      }
      await refresh();
      setPassword('');
      setConfirm('');
      navigate(authReturnPath(params.get('next')), { replace: true });
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page h5-auth">
      <div className="h5-auth-layout">
        <Panel className="account-card">
          {user ? (
            <>
              <span className="soft-badge">已连接本站</span>
              <h2>{user.name}</h2>
              <p>{user.email}</p>
              <Link className="button primary" to="/me">
                个人中心 <ArrowRight size={16} />
              </Link>
            </>
          ) : (
            <>
              <div className="tab-row">
                <button
                  className={mode === 'login' ? 'active' : ''}
                  onClick={() => setMode('login')}
                >
                  登录
                </button>
                {site.registrationOpen && (
                  <button
                    className={mode === 'register' ? 'active' : ''}
                    onClick={() => setMode('register')}
                  >
                    注册
                  </button>
                )}
              </div>
              <h2>{mode === 'login' ? '欢迎回到自习室。' : '创建你的学习账户。'}</h2>
              <form
                className="form-stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                {mode === 'register' && (
                  <label className="field">
                    怎么称呼你
                    <input
                      required
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      autoComplete="name"
                      maxLength={80}
                    />
                  </label>
                )}
                <label className="field">
                  {mode === 'login' ? '邮箱或管理员账号' : '邮箱'}
                  <input
                    required
                    type={mode === 'login' ? 'text' : 'email'}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete={mode === 'login' ? 'username' : 'email'}
                    placeholder={mode === 'login' ? '邮箱地址，或管理员账号 admin' : '你的邮箱地址'}
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  密码
                  <input
                    required
                    type="password"
                    minLength={8}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  />
                </label>
                {mode === 'register' && (
                  <label className="field">
                    确认密码
                    <input
                      required
                      type="password"
                      value={confirm}
                      onChange={(event) => setConfirm(event.target.value)}
                      autoComplete="new-password"
                    />
                  </label>
                )}
                <ErrorNotice error={error} />
                <button type="submit" className="button primary full" disabled={busy}>
                  {busy ? '正在连接…' : mode === 'login' ? '登录，继续学习' : '创建账户'}
                  <ArrowRight size={16} />
                </button>
              </form>
              {!site.registrationOpen && (
                <p className="fine-print">本站暂未开放注册，请联系本站管理员。</p>
              )}
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
export function ProfilePage() {
  const { user, refresh, site, pending, sync, syncNote, scope } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const section = params.get('section');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [name, setName] = useState(user?.name ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const lifetime = useRef(0),
    saving = useRef(false);
  useEffect(() => {
    lifetime.current++;
    saving.current = false;
    setBusy(false);
    setName(user?.name ?? '');
    setCurrentPassword('');
    setNewPassword('');
    setError(null);
    setNotice('');
    return () => {
      lifetime.current++;
    };
  }, [scope]);
  async function perform(action: () => Promise<void>, message = '') {
    if (saving.current) return;
    const life = lifetime.current;
    saving.current = true;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await action();
      if (life === lifetime.current) setNotice(message);
    } catch (value) {
      if (life === lifetime.current) setError(value);
    } finally {
      if (life === lifetime.current) {
        saving.current = false;
        setBusy(false);
      }
    }
  }
  async function changeName() {
    await perform(async () => {
      await post('me/profile', { name }, 'PATCH');
      await refresh();
    }, '称呼已更新。');
  }
  async function changePassword() {
    const life = lifetime.current;
    await perform(async () => {
      await auth('change-password', { currentPassword, newPassword, revokeOtherSessions: true });
      if (life === lifetime.current) {
        setCurrentPassword('');
        setNewPassword('');
      }
    }, '密码已更新，其他设备已退出登录。');
  }
  async function signOut() {
    await perform(async () => {
      await auth('sign-out', {});
      await refresh();
      navigate('/');
    });
  }
  if (!user)
    return (
      <div className="page">
        <LoginPrompt />
      </div>
    );
  const editing = section === 'profile' || section === 'security';
  return (
    <div className="page mobile-account h5-account">
      {editing ? (
        <>
          <Link className="mobile-back" to="/me">
            ← 返回个人中心
          </Link>
          <h2 className="h5-account-section-title">
            {section === 'profile' ? '个人资料' : '账户安全'}
          </h2>
          <ErrorNotice error={error} />
          {notice && <Notice>{notice}</Notice>}
          <Panel className="mobile-account-form">
            {section === 'profile' ? (
              <form
                className="form-stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  void changeName();
                }}
              >
                <label className="field">
                  邮箱
                  <input value={user.email} readOnly />
                </label>
                <label className="field">
                  怎么称呼你
                  <input
                    required
                    maxLength={80}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <button className="button primary" disabled={busy}>
                  保存称呼
                </button>
              </form>
            ) : (
              <form
                className="form-stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  void changePassword();
                }}
              >
                <label className="field">
                  当前密码
                  <input
                    type="password"
                    required
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                  />
                </label>
                <label className="field">
                  新密码
                  <input
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                </label>
                <p className="h5-caption">修改后保留本设备登录，其他设备将退出登录。</p>
                <button className="button primary" disabled={busy}>
                  修改密码
                </button>
              </form>
            )}
          </Panel>
        </>
      ) : (
        <>
          <header className="h5-profile">
            <span className="h5-profile-avatar" aria-hidden="true">
              {Array.from(user.name)[0] || '☾'}
            </span>
            <h1>{user.name}</h1>
            <p>{site.title}</p>
          </header>
          <ErrorNotice error={error} />
          <nav className="h5-list-group" aria-label="个人中心">
            <Link className="h5-list-row" to="/learning">
              <Settings2 size={21} />
              <span>我的学习与偏好</span>
              <ArrowRight size={17} />
            </Link>
            <Link className="h5-list-row" to="/memory">
              <ShieldCheck size={21} />
              <span>记忆曲线</span>
              <ArrowRight size={17} />
            </Link>
            <Link className="h5-list-row" to="/me?section=profile">
              <UserRound size={21} />
              <span>个人资料</span>
              <ArrowRight size={17} />
            </Link>
            <Link className="h5-list-row" to="/me?section=security">
              <LockKeyhole size={21} />
              <span>账户安全</span>
              <ArrowRight size={17} />
            </Link>
            {user.role === 'admin' && (
              <Link className="h5-list-row" to="/admin">
                <ShieldCheck size={21} />
                <span>本站管理</span>
                <ArrowRight size={17} />
              </Link>
            )}
          </nav>
          <section className="h5-sync-status">
            <p>{pending ? `${pending} 条记录等待同步` : '学习记录已连接'}</p>
            <button type="button" className="text-link" onClick={() => void sync()}>
              检查同步
            </button>
            {syncNote && <p role="status">{syncNote}</p>}
          </section>
          <button className="button quiet full" disabled={busy} onClick={() => void signOut()}>
            <LogOut size={17} />
            退出账户
          </button>
        </>
      )}
    </div>
  );
}
export function SetupPage() {
  const { site, refresh } = useApp();
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await setup({ token, email, password, name });
      setToken('');
      setPassword('');
      setDone(true);
      await refresh();
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page setup-page">
      <Heading
        eyebrow="首次打开 · 一次初始化"
        title="点亮这间自习室。"
        description="用部署时的初始化凭据创建本站第一个管理员。已完成的站点不会再次开放初始化。"
      />
      {site.initialized || done ? (
        <Empty
          title="本站已经完成初始化。"
          description="请使用本站管理员或已创建的学习账户登录。自动安装的管理员凭据保存在部署服务器，不会显示在网页中。"
          action={
            <Link className="button primary" to="/auth">
              去登录 <ArrowRight size={16} />
            </Link>
          }
        />
      ) : (
        <Panel className="account-card setup-card">
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="field">
              一次性初始化凭据
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                required
                autoComplete="off"
              />
            </label>
            <label className="field">
              管理员称呼
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                autoComplete="name"
              />
            </label>
            <label className="field">
              管理员邮箱
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="email"
              />
            </label>
            <label className="field">
              登录密码
              <input
                type="password"
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete="new-password"
              />
            </label>
            <ErrorNotice error={error} />
            <button className="button primary" disabled={busy}>
              {busy ? '正在初始化…' : '创建管理员，打开自习室'}
            </button>
          </form>
        </Panel>
      )}
    </div>
  );
}
