import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
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
  const client = useQueryClient();
  const plan = useRemote<TaskPlanResponse>('plan', 'study/plan', !!user);
  const navigate = useNavigate();
  const settings = useRemote<{ settings: Settings }>('settings', 'me/settings', !!user);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [name, setName] = useState(user?.name ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  useEffect(() => {
    setDraft(null);
    setName(user?.name ?? '');
    setCurrentPassword('');
    setNewPassword('');
    setError(null);
    setNotice('');
  }, [scope]);
  useEffect(() => {
    if (settings.data) setDraft(settings.data.settings);
  }, [settings.data]);
  async function saveSettings() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
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
      setNotice('计划已保存。已安排的学习组可以继续，其余内容按新目标调整。');
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  async function changeName() {
    setBusy(true);
    setError(null);
    try {
      await post('me/profile', { name }, 'PATCH');
      await refresh();
      setNotice('称呼已更新。');
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  async function changePassword() {
    setBusy(true);
    setError(null);
    try {
      await auth('change-password', { currentPassword, newPassword, revokeOtherSessions: true });
      setCurrentPassword('');
      setNewPassword('');
      setNotice('密码已更新，其他设备的会话已撤销。');
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    try {
      await auth('sign-out', {});
      await refresh();
      navigate('/');
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  if (!user)
    return (
      <div className="page">
        <LoginPrompt />
      </div>
    );
  return (
    <div className="page">
      <Heading
        eyebrow="我的 · 一点自己的节奏"
        title={
          <>
            今晚，<em>{user.name}。</em>
          </>
        }
        description={`你的学习记录保存在 ${site.title}。换设备登录后，也可以继续。`}
        action={
          <button className="button quiet" onClick={() => void signOut()} disabled={busy}>
            <LogOut size={16} />
            退出账户
          </button>
        }
      />
      <ErrorNotice error={error || settings.error} />
      {notice && <Notice>{notice}</Notice>}
      <div className="settings-grid">
        <Panel>
          <div className="panel-title">
            <UserRound size={19} />
            <h2>个人资料</h2>
          </div>
          <label className="field">
            本站邮箱
            <input value={user.email} readOnly />
          </label>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void changeName();
            }}
          >
            <label className="field">
              怎么称呼你
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={80}
              />
            </label>
            <button className="button ghost" disabled={busy}>
              保存称呼
            </button>
          </form>
          <p className="fine-print">显示名不会改变你的登录邮箱。</p>
        </Panel>
        <Panel>
          <div className="panel-title">
            <Settings2 size={19} />
            <h2>学习计划</h2>
          </div>
          {settings.isPending ? (
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
                <div className="form-columns">
                  <label className="field">
                    每天总词数（复习 + 新学）
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={draft.dailyTotalGoal}
                      onChange={(event) =>
                        setDraft({ ...draft, dailyTotalGoal: Number(event.target.value) })
                      }
                      required
                    />
                  </label>
                  <label className="field">
                    每组词数
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={draft.groupSize}
                      onChange={(event) =>
                        setDraft({ ...draft, groupSize: Number(event.target.value) })
                      }
                      required
                    />
                  </label>
                </div>
                <div className="task-plan-explanation">
                  <div>
                    <strong>新学来源：{plan.data?.plan.bookTitle ?? '尚未选择词书'}</strong>
                    <p>
                      先复习到期的词，再从选好的书里学新词。同词当天只计一次，巩固和拼写不重复占每日目标。
                    </p>
                    <p>
                      当前未安排逾期 {plan.data?.plan.unplannedOverdueCount ?? '—'}{' '}
                      词；换书或降低目标后，已安排的学习组仍可继续。
                      <Link className="text-link" to="/books">
                        选书并预览计划
                      </Link>
                    </p>
                  </div>
                </div>
                {draft.pendingTimeZone && (
                  <Notice>
                    时区 {draft.pendingTimeZone} 已预约下个学习日生效；今日按 {draft.timeZone}{' '}
                    统计。
                  </Notice>
                )}
                <label className="field">
                  统计时区（下个学习日生效）
                  <input
                    value={draft.pendingTimeZone ?? draft.timeZone}
                    onChange={(event) =>
                      setDraft({ ...draft, pendingTimeZone: null, timeZone: event.target.value })
                    }
                    required
                    placeholder="Asia/Shanghai"
                  />
                </label>
                <button className="button primary" disabled={busy}>
                  保存计划
                </button>
              </form>
            )
          )}
        </Panel>
        <Panel>
          <div className="panel-title">
            <LockKeyhole size={19} />
            <h2>账户安全</h2>
          </div>
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
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <label className="field">
              新密码
              <input
                type="password"
                minLength={8}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            <button className="button ghost" disabled={busy}>
              修改密码
            </button>
          </form>
        </Panel>
        <Panel>
          <div className="panel-title">
            <ShieldCheck size={19} />
            <h2>我的记录</h2>
          </div>
          <p>{pending ? `${pending} 条操作暂存等待同步。` : '本站账户保存你的学习状态与计划。'}</p>
          <button className="button ghost" onClick={() => void sync()}>
            检查暂存同步
          </button>
          {syncNote && <p className="fine-print">{syncNote}</p>}
          <div className="profile-links">
            <Link to="/wordbook">
              我的生词本 <ArrowRight size={15} />
            </Link>
            <Link to="/known">
              我的熟词与导入导出 <ArrowRight size={15} />
            </Link>
            <Link to="/assessment">
              词汇水平测验 <ArrowRight size={15} />
            </Link>
            <Link to="/memory">
              个人记忆与反馈 <ArrowRight size={15} />
            </Link>
            {user.role === 'admin' && (
              <Link to="/admin">
                本站管理 <ArrowRight size={15} />
              </Link>
            )}
          </div>
        </Panel>
      </div>
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
