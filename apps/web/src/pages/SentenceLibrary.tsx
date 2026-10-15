import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Quote, Search, Trash2 } from 'lucide-react';
import { useApp, useRemote } from '../AppContext';
import { api, post } from '../lib/api';
import type { Word } from '../lib/types';
import type { SavedSentence, SentencePage } from '../lib/mobile-content-types';
import { Dialog, Empty, ErrorNotice, Loading, LoginPrompt, Notice } from '../components/UI';
import { InteractiveEnglish } from '../components/InteractiveEnglish';
import { SentenceSaveButton } from '../components/SentenceSaveButton';
import { usePageLifetime } from './usePageLifetime';
import './mobile-content.css';

export function SentencesPage() {
  const { user } = useApp();
  const owner = usePageLifetime();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const filterWord = params.get('wordId') ?? '';
  const [query, setQuery] = useState(''),
    [input, setInput] = useState('');
  const [finder, setFinder] = useState(!!filterWord),
    [term, setTerm] = useState(''),
    [findQuery, setFindQuery] = useState('');
  const [wordId, setWordId] = useState(filterWord);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState('');
  const [removing, setRemoving] = useState<SavedSentence | null>(null);
  const saving = useRef(false);
  useEffect(() => {
    setWordId(filterWord);
    setFinder(!!filterWord);
  }, [filterWord]);
  useEffect(() => {
    setQuery('');
    setInput('');
    setTerm('');
    setFindQuery('');
    setBusy('');
    setError(null);
    setNotice('');
    setRemoving(null);
    saving.current = false;
  }, [owner.scope]);
  const word = useRemote<{ word: Word }>(
    'sentence-source-word',
    `words/${encodeURIComponent(wordId)}`,
    !!user && !!wordId,
  );
  const found = useRemote<{ items: Word[] }>(
    'sentence-source-search',
    `dictionary?q=${encodeURIComponent(findQuery)}&limit=10`,
    !!user && !!findQuery,
  );
  const list = useInfiniteQuery({
    queryKey: [owner.scope, 'sentences', 'pages', query, filterWord],
    enabled: !!user && owner.active,
    retry: false,
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      api<SentencePage>(
        `sentences?q=${encodeURIComponent(query)}&limit=25${filterWord ? `&wordId=${encodeURIComponent(filterWord)}` : ''}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.page.hasMore ? (last.page.nextCursor ?? undefined) : undefined,
  });
  const examples = [
    ...(word.data?.word.examples ?? []).map((item) => ({
      ...item,
      sourceType: 'word-example' as const,
    })),
    ...(word.data?.word.senses ?? [])
      .filter((item) => item.exampleEn && item.exampleZh)
      .map((item) => ({
        id: item.id,
        exampleEn: item.exampleEn!,
        exampleZh: item.exampleZh!,
        sourceType: 'sense' as const,
      })),
  ].filter(
    (item, index, all) =>
      !!item.exampleEn &&
      !!item.exampleZh &&
      all.findIndex(
        (other) => other.exampleEn === item.exampleEn && other.exampleZh === item.exampleZh,
      ) === index,
  );
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  async function mutate(id: string, action: () => Promise<unknown>, message: string) {
    if (saving.current) return;
    saving.current = true;
    const request = owner.capture();
    setBusy(id);
    setError(null);
    setNotice('');
    try {
      const result = await action();
      if (!owner.isCurrent(request)) return;
      setNotice(
        result && typeof result === 'object' && 'duplicate' in result && result.duplicate
          ? '这条例句已经在句库中。'
          : message,
      );
      setRemoving(null);
      await client.invalidateQueries({ queryKey: [owner.scope, 'sentences'] });
    } catch (value) {
      if (owner.isCurrent(request)) setError(value);
    } finally {
      if (owner.isCurrent(request)) {
        saving.current = false;
        setBusy('');
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
    <div className="page mobile-sentence-library">
      <Link className="mobile-back" to="/content">
        ← 内容中心
      </Link>
      <header className="mobile-content-heading">
        <span className="mobile-kicker">MY SENTENCES</span>
        <h1>我的句库</h1>
        <p>收藏在语境里遇见的句子，反复读懂它。</p>
      </header>
      <div className="mobile-toolbar">
        <span>{list.data ? `${list.data.pages[0]?.page.total ?? 0} 条收藏` : '双语例句收藏'}</span>
        <button className="button primary" onClick={() => setFinder(!finder)}>
          <Plus size={17} />
          收藏例句
        </button>
      </div>
      {filterWord && (
        <p className="mobile-caption">
          正在查看这个词的收藏。<Link to="/sentences">查看全部句库</Link>
        </p>
      )}
      {finder && (
        <section className="mobile-editor-panel">
          <h2>找到喜欢的一句话</h2>
          <form
            className="mobile-search"
            onSubmit={(event) => {
              event.preventDefault();
              setFindQuery(term.trim());
            }}
          >
            <Search size={17} />
            <input
              value={term}
              maxLength={120}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="查找一个词或词组"
              aria-label="查找例句所属词"
            />
            <button>查找</button>
          </form>
          <ErrorNotice error={found.error || word.error} />
          {found.isFetching && <Loading text="正在查找词条…" />}
          {findQuery && found.data && (
            <div className="mobile-source-words">
              {found.data.items.length ? (
                found.data.items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setWordId(item.id);
                      setFindQuery('');
                    }}
                  >
                    {item.lemma}
                  </button>
                ))
              ) : (
                <p>没有找到这个词。试试其他词形。</p>
              )}
            </div>
          )}
          {wordId && word.isPending && <Loading />}
          {word.data && (
            <>
              <h3>{word.data.word.lemma}</h3>
              {examples.length ? (
                examples.map((item) => (
                  <div className="mobile-source-example" key={`${item.sourceType}:${item.id}`}>
                    <p lang="en">
                      <InteractiveEnglish text={item.exampleEn} />
                    </p>
                    <p lang="zh">{item.exampleZh}</p>
                    <SentenceSaveButton
                      wordId={word.data.word.id}
                      sourceType={item.sourceType}
                      sourceId={item.id}
                    />
                  </div>
                ))
              ) : (
                <p className="mobile-caption">这个词暂无可收藏的双语例句。可以先记下自己的理解。</p>
              )}
            </>
          )}
          <p className="mobile-caption">
            也可以把自己的句子和理解，写在<Link to="/notes">学习笔记</Link>中。
          </p>
        </section>
      )}
      <form
        className="mobile-search"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(input.trim());
        }}
      >
        <Search size={17} />
        <input
          value={input}
          maxLength={120}
          onChange={(event) => setInput(event.target.value)}
          placeholder="搜索收藏的句子"
          aria-label="搜索句库"
        />
        <button>搜索</button>
      </form>
      <ErrorNotice error={error || list.error} onRetry={() => void list.refetch()} />
      {notice && <Notice>{notice}</Notice>}
      {list.isPending ? (
        <Loading />
      ) : rows.length ? (
        <div className="mobile-sentence-list">
          {rows.map((item) => (
            <article className="mobile-sentence-card" key={item.id}>
              <span className="mobile-quote-mark" aria-hidden="true">
                “
              </span>
              <p lang="en">
                <InteractiveEnglish text={item.exampleEn} />
              </p>
              <p lang="zh">{item.exampleZh}</p>
              <footer>
                <span>再回来，读懂这一句</span>
                <button
                  className="icon-button"
                  aria-label={`移除例句：${item.exampleEn}`}
                  disabled={!!busy}
                  onClick={() => setRemoving(item)}
                >
                  <Trash2 size={17} />
                </button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title={query ? '没有匹配的收藏' : '从一句真正读懂的话开始'}
          description="在词条里收藏双语例句，它们会保存在这里。"
          action={
            <button className="button primary" onClick={() => setFinder(true)}>
              查词，收藏一句
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
        title="移除这句收藏"
        onClose={() => {
          if (!busy) setRemoving(null);
        }}
      >
        {removing && (
          <>
            <p>{removing.exampleEn}</p>
            <p>{removing.exampleZh}</p>
            <p className="mobile-caption">以后仍能从词条里重新收藏。</p>
            <div className="action-row">
              <button className="button ghost" disabled={!!busy} onClick={() => setRemoving(null)}>
                保留
              </button>
              <button
                className="button primary"
                disabled={!!busy}
                onClick={() =>
                  void mutate(
                    removing.id,
                    () => api(`sentences/${encodeURIComponent(removing.id)}`, { method: 'DELETE' }),
                    '例句已移出句库。',
                  )
                }
              >
                确认移除
              </button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
