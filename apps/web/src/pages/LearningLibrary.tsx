import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { BookOpen, Search } from 'lucide-react';
import { useApp } from '../AppContext';
import { useScreenActive } from '../lib/screen-lifecycle';
import { api } from '../lib/api';
import { useWordCards } from '../lib/word-cards';
import type { LibraryResponse } from '../lib/mobile-content-types';
import { Empty, ErrorNotice, Loading, LoginPrompt } from '../components/UI';
import { AudioButton } from '../components/Pronunciation';
import './mobile-content.css';
export { SentencesPage } from './SentenceLibrary';
export { NotesPage } from './NotesLibrary';

export function LearningLibraryPage() {
  const { user, scope } = useApp();
  const active = useScreenActive();
  const cards = useWordCards();
  const [params, setParams] = useSearchParams();
  const view = ['learning', 'recent', 'learned'].includes(params.get('view') ?? '')
    ? params.get('view')!
    : 'learning';
  const query = params.get('q') ?? '';
  const [input, setInput] = useState(query);
  const list = useInfiniteQuery({
    queryKey: [scope, 'library', 'pages', view, query],
    enabled: !!user && active,
    retry: false,
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      api<LibraryResponse>(
        `library/words?view=${view}&q=${encodeURIComponent(query)}&limit=30${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.page.hasMore ? (last.page.nextCursor ?? undefined) : undefined,
  });
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  if (!user)
    return (
      <div className="page">
        <LoginPrompt />
      </div>
    );
  return (
    <div className="page mobile-library">
      <Link className="mobile-back" to="/content">
        ← 内容中心
      </Link>
      <header className="mobile-content-heading">
        <span className="mobile-kicker">MY WORDS</span>
        <h1>我的学习库</h1>
        <p>学过的词在这里，换一本书也保留同一份进度。</p>
      </header>
      <nav className="mobile-segmented" aria-label="学习库分类">
        {(
          [
            ['learning', '正在学习'],
            ['recent', '最近学习'],
            ['learned', '全部已学'],
          ] as const
        ).map(([value, label]) => (
          <Link
            key={value}
            className={view === value ? 'selected' : ''}
            aria-current={view === value ? 'page' : undefined}
            to={`/library?view=${value}${query ? `&q=${encodeURIComponent(query)}` : ''}`}
          >
            {label}
          </Link>
        ))}
      </nav>
      <form
        className="mobile-search"
        onSubmit={(event) => {
          event.preventDefault();
          setParams({ view, q: input.trim() });
        }}
      >
        <Search size={18} />
        <input
          aria-label="搜索已学单词"
          placeholder="搜索已学单词或词组"
          maxLength={120}
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <button type="submit">搜索</button>
      </form>
      <p className="mobile-caption">
        {view === 'recent'
          ? '最近30天有真实回忆评分的词。'
          : view === 'learning'
            ? '已开始学习且未暂停的词。'
            : '所有至少开始过一次学习的词。'}
        {list.data ? ` 共 ${list.data.pages[0]?.page.total ?? 0} 词。` : ''}
      </p>
      <ErrorNotice error={list.error} onRetry={() => void list.refetch()} />
      {list.isPending ? (
        <Loading />
      ) : rows.length ? (
        <div className="mobile-word-list">
          {rows.map((item) => (
            <article className="mobile-library-word" key={item.word.id}>
              <div className="mobile-word-line">
                <button
                  className="mobile-lemma"
                  onClick={(event) =>
                    cards?.openWord(item.word.lemma, event.currentTarget, 'pinned')
                  }
                >
                  {item.word.lemma}
                </button>
                <span>{item.word.entryKind === 'phrase' ? '词组' : '单词'}</span>
              </div>
              <p>
                {item.word.learningDefinitions?.[0]?.definitionZh ||
                  item.word.senses?.find((sense) => sense.definitionZh)?.definitionZh ||
                  '中文释义待补充'}
              </p>
              <div className="mobile-word-meta">
                <span>真实复习 {item.reviewCount} 次</span>
                <span>
                  {item.paused
                    ? '已暂停'
                    : item.dueAt
                      ? `下次 ${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(item.dueAt))}`
                      : '尚无到期时间'}
                </span>
              </div>
              <details>
                <summary>发音与更多操作</summary>
                <AudioButton word={item.word} />
                <div className="mobile-inline-links">
                  <Link to={`/lookup?q=${encodeURIComponent(item.word.lemma)}`}>查看完整词条</Link>
                  <Link to={`/notes?wordId=${encodeURIComponent(item.word.id)}`}>记一条笔记</Link>
                  <Link to={`/sentences?wordId=${encodeURIComponent(item.word.id)}`}>
                    查看与收藏例句
                  </Link>
                </div>
              </details>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title={query ? '没有找到这个词' : '这里还没有学习记录'}
          description={
            query
              ? '试试其他词形，或到查词页搜索词典。'
              : '选一本词书，完成真实学习后，词会保存在这里。'
          }
          action={
            <Link className="button primary" to="/books">
              <BookOpen size={17} />
              选择词书
            </Link>
          }
        />
      )}
      {list.hasNextPage && (
        <button
          className="button ghost full"
          disabled={list.isFetchingNextPage}
          onClick={() => {
            if (active) void list.fetchNextPage();
          }}
        >
          {list.isFetchingNextPage ? '正在读取…' : '加载更多'}
        </button>
      )}
    </div>
  );
}
