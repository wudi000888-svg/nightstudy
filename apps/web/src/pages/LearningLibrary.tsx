import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  Eye,
  EyeOff,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useApp } from '../AppContext';
import { useScreenActive } from '../lib/screen-lifecycle';
import { api } from '../lib/api';
import type { LibraryResponse, LibraryWord } from '../lib/mobile-content-types';
import {
  libraryConditions,
  libraryParams,
  libraryRequest,
  type LibraryConditions,
  type LibrarySort,
} from '../lib/library-state';
import { mutateWordbook } from '../lib/wordbook';
import { dictionaryText } from '../lib/dictionary';
import { stopApplicationAudio } from '../lib/audio-manager';
import {
  Dialog,
  Empty,
  ErrorNotice,
  Loading,
  LoginPrompt,
  Notice,
  WordSaveButton,
} from '../components/UI';
import { AudioButton } from '../components/Pronunciation';
import './mobile-content.css';
import './mobile-library.css';
export { SentencesPage } from './SentenceLibrary';
export { NotesPage } from './NotesLibrary';

export function LearningLibraryPage() {
  const { scope } = useApp();
  return <LearningLibraryContent key={scope} />;
}

function LearningLibraryContent() {
  const { user, scope } = useApp();
  const active = useScreenActive();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const conditions = libraryConditions(params);
  const { view, q: query, bookId, sort, anchor } = conditions;
  const [input, setInput] = useState(query);
  const [showDefinitions, setShowDefinitions] = useState(false);
  const [expandedWord, setExpandedWord] = useState<string | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [draftSort, setDraftSort] = useState<LibrarySort>(sort);
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [savedOverrides, setSavedOverrides] = useState<
    Map<string, { saved: boolean; item: LibraryWord }>
  >(() => new Map());
  const lifetime = useRef(0);
  const foreground = useRef(active);
  const saveLock = useRef(false);
  const page = useRef<HTMLDivElement | null>(null);
  const lastLocated = useRef('');
  const position = useRef({ screen: 0, page: 0 });
  const previousActive = useRef(active);
  const composing = useRef(false);
  foreground.current = active;
  const listKey = [scope, 'library', 'pages', bookId, view, query, sort, anchor];
  const list = useInfiniteQuery({
    queryKey: listKey,
    enabled: !!user && active,
    retry: false,
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      api<LibraryResponse>(libraryRequest(conditions, pageParam), { signal }),
    getNextPageParam: (last) =>
      last.page.hasMore ? (last.page.nextCursor ?? undefined) : undefined,
  });
  const firstPage = list.data?.pages[0];
  const rows = [
    ...new Map(
      (list.data?.pages.flatMap((result) => result.items) ?? []).map((item) => [
        item.word.id,
        item,
      ]),
    ).values(),
  ];
  const bookTitle = firstPage?.book?.title ?? '本书';
  const locating = !!bookId && !!query;
  const anchorMissing = !!anchor && (list.error as { status?: number } | null)?.status === 404;
  const changed = ['list_changed', 'cursor_expired', 'invalid_cursor'].includes(
    String((list.error as { code?: string } | null)?.code),
  );
  const invalidRange = changed || (list.error as { status?: number } | null)?.status === 404;
  const sortLabel = { book: '词书顺序', az: 'A → Z', za: 'Z → A', recent: '最近学习' }[sort];
  useEffect(() => {
    setInput(query);
  }, [query]);
  useEffect(() => {
    lifetime.current++;
    return () => {
      lifetime.current++;
      stopApplicationAudio();
    };
  }, []);
  useEffect(() => {
    const wasActive = previousActive.current;
    const returned = active && !wasActive;
    previousActive.current = active;
    if (!active && wasActive) {
      position.current = {
        screen: page.current?.closest<HTMLElement>('.h5-screen-content')?.scrollTop ?? 0,
        page: window.scrollY,
      };
      stopApplicationAudio();
    }
    if (!returned) return;
    const frame = requestAnimationFrame(() => {
      const screen = page.current?.closest<HTMLElement>('.h5-screen-content');
      if (screen) screen.scrollTop = position.current.screen;
      window.scrollTo({ top: position.current.page, behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  useEffect(() => {
    if (!active || invalidRange || !anchor || firstPage?.page.anchorWordId !== anchor) return;
    const identity = `${bookId}:${view}:${sort}:${anchor}`;
    if (lastLocated.current === identity) return;
    const frame = requestAnimationFrame(() => {
      const row = [...(page.current?.querySelectorAll<HTMLElement>('[data-word-id]') ?? [])].find(
        (element) => element.dataset.wordId === anchor,
      );
      if (!row || !foreground.current) return;
      lastLocated.current = identity;
      row.scrollIntoView({ block: 'center', behavior: 'instant' });
      setExpandedWord(anchor);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, invalidRange, anchor, bookId, view, sort, firstPage]);
  function update(next: Partial<LibraryConditions>) {
    if (!foreground.current) return;
    stopApplicationAudio();
    setExpandedWord(null);
    lastLocated.current = '';
    setParams(libraryParams({ ...conditions, anchor: '', ...next }), { replace: true });
  }
  function detail(item: LibraryWord) {
    if (!foreground.current) return;
    position.current = {
      screen: page.current?.closest<HTMLElement>('.h5-screen-content')?.scrollTop ?? 0,
      page: window.scrollY,
    };
    stopApplicationAudio();
    navigate(
      `/lookup?q=${encodeURIComponent(item.word.lemma)}&entry=${encodeURIComponent(item.word.id)}`,
    );
  }
  async function save(item: LibraryWord) {
    if (saveLock.current || !foreground.current || list.error || list.isFetching) return;
    const wordId = item.word.id;
    const saved = savedFor(item);
    const life = lifetime.current;
    saveLock.current = true;
    setSaving(wordId);
    setSaveError(null);
    setNotice('');
    try {
      await mutateWordbook(client, scope, wordId, saved, () => lifetime.current === life);
      if (lifetime.current !== life) return;
      setSavedOverrides((old) => new Map(old).set(wordId, { saved: !saved, item }));
      setNotice(saved ? '已移出生词本，学习进度仍保留。' : '已加入生词本。');
      void client.invalidateQueries({ queryKey: [scope, 'library'] });
    } catch (error) {
      if (lifetime.current === life) setSaveError(error);
    } finally {
      if (lifetime.current === life) {
        saveLock.current = false;
        setSaving(null);
      }
    }
  }
  function savedFor(item: LibraryWord) {
    const override = savedOverrides.get(item.word.id);
    return override?.item === item
      ? override.saved
      : item.collection.inWordbook || item.collection.wordbookStatus === 'consolidated';
  }
  if (!user)
    return (
      <div className="page">
        <LoginPrompt />
      </div>
    );
  const views = bookId
    ? ([
        ['all', '全部'],
        ['unlearned', '未学'],
        ['learning', '在学'],
        ['learned', '已学'],
        ['known', '熟词'],
      ] as const)
    : ([
        ['learning', '正在学习'],
        ['recent', '最近学习'],
        ['learned', '全部已学'],
      ] as const);
  return (
    <div className="page mobile-library library-browser" ref={page}>
      <header className="library-heading">
        <BookOpen size={21} aria-hidden="true" />
        <div>
          <h1>{bookId ? bookTitle : '学习记录'}</h1>
          <p>{bookId ? '词书浏览' : '各词书的学习进度汇集在这里'}</p>
        </div>
        {firstPage && !invalidRange && <span>{firstPage.page.total} 词</span>}
      </header>
      <nav className="library-status-tabs" aria-label={bookId ? '词书学习状态' : '学习库分类'}>
        {views.map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={view === value}
            onClick={() => update({ view: value })}
          >
            {label}
          </button>
        ))}
      </nav>
      <form
        className="library-search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (composing.current) return;
          update({ q: input.trim() });
        }}
      >
        <Search size={18} aria-hidden="true" />
        <input
          aria-label={bookId ? '在本书中查找' : '搜索已学单词'}
          placeholder={bookId ? '在本书中查找单词或词组' : '搜索我的学习记录'}
          maxLength={120}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        {input && (
          <button
            type="button"
            className="library-clear"
            aria-label="清空搜索"
            onClick={() => {
              setInput('');
              update({ q: '' });
            }}
          >
            <X size={16} />
          </button>
        )}
        <button type="submit">查找</button>
      </form>
      <div className="library-toolbar">
        <button
          type="button"
          aria-label={`排序方式：${sortLabel}`}
          onClick={() => {
            setDraftSort(sort);
            setSortOpen(true);
          }}
        >
          <SlidersHorizontal size={16} />
          <span>{sortLabel}</span>
          <ChevronDown size={14} />
        </button>
        <button
          type="button"
          aria-pressed={showDefinitions}
          aria-label={showDefinitions ? '隐藏全部释义' : '显示全部释义'}
          onClick={() => setShowDefinitions((value) => !value)}
        >
          {showDefinitions ? <EyeOff size={17} /> : <Eye size={17} />}
          <span>释义</span>
        </button>
      </div>
      {locating && (
        <p className="library-search-hint">在“{bookTitle}”中匹配，选择一个词回到词表定位。</p>
      )}
      {!!anchor && firstPage?.page.anchorWordId === anchor && !invalidRange && (
        <div className="library-location-status" role="status">
          已定位到所选单词
          <button type="button" onClick={() => update({ anchor: '' })}>
            查看完整词表
          </button>
        </div>
      )}
      {!!notice && <Notice>{notice}</Notice>}
      <ErrorNotice error={saveError} />
      {anchorMissing ? (
        <Notice>
          这个词已不在当前范围内。
          <button type="button" className="text-link" onClick={() => update({ anchor: '' })}>
            返回词表
          </button>
        </Notice>
      ) : changed ? (
        <Notice>
          词表已有更新，请重新读取。
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
      {list.isPending ? (
        <Loading text="正在读取词表…" />
      ) : invalidRange ? null : rows.length ? (
        <section
          className="library-rows"
          aria-label={locating ? '本书匹配词' : '词表'}
          aria-busy={list.isFetching && !list.isFetchingNextPage}
        >
          {rows.map((item) => {
            const word = item.word;
            const expanded = expandedWord === word.id;
            const sense =
              word.learningDefinitions?.[0] ??
              word.senses?.find((value) => value.definitionZh || value.definitionEn);
            const saved = savedFor(item);
            return (
              <article
                className={`library-row${expanded ? ' is-expanded' : ''}${anchor === word.id ? ' is-located' : ''}`}
                key={word.id}
                data-word-id={word.id}
              >
                <button
                  type="button"
                  className="library-row-heading"
                  aria-label={
                    locating ? `定位 ${word.lemma}` : `${expanded ? '收起' : '展开'} ${word.lemma}`
                  }
                  aria-expanded={locating ? undefined : expanded}
                  onClick={() => {
                    if (locating) update({ q: '', anchor: word.id });
                    else {
                      stopApplicationAudio();
                      setExpandedWord(expanded ? null : word.id);
                    }
                  }}
                >
                  <span className="library-lemma">{word.lemma}</span>
                  {word.entryKind === 'phrase' && <small>词组</small>}
                  {locating ? (
                    <ArrowUpRight size={16} />
                  ) : (
                    <ChevronDown className="library-row-chevron" size={16} />
                  )}
                </button>
                {(showDefinitions || expanded || locating) && (
                  <p className="library-definition">
                    {sense?.pos && <em>{sense.pos}</em>}
                    {dictionaryText(sense?.definitionZh) ||
                      dictionaryText(sense?.definitionEn) ||
                      '查看词条了解更多'}
                  </p>
                )}
                {expanded && !locating && (
                  <div className="library-row-detail">
                    <AudioButton word={word} />
                    {sense?.definitionZh && sense.definitionEn && (
                      <p className="library-english-definition">
                        {dictionaryText(sense.definitionEn)}
                      </p>
                    )}
                    <div className="library-review-meta">
                      <span>{item.progress ? `复习 ${item.reviewCount} 次` : '尚未学习'}</span>
                      <span>
                        {item.paused
                          ? '已暂停复习'
                          : item.dueAt
                            ? `下次复习 ${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(item.dueAt))}`
                            : ''}
                      </span>
                    </div>
                    <div className="library-row-actions">
                      <WordSaveButton
                        lemma={word.lemma}
                        saved={saved}
                        consolidated={item.collection.wordbookStatus === 'consolidated'}
                        busy={saving === word.id}
                        disabled={
                          (!!saving && saving !== word.id) || !!list.error || list.isFetching
                        }
                        onClick={() => void save(item)}
                      />
                      <button type="button" onClick={() => detail(item)}>
                        完整词条 <ArrowUpRight size={15} />
                      </button>
                      <Link to={`/notes?wordId=${encodeURIComponent(word.id)}`}>记笔记</Link>
                    </div>
                    {!!list.error && (
                      <p className="library-search-hint">重新读取词表后可更改收藏。</p>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </section>
      ) : (
        !list.error && (
          <Empty
            title={query ? '没有匹配的词' : bookId ? '当前分类没有单词' : '这里还没有学习记录'}
            description={
              query
                ? bookId
                  ? '试试其他词形，或到查词页搜索完整词典。'
                  : '试试其他词形，或到查词页搜索词典。'
                : bookId
                  ? '可以切换到全部，查看这本书的完整词表。'
                  : '选一本词书，完成学习后，词会保存在这里。'
            }
            action={
              query ? (
                <Link className="button ghost" to={`/lookup?q=${encodeURIComponent(query)}`}>
                  到完整词典查找
                </Link>
              ) : bookId ? (
                <button
                  type="button"
                  className="button ghost"
                  onClick={() => update({ view: 'all' })}
                >
                  查看全部
                </button>
              ) : (
                <Link className="button primary" to="/books">
                  <BookOpen size={17} />
                  选择词书
                </Link>
              )
            }
          />
        )
      )}
      {list.hasNextPage && !invalidRange && (
        <button
          type="button"
          className="library-load-more"
          disabled={list.isFetchingNextPage || changed}
          onClick={() => {
            if (active) void list.fetchNextPage();
          }}
        >
          {list.isFetchingNextPage ? '正在读取…' : '查看更多'}
        </button>
      )}
      <Dialog open={sortOpen} title="词表排序" onClose={() => setSortOpen(false)}>
        <div className="library-sort-options">
          {(bookId ? ['book', 'az', 'za', 'recent'] : ['az', 'za', 'recent']).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={draftSort === value}
              onClick={() => setDraftSort(value as LibrarySort)}
            >
              {{ book: '词书顺序', az: 'A → Z', za: 'Z → A', recent: '最近学习' }[value]}
            </button>
          ))}
          <button
            type="button"
            className="button primary full"
            onClick={() => {
              update({ sort: draftSort });
              setSortOpen(false);
            }}
          >
            应用排序
          </button>
        </div>
      </Dialog>
    </div>
  );
}
