import React, { type ReactElement, type ReactNode } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { WordCardProvider } from '../components/WordCards';
import { WordSaveButton } from '../components/UI';
import { LookupPage } from '../pages/Lookup';
import { api, post } from './api';
import {
  isWordbookSaved,
  mutateWordbook,
  wordbookEntryKey,
  type WordbookEntryResponse,
} from './wordbook';
import type { Word, WordbookItem } from './types';

const state = vi.hoisted(() => ({
  scope: 'bookmark-ui:user-a',
  slots: [] as unknown[],
  cursor: 0,
  refs: [] as { current: unknown }[],
  refCursor: 0,
  timers: new Map<number, () => void>(),
  timerId: 0,
  client: null as QueryClient | null,
  wordbookItems: [] as WordbookItem[],
  listOptions: [] as {
    queryKey: unknown[];
    queryFn: (context: { pageParam: string | null }) => unknown;
  }[],
}));
// Exercise the actual pointer/focus and save handlers without adding a DOM library.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = state.cursor++;
      if (!(index in state.slots)) state.slots[index] = initial;
      return [
        state.slots[index],
        (value: unknown) => {
          state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value;
        },
      ];
    },
    useRef: (initial: unknown) => (state.refs[state.refCursor++] ??= { current: initial }),
    useEffect: () => {},
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
    useId: () => 'bookmark-ui-title',
  };
});
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (node: ReactNode) => node,
}));
vi.mock('../AppContext', () => ({
  useApp: () => ({ user: { id: 'user-a' }, scope: state.scope }),
  useRemote: (_key: string, path: string) => ({
    data: state.client!.getQueryData([state.scope, 'wordbook-entry', path]) ?? { item: null },
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useLocation: () => ({ key: 'bookmark-test', pathname: '/lookup' }),
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => state.client,
  useInfiniteQuery: (options: (typeof state.listOptions)[number]) => {
    state.listOptions.push(options);
    return {
      data: {
        pages: [
          {
            items: state.wordbookItems,
            page: { total: state.wordbookItems.length, hasMore: false, nextCursor: null },
          },
        ],
      },
      isPending: false,
      isFetching: false,
      hasNextPage: false,
      error: null,
    };
  },
}));
vi.mock('./api', () => ({
  api: vi.fn(),
  post: vi.fn(),
  errorText: (error: Error) => error.message,
}));

const word: Word = {
  id: 'bookmark-word-water',
  lemma: 'water',
  senses: [{ id: 'water-noun', pos: 'n.', definitionZh: '水', definitionEn: 'A clear liquid.' }],
};
const item = { id: 'saved-water', wordId: word.id, note: '', favorite: true, paused: false };
const collection = { inWordbook: true, wordbookStatus: 'active' as const, known: null };
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (!React.isValidElement<Record<string, unknown>>(node))
    return Array.isArray(node) ? node.flatMap(elements) : [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function find(tree: ReactNode, predicate: (element: Element) => boolean) {
  const element = elements(tree).find(predicate);
  if (!element) throw new Error('Expected card control is missing');
  return element;
}
function renderCard() {
  state.cursor = state.refCursor = 0;
  return WordCardProvider({ children: null });
}
function renderWordbook() {
  state.cursor = state.refCursor = 0;
  return LookupPage({ initialTab: 'wordbook' });
}
async function openHover() {
  const wrapper = renderCard();
  const actions = wrapper.props.value as {
    openWord: (text: string, anchor: unknown, mode: string) => void;
  };
  actions.openWord(
    'water',
    {
      getBoundingClientRect: () => ({ left: 100, right: 140, top: 200, bottom: 220 }),
    },
    'hover',
  );
  for (const [id, callback] of state.timers) {
    state.timers.delete(id);
    callback();
  }
  await Promise.resolve();
  return renderCard();
}
beforeAll(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('window', {
    innerWidth: 1280,
    innerHeight: 720,
    setTimeout: (callback: () => void) => {
      const id = ++state.timerId;
      state.timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => state.timers.delete(id),
  });
  vi.stubGlobal('document', { body: {}, activeElement: null });
});
beforeEach(() => {
  state.scope = 'bookmark-ui:user-a';
  state.slots = [];
  state.refs = [];
  state.timers.clear();
  state.wordbookItems = [];
  state.listOptions = [];
  state.client?.clear();
  state.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(api)
    .mockReset()
    .mockResolvedValue({ word, queried: 'water', matchedLemma: 'water', matchType: 'exact' });
  vi.mocked(post)
    .mockReset()
    .mockResolvedValue({ item, added: true, alreadySaved: false, collection });
});
afterAll(() => {
  state.client?.clear();
  vi.unstubAllGlobals();
});

it('keeps the star, pin and close controls in place across pointerdown auto-pin, and submits once', async () => {
  let tree = await openHover();
  const tools = () =>
    elements(find(tree, (element) => element.props.className === 'word-card-tools'))
      .filter((element) => element.type === WordSaveButton || element.type === 'button')
      .map((element) => element.type);
  const before = tools();
  expect(before).toHaveLength(3);
  const panel = find(tree, (element) => element.props.className === 'word-card-layer');
  (panel.props.onPointerDown as (event: unknown) => void)({ target: { closest: () => null } });
  tree = renderCard();
  expect(tools()).toEqual(before);
  expect(
    find(tree, (element) => element.props['data-word-card-pin'] === true).props['aria-pressed'],
  ).toBe(true);
  const save = find(tree, (element) => element.type === WordSaveButton);
  (save.props.onClick as () => void)();
  (save.props.onClick as () => void)();
  await vi.waitFor(() => expect(vi.mocked(post)).toHaveBeenCalledTimes(1));
  await vi.waitFor(() =>
    expect(state.client!.getQueryData(wordbookEntryKey(state.scope, word.id))).toMatchObject({
      item,
    }),
  );
  tree = renderCard();
  expect(find(tree, (element) => element.type === WordSaveButton).props.saved).toBe(true);
  expect(
    find(tree, (element) => element.props.className === 'word-card-save-notice').props.role,
  ).toBe('status');
});

it('lets the same pin button fix and unfix a card without parent focus overriding the action', async () => {
  let tree = await openHover();
  const pinButton = () => find(tree, (element) => element.props['data-word-card-pin'] === true);
  const panel = find(tree, (element) => element.props.className === 'word-card-layer');
  (panel.props.onFocusCapture as (event: unknown) => void)({ target: { closest: () => ({}) } });
  (pinButton().props.onClick as () => void)();
  tree = renderCard();
  expect(pinButton().props['aria-label']).toBe('取消固定词卡');
  (pinButton().props.onClick as () => void)();
  tree = renderCard();
  expect(pinButton().props['aria-label']).toBe('固定词卡');
  expect(pinButton().props['aria-pressed']).toBe(false);
});

it('publishes an accepted save even if list refresh fails, and clears the exact entry on remove', async () => {
  const client = state.client!;
  const refresh = vi.spyOn(client, 'resetQueries').mockRejectedValue(new Error('list unavailable'));
  await mutateWordbook(client, state.scope, word.id, false, () => true);
  expect(
    isWordbookSaved(client.getQueryData(wordbookEntryKey(state.scope, word.id)), word.id),
  ).toBe(true);
  expect(refresh).toHaveBeenCalledWith({ queryKey: [state.scope, 'wordbook'] });
  vi.mocked(post).mockResolvedValue({
    deleted: true,
    progressRetained: true,
    collection: { ...collection, inWordbook: false, wordbookStatus: null, known: 'manual' },
  });
  await mutateWordbook(client, state.scope, word.id, true, () => true);
  expect(client.getQueryData(wordbookEntryKey(state.scope, word.id))).toMatchObject({
    item: null,
    collection: { known: 'manual' },
  });
  expect(vi.mocked(post)).toHaveBeenLastCalledWith(`wordbook/${word.id}`, {}, 'DELETE');
});

it('does not fake a saved star after a failed POST or publish an old account response into a new scope', async () => {
  const client = state.client!;
  vi.mocked(post).mockRejectedValueOnce(new Error('network unavailable'));
  await expect(mutateWordbook(client, state.scope, word.id, false, () => true)).rejects.toThrow(
    'network unavailable',
  );
  expect(client.getQueryData(wordbookEntryKey(state.scope, word.id))).toBeUndefined();
  let resolve!: (value: unknown) => void;
  vi.mocked(post).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const originalScope = state.scope;
  const pending = mutateWordbook(
    client,
    originalScope,
    word.id,
    false,
    () => state.scope === originalScope,
  );
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  state.scope = 'bookmark-ui:user-b';
  resolve({ item, collection });
  expect(await pending).toBeNull();
  expect(client.getQueryData(wordbookEntryKey(originalScope, word.id))).toBeUndefined();
  expect(client.getQueryData(wordbookEntryKey(state.scope, word.id))).toBeUndefined();
});

it('recognizes a retained consolidated bookmark without claiming it is a known word', () => {
  const entry: WordbookEntryResponse = {
    item: null,
    consolidatedItem: { ...item, graduatedAt: '2026-10-15T00:00:00Z' },
    collection: { inWordbook: false, wordbookStatus: 'consolidated', known: null },
  };
  expect(isWordbookSaved(entry, word.id)).toBe(true);
  expect(isWordbookSaved(entry, 'another-word')).toBe(false);
  expect(entry.collection?.known).toBeNull();
});

it('refreshes the exact card entry when the corresponding wordbook row is removed', async () => {
  state.wordbookItems = [{ ...item, word, progress: null, status: 'active' }];
  state.client!.setQueryData(wordbookEntryKey(state.scope, word.id), { item, collection });
  vi.mocked(post).mockResolvedValue({
    deleted: true,
    progressRetained: true,
    collection: { ...collection, inWordbook: false, wordbookStatus: null },
  });
  const tree = renderWordbook();
  const remove = find(
    tree,
    (element) => element.props['aria-label'] === '移除 water 收藏，保留学习进度',
  );
  (remove.props.onClick as () => void)();
  await vi.waitFor(() =>
    expect(state.client!.getQueryData(wordbookEntryKey(state.scope, word.id))).toMatchObject({
      item: null,
    }),
  );
  expect(vi.mocked(post)).toHaveBeenCalledWith(`wordbook/${word.id}`, {}, 'DELETE');
});

it('separates active and consolidated pagination keys and offers re-add rather than an invalid active-only edit', async () => {
  let tree = renderWordbook();
  expect(state.listOptions.at(-1)?.queryKey).toEqual([state.scope, 'wordbook', 'pages', 'active']);
  const filter = find(
    tree,
    (element) => element.type === 'button' && element.props.children === '已巩固',
  );
  (filter.props.onClick as () => void)();
  state.wordbookItems = [
    { ...item, word, progress: null, status: 'consolidated', graduatedAt: '2026-10-15T00:00:00Z' },
  ];
  tree = renderWordbook();
  const options = state.listOptions.at(-1)!;
  expect(options.queryKey).toEqual([state.scope, 'wordbook', 'pages', 'consolidated']);
  await options.queryFn({ pageParam: 'scoped-cursor' });
  expect(vi.mocked(api)).toHaveBeenLastCalledWith(
    'wordbook?limit=50&status=consolidated&cursor=scoped-cursor',
  );
  expect(elements(tree).some((element) => element.props['aria-label'] === '编辑 water 备注')).toBe(
    false,
  );
  const restore = find(
    tree,
    (element) => element.type === 'button' && element.props.children === '重新加入',
  );
  (restore.props.onClick as () => void)();
  await vi.waitFor(() =>
    expect(state.client!.getQueryData(wordbookEntryKey(state.scope, word.id))).toMatchObject({
      item,
      collection,
    }),
  );
  renderWordbook();
  expect(state.listOptions.at(-1)?.queryKey).toEqual([state.scope, 'wordbook', 'pages', 'active']);
});
