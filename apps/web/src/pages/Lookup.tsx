import { useState } from 'react';
import { Bookmark, Search, Trash2, Pause, Play, Pencil, ArrowRight } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useApp, useRemote } from '../AppContext';
import { api, post } from '../lib/api';
import type { Word, WordbookItem } from '../lib/types';
import {
  Dialog,
  Empty,
  ErrorNotice,
  Heading,
  Loading,
  Notice,
  Panel,
  WordView,
  formatDate,
} from '../components/UI';

export function LookupPage() {
  const { user, scope } = useApp();
  const client = useQueryClient();
  const [tab, setTab] = useState('lookup');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Word[]>([]);
  const [selected, setSelected] = useState<Word | null>(null);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<WordbookItem | null>(null);
  const [note, setNote] = useState('');
  const wordbook = useRemote<{ items: WordbookItem[] }>('wordbook', 'wordbook', !!user);
  async function search() {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const data = await api<{ items: Word[]; completeDictionary: boolean }>(
        `dictionary?q=${encodeURIComponent(query.trim())}`,
      );
      setResults(data.items);
      setSelected(data.items[0] ?? null);
      setSearched(true);
      if (!data.items.length)
        setNotice('演示内容中暂时没有查到这个词，可以试试 rain、quiet 或 learn。');
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  async function collect(wordId: string) {
    if (!user) {
      setNotice('登录后可将这个词保存在本站生词本。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post('wordbook', { wordId });
      await client.invalidateQueries({ queryKey: [scope, 'wordbook'] });
      setNotice('已加入你的生词本。');
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  async function change(item: WordbookItem, input: Record<string, unknown>, method = 'PATCH') {
    setError(null);
    setBusy(true);
    try {
      await post(`wordbook/${item.wordId}`, input, method);
      await wordbook.refetch();
      setEditing(null);
      setNotice(method === 'DELETE' ? '已从生词本移除，学习进度仍保留。' : '生词本记录已保存。');
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page">
      <Heading
        eyebrow="查词 · 先解决眼前的问题"
        title={
          <>
            把一个词，<em>读到有语境。</em>
          </>
        }
        description="Alpha 查询当前已发布的原创演示内容，完整扩展词典会在后续数据包中接入。"
      />
      <div className="tab-row">
        <button className={tab === 'lookup' ? 'active' : ''} onClick={() => setTab('lookup')}>
          <Search size={16} /> 查词
        </button>
        <button className={tab === 'wordbook' ? 'active' : ''} onClick={() => setTab('wordbook')}>
          <Bookmark size={16} /> 我的生词本
        </button>
      </div>
      <ErrorNotice error={error || (tab === 'wordbook' ? wordbook.error : null)} />
      {notice && <Notice>{notice}</Notice>}
      {tab === 'lookup' ? (
        <>
          <form
            className="search-bar"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <Search size={21} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="输入一个想读懂的词，例如 quiet"
              aria-label="查词输入"
            />
            <button type="submit" className="button primary" disabled={busy || !query.trim()}>
              {busy ? '查找中…' : '查词'}
              <ArrowRight size={15} />
            </button>
          </form>
          {results.length > 1 && (
            <div className="filter-row">
              {results.map((word) => (
                <button
                  key={word.id}
                  className={selected?.id === word.id ? 'active' : ''}
                  onClick={() => setSelected(word)}
                >
                  {word.lemma}
                </button>
              ))}
            </div>
          )}
          {selected ? (
            <Panel className="lookup-card">
              <div className="section-heading">
                <span className="soft-badge">原创演示 · 词条</span>
                <button
                  className="button quiet"
                  disabled={busy}
                  onClick={() => void collect(selected.id)}
                >
                  <Bookmark size={16} /> 加入生词本
                </button>
              </div>
              <WordView word={selected} />
            </Panel>
          ) : (
            !searched && (
              <Empty
                title="从你真正遇到的一个词开始。"
                description="查清词义，看一句语境，再决定是否把它留下。"
              />
            )
          )}
        </>
      ) : !user ? (
        <Empty title="生词本属于你的账户。" description="登录后，可以把遇到的词和备注一起保存。" />
      ) : wordbook.isPending ? (
        <Loading />
      ) : wordbook.data?.items.length ? (
        <Panel className="wordbook-panel">
          <div className="section-heading">
            <h2>已保存 {wordbook.data.items.length} 个词</h2>
            <span className="tiny-label">收藏与记忆进度分开</span>
          </div>
          <div className="wordbook-list">
            {wordbook.data.items.map((item) => (
              <article key={item.id}>
                <div className="wordbook-main">
                  <button
                    className="word-link"
                    onClick={() => {
                      setTab('lookup');
                      setSelected(item.word);
                      setResults([item.word]);
                    }}
                  >
                    <strong>{item.word.lemma}</strong>
                    <span>{item.word.senses?.[0]?.definitionZh}</span>
                  </button>
                  {item.note && <p className="word-note">{item.note}</p>}
                  <small>
                    {item.paused
                      ? '已暂停复习'
                      : item.progress?.dueAt
                        ? `下次 ${formatDate(item.progress.dueAt)}`
                        : '尚未完成记忆评价'}
                  </small>
                </div>
                <div className="row-actions">
                  <button
                    className="icon-button"
                    aria-label={`编辑 ${item.word.lemma} 备注`}
                    onClick={() => {
                      setEditing(item);
                      setNote(item.note);
                    }}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    className="icon-button"
                    disabled={busy}
                    aria-label={
                      item.paused ? `恢复 ${item.word.lemma} 复习` : `暂停 ${item.word.lemma} 复习`
                    }
                    onClick={() => void change(item, { paused: !item.paused })}
                  >
                    {item.paused ? <Play size={16} /> : <Pause size={16} />}
                  </button>
                  <button
                    className="icon-button"
                    disabled={busy}
                    aria-label={`移除 ${item.word.lemma} 收藏，保留学习进度`}
                    onClick={() => void change(item, {}, 'DELETE')}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </Panel>
      ) : (
        <Empty
          title="生词本还是空的。"
          description="先查一个词，再把它和自己的备注留下。"
          action={
            <button className="button primary" onClick={() => setTab('lookup')}>
              去查词
            </button>
          }
        />
      )}
      <Dialog open={!!editing} title="留下自己的语境" onClose={() => setEditing(null)}>
        <label className="field">
          备注
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={4}
            maxLength={4000}
          />
        </label>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => editing && void change(editing, { note })}
        >
          保存备注
        </button>
      </Dialog>
    </div>
  );
}
