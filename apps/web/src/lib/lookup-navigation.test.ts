import React, { type ReactElement, type ReactNode } from 'react';
import { createMemoryRouter } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { LookupPage } from '../pages/Lookup';
import { Dialog, WordView } from '../components/UI';
import { api, post } from './api';
import { wordbookEntryKey } from './wordbook';
import type { Word, WordbookItem } from './types';

interface Effect {
  deps: unknown[];
  cleanup?: () => void;
}
const state = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  return {
    scope: 'lookup-test:user-a',
    active: true,
    infiniteEnabled: undefined as boolean | undefined,
    slots: [] as unknown[],
    cursor: 0,
    refs: [] as { current: unknown }[],
    refCursor: 0,
    effectCursor: 0,
    effects: [] as Effect[],
    pending: [] as { index: number; deps: unknown[]; setup: () => unknown }[],
    router: null as ReturnType<typeof createMemoryRouter> | null,
    client: null as QueryClient | null,
    words: [] as WordbookItem[],
    scrollY: 0,
  };
});
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = state.cursor++;
      if (!(i in state.slots)) state.slots[i] = typeof initial === 'function' ? initial() : initial;
      return [
        state.slots[i],
        (value: unknown) => {
          state.slots[i] = typeof value === 'function' ? value(state.slots[i]) : value;
        },
      ];
    },
    useRef: (initial: unknown) => (state.refs[state.refCursor++] ??= { current: initial }),
    useMemo: (factory: () => unknown) => factory(),
    useEffect: (setup: () => unknown, deps: unknown[]) => {
      const index = state.effectCursor++;
      const previous = state.effects[index];
      if (
        !previous ||
        deps.length !== previous.deps.length ||
        deps.some((v, i) => !Object.is(v, previous.deps[i]))
      )
        state.pending.push({ index, deps, setup });
    },
  };
});
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useSearchParams: () => [
    new URLSearchParams(state.router!.state.location.search),
    (next: URLSearchParams, options?: { replace?: boolean }) =>
      void state.router!.navigate(`/lookup?${next}`, options),
  ],
}));
vi.mock('./screen-lifecycle', async (original) => ({
  ...(await original<typeof import('./screen-lifecycle')>()),
  useScreenActive: () => state.active,
}));
vi.mock('../AppContext', () => ({
  useApp: () => ({ user: { id: state.scope }, scope: state.scope }),
  useRemote: () => ({ data: { item: null }, error: null, isFetching: false, refetch: vi.fn() }),
}));
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => state.client,
  useInfiniteQuery: (options: { enabled?: boolean }) => {
    state.infiniteEnabled = options.enabled;
    return {
      data: {
        pages: [
          {
            items: state.words,
            page: { total: state.words.length, nextCursor: null, hasMore: false },
          },
        ],
      },
      isPending: false,
      error: null,
    };
  },
}));
vi.mock('./api', () => ({
  api: vi.fn(),
  post: vi.fn(),
  errorText: (error: Error) => error.message,
}));

const water: Word = {
  id: 'lookup-water',
  lemma: 'water',
  senses: [{ id: 'water-noun', definitionZh: '水', definitionEn: 'A clear liquid.' }],
};
const wait: Word = {
  id: 'lookup-wait',
  lemma: 'wait',
  senses: [{ id: 'wait-verb', definitionZh: '等待' }],
};
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (!React.isValidElement<Record<string, unknown>>(node))
    return Array.isArray(node) ? node.flatMap(elements) : [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function find(tree: ReactNode, predicate: (element: Element) => boolean) {
  const result = elements(tree).find(predicate);
  if (!result) throw Error('Lookup control is missing');
  return result;
}
function render(initialTab: 'lookup' | 'wordbook' = 'lookup') {
  state.cursor = state.refCursor = state.effectCursor = 0;
  state.pending = [];
  const wrapper = LookupPage({ initialTab });
  const tree = (wrapper.type as (props: unknown) => ReactElement)(wrapper.props);
  const pending = [...state.pending];
  state.pending = [];
  for (const effect of pending) {
    state.effects[effect.index]?.cleanup?.();
    const cleanup = effect.setup();
    state.effects[effect.index] = {
      deps: effect.deps,
      cleanup: typeof cleanup === 'function' ? (cleanup as () => void) : undefined,
    };
  }
  return tree;
}
function cleanup() {
  for (const effect of state.effects) effect?.cleanup?.();
}
async function settle(initialTab: 'lookup' | 'wordbook' = 'lookup') {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    render(initialTab);
  }
  return render(initialTab);
}
beforeAll(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected lookup network')));
});
beforeEach(() => {
  cleanup();
  state.router?.dispose();
  state.client?.clear();
  state.scope = 'lookup-test:user-a';
  state.active = true;
  state.infiniteEnabled = undefined;
  state.slots = [];
  state.refs = [];
  state.effects = [];
  state.pending = [];
  state.words = [];
  state.scrollY = 0;
  state.router = createMemoryRouter([{ path: '*', element: null }], {
    initialEntries: ['/lookup'],
  });
  state.client = new QueryClient();
  vi.mocked(api).mockReset();
  vi.mocked(post).mockReset();
  vi.stubGlobal('window', {
    __NIGHTSTUDY_CONFIG__: {},
    get scrollY() {
      return state.scrollY;
    },
    requestAnimationFrame: (fn: () => void) => {
      fn();
      return 1;
    },
    cancelAnimationFrame: vi.fn(),
    scrollTo: vi.fn((value: { top: number }) => {
      state.scrollY = value.top;
    }),
  });
});
afterAll(() => {
  cleanup();
  state.router?.dispose();
  state.client?.clear();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('actually resolves a q deep link and opens only its exact canonical word instead of the first prefix neighbour', async () => {
  await state.router!.navigate('/lookup?q=water');
  vi.mocked(api).mockImplementation(async (path) =>
    String(path).startsWith('dictionary/resolve')
      ? { word: water, matchType: 'exact' }
      : { items: [wait, water], page: { total: 2, nextCursor: null, hasMore: false } },
  );
  const tree = await settle();
  expect(state.router!.state.location.search).toContain('entry=lookup-water');
  expect(find(tree, (element) => element.type === WordView).props.word).toEqual(water);
  expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual([
    'dictionary?q=water&limit=20',
    'dictionary/resolve?text=water',
  ]);
});

it('preserves results and list/page position across the real router back and forward without re-querying', async () => {
  await state.router!.navigate('/lookup?q=wa');
  vi.mocked(api).mockImplementation(async (path) =>
    String(path).startsWith('dictionary/resolve')
      ? { word: null, matchType: 'not-found' }
      : String(path).startsWith('dictionary?')
        ? { items: [water, wait], page: { total: 2, nextCursor: null, hasMore: false } }
        : { word: String(path).endsWith('lookup-wait') ? wait : water },
  );
  let tree = await settle();
  expect(state.router!.state.location.search).toBe('?q=wa');
  const list = find(tree, (element) => element.type === 'aside');
  (list.props.ref as { current: unknown }).current = { scrollTop: 58 };
  state.scrollY = 420;
  (
    find(tree, (element) => element.props['aria-label'] === '查看 wait 完整词条').props
      .onClick as () => void
  )();
  tree = await settle();
  expect(state.router!.state.location.search).toContain('entry=lookup-wait');
  expect(find(tree, (element) => element.type === WordView).props.word).toEqual(wait);
  const count = vi.mocked(api).mock.calls.length;
  await state.router!.navigate(-1);
  tree = await settle();
  expect(state.router!.state.location.search).toBe('?q=wa');
  expect(
    find(tree, (element) => element.props.className === 'dictionary-layout lookup-workspace'),
  ).toBeDefined();
  expect(state.scrollY).toBe(420);
  expect((list.props.ref as { current: { scrollTop: number } }).current.scrollTop).toBe(58);
  await state.router!.navigate(1);
  await settle();
  expect(vi.mocked(api)).toHaveBeenCalledTimes(count);
});

it('aborts an obsolete search and ignores late results when q changes', async () => {
  let resolveOldList!: (value: unknown) => void, resolveOldExact!: (value: unknown) => void;
  vi.mocked(api).mockImplementation((path) =>
    String(path) === 'dictionary?q=water&limit=20'
      ? new Promise((done) => {
          resolveOldList = done;
        })
      : String(path) === 'dictionary/resolve?text=water'
        ? new Promise((done) => {
            resolveOldExact = done;
          })
        : Promise.resolve(
            String(path).startsWith('dictionary/resolve')
              ? { word: wait, matchType: 'exact' }
              : { items: [wait], page: { total: 1, nextCursor: null, hasMore: false } },
          ),
  );
  await state.router!.navigate('/lookup?q=water');
  render();
  const firstSignal = vi.mocked(api).mock.calls[0]![1]!.signal;
  await state.router!.navigate('/lookup?q=wait');
  await settle();
  expect(firstSignal?.aborted).toBe(true);
  resolveOldList({ items: [water], page: { total: 1, nextCursor: null, hasMore: false } });
  resolveOldExact({ word: water, matchType: 'exact' });
  const tree = await settle();
  expect(find(tree, (element) => element.type === WordView).props.word).toEqual(wait);
  expect(state.router!.state.location.search).toContain('entry=lookup-wait');
});

it('can start a new desktop search from an open detail without mistaking it for back navigation', async () => {
  vi.mocked(api).mockImplementation(async (path) => {
    const target = String(path).includes('wait') ? wait : water;
    return String(path).startsWith('dictionary/resolve')
      ? { word: target, matchType: 'exact' }
      : { items: [target], page: { total: 1, nextCursor: null, hasMore: false } };
  });
  await state.router!.navigate('/lookup?q=water');
  let tree = await settle();
  (
    find(tree, (element) => element.props['aria-label'] === '查词输入').props.onChange as (
      event: unknown,
    ) => void
  )({ target: { value: 'wait' } });
  tree = render();
  (
    find(tree, (element) => element.props.className === 'search-bar').props.onSubmit as (
      event: unknown,
    ) => void
  )({ preventDefault: vi.fn() });
  tree = await settle();
  expect(find(tree, (element) => element.type === WordView).props.word).toEqual(wait);
  expect(state.router!.state.location.search).toContain('entry=lookup-wait');
});

it('restarts an aborted initial deep-link read after Strict Mode effect cleanup and setup', async () => {
  await state.router!.navigate('/lookup?q=water');
  vi.mocked(api)
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockImplementationOnce(() => new Promise(() => {}));
  render();
  const firstSignal = vi.mocked(api).mock.calls[0]![1]!.signal;
  cleanup();
  state.effects = [];
  vi.mocked(api).mockImplementation(async (path) =>
    String(path).startsWith('dictionary/resolve')
      ? { word: water, matchType: 'exact' }
      : { items: [water], page: { total: 1, nextCursor: null, hasMore: false } },
  );
  const tree = await settle();
  expect(firstSignal?.aborted).toBe(true);
  expect(find(tree, (element) => element.type === WordView).props.word).toEqual(water);
});

it('remounts private notes on account changes and never publishes an old save receipt after cleanup', async () => {
  state.words = [
    {
      id: 'lookup-saved',
      wordId: water.id,
      word: water,
      note: 'private-a-note',
      favorite: true,
      paused: false,
      progress: null,
      status: 'active',
    },
  ];
  let tree = render('wordbook');
  (
    find(tree, (element) => element.props['aria-label'] === '编辑 water 备注').props
      .onClick as () => void
  )();
  tree = render('wordbook');
  expect(find(tree, (element) => element.type === Dialog).props.open).toBe(true);
  let resolve!: (value: unknown) => void;
  vi.mocked(post).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const save = elements(find(tree, (element) => element.type === Dialog)).find(
    (element) => element.type === 'button',
  )!;
  (save.props.onClick as () => void)();
  await Promise.resolve();
  const previous = LookupPage({ initialTab: 'wordbook' }).key;
  cleanup();
  state.scope = 'lookup-test:user-b';
  state.slots = [];
  state.refs = [];
  state.effects = [];
  state.pending = [];
  state.words = [];
  expect(LookupPage({ initialTab: 'wordbook' }).key).not.toBe(previous);
  tree = render('wordbook');
  resolve({
    item: { ...state.words[0], id: 'lookup-saved', wordId: water.id, note: 'private-a-note' },
  });
  await Promise.resolve();
  expect(find(tree, (element) => element.type === Dialog).props.open).toBe(false);
  expect(find(tree, (element) => element.type === 'textarea').props.value).toBe('');
  expect(
    state.client!.getQueryData(wordbookEntryKey('lookup-test:user-a', water.id)),
  ).toBeUndefined();
  expect(state.client!.getQueryData(wordbookEntryKey(state.scope, water.id))).toBeUndefined();
});

it('retains a late exact lookup result while hidden without replacing the foreground route', async () => {
  await state.router!.navigate('/lookup?q=water');
  let resolveList!: (value: unknown) => void, resolveExact!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(
    (path) =>
      new Promise((done) => {
        if (String(path).startsWith('dictionary/resolve')) resolveExact = done;
        else resolveList = done;
      }),
  );
  render();
  state.active = false;
  render();
  expect(state.infiniteEnabled).toBe(false);
  resolveList({ items: [water], page: { total: 1, nextCursor: null, hasMore: false } });
  resolveExact({ word: water, matchType: 'exact' });
  const tree = await settle();
  expect(state.router!.state.location.search).toBe('?q=water');
  expect(find(tree, (element) => element.type === WordView).props.word).toEqual(water);
  expect(api).toHaveBeenCalledTimes(2);
});
it('does not hydrate a hidden lookup until its own screen becomes active', async () => {
  state.active = false;
  await state.router!.navigate('/lookup?q=water');
  await settle();
  expect(api).not.toHaveBeenCalled();
  state.active = true;
  vi.mocked(api).mockImplementation(async (path) =>
    String(path).startsWith('dictionary/resolve')
      ? { word: water, matchType: 'exact' }
      : { items: [water], page: { total: 1, nextCursor: null, hasMore: false } },
  );
  await settle();
  expect(api).toHaveBeenCalledTimes(2);
  expect(state.router!.state.location.search).toContain('entry=lookup-water');
});
