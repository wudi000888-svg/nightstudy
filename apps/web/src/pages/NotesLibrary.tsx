import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { NotebookPen, Plus, Search, Trash2 } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { api, ApiError, post } from '../lib/api';
import type { Word } from '../lib/types';
import type { LearningNote, NotePage } from '../lib/mobile-content-types';
import { Dialog, Empty, ErrorNotice, Loading, LoginPrompt, Notice } from '../components/UI';
import { usePageLifetime } from './usePageLifetime';
import './mobile-content.css';

export function NotesPage() {
  const { user } = useApp();
  const [params] = useSearchParams();
  const sourceWord = params.get('wordId');
  const owner = usePageLifetime(sourceWord ?? ''),
    client = useQueryClient();
  const [query, setQuery] = useState(''),
    [input, setInput] = useState('');
  const [editing, setEditing] = useState<LearningNote | null>(null),
    [editor, setEditor] = useState(!!sourceWord);
  const [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [wordId, setWordId] = useState<string | null>(sourceWord);
  const [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<LearningNote | null>(null);
  const saving = useRef(false);
  useEffect(() => {
    setEditing(null);
    setTitle('');
    setBody('');
    setWordId(sourceWord);
    setEditor(!!sourceWord);
    setRemoving(null);
    setError(null);
    setNotice('');
    setBusy(false);
    saving.current = false;
  }, [owner.scope, sourceWord]);
  const attached = useRemote<{ word: Word }>(
    'note-attached-word',
    `words/${encodeURIComponent(wordId ?? '')}`,
    !!user && !!wordId && editor,
  );
  const list = useInfiniteQuery({
    queryKey: [owner.scope, 'notes', 'pages', query],
    enabled: !!user && owner.active,
    retry: false,
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      api<NotePage>(
        `notes?q=${encodeURIComponent(query)}&limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.page.hasMore ? (last.page.nextCursor ?? undefined) : undefined,
  });
  const notes = list.data?.pages.flatMap((page) => page.items) ?? [];
  function open(note: LearningNote | null) {
    setEditing(note);
    setTitle(note?.title ?? '');
    setBody(note?.body ?? '');
    setWordId(note?.wordId ?? sourceWord);
    setEditor(true);
    setError(null);
    setNotice('');
  }
  async function save() {
    if (saving.current) return;
    saving.current = true;
    const request = owner.capture();
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await post(
        editing ? `notes/${encodeURIComponent(editing.id)}` : 'notes',
        {
          title: title.trim(),
          body: body.trim(),
          wordId,
          ...(editing ? { expectedRevision: editing.revision } : {}),
        },
        editing ? 'PATCH' : 'POST',
      );
      if (!owner.isCurrent(request)) return;
      setEditor(false);
      setEditing(null);
      setNotice('笔记已保存。');
      await client.invalidateQueries({ queryKey: [owner.scope, 'notes'] });
    } catch (value) {
      if (owner.isCurrent(request)) setError(value);
    } finally {
      if (owner.isCurrent(request)) {
        setBusy(false);
        saving.current = false;
      }
    }
  }
  async function remove(note: LearningNote) {
    if (saving.current) return;
    saving.current = true;
    const request = owner.capture();
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await post(
        `notes/${encodeURIComponent(note.id)}`,
        { expectedRevision: note.revision },
        'DELETE',
      );
      if (!owner.isCurrent(request)) return;
      setRemoving(null);
      if (editing?.id === note.id) {
        setEditor(false);
        setEditing(null);
      }
      setNotice('笔记已删除。');
      await client.invalidateQueries({ queryKey: [owner.scope, 'notes'] });
    } catch (value) {
      if (owner.isCurrent(request)) setError(value);
    } finally {
      if (owner.isCurrent(request)) {
        setBusy(false);
        saving.current = false;
      }
    }
  }
  async function reload() {
    const note = removing ?? editing;
    if (!note || saving.current) return;
    saving.current = true;
    const request = owner.capture();
    setBusy(true);
    try {
      const result = await api<{ note: LearningNote }>(`notes/${encodeURIComponent(note.id)}`);
      if (!owner.isCurrent(request)) return;
      if (removing) setRemoving(result.note);
      else open(result.note);
      setError(null);
      setNotice('已读取服务器最新版本。');
    } catch (value) {
      if (owner.isCurrent(request)) setError(value);
    } finally {
      if (owner.isCurrent(request)) {
        setBusy(false);
        saving.current = false;
      }
    }
  }
  if (!user)
    return (
      <div className="page">
        <LoginPrompt />
      </div>
    );
  return (
    <div className="page mobile-notes-library">
      <Link className="mobile-back" to="/content">
        ← 内容中心
      </Link>
      <header className="mobile-content-heading">
        <span className="mobile-kicker">MY NOTES</span>
        <h1>学习笔记</h1>
        <p>记下自己的理解，也给暂时没想明白的地方留一页。</p>
      </header>
      <div className="mobile-toolbar">
        <span>
          {list.data ? `${list.data.pages[0]?.page.total ?? 0} 条笔记` : '自己的学习记录'}
        </span>
        <button className="button primary" onClick={() => open(null)} disabled={busy}>
          <Plus size={17} />
          写笔记
        </button>
      </div>
      <ErrorNotice error={error || list.error} onRetry={() => void list.refetch()} />
      {error instanceof ApiError && error.status === 409 && (
        <Notice>
          笔记已在其他页面更新，本次修改未覆盖服务器版本。
          <button className="text-link" disabled={busy} onClick={() => void reload()}>
            放弃本地修改并读取最新版本
          </button>
        </Notice>
      )}
      {notice && <Notice>{notice}</Notice>}
      {editor && (
        <section className="mobile-editor-panel">
          <h2>{editing ? '编辑笔记' : '写一条笔记'}</h2>
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="field">
              标题
              <input
                required
                maxLength={120}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="今天记住了什么？"
              />
            </label>
            <label className="field">
              内容
              <textarea
                required
                maxLength={20000}
                rows={9}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="词义区别、例句、自己的联想…"
              />
            </label>
            {wordId && (
              <div className="mobile-note-attachment">
                <NotebookPen size={15} />
                <span>关联：{attached.data?.word.lemma ?? '所选词条'}</span>
                <button type="button" className="text-link" onClick={() => setWordId(null)}>
                  移除关联
                </button>
              </div>
            )}
            <div className="action-row">
              <button className="button primary" disabled={busy || !title.trim() || !body.trim()}>
                {busy ? '正在保存…' : '保存笔记'}
              </button>
              <button
                type="button"
                className="button ghost"
                disabled={busy}
                onClick={() => setEditor(false)}
              >
                取消
              </button>
            </div>
          </form>
        </section>
      )}
      <form
        className="mobile-search"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(input.trim());
        }}
      >
        <Search size={18} />
        <input
          aria-label="搜索笔记"
          value={input}
          maxLength={120}
          onChange={(event) => setInput(event.target.value)}
          placeholder="搜索标题或内容"
        />
        <button>搜索</button>
      </form>
      {list.isPending ? (
        <Loading />
      ) : notes.length ? (
        <div className="mobile-notes-list">
          {notes.map((note) => (
            <article className="mobile-note-card" key={note.id}>
              <button className="mobile-note-open" onClick={() => open(note)} disabled={busy}>
                <h2>{note.title}</h2>
                <p>{note.body}</p>
              </button>
              <footer>
                <span>
                  {new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(
                    new Date(note.updatedAt),
                  )}{' '}
                  更新{note.wordId ? ' · 已关联词条' : ''}
                </span>
                <button
                  className="icon-button"
                  aria-label={`删除笔记：${note.title}`}
                  disabled={busy}
                  onClick={() => setRemoving(note)}
                >
                  <Trash2 size={17} />
                </button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title={query ? '没有匹配的笔记' : '让自己的理解，也有个地方'}
          description="记录词义区别、读书摘记，或一句自己的话。"
          action={
            <button className="button primary" onClick={() => open(null)}>
              写第一条笔记
            </button>
          }
        />
      )}
      {list.hasNextPage && (
        <button
          className="button ghost full"
          disabled={list.isFetchingNextPage}
          onClick={() => {
            if (owner.active) void list.fetchNextPage();
          }}
        >
          加载更多
        </button>
      )}
      <Dialog
        open={!!removing}
        title="删除这条笔记"
        onClose={() => {
          if (!busy) setRemoving(null);
        }}
      >
        {removing && (
          <>
            <p>{removing.title}</p>
            <p className="mobile-caption">确认后移除自己的这条笔记，不改变词条或学习进度。</p>
            <ErrorNotice error={error} />
            {error instanceof ApiError && error.status === 409 && (
              <button className="text-link" disabled={busy} onClick={() => void reload()}>
                读取最新版本后再确认
              </button>
            )}
            <div className="action-row">
              <button className="button ghost" disabled={busy} onClick={() => setRemoving(null)}>
                保留
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void remove(removing)}
              >
                确认删除
              </button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
