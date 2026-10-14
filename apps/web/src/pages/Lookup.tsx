import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bookmark, Search, Trash2, Pause, Play, Pencil, ArrowRight, Languages } from 'lucide-react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useApp, useRemote } from '../AppContext';
import { api, post } from '../lib/api';
import type { PageInfo, Word, WordbookItem } from '../lib/types';
import { TranslationPanel } from '../components/Translation';
import { dictionaryText } from '../lib/dictionary';
import {
  isWordbookSaved,
  mutateWordbook,
  wordbookEntryKey,
  wordbookEntryPath,
  type WordbookEntryResponse,
} from '../lib/wordbook';
import {
  Dialog,
  Empty,
  ErrorNotice,
  Heading,
  Loading,
  Notice,
  Panel,
  WordSaveButton,
  WordView,
  formatDate,
} from '../components/UI';

export function LookupPage({ initialTab = 'lookup' }: { initialTab?: 'lookup' | 'wordbook' }) {
  const { user, scope } = useApp();
  const client = useQueryClient();
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [params] = useSearchParams();
  const [tab, setTab] = useState<'lookup' | 'wordbook' | 'translation'>(initialTab);
  const [query, setQuery] = useState(params.get('q') ?? '');
  useEffect(() => {
    const value = params.get('q');
    if (value !== null) {
      setQuery(value);
      setTab('lookup');
    }
  }, [params]);
  const [results, setResults] = useState<Word[]>([]);
  const [selected, setSelected] = useState<Word | null>(null);
  const [page, setPage] = useState<PageInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<unknown>(null);
  const selection = useRef(0);
  const [translationText, setTranslationText] = useState('');
  const [busy, setBusy] = useState(false);
  const saveBusy = useRef(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<WordbookItem | null>(null);
  const [note, setNote] = useState('');
  const [wordbookStatus, setWordbookStatus] = useState<'active' | 'consolidated'>('active');
  const wordbook = useInfiniteQuery({
    queryKey: [scope, 'wordbook', 'pages', wordbookStatus],
    queryFn: ({ pageParam }) =>
      api<{ items: WordbookItem[]; page: PageInfo }>(
        `wordbook?limit=50&status=${wordbookStatus}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) =>
      last.page?.hasMore ? (last.page.nextCursor ?? undefined) : undefined,
    enabled: !!user,
    retry: false,
  });
  const wordbookItems = useMemo(
    () => [
      ...new Map(
        (wordbook.data?.pages.flatMap((batch) => batch.items) ?? []).map((item) => [item.id, item]),
      ).values(),
    ],
    [wordbook.data],
  );
  const wordbookPage = wordbook.data?.pages.at(-1)?.page;
  useEffect(() => {
    setEditing(null);
    setNote('');
    setNotice('');
    setError(null);
    setBusy(false);
    saveBusy.current = false;
    setWordbookStatus('active');
  }, [scope]);
  const selectedCollection = useRemote<WordbookEntryResponse>(
    'wordbook-entry',
    wordbookEntryPath(selected?.id ?? ''),
    !!user && !!selected,
  );
  const selectedSaved = !!selected && isWordbookSaved(selectedCollection.data, selected.id);
  const selectedConsolidated =
    !!selected && selectedCollection.data?.consolidatedItem?.wordId === selected.id;
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
    if (saveBusy.current) return;
    saveBusy.current = true;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const remove = selectedSaved && selected?.id === wordId;
      const receipt = await mutateWordbook(
        client,
        scope,
        wordId,
        remove,
        () => currentScope.current === scope,
      );
      if (receipt && currentScope.current === scope)
        setNotice(
          remove
            ? selectedConsolidated
              ? '已移除已巩固收藏，学习进度仍保留。'
              : '已从生词本移除，学习进度仍保留。'
            : '已加入生词本，可在“我的生词本”查看。',
        );
    } catch (value) {
      if (currentScope.current === scope) setError(value);
    } finally {
      if (currentScope.current === scope) {
        saveBusy.current = false;
        setBusy(false);
      }
    }
  }
  async function change(item: WordbookItem, input: Record<string, unknown>, method = 'PATCH') {
    if (saveBusy.current) return;
    saveBusy.current = true;
    setError(null);
    setBusy(true);
    try {
      if (method === 'DELETE') {
        await mutateWordbook(
          client,
          scope,
          item.wordId,
          true,
          () => currentScope.current === scope,
        );
      } else {
        const result = await post<{ item: WordbookItem }>(
          wordbookEntryPath(item.wordId),
          input,
          method,
        );
        if (currentScope.current !== scope) return;
        client.setQueryData<WordbookEntryResponse>(
          wordbookEntryKey(scope, item.wordId),
          (previous) => ({
            ...previous,
            item: result.item,
          }),
        );
        void client.resetQueries({ queryKey: [scope, 'wordbook'] }).catch(() => {});
      }
      if (currentScope.current === scope) {
        setEditing(null);
        setNotice(method === 'DELETE' ? '已从生词本移除，学习进度仍保留。' : '生词本记录已保存。');
      }
    } catch (value) {
      if (currentScope.current === scope) setError(value);
    } finally {
      if (currentScope.current === scope) {
        saveBusy.current = false;
        setBusy(false);
      }
    }
  }
  async function restore(item: WordbookItem) {
    if (saveBusy.current) return;
    saveBusy.current = true;
    setBusy(true);
    setError(null);
    try {
      const receipt = await mutateWordbook(
        client,
        scope,
        item.wordId,
        false,
        () => currentScope.current === scope,
      );
      if (receipt && currentScope.current === scope) {
        setWordbookStatus('active');
        setNotice('已重新加入生词本，学习进度与备注仍保留。');
      }
    } catch (value) {
      if (currentScope.current === scope) setError(value);
    } finally {
      if (currentScope.current === scope) {
        saveBusy.current = false;
        setBusy(false);
      }
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
        description="读懂释义，听清发音，在一句语境里记住它。"
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
      {tab === 'wordbook' && user && (
        <div className="wordbook-filters">
          <div className="tab-row" aria-label="生词本分类">
            <button
              className={wordbookStatus === 'active' ? 'active' : ''}
              onClick={() => setWordbookStatus('active')}
            >
              正在巩固
            </button>
            <button
              className={wordbookStatus === 'consolidated' ? 'active' : ''}
              onClick={() => setWordbookStatus('consolidated')}
            >
              已巩固
            </button>
          </div>
          <p>
            收藏留在生词本；复习后逐渐熟悉的词，可以在<Link to="/known">熟词页</Link>查看。
          </p>
        </div>
      )}
      {tab === 'translation' ? (
        <TranslationPanel key={translationText} initialText={translationText} />
      ) : tab === 'lookup' ? (
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
                      <span className="lookup-word-label">
                        {selected.entryKind === 'phrase' ? '词组' : '释义'}
                      </span>
                      <div className="action-row">
                        <button
                          className="icon-button"
                          aria-label="翻译这个词"
                          title="翻译这个词"
                          onClick={() => {
                            setTranslationText(selected.lemma);
                            setTab('translation');
                          }}
                        >
                          <Languages size={18} />
                        </button>
                        <WordSaveButton
                          lemma={selected.lemma}
                          saved={selectedSaved}
                          consolidated={selectedConsolidated}
                          busy={busy}
                          disabled={
                            !!user &&
                            (selectedCollection.isFetching ||
                              !!selectedCollection.error ||
                              !selectedCollection.data)
                          }
                          onClick={() => void collect(selected.id)}
                        />
                      </div>
                    </div>
                    {detailBusy ? (
                      <Loading text="正在读取完整释义…" />
                    ) : (
                      <>
                        <ErrorNotice
                          error={detailError || selectedCollection.error}
                          onRetry={() => {
                            void choose(selected);
                            if (selectedCollection.error) void selectedCollection.refetch();
                          }}
                        />
                        {detailError && <Notice>暂时只能显示简略释义，请重试。</Notice>}
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
      ) : wordbookItems.length ? (
        <Panel className="wordbook-panel">
          <div className="section-heading">
            <h2>
              已加载 {wordbookItems.length} / {wordbookPage?.total ?? wordbookItems.length} 个词
            </h2>
            <span className="tiny-label">收藏与记忆进度分开</span>
          </div>
          <div className="wordbook-list">
            {wordbookItems.map((item) => (
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
                    {item.status === 'consolidated' || item.graduatedAt
                      ? '已巩固 · 可重新加入生词本'
                      : item.paused
                        ? '已暂停复习'
                        : item.progress?.dueAt
                          ? `下次 ${formatDate(item.progress.dueAt)}`
                          : '尚未完成记忆评价'}
                  </small>
                </div>
                <div className="row-actions">
                  {item.status === 'consolidated' || item.graduatedAt ? (
                    <button
                      className="button ghost"
                      disabled={busy}
                      onClick={() => void restore(item)}
                    >
                      重新加入
                    </button>
                  ) : (
                    <>
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
                          item.paused
                            ? `恢复 ${item.word.lemma} 复习`
                            : `暂停 ${item.word.lemma} 复习`
                        }
                        onClick={() => void change(item, { paused: !item.paused })}
                      >
                        {item.paused ? <Play size={16} /> : <Pause size={16} />}
                      </button>
                    </>
                  )}
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
          {wordbook.hasNextPage && (
            <div className="pagination-actions">
              <button
                className="button ghost"
                disabled={wordbook.isFetching || busy}
                onClick={() => void wordbook.fetchNextPage()}
              >
                {wordbook.isFetchingNextPage ? '正在读取更多…' : '更多生词'}{' '}
                <ArrowRight size={16} />
              </button>
            </div>
          )}
        </Panel>
      ) : (
        <Empty
          title={wordbookStatus === 'consolidated' ? '还没有已巩固的词。' : '生词本还是空的。'}
          description={
            wordbookStatus === 'consolidated'
              ? '继续复习，已经巩固的收藏会保留在这里。'
              : '先查一个词，再把它和自己的备注留下。'
          }
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
