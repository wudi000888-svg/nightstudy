import { useRef, useState } from 'react';
import { Bookmark, Search, Trash2, Pause, Play, Pencil, ArrowRight, Languages } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useApp, useRemote } from '../AppContext';
import { api, post } from '../lib/api';
import type { PageInfo, Word, WordbookItem } from '../lib/types';
import { TranslationPanel } from '../components/Translation';
import { dictionaryText } from '../lib/dictionary';
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

export function LookupPage({ initialTab = 'lookup' }: { initialTab?: 'lookup' | 'wordbook' }) {
  const { user, scope } = useApp();
  const client = useQueryClient();
  const [tab, setTab] = useState<'lookup' | 'wordbook' | 'translation'>(initialTab);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Word[]>([]);
  const [selected, setSelected] = useState<Word | null>(null);
  const [page, setPage] = useState<PageInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<unknown>(null);
  const selection = useRef(0);
  const [translationText, setTranslationText] = useState('');
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<WordbookItem | null>(null);
  const [note, setNote] = useState('');
  const wordbook = useRemote<{ items: WordbookItem[] }>('wordbook', 'wordbook', !!user);
  const dictionary = useRemote<{
    installedDictionary: boolean;
    declaredEntryCount: number;
    packs: {
      id: string;
      version: string;
      license: string;
      entryCount: number;
      phoneticCount: number;
      definitionZhCount: number;
      definitionEnCount: number;
    }[];
  }>('dictionary-stats', 'dictionary/stats');
  async function choose(word: Word) {
    const request = ++selection.current;
    setSelected(word);
    setDetailBusy(true);
    setDetailError(null);
    try {
      const result = await api<{ word: Word }>(`words/${encodeURIComponent(word.id)}`);
      if (request === selection.current) setSelected(result.word);
    } catch (value) {
      if (request === selection.current) setDetailError(value);
    } finally {
      if (request === selection.current) setDetailBusy(false);
    }
  }
  async function search(more = false) {
    const term = more ? searchQuery : query.trim();
    if (!term || busy || (more && !page?.nextCursor)) return;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const data = await api<{ items: Word[]; page: PageInfo }>(
        `dictionary?q=${encodeURIComponent(term)}&limit=20${more ? `&cursor=${encodeURIComponent(page!.nextCursor!)}` : ''}`,
      );
      setResults((current) =>
        more
          ? [...new Map([...current, ...data.items].map((word) => [word.id, word])).values()]
          : data.items,
      );
      setPage(data.page);
      setSearchQuery(term);
      setSearched(true);
      if (!more) {
        selection.current++;
        if (data.items[0]) void choose(data.items[0]);
        else {
          setSelected(null);
          setDetailError(null);
          setDetailBusy(false);
        }
      }
      if (!data.items.length && !more)
        setNotice('本站词库中暂时没有匹配到这个单词前缀。请检查拼写，或在网页翻译中查询语境。');
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
        description="查询本站词库，查看来源音标、已有中文释义和英文解释，再用可用的设备英语语音读一遍。"
      />
      <div className="tab-row">
        <button className={tab === 'lookup' ? 'active' : ''} onClick={() => setTab('lookup')}>
          <Search size={16} /> 查词
        </button>
        <button className={tab === 'wordbook' ? 'active' : ''} onClick={() => setTab('wordbook')}>
          <Bookmark size={16} /> 我的生词本
        </button>
        <button
          className={tab === 'translation' ? 'active' : ''}
          onClick={() => setTab('translation')}
        >
          <Languages size={16} /> 网页翻译
        </button>
      </div>
      <ErrorNotice error={error || (tab === 'wordbook' ? wordbook.error : null)} />
      {notice && <Notice>{notice}</Notice>}
      {tab === 'translation' ? (
        <TranslationPanel key={translationText} initialText={translationText} />
      ) : tab === 'lookup' ? (
        <>
          {dictionary.data && (
            <div className="dictionary-status">
              <span className="soft-badge">
                {dictionary.data.installedDictionary ? '词典数据已安装' : '本站已发布内容'}
              </span>
              {dictionary.data.installedDictionary && (
                <span>
                  安装包记录数 {dictionary.data.declaredEntryCount.toLocaleString()} ·
                  来自数据包元数据
                </span>
              )}
              <small>按英文单词或前缀查找。选择结果后读取完整释义。</small>
              {dictionary.data.packs.length > 0 && (
                <details className="dictionary-pack-details">
                  <summary>查看数据覆盖与许可</summary>
                  <p>以下来自安装包元数据，各包可能覆盖相同单词，不能直接相加为本站去重词数。</p>
                  {dictionary.data.packs.map((pack) => (
                    <div className="dictionary-pack" key={pack.id}>
                      <strong>
                        {pack.id} · {pack.version}
                      </strong>
                      <span>
                        {pack.entryCount.toLocaleString()} 条记录 · 中文释义{' '}
                        {pack.definitionZhCount.toLocaleString()} 条 · 英文释义{' '}
                        {pack.definitionEnCount.toLocaleString()} 条 · 读音标注{' '}
                        {pack.phoneticCount.toLocaleString()} 条
                      </span>
                      <small>许可：{pack.license} · 未提供的内容不会补造</small>
                    </div>
                  ))}
                </details>
              )}
            </div>
          )}
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
              placeholder="输入英文单词或开头，例如 rain"
              aria-label="查词输入"
              maxLength={160}
              disabled={busy}
            />
            <button type="submit" className="button primary" disabled={busy || !query.trim()}>
              {busy ? '查找中…' : '查词'}
              <ArrowRight size={15} />
            </button>
          </form>
          {searched && results.length > 0 && (
            <div className="dictionary-layout">
              <aside className="dictionary-results" aria-label="词典搜索结果">
                <div className="dictionary-results-heading">
                  “{searchQuery}” · {page?.total ?? results.length} 个匹配
                </div>
                {results.map((word) => (
                  <button
                    key={word.id}
                    className={selected?.id === word.id ? 'active' : ''}
                    onClick={() => void choose(word)}
                  >
                    <strong>{word.lemma}</strong>
                    <span>
                      {dictionaryText(
                        word.senses?.find((sense) => sense.definitionZh?.trim())?.definitionZh,
                      ) ||
                        word.senses?.find((sense) => sense.definitionEn?.trim())?.definitionEn ||
                        '查看完整词条'}
                    </span>
                  </button>
                ))}
                {page?.hasMore && (
                  <button
                    className="button ghost"
                    disabled={busy}
                    onClick={() => void search(true)}
                  >
                    {busy ? '正在读取…' : '更多匹配词'}
                  </button>
                )}
              </aside>
              <div className="dictionary-detail">
                {selected ? (
                  <Panel className="lookup-card">
                    <div className="section-heading">
                      <span className="soft-badge">
                        {detailError ? '词条摘要' : '完整词条'}
                        {!detailBusy && selected.senseCount
                          ? ` · ${selected.senseCount} 条释义`
                          : ''}
                      </span>
                      <div className="action-row">
                        <button
                          className="button quiet"
                          onClick={() => {
                            setTranslationText(selected.lemma);
                            setTab('translation');
                          }}
                        >
                          <Languages size={16} /> 网页翻译
                        </button>
                        <button
                          className="button quiet"
                          disabled={busy}
                          onClick={() => void collect(selected.id)}
                        >
                          <Bookmark size={16} /> 加入生词本
                        </button>
                      </div>
                    </div>
                    {detailBusy ? (
                      <Loading text="正在读取完整释义…" />
                    ) : (
                      <>
                        <ErrorNotice error={detailError} onRetry={() => void choose(selected)} />
                        {detailError && <Notice>当前显示搜索摘要，完整词条尚未读取。</Notice>}
                        <WordView word={selected} />
                      </>
                    )}
                  </Panel>
                ) : null}
              </div>
            </div>
          )}
          {!searched && (
            <Empty
              title="从你真正遇到的一个词开始。"
              description="查清词义，看一句语境，再决定是否把它留下。"
            />
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
                      setResults([item.word]);
                      setSearched(true);
                      setSearchQuery(item.word.lemma);
                      setPage(null);
                      void choose(item.word);
                    }}
                  >
                    <strong>{item.word.lemma}</strong>
                    <span>
                      {item.word.senses?.find((sense) => sense.definitionZh?.trim())
                        ?.definitionZh || '暂无中文释义'}
                    </span>
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
