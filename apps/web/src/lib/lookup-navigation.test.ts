import React, { type ReactElement, type ReactNode } from 'react';
import { createMemoryRouter } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { LookupPage } from '../pages/Lookup';
import { Dialog, WordView } from '../components/UI';
import { api, post } from './api';
import { wordbookEntryKey } from './wordbook';
import type { Word } from './types';
import type { DictionaryBrief, LookupResponse } from './lookup-state';

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
    words: [] as LookupResponse['items'],
    suggestions: [] as LookupResponse['suggestions'],
    listError: null as unknown,
    queryOptions: null as null | {
      queryKey: unknown[];
      queryFn: (value: { pageParam: null; signal: AbortSignal }) => Promise<unknown>;
    },
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
  useLocation: () => state.router!.state.location,
  useSearchParams: () => [
    new URLSearchParams(state.router!.state.location.search),
    (next: URLSearchParams, options?: { replace?: boolean; state?: unknown }) =>
      void state.router!.navigate(`${state.router!.state.location.pathname}?${next}`, options),
  ],
}));
vi.mock('../components/AppNavigation', () => ({
  useAppNavigation: () => ({ goBack: () => void state.router!.navigate(-1) }),
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
  useInfiniteQuery: (options: { enabled?: boolean } & NonNullable<typeof state.queryOptions>) => {
    state.queryOptions = options;
    state.infiniteEnabled = options.enabled;
    return {
      data: {
        pages: [
          {
            items: state.words,
            suggestions: state.suggestions,
            page: { total: state.words.length, nextCursor: null, hasMore: false },
          },
        ],
      },
      isPending: false,
      error: state.listError,
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
  state.suggestions = [];
  state.listError = null;
  state.queryOptions = null;
  state.scrollY = 0;
  state.router = createMemoryRouter([{ path: '*', element: null }], {
    initialEntries: ['/lookup'],
  });
  state.client = new QueryClient();
  vi.useRealTimers();
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

const waterBrief: DictionaryBrief = {
  id: water.id,
  lemma: water.lemma,
  normalizedLemma: 'water',
  pos: ['n.'],
  definitionZh: '水',
  definitionEn: 'A clear liquid.',
  matchType: 'prefix',
  collection: { inWordbook: false, wordbookStatus: null },
};
const waitBrief: DictionaryBrief = {
  ...waterBrief,
  id: wait.id,
  lemma: wait.lemma,
  normalizedLemma: 'wait',
  definitionZh: '等待',
};
it('keeps q searches as lists and sends every matching/sort condition to the server', async () => {
  await state.router!.navigate('/lookup?q=sys&match=contains&sort=za');
  state.words = [waterBrief, waitBrief];
  const tree = await settle();
  expect(elements(tree).some((element) => element.type === WordView)).toBe(false);
  expect(api).not.toHaveBeenCalled();
  expect(state.queryOptions!.queryKey).toEqual([
    state.scope,
    'lookup',
    'pages',
    'sys',
    'contains',
    'za',
    'active',
  ]);
  await state.queryOptions!.queryFn({ pageParam: null, signal: new AbortController().signal });
  expect(api).toHaveBeenCalledWith(
    'dictionary?q=sys&match=contains&sort=za&limit=20',
    expect.anything(),
  );
  // The UI retains the server's order instead of sorting a loaded page.
  expect(
    elements(tree)
      .filter((e) => String(e.props['aria-label']).startsWith('查看 '))
      .map((e) => e.props['aria-label']),
  ).toEqual(['查看 water 完整词条', '查看 wait 完整词条']);
});

it('keeps filter edits local until applying them together to the server query', async () => {
  await state.router!.navigate('/lookup?q=claim&match=smart&sort=relevance');
  let tree = await settle();
  const summary = find(tree, (element) =>
    String(element.props['aria-label']).startsWith('筛选与排序：'),
  );
  (summary.props.onClick as () => void)();
  tree = render();
  const panel = find(
    tree,
    (element) => element.type === Dialog && element.props.title === '筛选与排序',
  );
  expect(panel.props.open).toBe(true);
  (
    find(panel, (element) => element.props['aria-label'] === '匹配方式').props.onChange as (
      event: unknown,
    ) => void
  )({ target: { value: 'prefix' } });
  (
    find(panel, (element) => element.props['aria-label'] === '排序方式').props.onChange as (
      event: unknown,
    ) => void
  )({ target: { value: 'za' } });
  expect(state.router!.state.location.search).toBe('?q=claim&match=smart&sort=relevance');
  tree = render();
  (
    find(tree, (element) => element.type === 'button' && element.props.children === '应用筛选')
      .props.onClick as () => void
  )();
  tree = await settle();
  expect(state.router!.state.location.search).toBe('?q=claim&match=prefix&sort=za');
  expect(
    find(tree, (element) => element.type === Dialog && element.props.title === '筛选与排序').props
      .open,
  ).toBe(false);
});

it('starts private word lists with quiet word forms and expands only the selected row', async () => {
  await state.router!.navigate('/wordbook');
  state.words = [
    {
      id: 'saved-water',
      wordId: water.id,
      word: waterBrief,
      note: 'one note',
      favorite: true,
      paused: false,
      status: 'active',
      progress: null,
    },
  ];
  let tree = await settle('wordbook');
  expect(
    elements(tree).some((element) => element.props.className === 'lookup-result-definition'),
  ).toBe(false);
  expect(elements(tree).some((element) => element.props['aria-label'] === '编辑 water 备注')).toBe(
    false,
  );
  (
    find(tree, (element) => element.props['aria-label'] === '展开 water').props
      .onClick as () => void
  )();
  tree = render('wordbook');
  expect(find(tree, (element) => element.props['aria-label'] === '编辑 water 备注')).toBeDefined();
  expect(state.router!.state.location.pathname).toBe('/wordbook');
  (
    find(tree, (element) => element.props['aria-label'] === '收起 water').props
      .onClick as () => void
  )();
  tree = render('wordbook');
  (
    find(tree, (element) => element.props['aria-label'] === '显示全部释义').props
      .onClick as () => void
  )();
  tree = render('wordbook');
  expect(
    find(tree, (element) => element.props.className === 'lookup-result-definition'),
  ).toBeDefined();
  expect(elements(tree).some((element) => element.props['aria-label'] === '编辑 water 备注')).toBe(
    false,
  );
});
it('matches the server contains guard for accented letters and literal punctuation', async () => {
  for (const [q, enabled] of [
    ['naïve', true],
    ['abc%_', true],
    ['ab', false],
    ['a%b', false],
  ] as const) {
    await state.router!.navigate(`/lookup?q=${encodeURIComponent(q)}&match=contains`);
    await settle();
    expect(state.infiniteEnabled, q).toBe(enabled);
  }
});

it('hides a cached result list and its suggestions when the signed list version is no longer valid', async () => {
  await state.router!.navigate('/lookup?q=wat');
  state.words = [waterBrief];
  state.suggestions = [{ id: 'water', lemma: 'water', matchType: 'spelling' }];
  let tree = await settle();
  expect(
    find(tree, (element) => element.props['aria-label'] === '查看 water 完整词条'),
  ).toBeDefined();
  state.listError = { status: 409, code: 'list_changed' };
  tree = render();
  expect(
    elements(tree).some((element) => element.props['aria-label'] === '查看 water 完整词条'),
  ).toBe(false);
  expect(elements(tree).some((element) => element.props['aria-label'] === '拼写建议')).toBe(false);
});
it('keeps a private q route private when opening and returning from a word', async () => {
  await state.router!.navigate('/wordbook?q=wa&match=prefix&sort=za&status=consolidated');
  state.words = [
    {
      id: 'saved-water',
      wordId: water.id,
      word: waterBrief,
      note: '',
      favorite: true,
      paused: false,
      status: 'consolidated',
      progress: null,
    },
  ];
  vi.mocked(api).mockResolvedValue({ word: water });
  let tree = await settle('wordbook');
  expect(find(tree, (e) => e.props['aria-label'] === '搜索我的生词本')).toBeDefined();
  const list = find(tree, (e) => e.props['aria-label'] === '我的生词本列表');
  const screenScroll = { scrollTop: 340 };
  ((tree as Element).props.ref as { current: unknown }).current = { closest: () => screenScroll };
  (list.props.ref as { current: unknown }).current = { scrollTop: 58 };
  state.scrollY = 420;
  (find(tree, (e) => e.props['aria-label'] === '展开 water').props.onClick as () => void)();
  tree = await settle('wordbook');
  (
    find(tree, (e) => e.props['aria-label'] === '查看 water 完整词条').props.onClick as () => void
  )();
  tree = await settle('wordbook');
  expect(state.router!.state.location.pathname).toBe('/wordbook');
  expect(state.router!.state.location.search).toBe(
    '?q=wa&match=prefix&sort=za&status=consolidated&entry=lookup-water',
  );
  expect(find(tree, (e) => e.type === WordView).props.word).toEqual(water);
  expect(elements(tree).some((e) => e.props.className === 'dictionary-back')).toBe(false);
  await state.router!.navigate(-1);
  tree = await settle('wordbook');
  expect(state.router!.state.location.search).toBe(
    '?q=wa&match=prefix&sort=za&status=consolidated',
  );
  expect(state.scrollY).toBe(420);
  expect(screenScroll.scrollTop).toBe(340);
  expect((list.props.ref as { current: { scrollTop: number } }).current.scrollTop).toBe(58);
  expect(find(tree, (e) => e.props['aria-label'] === '搜索我的生词本')).toBeDefined();
});
it('reads a deep-linked entry independently and preserves every condition when selecting a sense', async () => {
  await state.router!.navigate(
    '/wordbook?q=wa&match=smart&sort=relevance&status=active&entry=lookup-water&sense=water-noun',
  );
  vi.mocked(api).mockResolvedValue({ word: water });
  let tree = await settle('wordbook');
  expect(api).toHaveBeenCalledWith('words/lookup-water', expect.anything());
  expect(api).toHaveBeenCalledTimes(1);
  const details = find(tree, (e) => e.type === WordView);
  expect(details.props.focusSenseId).toBe('water-noun');
  (details.props.onSenseChange as (id: string) => void)('water-noun');
  tree = await settle('wordbook');
  expect(state.router!.state.location.pathname).toBe('/wordbook');
  expect(state.router!.state.location.search).toContain(
    'q=wa&match=smart&sort=relevance&status=active&entry=lookup-water&sense=water-noun',
  );
  (find(tree, (e) => e.props.className === 'dictionary-back').props.onClick as () => void)();
  await settle('wordbook');
  expect(state.router!.state.location.pathname).toBe('/wordbook');
  expect(state.router!.state.location.search).not.toContain('entry=');
});
it('aborts obsolete details and never shows a late word under another entry', async () => {
  let resolveOld!: (value: unknown) => void;
  vi.mocked(api).mockImplementation((path) =>
    String(path).endsWith(water.id)
      ? new Promise((done) => {
          resolveOld = done;
        })
      : Promise.resolve({ word: wait }),
  );
  await state.router!.navigate('/lookup?entry=lookup-water');
  render();
  const signal = vi.mocked(api).mock.calls[0]![1]!.signal;
  await state.router!.navigate('/lookup?entry=lookup-wait');
  await settle();
  expect(signal?.aborted).toBe(true);
  resolveOld({ word: water });
  const tree = await settle();
  expect(find(tree, (e) => e.type === WordView).props.word).toEqual(wait);
});
it('does not silently replace an invalid sense with a different meaning', async () => {
  await state.router!.navigate('/lookup?entry=lookup-water&sense=missing');
  vi.mocked(api).mockResolvedValue({ word: water });
  const tree = await settle();
  expect(elements(tree).some((e) => e.type === WordView)).toBe(false);
  expect(elements(tree).some((e) => e.props.title === '这个词义暂时不可用。')).toBe(true);
});

it('revalidates a cached detail when it is reopened instead of retaining held or edited meanings', async () => {
  await state.router!.navigate('/lookup?q=wa');
  state.words = [waterBrief];
  vi.mocked(api).mockResolvedValue({ word: water });
  let tree = await settle();
  (
    find(tree, (e) => e.props['aria-label'] === '查看 water 完整词条').props.onClick as () => void
  )();
  await settle();
  await state.router!.navigate(-1);
  await settle();
  vi.mocked(api).mockResolvedValue({
    word: { ...water, senses: [{ id: 'new', definitionZh: '更新后的释义' }] },
  });
  await state.router!.navigate(1);
  tree = await settle();
  expect(api).toHaveBeenCalledTimes(2);
  expect((find(tree, (e) => e.type === WordView).props.word as Word).senses![0]!.id).toBe('new');
});

it('does not POP to an unrelated list after conditions in a detail URL have changed', async () => {
  await state.router!.navigate('/lookup?q=wa');
  state.words = [waterBrief];
  vi.mocked(api).mockResolvedValue({ word: water });
  let tree = await settle();
  (
    find(tree, (e) => e.props['aria-label'] === '查看 water 完整词条').props.onClick as () => void
  )();
  await settle();
  const oldState: unknown = state.router!.state.location.state;
  await state.router!.navigate('/lookup?q=sys&match=contains&sort=za&entry=lookup-water', {
    state: oldState,
  });
  tree = await settle();
  (find(tree, (e) => e.props.className === 'dictionary-back').props.onClick as () => void)();
  await settle();
  expect(state.router!.state.location.search).toBe('?q=sys&match=contains&sort=za');
});
it('debounces editable input, waits through IME composition and submits immediately on enter', async () => {
  vi.useFakeTimers();
  let tree = render();
  let input = find(tree, (e) => e.props['aria-label'] === '查词输入');
  (input.props.onCompositionStart as () => void)();
  (input.props.onChange as (event: unknown) => void)({ target: { value: 'sys' } });
  tree = render();
  await vi.advanceTimersByTimeAsync(500);
  expect(state.router!.state.location.search).toBe('');
  input = find(tree, (e) => e.props['aria-label'] === '查词输入');
  (input.props.onCompositionEnd as (event: unknown) => void)({
    currentTarget: { value: 'system' },
  });
  tree = render();
  await vi.advanceTimersByTimeAsync(299);
  expect(state.router!.state.location.search).toBe('');
  await vi.advanceTimersByTimeAsync(1);
  await settle();
  expect(state.router!.state.location.search).toContain('q=system');
  tree = render();
  (
    find(tree, (e) => e.props['aria-label'] === '查词输入').props.onChange as (
      event: unknown,
    ) => void
  )({ target: { value: 'water' } });
  tree = render();
  (find(tree, (e) => e.props.role === 'search').props.onSubmit as (event: unknown) => void)({
    preventDefault: vi.fn(),
  });
  await settle();
  expect(state.router!.state.location.search).toContain('q=water');
});
it('uses spelling suggestions only after an explicit user action', async () => {
  await state.router!.navigate('/lookup?q=systme');
  state.suggestions = [{ id: 'system', lemma: 'system', matchType: 'spelling' }];
  let tree = await settle();
  expect(state.router!.state.location.search).toBe('?q=systme');
  const suggestions = find(tree, (e) => e.props['aria-label'] === '拼写建议');
  (find(suggestions, (e) => e.type === 'button').props.onClick as () => void)();
  tree = await settle();
  expect(state.router!.state.location.search).toContain('q=system');
  expect(elements(tree).some((e) => e.type === WordView)).toBe(false);
});

it('keeps text typed after a suggestion navigation while the prior q effect is still pending', async () => {
  vi.useFakeTimers();
  await state.router!.navigate('/lookup?q=systme');
  state.suggestions = [{ id: 'system', lemma: 'system', matchType: 'spelling' }];
  let tree = await settle();
  const suggestions = find(tree, (e) => e.props['aria-label'] === '拼写建议');
  (find(suggestions, (e) => e.type === 'button').props.onClick as () => void)();
  (
    find(tree, (e) => e.props['aria-label'] === '查词输入').props.onChange as (
      event: unknown,
    ) => void
  )({ target: { value: 'bank' } });
  tree = render();
  await vi.advanceTimersByTimeAsync(300);
  tree = await settle();
  expect(new URLSearchParams(state.router!.state.location.search).get('q')).toBe('bank');
  expect(find(tree, (e) => e.props['aria-label'] === '查词输入').props.value).toBe('bank');
});
it('unmounts private notes on account changes and rejects a late save receipt', async () => {
  state.words = [
    {
      id: 'saved-water',
      wordId: water.id,
      word: waterBrief,
      note: 'private-a-note',
      favorite: true,
      paused: false,
      status: 'active',
      progress: null,
    },
  ];
  let tree = render('wordbook');
  (find(tree, (e) => e.props['aria-label'] === '展开 water').props.onClick as () => void)();
  tree = render('wordbook');
  (find(tree, (e) => e.props['aria-label'] === '编辑 water 备注').props.onClick as () => void)();
  tree = render('wordbook');
  let resolve!: (value: unknown) => void;
  vi.mocked(post).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  (
    find(
      find(tree, (e) => e.type === Dialog && e.props.title === '留下自己的语境'),
      (e) => e.type === 'button',
    ).props.onClick as () => void
  )();
  await Promise.resolve();
  const previous = LookupPage({ initialTab: 'wordbook' }).key;
  cleanup();
  state.scope = 'lookup-test:user-b';
  state.slots = [];
  state.refs = [];
  state.effects = [];
  state.words = [];
  expect(LookupPage({ initialTab: 'wordbook' }).key).not.toBe(previous);
  tree = render('wordbook');
  resolve({ item: { id: 'saved-water', wordId: water.id, note: 'private-a-note' } });
  await settle('wordbook');
  expect(
    find(tree, (e) => e.type === Dialog && e.props.title === '留下自己的语境').props.open,
  ).toBe(false);
  expect(find(tree, (e) => e.type === 'textarea').props.value).toBe('');
  expect(
    state.client!.getQueryData(wordbookEntryKey('lookup-test:user-a', water.id)),
  ).toBeUndefined();
  expect(state.client!.getQueryData(wordbookEntryKey(state.scope, water.id))).toBeUndefined();
});
it('does not hydrate hidden details and aborts a visible request on screen deactivation', async () => {
  state.active = false;
  await state.router!.navigate('/lookup?q=water&entry=lookup-water');
  await settle();
  expect(api).not.toHaveBeenCalled();
  expect(state.infiniteEnabled).toBe(false);
  state.active = true;
  vi.mocked(api).mockImplementation(() => new Promise(() => {}));
  render();
  const signal = vi.mocked(api).mock.calls[0]![1]!.signal;
  state.active = false;
  render();
  expect(signal?.aborted).toBe(true);
  expect(state.infiniteEnabled).toBe(false);
});
