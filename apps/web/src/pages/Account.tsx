import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  LogOut,
  ShieldCheck,
  UserRound,
  LockKeyhole,
  Settings2,
} from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { auth, post, setup } from '../lib/api';
import { goalLabels, goalNames, type Settings } from '../lib/types';
import { Empty, ErrorNotice, Heading, Loading, LoginPrompt, Notice, Panel } from '../components/UI';
import type { TaskPlanResponse } from '../components/tasks/types';
import type { LearningStats } from '../lib/mobile-content-types';
import { PreferencesSettings } from './PreferencesSettings';
import { useLearningPreferences } from '../LearningPreferences';
import './mobile-content.css';

export function AuthPage() {
  const { site, user, refresh } = useApp();
  const navigate = useNavigate();
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
      navigate('/');
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page">
      <Heading
        eyebrow="账户 · 让记录跟着你"
        title={
          <>
            把今晚的积累，<em>留到明天。</em>
          </>
        }
      />
      <div className="account-layout">
        <div className="account-story">
          <span className="story-mark">☾</span>
          <h2>
            让记住的每一点，
            <br />
            都属于你。
          </h2>
          <p>词书、计划、学习组与复习进度保存在本站账户。换一台设备，也可以继续。</p>
          <ul>
            <li>
              <Check size={17} /> 一个词，一份自己的记忆进度
            </li>
            <li>
              <Check size={17} /> 学过的词和熟悉的词，慢慢积累
            </li>
            <li>
              <Check size={17} /> 本站独立的账户与学习空间
            </li>
          </ul>
        </div>
        <Panel className="account-card">
          {user ? (
            <>
              <span className="soft-badge">已连接本站</span>
              <h2>{user.name}</h2>
              <p>{user.email}</p>
              <Link className="button primary" to="/me">
                我的学习设置 <ArrowRight size={16} />
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
  const { preferences } = useLearningPreferences();
  const client = useQueryClient();
  const plan = useRemote<TaskPlanResponse>('plan', 'study/plan', !!user);
  const stats = useRemote<LearningStats>('stats', 'stats', !!user);
  const settings = useRemote<{ settings: Settings }>('settings', 'me/settings', !!user);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const section = params.get('section');
  const [draft, setDraft] = useState<Settings | null>(null);
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
    setDraft(null);
    setName(user?.name ?? '');
    setCurrentPassword('');
    setNewPassword('');
    setError(null);
    setNotice('');
    return () => {
      lifetime.current++;
    };
  }, [scope]);
  useEffect(() => {
    if (settings.data) setDraft(settings.data.settings);
  }, [settings.data]);
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
  async function saveSettings() {
    if (!draft) return;
    await perform(async () => {
      await post(
        'me/settings',
        {
          goal: draft.goal,
          dailyTotalGoal: draft.dailyTotalGoal,
          groupSize: draft.groupSize,
          timeZone: draft.pendingTimeZone ?? draft.timeZone,
          expectedRevision: draft.revision,
        },
        'PATCH',
      );
      await client.invalidateQueries({ queryKey: [scope] });
    }, '计划已保存，已安排的学习组可以继续。');
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
    }, '密码已更新，其他设备的会话已撤销。');
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
  const titles: Record<string, string> = {
    profile: '个人资料',
    plan: '学习计划',
    preferences: '学习偏好',
    security: '账户安全',
  };
  const title = section ? titles[section] : null;
  return (
    <div className="page mobile-account">
      {title ? (
        <>
          <Link className="mobile-back" to="/me">
            ← 返回个人中心
          </Link>
          <Heading eyebrow="我的自习室" title={title} />
          <ErrorNotice error={error || (section === 'plan' ? settings.error : null)} />
          {notice && <Notice>{notice}</Notice>}
          <Panel className="mobile-account-form">
            {section === 'profile' && (
              <form
                className="form-stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  void changeName();
                }}
              >
                <label className="field">
                  本站邮箱
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
                <p className="mobile-caption">显示名不会改变登录邮箱。</p>
                <button className="button primary" disabled={busy}>
                  保存称呼
                </button>
              </form>
            )}
            {section === 'plan' &&
              (settings.isPending ? (
                <Loading />
              ) : (
                draft && (
                  <form
                    className="form-stack"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveSettings();
                    }}
                  >
                    <label className="field">
                      学习方向
                      <select
                        value={draft.goal}
                        onChange={(event) =>
                          setDraft({ ...draft, goal: event.target.value as Settings['goal'] })
                        }
                      >
                        {goalNames.map((goal) => (
                          <option key={goal} value={goal}>
                            {goalLabels[goal]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      每日总词数（复习 + 新学）
                      <input
                        type="number"
                        required
                        min={1}
                        max={100}
                        value={draft.dailyTotalGoal}
                        onChange={(event) =>
                          setDraft({ ...draft, dailyTotalGoal: Number(event.target.value) })
                        }
                      />
                    </label>
                    <label className="field">
                      每组词数
                      <input
                        type="number"
                        required
                        min={1}
                        max={20}
                        value={draft.groupSize}
                        onChange={(event) =>
                          setDraft({ ...draft, groupSize: Number(event.target.value) })
                        }
                      />
                    </label>
                    <div className="mobile-plan-note">
                      <strong>{plan.data?.plan.bookTitle ?? '尚未选择词书'}</strong>
                      <p>
                        先复习，再学新词。同词当天只计一次；换书或降低目标不撤回已安排的学习组。
                      </p>
                      <Link to="/books">选书并预览计划 →</Link>
                    </div>
                    {draft.pendingTimeZone && (
                      <Notice>
                        {draft.pendingTimeZone} 将在下个学习日生效；今日按 {draft.timeZone} 统计。
                      </Notice>
                    )}
                    <label className="field">
                      统计时区
                      <input
                        required
                        value={draft.pendingTimeZone ?? draft.timeZone}
                        placeholder="Asia/Shanghai"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            pendingTimeZone: null,
                            timeZone: event.target.value,
                          })
                        }
                      />
                    </label>
                    <p className="mobile-caption">
                      学习日从当地凌晨4点开始。时区调整在下个学习日生效。
                    </p>
                    <button className="button primary" disabled={busy}>
                      保存计划
                    </button>
                  </form>
                )
              ))}
            {section === 'preferences' && <PreferencesSettings />}
            {section === 'security' && (
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
                <p className="mobile-caption">修改后保留本设备登录，撤销其他设备的会话。</p>
                <button className="button primary" disabled={busy}>
                  修改密码
                </button>
              </form>
            )}
          </Panel>
        </>
      ) : (
        <>
          <header className="mobile-profile-head">
            <span className="mobile-avatar" aria-hidden="true">
              {user.name.slice(0, 1) || '☾'}
            </span>
            <div>
              <span className="tiny-label">我的自习室</span>
              <h1>{user.name}</h1>
              <p>{site.title}</p>
            </div>
            <Link to="/me?section=profile" aria-label="编辑个人资料">
              <ArrowRight size={20} />
            </Link>
          </header>
          <ErrorNotice error={error} />
          <div className="mobile-stat-strip">
            <div>
              <strong>{stats.data?.totalLearned ?? '—'}</strong>
              <span>已学词</span>
            </div>
            <div>
              <strong>{stats.data?.activeDays ?? '—'}</strong>
              <span>满5分钟的学习日</span>
            </div>
            <div>
              <strong>{stats.data?.knownClaimCount ?? '—'}</strong>
              <span>熟词</span>
            </div>
          </div>
          <ErrorNotice error={stats.error} onRetry={() => void stats.refetch()} />
          <nav className="mobile-account-menu" aria-label="账户与学习设置">
            <Link to="/me?section=plan">
              <Settings2 size={21} />
              <span>
                <strong>学习计划</strong>
                <small>
                  {settings.data
                    ? `每日 ${settings.data.settings.dailyTotalGoal} 词 · 每组 ${settings.data.settings.groupSize} 词`
                    : '目标、词书与学习时区'}
                </small>
              </span>
              <ArrowRight size={17} />
            </Link>
            <Link to="/me?section=preferences">
              <Check size={21} />
              <span>
                <strong>学习偏好</strong>
                <small>
                  {preferences.accent === 'uk' ? '英式' : '美式'}发音 ·{' '}
                  {preferences.autoPlay ? '自动播放' : '点击播放'} · 字号与主题
                </small>
              </span>
              <ArrowRight size={17} />
            </Link>
            <Link to="/content">
              <UserRound size={21} />
              <span>
                <strong>我的学习内容</strong>
                <small>在学、句库、笔记与学堂</small>
              </span>
              <ArrowRight size={17} />
            </Link>
            <Link to="/memory">
              <ShieldCheck size={21} />
              <span>
                <strong>学习统计与记忆曲线</strong>
                <small>真实练习记录与记忆预测</small>
              </span>
              <ArrowRight size={17} />
            </Link>
            <Link to="/books/mine">
              <Settings2 size={21} />
              <span>
                <strong>我的词书与导入</strong>
                <small>管理自己选的内容</small>
              </span>
              <ArrowRight size={17} />
            </Link>
            <Link to="/me?section=profile">
              <UserRound size={21} />
              <span>
                <strong>个人资料</strong>
                <small>称呼与账户信息</small>
              </span>
              <ArrowRight size={17} />
            </Link>
            <Link to="/me?section=security">
              <LockKeyhole size={21} />
              <span>
                <strong>账户安全</strong>
                <small>修改密码与其他设备会话</small>
              </span>
              <ArrowRight size={17} />
            </Link>
            {user.role === 'admin' && (
              <Link to="/admin">
                <ShieldCheck size={21} />
                <span>
                  <strong>本站管理</strong>
                  <small>内容、用户和服务设置</small>
                </span>
                <ArrowRight size={17} />
              </Link>
            )}
          </nav>
          <section className="mobile-sync-status">
            <p>{pending ? `${pending} 条操作等待同步` : '学习记录跟随本站账户保存'}</p>
            <button className="text-link" onClick={() => void sync()}>
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
