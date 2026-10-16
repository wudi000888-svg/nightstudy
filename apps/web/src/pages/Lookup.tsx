import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import {
  Search,
  Trash2,
  Pause,
  Play,
  Pencil,
  ArrowLeft,
  X,
  SlidersHorizontal,
  Eye,
  EyeOff,
  ChevronDown,
  ArrowUpRight,
} from 'lucide-react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useApp, useRemote } from '../AppContext';
import { useScreenActive } from '../lib/screen-lifecycle';
import { api, post } from '../lib/api';
import type { Word, WordbookItem } from '../lib/types';
import { dictionaryText } from '../lib/dictionary';
import { stopApplicationAudio } from '../lib/audio-manager';
import { AudioButton } from '../components/Pronunciation';
import {
  lookupConditions,
  lookupParams,
  lookupRequest,
  isWordbookBrief,
  type LookupKind,
  type LookupMatch,
  type LookupSort,
  type LookupConditions,
  type DictionaryBrief,
  type WordbookBrief,
  type LookupResponse,
} from '../lib/lookup-state';
import {
  isWordbookSaved,
  mutateWordbook,
  wordbookEntryKey,
  wordbookEntryPath,
  type WordbookEntryResponse,
} from '../lib/wordbook';
import { useAppNavigation } from '../components/AppNavigation';
import {
  Dialog,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  WordSaveButton,
  WordView,
  formatDate,
} from '../components/UI';
import './mobile-lookup.css';

function SavedWordPronunciation({ wordId }: { wordId: string }) {
  const word = useRemote<{ word: Word }>('words', `words/${encodeURIComponent(wordId)}`);
  return word.data?.word.id === wordId ? (
    <AudioButton word={word.data.word} />
  ) : word.error ? (
    <button type="button" className="text-link" onClick={() => void word.refetch()}>
      重新读取发音
    </button>
  ) : (
    <span className="lookup-row-loading" role="status">
      正在读取发音…
    </span>
  );
}

export function LookupPage({ initialTab = 'lookup' }: { initialTab?: LookupKind }) {
  const { scope } = useApp();
  return <LookupContent key={`${scope}:${initialTab}`} kind={initialTab} />;
}
function LookupContent({ kind }: { kind: LookupKind }) {
  const { user, scope } = useApp();
  const active = useScreenActive();
  const client = useQueryClient();
  const navigation = useAppNavigation();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const conditions = lookupConditions(params, kind);
  const { q, match, sort, status } = conditions;
  const queryTooShort =
    match === 'contains' && !!q && !/[\p{L}\p{N}]{3}/u.test(q.normalize('NFKC'));
  const entry = params.get('entry');
  const sense = params.get('sense') ?? undefined;
  const listKey = [scope, kind, 'pages', q, match, sort, status];
  const [input, setInput] = useState(q);
  const [composing, setComposing] = useState(false);
  const [selected, setSelected] = useState<Word | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<unknown>(null);
  const [mutationWords, setMutationWords] = useState<Set<string>>(() => new Set());
  const [mutationError, setMutationError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<WordbookBrief | null>(null);
  const [note, setNote] = useState('');
  const [detailRetry, setDetailRetry] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [draftMatch, setDraftMatch] = useState<LookupMatch>(match);
  const [draftSort, setDraftSort] = useState<LookupSort>(sort);
  const [showDefinitions, setShowDefinitions] = useState(false);
  const [expandedWord, setExpandedWord] = useState<string | null>(null);
  const lifetime = useRef(0);
  const foreground = useRef(active);
  const locks = useRef(new Set<string>());
  const listElement = useRef<HTMLElement | null>(null);
  const pageElement = useRef<HTMLDivElement | null>(null);
  const listPosition = useRef({ page: 0, list: 0, screen: 0 });
  const listOrigin = useRef<{ wordId: string; listKey: string; listParams: string } | null>(null);
  const previousEntry = useRef(entry);
  const detailCache = useRef(new Map<string, Word>());
  const inputEdited = useRef(false);
  const inputRevision = useRef(0);
  const pendingInputRoute = useRef<{ q: string; revision: number } | null>(null);
  const sortExplicit = useRef(params.has('sort'));
  const matchLabel = {
    smart: '智能匹配',
    prefix: '开头匹配',
    contains: '包含匹配',
    exact: '精确匹配',
  }[match];
  const sortLabel = {
    relevance: '相关度',
    'updated-desc': '最近更新',
    az: 'A → Z',
    za: 'Z → A',
  }[sort];
  foreground.current = active;
  useEffect(() => {
    lifetime.current++;
    return () => {
      lifetime.current++;
      stopApplicationAudio();
    };
  }, []);
  useEffect(() => {
    const written = pendingInputRoute.current;
    pendingInputRoute.current = null;
    if (written?.q === q && written.revision !== inputRevision.current) return;
    inputEdited.current = false;
    setInput(q);
  }, [q]);
  function update(next: Partial<LookupConditions>, replace = true) {
    if (!foreground.current) return;
    stopApplicationAudio();
    setExpandedWord(null);
    setParams(lookupParams({ ...conditions, ...next }, kind), { replace });
  }
  function submit(text = input) {
    const nextQ = text.trim();
    inputEdited.current = false;
    if (nextQ === q && !entry) return;
    pendingInputRoute.current = { q: nextQ, revision: inputRevision.current };
    update({
      q: nextQ,
      sort:
        !sortExplicit.current && kind === 'wordbook'
          ? nextQ
            ? 'relevance'
            : 'updated-desc'
          : sort,
    });
  }
  useEffect(() => {
    if (!active || composing || !inputEdited.current) return;
    const timer = setTimeout(() => submit(), 300);
    return () => clearTimeout(timer);
  }, [input, composing, active, q, match, sort, status]);
  const list = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam, signal }) =>
      api<LookupResponse>(lookupRequest(conditions, kind, pageParam), { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) =>
      last.page.hasMore ? (last.page.nextCursor ?? undefined) : undefined,
    enabled: active && !queryTooShort && (kind === 'lookup' ? !!q : !!user),
    retry: false,
  });
  const items = [
    ...new Map(
      (list.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.id, item]),
    ).values(),
  ];
  const firstPage = list.data?.pages[0];
  const suggestions = firstPage?.suggestions ?? [];
  const selectedCollection = useRemote<WordbookEntryResponse>(
    'wordbook-entry',
    wordbookEntryPath(entry ?? ''),
    !!user && !!entry && active,
  );
  const saved = !!entry && isWordbookSaved(selectedCollection.data, entry);
  const consolidated = !!entry && selectedCollection.data?.consolidatedItem?.wordId === entry;
  // Search pages never choose the detail. A stable deep link is read independently.
  useEffect(() => {
    if (!entry || !active) return;
    const controller = new AbortController();
    const cached = detailCache.current.get(entry);
    setSelected(cached ?? null);
    setDetailError(null);
    setDetailBusy(true);
    const life = lifetime.current;
    void api<{ word: Word }>(`words/${encodeURIComponent(entry)}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted || lifetime.current !== life) return;
        if (data.word.id !== entry) throw new Error('词条暂未正确载入，请重试。');
        detailCache.current.delete(entry);
        detailCache.current.set(entry, data.word);
        while (detailCache.current.size > 24)
          detailCache.current.delete(detailCache.current.keys().next().value!);
        setSelected(data.word);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && lifetime.current === life) {
          if ((error as { status?: number })?.status === 404) {
            detailCache.current.delete(entry);
            setSelected(null);
          }
          setDetailError(error);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && lifetime.current === life) setDetailBusy(false);
      });
    return () => {
      controller.abort();
      stopApplicationAudio();
    };
  }, [entry, active, detailRetry]);
  useEffect(() => {
    const returned = !!previousEntry.current && !entry;
    const opened = !!entry && entry !== previousEntry.current;
    previousEntry.current = entry;
    if (!active || (!returned && !opened)) return;
    const frame = window.requestAnimationFrame(() => {
      if (!foreground.current) return;
      const screen = pageElement.current?.closest<HTMLElement>('.h5-screen-content');
      if (screen) screen.scrollTop = returned ? listPosition.current.screen : 0;
      if (!returned) return;
      if (listElement.current) listElement.current.scrollTop = listPosition.current.list;
      window.scrollTo({ top: listPosition.current.page, behavior: 'instant' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entry, active]);
  function choose(word: DictionaryBrief) {
    if (!foreground.current) return;
    listPosition.current = {
      page: window.scrollY,
      list: listElement.current?.scrollTop ?? 0,
      screen: pageElement.current?.closest<HTMLElement>('.h5-screen-content')?.scrollTop ?? 0,
    };
    listOrigin.current = {
      wordId: word.id,
      listKey: location.key,
      listParams: String(lookupParams(conditions, kind)),
    };
    setParams(lookupParams(conditions, kind, word.id), { state: { lookupListKey: location.key } });
  }
  function returnToList() {
    stopApplicationAudio();
    if (canReturnToList) navigation.goBack();
    else setParams(lookupParams(conditions, kind), { replace: true });
  }
  function chooseSense(id: string) {
    if (!entry || !foreground.current) return;
    stopApplicationAudio();
    setParams(lookupParams(conditions, kind, entry, id), { replace: true, state: location.state });
  }
  async function mutate(
    wordId: string,
    action: (isCurrent: () => boolean) => Promise<unknown>,
    message: string,
  ) {
    if (locks.current.has(wordId)) return;
    if (!user) {
      setNotice('登录后可以收藏遇到的词。');
      return;
    }
    locks.current.add(wordId);
    setMutationWords(new Set(locks.current));
    setMutationError(null);
    setNotice('');
    const life = lifetime.current;
    try {
      await action(() => lifetime.current === life);
      if (life !== lifetime.current) return;
      setEditing(null);
      setNotice(message);
    } catch (error) {
      if (life === lifetime.current) setMutationError(error);
    } finally {
      if (life === lifetime.current) {
        locks.current.delete(wordId);
        setMutationWords(new Set(locks.current));
      }
    }
  }
  async function change(item: WordbookBrief, input: Record<string, unknown>) {
    return mutate(
      item.wordId,
      async () => {
        const life = lifetime.current;
        const result = await post<{ item: WordbookItem }>(
          wordbookEntryPath(item.wordId),
          input,
          'PATCH',
        );
        if (lifetime.current !== life) return;
        client.setQueryData<WordbookEntryResponse>(wordbookEntryKey(scope, item.wordId), (old) => ({
          ...old,
          item: result.item,
        }));
        await client.resetQueries({ queryKey: [scope, 'wordbook'] });
      },
      '生词本记录已保存。',
    );
  }
  const currentWord = selected?.id === entry ? selected : null;
  const canReturnToList =
    !!entry &&
    listOrigin.current?.wordId === entry &&
    listOrigin.current.listKey ===
      (location.state as { lookupListKey?: string } | null)?.lookupListKey &&
    listOrigin.current.listParams === String(lookupParams(conditions, kind));
  const invalidSense =
    !!sense &&
    !!currentWord &&
    !(currentWord.senses?.length ? currentWord.senses : (currentWord.dictionarySenses ?? [])).some(
      (item) => item.id === sense,
    );
  const listChanged =
    !!list.error &&
    ['list_changed', 'cursor_expired', 'invalid_cursor'].includes(
      String((list.error as { code?: string }).code),
    );
  const busyList = list.isFetching && !list.isFetchingNextPage;
  const saveAction =
    currentWord && entry ? (
      <WordSaveButton
        lemma={currentWord.lemma}
        saved={saved}
        consolidated={consolidated}
        busy={mutationWords.has(entry)}
        disabled={
          !!user &&
          (selectedCollection.isFetching || !!selectedCollection.error || !selectedCollection.data)
        }
        onClick={() =>
          void mutate(
            entry,
            (isCurrent) => mutateWordbook(client, scope, entry, saved, isCurrent),
            saved ? '已移除收藏，学习进度仍保留。' : '已加入生词本。',
          )
        }
      />
    ) : undefined;
  return (
    <div
      ref={pageElement}
      className={`page lookup-page lookup-h5${entry ? ' has-mobile-detail' : ''}`}
    >
      {!entry && (
        <>
          {kind === 'wordbook' && user && (
            <div className="lookup-status-tabs" aria-label="生词本分类">
              {(
                [
                  ['active', '正在巩固'],
                  ['consolidated', '已巩固'],
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={status === value}
                  onClick={() => update({ status: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <form
            className="search-bar lookup-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              if (!composing) submit();
            }}
          >
            <Search size={20} aria-hidden="true" />
            <input
              value={input}
              aria-label={kind === 'wordbook' ? '搜索我的生词本' : '查词输入'}
              placeholder={kind === 'wordbook' ? '在生词本中查找' : '输入英文单词或词组'}
              maxLength={160}
              enterKeyHint="search"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => {
                inputRevision.current++;
                inputEdited.current = true;
                setInput(event.target.value);
              }}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={(event) => {
                inputRevision.current++;
                setComposing(false);
                inputEdited.current = true;
                setInput(event.currentTarget.value);
              }}
            />
            {input && (
              <button
                type="button"
                className="lookup-clear"
                aria-label="清空搜索"
                onClick={() => {
                  setInput('');
                  submit('');
                }}
              >
                <X size={17} />
              </button>
            )}
            <button type="submit" className="lookup-submit">
              查找
            </button>
          </form>
          <div className="lookup-browse-toolbar">
            <button
              type="button"
              className="lookup-filter-summary"
              aria-label={`筛选与排序：${matchLabel}，${sortLabel}`}
              onClick={() => {
                setDraftMatch(match);
                setDraftSort(sort);
                setFilterOpen(true);
              }}
            >
              <SlidersHorizontal size={16} />
              <span>
                {matchLabel} · {sortLabel}
              </span>
              <ChevronDown size={14} />
            </button>
            {kind === 'wordbook' && (
              <button
                type="button"
                className="lookup-definition-toggle"
                aria-label={showDefinitions ? '隐藏全部释义' : '显示全部释义'}
                aria-pressed={showDefinitions}
                onClick={() => setShowDefinitions((value) => !value)}
              >
                {showDefinitions ? <EyeOff size={17} /> : <Eye size={17} />}
                <span>释义</span>
              </button>
            )}
          </div>
        </>
      )}
      {!!notice && <Notice>{notice}</Notice>}
      <ErrorNotice error={mutationError} />
      {entry ? (
        <section className="lookup-entry" aria-label="词条详情">
          {!canReturnToList && (
            <div className="lookup-entry-toolbar">
              <button type="button" className="dictionary-back" onClick={returnToList}>
                <ArrowLeft size={19} />
                查看匹配词
              </button>
            </div>
          )}
          {detailBusy && <Loading text="正在读取词条…" />}
          <ErrorNotice
            error={detailError || selectedCollection.error}
            onRetry={() => {
              setDetailRetry((value) => value + 1);
              if (selectedCollection.error) void selectedCollection.refetch();
            }}
          />
          {invalidSense ? (
            <Empty
              title="这个词义暂时不可用。"
              description="可以查看这个词的其他词义。"
              action={
                <button
                  className="button ghost"
                  onClick={() =>
                    setParams(lookupParams(conditions, kind, entry), { replace: true })
                  }
                >
                  查看其他词义
                </button>
              }
            />
          ) : (
            currentWord && (
              <WordView
                word={currentWord}
                focusSenseId={sense}
                onSenseChange={chooseSense}
                headerAction={saveAction}
              />
            )
          )}
        </section>
      ) : kind === 'wordbook' && !user ? (
        <Empty
          title="把遇到的词留下。"
          description="登录后可以使用自己的生词本。"
          action={
            <Link className="button primary" to="/auth">
              登录
            </Link>
          }
        />
      ) : (
        <>
          {kind === 'lookup' && !q ? (
            <Empty title="查清一个词，读懂一种语境。" description="支持单词、词组和模糊查找。" />
          ) : (
            <>
              <div className="lookup-results-summary" role="status" aria-live="polite">
                {listChanged
                  ? ''
                  : busyList
                    ? '正在查找…'
                    : firstPage
                      ? `${q ? `“${q}” · ` : ''}${firstPage.page.total === null ? `已显示 ${items.length} 个词` : `${firstPage.page.total} 个匹配`}`
                      : ''}
              </div>
              {listChanged ? (
                <Notice>
                  列表已有更新，请重新读取。
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => void client.resetQueries({ queryKey: listKey, exact: true })}
                  >
                    重新读取
                  </button>
                </Notice>
              ) : (
                <ErrorNotice
                  error={list.error}
                  onRetry={() => {
                    if (list.isFetchNextPageError) void list.fetchNextPage();
                    else void list.refetch();
                  }}
                />
              )}
              {queryTooShort ? (
                <Notice>包含匹配需要至少连续三个英文字母或数字。</Notice>
              ) : (
                list.isPending && <Loading text="正在读取词语…" />
              )}
              {suggestions.length > 0 && !listChanged && (
                <section className="lookup-suggestions" aria-label="拼写建议">
                  <span>可能想查</span>
                  <div>
                    {suggestions.map((suggestion) => (
                      <button
                        key={suggestion.id}
                        type="button"
                        onClick={() => {
                          setInput(suggestion.lemma);
                          submit(suggestion.lemma);
                        }}
                      >
                        {suggestion.lemma}
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {!listChanged && (
                <section
                  ref={listElement}
                  className="lookup-results"
                  aria-label={kind === 'wordbook' ? '我的生词本列表' : '词典搜索结果'}
                  aria-busy={busyList}
                >
                  {items.map((item) => {
                    const savedItem = isWordbookBrief(item) ? item : null;
                    const word = savedItem ? savedItem.word : (item as DictionaryBrief);
                    const rowBusy = mutationWords.has(word.id);
                    const expanded = expandedWord === word.id;
                    return (
                      <article
                        className={`lookup-result-row${savedItem ? ' lookup-compact-row' : ''}${expanded ? ' is-expanded' : ''}`}
                        key={item.id}
                        data-word-id={word.id}
                      >
                        <button
                          className="lookup-result-word"
                          type="button"
                          aria-label={
                            savedItem
                              ? `${expanded ? '收起' : '展开'} ${word.lemma}`
                              : `查看 ${word.lemma} 完整词条`
                          }
                          aria-expanded={savedItem ? expanded : undefined}
                          onClick={() => {
                            if (savedItem) setExpandedWord(expanded ? null : word.id);
                            else choose(word);
                          }}
                        >
                          <span className="lookup-result-lemma">
                            {word.lemma}
                            {word.matchType === 'exact' && <small>精确</small>}
                            {savedItem && <ChevronDown size={16} className="lookup-row-chevron" />}
                          </span>
                          {(!savedItem || showDefinitions || expanded) && (
                            <span className="lookup-result-definition">
                              {word.pos?.length > 0 && <em>{word.pos.join(' / ')}</em>}
                              {dictionaryText(word.definitionZh) ||
                                dictionaryText(word.definitionEn) ||
                                '查看词义'}
                            </span>
                          )}
                        </button>
                        {savedItem && expanded && (
                          <>
                            <SavedWordPronunciation wordId={word.id} />
                            <div className="lookup-result-personal">
                              {savedItem.note && <p>{savedItem.note}</p>}
                              <small>
                                {savedItem.status === 'consolidated' || savedItem.graduatedAt
                                  ? '已巩固'
                                  : savedItem.paused
                                    ? '已暂停复习'
                                    : savedItem.progress?.dueAt
                                      ? `下次复习 ${formatDate(savedItem.progress.dueAt)}`
                                      : '等待复习'}
                              </small>
                            </div>
                            <div className="lookup-row-actions">
                              <button
                                type="button"
                                aria-label={`查看 ${word.lemma} 完整词条`}
                                onClick={() => choose(word)}
                              >
                                完整词条 <ArrowUpRight size={15} />
                              </button>
                              {savedItem.status === 'consolidated' || savedItem.graduatedAt ? (
                                <button
                                  type="button"
                                  disabled={rowBusy}
                                  onClick={() =>
                                    void mutate(
                                      word.id,
                                      (isCurrent) =>
                                        mutateWordbook(client, scope, word.id, false, isCurrent),
                                      '已重新加入生词本。',
                                    )
                                  }
                                >
                                  重新加入
                                </button>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    title="编辑备注"
                                    aria-label={`编辑 ${word.lemma} 备注`}
                                    disabled={rowBusy}
                                    onClick={() => {
                                      setEditing(savedItem);
                                      setNote(savedItem.note);
                                    }}
                                  >
                                    <Pencil size={16} />
                                  </button>
                                  <button
                                    type="button"
                                    title={savedItem.paused ? '恢复复习' : '暂停复习'}
                                    aria-label={`${savedItem.paused ? '恢复' : '暂停'} ${word.lemma} 复习`}
                                    disabled={rowBusy}
                                    onClick={() =>
                                      void change(savedItem, { paused: !savedItem.paused })
                                    }
                                  >
                                    {savedItem.paused ? <Play size={16} /> : <Pause size={16} />}
                                  </button>
                                </>
                              )}
                              <button
                                type="button"
                                title="移除收藏"
                                aria-label={`移除 ${word.lemma} 收藏，保留学习进度`}
                                disabled={rowBusy}
                                onClick={() =>
                                  void mutate(
                                    word.id,
                                    (isCurrent) =>
                                      mutateWordbook(client, scope, word.id, true, isCurrent),
                                    '已移除收藏，学习进度仍保留。',
                                  )
                                }
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </>
                        )}
                      </article>
                    );
                  })}
                </section>
              )}
              {!list.isPending && !list.error && !items.length && (
                <Empty
                  title={
                    q
                      ? '没有匹配的词。'
                      : status === 'consolidated'
                        ? '还没有已巩固的词。'
                        : '生词本还是空的。'
                  }
                  description={
                    q ? '试试开头匹配，或检查拼写建议。' : '收藏遇到的词，复习时再与它相见。'
                  }
                />
              )}
              {list.hasNextPage && !listChanged && (
                <button
                  type="button"
                  className="lookup-load-more"
                  disabled={list.isFetching || listChanged}
                  onClick={() => {
                    if (active) void list.fetchNextPage();
                  }}
                >
                  {list.isFetchingNextPage ? '正在读取更多…' : '查看更多'}
                </button>
              )}
            </>
          )}
        </>
      )}
      <Dialog open={filterOpen && !entry} title="筛选与排序" onClose={() => setFilterOpen(false)}>
        <div className="lookup-filter-panel">
          <p>这些条件会应用于全部匹配词。</p>
          <label className="field">
            匹配方式
            <select
              aria-label="匹配方式"
              value={draftMatch}
              onChange={(event) => setDraftMatch(event.target.value as LookupMatch)}
            >
              <option value="smart">智能匹配</option>
              <option value="prefix">开头匹配</option>
              <option
                value="contains"
                disabled={!!q && !/[\p{L}\p{N}]{3}/u.test(q.normalize('NFKC'))}
              >
                包含匹配
              </option>
              <option value="exact">精确匹配</option>
            </select>
          </label>
          <label className="field">
            排序方式
            <select
              aria-label="排序方式"
              value={draftSort}
              onChange={(event) => setDraftSort(event.target.value as LookupSort)}
            >
              <option value="relevance">相关度</option>
              {kind === 'wordbook' && <option value="updated-desc">最近更新</option>}
              <option value="az">A → Z</option>
              <option value="za">Z → A</option>
            </select>
          </label>
          <button
            type="button"
            className="button primary full"
            onClick={() => {
              sortExplicit.current = true;
              update({ match: draftMatch, sort: draftSort });
              setFilterOpen(false);
            }}
          >
            应用筛选
          </button>
        </div>
      </Dialog>
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
          type="button"
          className="button primary"
          disabled={!!editing && mutationWords.has(editing.wordId)}
          onClick={() => {
            if (editing) void change(editing, { note });
          }}
        >
          保存备注
        </button>
      </Dialog>
    </div>
  );
}
