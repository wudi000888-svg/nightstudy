import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { BookGrid, bookKindLabel } from '../pages/Home';
import { KnownPage, type KnownWord } from '../pages/Known';
import { api } from './api';
import type { Book, PageInfo } from './types';

interface KnownBatch {
  items: KnownWord[];
  page: PageInfo;
}
interface KnownQueryOptions {
  queryKey: unknown[];
  queryFn: (context: { pageParam: string | null; signal: AbortSignal }) => Promise<KnownBatch>;
  getNextPageParam: (last: KnownBatch) => string | undefined;
}
const state = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  return {
    scope: 'component-test:user-a',
    options: null as KnownQueryOptions | null,
    pages: [] as KnownBatch[],
  };
});
vi.mock('../AppContext', () => ({
  useApp: () => ({ user: { id: 'component-test-user' }, scope: state.scope }),
  useRemote: () => ({ data: undefined, error: null, isPending: false }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useInfiniteQuery: (options: KnownQueryOptions) => {
    state.options = options;
    return {
      data: { pages: state.pages },
      isPending: false,
      hasNextPage: true,
      isFetchingNextPage: false,
      error: null,
    };
  },
}));
vi.mock('./api', () => ({
  api: vi
    .fn()
    .mockResolvedValue({ items: [], page: { total: 0, hasMore: false, nextCursor: null } }),
  post: vi.fn(),
  download: vi.fn(),
  errorText: () => '',
}));
const h = React.createElement;
function render(element: React.ReactElement) {
  return renderToStaticMarkup(h(MemoryRouter, null, element));
}
beforeAll(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected component network')));
});
afterAll(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('keeps book kinds and progress readable without exposing the bundled pack description or version', () => {
  const base: Book = {
    id: 'content-ecdict-test-cet4',
    slug: 'component-test-book',
    title: '四级词汇',
    description: 'ECDICT固定基础CSV source-version。许可 MIT。',
    goal: 'cet4',
    version: 'component-source-version',
    wordCount: 10,
    learnedCount: 2,
    coveredCount: 3,
    claimedKnownCount: 1,
    isDemo: false,
  };
  const markup = render(
    h(BookGrid, {
      books: [
        base,
        {
          ...base,
          id: 'content-phrase-books-test-cet4-phrases',
          title: '四级方向常用词组',
          kind: 'phrases',
        },
      ],
      onSelect: () => {},
    }),
  );
  expect(bookKindLabel(base)).toBe('词书');
  expect(markup).toContain('10 个单词');
  expect(markup).toContain('10 条词组');
  expect(markup).toContain('词组本');
  expect(markup).toContain('已学 2 · 进度 3 / 10');
  expect(markup).not.toContain('固定基础CSV');
  expect(markup).not.toContain('许可 MIT');
  expect(markup).not.toContain('source-version');
  const privateMarkup = render(
    h(BookGrid, {
      books: [{ ...base, visibility: 'private', description: '我整理的工作用词。' }],
      onSelect: () => {},
    }),
  );
  expect(privateMarkup).toContain('我的词书');
  expect(privateMarkup).toContain('我整理的工作用词。');
});

it('shows loaded known words and their actual origin while using the bounded cursor contract', async () => {
  const manual: KnownWord = {
    wordId: 'component-water',
    word: {
      id: 'component-water',
      lemma: 'water',
      senses: [{ id: 'component-sense', definitionZh: '水' }],
    },
    origin: 'manual',
    knownAt: '2026-10-14T00:00:00Z',
    progress: null,
  };
  const automatic: KnownWord = {
    ...manual,
    wordId: 'component-quiet',
    word: {
      id: 'component-quiet',
      lemma: 'quiet',
      senses: [{ id: 'component-sense-2', definitionZh: '安静的' }],
    },
    origin: 'automatic',
  };
  const page: PageInfo = { total: 105, hasMore: true, nextCursor: 'site/user+cursor=' };
  state.pages = [
    { items: [manual], page },
    { items: [manual, automatic], page },
  ];
  const markup = render(h(KnownPage));
  expect(markup).toContain('已显示 2 / 105 词');
  expect(markup).toContain('更多熟词');
  expect(markup).toContain('自己标记');
  expect(markup).toContain('复习后熟悉');
  expect((markup.match(/href="\/lookup\?q=water"/g) ?? []).length).toBe(1);
  expect(markup).not.toContain('FSRS');
  const options = state.options!;
  expect(options.queryKey.slice(0, 2)).toEqual([state.scope, 'known-words']);
  const signal = new AbortController().signal;
  await options.queryFn({ pageParam: page.nextCursor, signal });
  expect(api).toHaveBeenLastCalledWith('known-words?limit=50&cursor=site%2Fuser%2Bcursor%3D', {
    signal,
  });
  expect(options.getNextPageParam({ items: [], page })).toBe(page.nextCursor);
  expect(
    options.getNextPageParam({ items: [], page: { total: 105, hasMore: false, nextCursor: null } }),
  ).toBeUndefined();
});

it('resets the private known-word page subtree immediately when the account scope changes', () => {
  state.scope = 'component-test:user-a';
  const initial = KnownPage().key;
  expect(KnownPage().key).toBe(initial);
  state.scope = 'component-test:user-b';
  expect(KnownPage().key).not.toBe(initial);
});
