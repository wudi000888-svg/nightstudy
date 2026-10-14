import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  BookOpen,
  ShieldCheck,
  Users,
  FileText,
  Search,
  Save,
  MessageSquare,
  Settings2,
  Network,
  Sparkles,
} from 'lucide-react';
import { AdminBooks } from '../components/AdminBooks';
import { AdminConfirm, type AdminConfirmation } from '../components/AdminConfirm';
import { AdminSystem } from '../components/AdminSystem';
import { AdminFleet } from '../components/AdminFleet';
import { DeepSeekSettings } from '../components/DeepSeekSettings';
import { useApp, useRemote } from '../AppContext';
import { ApiError, post } from '../lib/api';
import {
  adminWordPatch,
  adminWordTarget,
  loadAdminWord,
  type AdminWordTarget,
  type CandidateSourceStatus,
} from '../lib/admin-word-editor';
import type { PageInfo, Word, Sense } from '../lib/types';
import {
  Dialog,
  Empty,
  ErrorNotice,
  Heading,
  Loading,
  LoginPrompt,
  Notice,
  Panel,
} from '../components/UI';
interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  disabled: boolean;
  createdAt: string;
}
interface Announcement {
  id: string;
  title: string;
  body: string;
  status: string;
}
export function AdminPage() {
  const { scope } = useApp();
  return <AdminPageContent key={scope} />;
}
function AdminPageContent() {
  const { user, site } = useApp();
  const isAdmin = user?.role === 'admin';
  const location = useLocation();
  const requestedSection = location.pathname.split('/')[2] ?? 'overview';
  const section = requestedSection === 'words' ? 'content' : requestedSection;
  const tab = [
    'overview',
    'users',
    'books',
    'content',
    'announcements',
    'system',
    'fleet',
    'ai',
  ].includes(section)
    ? section
    : 'overview';
  const [confirmation, setConfirmation] = useState<AdminConfirmation | null>(null);
  const [search, setSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [wordCursor, setWordCursor] = useState('');
  const overview = useRemote<{
    users: number;
    words: number;
    books: number;
    reviews: number;
    imports: number;
  }>('admin-overview', 'admin/overview', isAdmin);
  const users = useRemote<{ items: AdminUser[] }>('admin-users', 'admin/users', isAdmin);
  const words = useRemote<{ items: Word[]; page: PageInfo }>(
    'admin-words',
    `admin/words?q=${encodeURIComponent(activeSearch)}&limit=50${wordCursor ? `&cursor=${encodeURIComponent(wordCursor)}` : ''}`,
    isAdmin,
  );
  const announcements = useRemote<{ items: Announcement[] }>(
    'admin-announcements',
    'admin/announcements',
    isAdmin,
  );
  const [editing, setEditing] = useState<Word | null>(null);
  const [editorTarget, setEditorTarget] = useState<AdminWordTarget | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState<unknown>(null);
  const [editorConflict, setEditorConflict] = useState(false);
  const [sourceStatus, setSourceStatus] = useState<CandidateSourceStatus>('unbound');
  const [sense, setSense] = useState<Sense | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [announcementTitle, setAnnouncementTitle] = useState('');
  const [announcementBody, setAnnouncementBody] = useState('');
  const editorRequest = useRef(0);
  const editorAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const savingWord = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      editorAbort.current?.abort();
    };
  }, []);
  async function openEditor(target: AdminWordTarget) {
    const request = ++editorRequest.current;
    editorAbort.current?.abort();
    const controller = new AbortController();
    editorAbort.current = controller;
    setEditorTarget(target);
    setEditing(null);
    setSense(null);
    setEditorError(null);
    setEditorConflict(false);
    setSourceStatus('unbound');
    setEditorLoading(true);
    try {
      const result = await loadAdminWord(target, controller.signal);
      if (!mounted.current || request !== editorRequest.current) return;
      setEditing(result.word);
      setSense(result.sense);
      setSourceStatus(result.sourceStatus);
      if (target.senseId && !result.sense)
        setEditorError(new Error('指定义项不属于这个词，请重新选择原始义项。'));
    } catch (value) {
      if (mounted.current && request === editorRequest.current) setEditorError(value);
    } finally {
      if (mounted.current && request === editorRequest.current) setEditorLoading(false);
    }
  }
  function closeEditor() {
    if (savingWord.current) return;
    ++editorRequest.current;
    editorAbort.current?.abort();
    setEditorTarget(null);
    setEditing(null);
    setSense(null);
  }
  useEffect(() => {
    if (!isAdmin || tab !== 'content') return;
    const target = adminWordTarget(location.search);
    if (target) void openEditor(target);
  }, [isAdmin, tab, location.search]);
  async function toggleUser(value: AdminUser) {
    setBusy(true);
    setError(null);
    try {
      await post(`admin/users/${value.id}`, { disabled: !value.disabled }, 'PATCH');
      await users.refetch();
      setNotice(value.disabled ? '本站用户已恢复。' : '本站用户已停用，旧会话已撤销。');
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  async function saveWord() {
    if (!editing || !sense || editorConflict || savingWord.current || editorLoading) return;
    const request = editorRequest.current;
    savingWord.current = true;
    setBusy(true);
    setEditorError(null);
    try {
      await post(
        `admin/words/${encodeURIComponent(editing.id)}`,
        adminWordPatch(editing, sense),
        'PATCH',
      );
      await words.refetch();
      if (!mounted.current || request !== editorRequest.current) return;
      setEditorTarget(null);
      setEditing(null);
      setSense(null);
      setNotice('词条已保存，新的学习组会使用更新内容。');
    } catch (value) {
      if (mounted.current && request === editorRequest.current) {
        setEditorError(value);
        if (value instanceof ApiError && (value.status === 403 || value.status === 409))
          setEditorConflict(true);
      }
    } finally {
      savingWord.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function publishAnnouncement() {
    setBusy(true);
    setError(null);
    try {
      await post('admin/announcements', {
        title: announcementTitle,
        body: announcementBody,
        status: 'published',
      });
      await announcements.refetch();
      setAnnouncementTitle('');
      setAnnouncementBody('');
      setNotice('公告已发布。');
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  async function removeAnnouncement(id: string) {
    setBusy(true);
    setError(null);
    try {
      await post(`admin/announcements/${id}`, {}, 'DELETE');
      await announcements.refetch();
      setNotice('公告已移除。');
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
  if (!isAdmin)
    return (
      <div className="page">
        <Empty
          title="这扇门属于本站管理员。"
          description="当前账户没有管理权限，你的学习记录仍然可以正常使用。"
        />
      </div>
    );
  return (
    <div className="page admin-page">
      <Heading
        eyebrow={`管理自习室 · ${site.title}`}
        title={
          <>
            让这间自习室，<em>好好运行。</em>
          </>
        }
        description="这里的用户、内容与操作只属于本站。服务端对每个操作检查管理权限。"
      />
      <div className="tab-row admin-tabs">
        {[
          { id: 'overview', label: '概览', icon: ShieldCheck },
          { id: 'users', label: '用户', icon: Users },
          { id: 'books', label: '词书', icon: BookOpen },
          { id: 'content', label: '内容', icon: FileText },
          { id: 'announcements', label: '公告', icon: MessageSquare },
          { id: 'system', label: '系统与更新', icon: Settings2 },
          { id: 'fleet', label: '群站管理', icon: Network },
          { id: 'ai', label: 'AI 内容辅助', icon: Sparkles },
        ].map(({ id, label, icon: Icon }) => (
          <Link
            key={id}
            className={tab === id ? 'active' : ''}
            aria-current={tab === id ? 'page' : undefined}
            to={id === 'overview' ? '/admin' : `/admin/${id}`}
          >
            <Icon size={16} />
            {label}
          </Link>
        ))}
      </div>
      <ErrorNotice error={error} />
      {notice && <Notice>{notice}</Notice>}
      {tab === 'system' && <AdminSystem />}
      {tab === 'fleet' && <AdminFleet />}
      {tab === 'ai' && <DeepSeekSettings />}
      {tab === 'overview' && (
        <>
          {overview.isPending ? (
            <Loading />
          ) : (
            overview.data && (
              <div className="four-metrics">
                {[
                  { label: '本站用户', value: overview.data.users },
                  { label: '内容词条', value: overview.data.words },
                  { label: '本站词书', value: overview.data.books },
                  { label: '真实评价记录', value: overview.data.reviews },
                ].map((value) => (
                  <Panel className="metric" key={value.label}>
                    <span>{value.label}</span>
                    <strong>{value.value}</strong>
                  </Panel>
                ))}
              </div>
            )
          )}
          <ErrorNotice error={overview.error} />
          <Panel>
            <h2>当前 Alpha 内容范围</h2>
            <p>
              词书及词条保留各自来源与许可。学习与测验使用本站已发布内容，学习任务保留签发时的内容快照。
            </p>
            <p className="fine-print">
              已记录 {overview.data?.imports ?? '—'} 个熟词导入批次 · 站点版本 {site.version}
            </p>
          </Panel>
        </>
      )}
      {tab === 'users' && (
        <Panel>
          <ErrorNotice error={users.error} />
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>用户</th>
                  <th>邮箱</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.data?.items.map((value) => (
                  <tr key={value.id}>
                    <td>{value.name}</td>
                    <td>{value.email}</td>
                    <td>{value.role === 'admin' ? '管理员' : '用户'}</td>
                    <td>{value.disabled ? '停用' : '正常'}</td>
                    <td>
                      <button
                        className="button quiet"
                        disabled={busy}
                        onClick={() =>
                          setConfirmation({
                            title: value.disabled ? '恢复本站用户？' : '停用本站用户？',
                            message: value.disabled
                              ? `将恢复 ${value.name}（${value.email}）在本站的登录权限。`
                              : `将停用 ${value.name}（${value.email}）并撤销其本站会话，学习记录仍会保留。`,
                            label: value.disabled ? '确认恢复' : '确认停用',
                            run: () => toggleUser(value),
                          })
                        }
                      >
                        {value.disabled ? '恢复' : '停用'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {tab === 'books' && <AdminBooks />}
      {tab === 'content' && (
        <Panel>
          <form
            className="search-bar compact-search"
            onSubmit={(event) => {
              event.preventDefault();
              setActiveSearch(search);
              setWordCursor('');
            }}
          >
            <Search size={18} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="按英文单词前缀搜索"
              aria-label="管理词条前缀"
            />
            <button className="button ghost">查询</button>
          </form>
          <ErrorNotice error={words.error} />
          {words.isPending && <Loading text="正在读取这一页词条…" />}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>词形</th>
                  <th>中文释义</th>
                  <th>来源</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {words.data?.items.map((value) => (
                  <tr key={value.id}>
                    <td>
                      <strong>{value.lemma}</strong>
                    </td>
                    <td>
                      {value.senses?.find((item) => item.definitionZh?.trim())?.definitionZh ||
                        '暂无中文释义'}
                    </td>
                    <td>{value.sourceRef}</td>
                    <td>
                      <button
                        className="button quiet"
                        disabled={busy}
                        onClick={() => void openEditor({ wordId: value.id })}
                      >
                        编辑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination-actions">
            <span className="fine-print">
              {words.data?.page.total ?? '—'} 个匹配词条 · 每页最多50条
            </span>
            {wordCursor && (
              <button className="button ghost" onClick={() => setWordCursor('')}>
                返回首屏
              </button>
            )}
            {words.data?.page.hasMore && (
              <button
                className="button ghost"
                onClick={() => setWordCursor(words.data!.page.nextCursor!)}
              >
                下一页词条
              </button>
            )}
          </div>
        </Panel>
      )}
      {tab === 'announcements' && (
        <div className="settings-grid">
          <Panel>
            <h2>发布本站公告</h2>
            <form
              className="form-stack"
              onSubmit={(event) => {
                event.preventDefault();
                void publishAnnouncement();
              }}
            >
              <label className="field">
                标题
                <input
                  value={announcementTitle}
                  onChange={(event) => setAnnouncementTitle(event.target.value)}
                  required
                  maxLength={160}
                />
              </label>
              <label className="field">
                正文
                <textarea
                  value={announcementBody}
                  onChange={(event) => setAnnouncementBody(event.target.value)}
                  required
                  rows={5}
                  maxLength={4000}
                />
              </label>
              <button className="button primary" disabled={busy}>
                发布公告
              </button>
            </form>
          </Panel>
          <Panel>
            <h2>已发布与草稿</h2>
            {announcements.data?.items.map((value) => (
              <article className="announcement-card" key={value.id}>
                <strong>{value.title}</strong>
                <p>{value.body}</p>
                <button
                  className="button quiet"
                  disabled={busy}
                  onClick={() =>
                    setConfirmation({
                      title: '移除本站公告？',
                      message: `将移除“${value.title}”，本站用户将无法继续查看这条公告。`,
                      label: '确认移除',
                      run: () => removeAnnouncement(value.id),
                    })
                  }
                >
                  移除公告
                </button>
              </article>
            ))}
            <ErrorNotice error={announcements.error} />
          </Panel>
        </div>
      )}
      <Dialog
        open={!!editorTarget}
        title={`编辑 ${editing?.lemma ?? '词条'}`}
        onClose={closeEditor}
      >
        {editorLoading && <Loading text="正在读取完整原始义项…" />}
        <ErrorNotice error={editorError} />
        {editorTarget && !editorLoading && (
          <button
            type="button"
            className="button quiet"
            disabled={busy}
            onClick={() =>
              void openEditor({ ...editorTarget, senseId: sense?.id ?? editorTarget.senseId })
            }
          >
            重新载入原义项（丢弃未保存修改）
          </button>
        )}
        {sourceStatus === 'changed' && (
          <Notice>候选依据的原义已改变，请重新生成预览。这里显示最新原始内容，未填入候选。</Notice>
        )}
        {sourceStatus === 'unverifiable' && (
          <Notice>暂未确认候选与当前原义一致，请重新预览后校对。这里未填入候选。</Notice>
        )}
        {editing && !editorLoading && (
          <label className="field">
            选择原始义项
            <select
              value={sense?.id ?? ''}
              disabled={busy}
              onChange={(event) => {
                const selected = editing.senses?.find((item) => item.id === event.target.value);
                setSense(selected ? { ...selected } : null);
                if (!editorConflict) setEditorError(null);
              }}
            >
              <option value="">请选择义项</option>
              {editing.senses?.map((item, index) => (
                <option key={item.id} value={item.id}>
                  {index + 1}. {item.pos || '未标词性'} ·{' '}
                  {(item.definitionZh || item.definitionEn || '空义项').slice(0, 100)}
                </option>
              ))}
            </select>
          </label>
        )}
        {editing && sense && !editorLoading && (
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void saveWord();
            }}
          >
            <div className="management-card">
              <strong>当前原始义项 · {sense.pos || '未标词性'}</strong>
              <p>
                中文：
                {editing.senses?.find((item) => item.id === sense.id)?.definitionZh || '未填写'}
              </p>
              <p>
                英文：
                {editing.senses?.find((item) => item.id === sense.id)?.definitionEn || '未填写'}
              </p>
              <p className="fine-print">以下修改仅在点击“人工保存内容”后写入这个义项。</p>
            </div>
            <label className="field">
              内容状态
              <select
                value={editing.status}
                disabled={busy}
                onChange={(event) =>
                  editing && setEditing({ ...editing, status: event.target.value })
                }
              >
                <option value="published">发布</option>
                <option value="draft">草稿</option>
                <option value="archived">归档</option>
              </select>
            </label>
            <label className="field">
              中文释义
              <textarea
                value={sense.definitionZh}
                onChange={(event) => setSense({ ...sense, definitionZh: event.target.value })}
                disabled={busy}
                rows={2}
              />
            </label>
            <label className="field">
              英文释义
              <textarea
                value={sense.definitionEn ?? ''}
                disabled={busy}
                onChange={(event) => setSense({ ...sense, definitionEn: event.target.value })}
                rows={2}
              />
            </label>
            <label className="field">
              该义项的英文例句
              <textarea
                value={sense.exampleEn ?? ''}
                disabled={busy}
                onChange={(event) => setSense({ ...sense, exampleEn: event.target.value })}
                rows={2}
              />
            </label>
            <label className="field">
              该义项的中文例句
              <textarea
                value={sense.exampleZh ?? ''}
                disabled={busy}
                onChange={(event) => setSense({ ...sense, exampleZh: event.target.value })}
                rows={2}
              />
            </label>
            <p className="fine-print">这里保存所选义项的例句，不会新增或替换独立词级用法例句。</p>
            <button className="button primary" disabled={busy || editorConflict}>
              <Save size={16} />
              人工保存内容
            </button>
          </form>
        )}
      </Dialog>
      <AdminConfirm action={confirmation} onClose={() => setConfirmation(null)} />
    </div>
  );
}
