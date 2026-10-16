import React, { type ReactElement, type ReactNode } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { LearningLibraryPage } from '../pages/LearningLibrary';
import { AudioButton } from '../components/Pronunciation';
import { Dialog, Notice, WordSaveButton } from '../components/UI';
import { api, post } from './api';
import type { LibraryResponse, LibraryWord } from './mobile-content-types';

interface Effect {
  deps: unknown[];
  cleanup?: () => void;
}
const state = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  return {
    scope: 'library:user-a',
    active: true,
    slots: [] as unknown[],
    cursor: 0,
    refs: [] as { current: unknown }[],
    refCursor: 0,
    effects: [] as Effect[],
    effectCursor: 0,
    pending: [] as { index: number; deps: unknown[]; setup: () => unknown }[],
    router: null as ReturnType<typeof createMemoryRouter> | null,
    client: null as QueryClient | null,
    response: null as LibraryResponse | null,
    error: null as unknown,
    query: null as null | {
      queryKey: unknown[];
      enabled: boolean;
      queryFn: (value: { pageParam: string; signal: AbortSignal }) => Promise<unknown>;
    },
    scrollY: 0,
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
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
  useEffect: (setup: () => unknown, deps: unknown[]) => {
    const index = state.effectCursor++;
    const previous = state.effects[index];
    if (
      !previous ||
      deps.length !== previous.deps.length ||
      deps.some((value, i) => !Object.is(value, previous.deps[i]))
    )
      state.pending.push({ index, deps, setup });
  },
}));
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => state.router!.navigate,
  useSearchParams: () => [
    new URLSearchParams(state.router!.state.location.search),
    (params: URLSearchParams, options?: { replace?: boolean }) =>
      void state.router!.navigate(`/library?${params}`, options),
  ],
}));
vi.mock('../AppContext', () => ({
  useApp: () => ({ user: { id: state.scope }, scope: state.scope }),
}));
vi.mock('./screen-lifecycle', async (original) => ({
  ...(await original<typeof import('./screen-lifecycle')>()),
  useScreenActive: () => state.active,
}));
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => state.client,
  useInfiniteQuery: (options: typeof state.query) => {
    state.query = options;
    return {
      data: state.response ? { pages: [state.response] } : undefined,
      isPending: false,
      isFetching: false,
      error: state.error,
      refetch: vi.fn(),
    };
  },
}));
vi.mock('./api', () => ({
  api: vi.fn(),
  post: vi.fn(),
  errorText: (error: Error) => error.message,
}));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (!React.isValidElement<Record<string, unknown>>(node))
    return Array.isArray(node) ? node.flatMap(elements) : [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function find(tree: ReactNode, predicate: (element: Element) => boolean) {
  const element = elements(tree).find(predicate);
  if (!element) throw Error('Library control missing');
  return element;
}
function click(tree: ReactNode, label: string) {
  (find(tree, (element) => element.props['aria-label'] === label).props.onClick as () => void)();
}
function render() {
  state.cursor = state.refCursor = state.effectCursor = 0;
  state.pending = [];
  const wrapper = LearningLibraryPage();
  const tree = (wrapper.type as (props: unknown) => Element)(wrapper.props);
  for (const effect of state.pending) {
    state.effects[effect.index]?.cleanup?.();
    const cleanup = effect.setup();
    state.effects[effect.index] = {
      deps: effect.deps,
      cleanup: typeof cleanup === 'function' ? (cleanup as () => void) : undefined,
    };
  }
  return tree;
}
async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    render();
  }
  return render();
}
function cleanup() {
  for (const effect of state.effects) effect?.cleanup?.();
}
const water: LibraryWord = {
  word: {
    id: 'water-id',
    lemma: 'water',
    senses: [{ id: 'water-noun', pos: 'n.', definitionZh: '水', definitionEn: 'A clear liquid.' }],
  },
  progress: null,
  learnedAt: null,
  reviewedAt: null,
  dueAt: null,
  reviewCount: 0,
  paused: false,
  collection: { inWordbook: false, wordbookStatus: null },
};
beforeAll(() => {
  vi.stubGlobal('React', React);
});
beforeEach(() => {
  cleanup();
  state.router?.dispose();
  state.client?.clear();
  state.scope = 'library:user-a';
  state.active = true;
  state.slots = [];
  state.refs = [];
  state.effects = [];
  state.pending = [];
  state.error = null;
  state.query = null;
  state.scrollY = 0;
  state.client = new QueryClient();
  state.router = createMemoryRouter([{ path: '*', element: null }], {
    initialEntries: ['/library?bookId=cet4&view=all&sort=book'],
  });
  state.response = {
    book: { id: 'cet4', title: '四级词书' },
    items: [water],
    page: { total: 1, hasMore: false, nextCursor: null },
  };
  vi.mocked(api).mockReset();
  vi.mocked(post).mockReset();
  vi.stubGlobal('window', {
    __NIGHTSTUDY_CONFIG__: {},
    get scrollY() {
      return state.scrollY;
    },
    scrollTo: vi.fn((value: { top: number }) => {
      state.scrollY = value.top;
    }),
  });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    callback();
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterAll(() => {
  cleanup();
  state.router?.dispose();
  state.client?.clear();
  vi.unstubAllGlobals();
});

it('shows compact words first and reveals details only for the chosen row', async () => {
  let tree = await settle();
  expect(elements(tree).some((element) => element.type === AudioButton)).toBe(false);
  expect(elements(tree).some((element) => element.props.className === 'library-definition')).toBe(
    false,
  );
  click(tree, '展开 water');
  tree = render();
  expect(find(tree, (element) => element.type === AudioButton).props.word).toEqual(water.word);
  expect(find(tree, (element) => element.type === WordSaveButton).props.saved).toBe(false);
  click(tree, '收起 water');
  tree = render();
  click(tree, '显示全部释义');
  tree = render();
  expect(find(tree, (element) => element.props.className === 'library-definition')).toBeDefined();
  expect(elements(tree).some((element) => element.type === AudioButton)).toBe(false);
});

it('locates a book search candidate without navigating to a global dictionary entry', async () => {
  await state.router!.navigate('/library?bookId=cet4&view=unlearned&sort=za&q=wat');
  let tree = await settle();
  click(tree, '定位 water');
  tree = await settle();
  expect(state.router!.state.location.pathname).toBe('/library');
  expect(state.router!.state.location.search).toBe(
    '?bookId=cet4&view=unlearned&sort=za&anchor=water-id',
  );
  await state.query!.queryFn({ pageParam: '', signal: new AbortController().signal });
  expect(api).toHaveBeenCalledWith(
    'library/words?bookId=cet4&view=unlearned&sort=za&locate=water-id&limit=30',
    expect.anything(),
  );
});

it('highlights and expands only the stable anchor confirmed by the server', async () => {
  await state.router!.navigate('/library?bookId=cet4&anchor=water-id');
  let tree = await settle();
  const scrollIntoView = vi.fn();
  (tree.props.ref as { current: unknown }).current = {
    querySelectorAll: () => [{ dataset: { wordId: 'water-id' }, scrollIntoView }],
  };
  expect(scrollIntoView).not.toHaveBeenCalled();
  state.response = {
    ...state.response!,
    page: { ...state.response!.page, anchorWordId: 'water-id' },
  };
  tree = await settle();
  expect(scrollIntoView).toHaveBeenCalledOnce();
  expect(find(tree, (element) => element.props['aria-label'] === '收起 water')).toBeDefined();
  render();
  expect(scrollIntoView).toHaveBeenCalledOnce();
});

it('does not redirect a missing anchor to another word and offers to reset the range', async () => {
  await state.router!.navigate('/library?bookId=cet4&view=known&anchor=missing-word');
  state.response = null;
  state.error = { status: 404, code: 'library_anchor_missing' };
  let tree = await settle();
  const notice = find(tree, (element) => element.type === Notice);
  const reset = find(notice, (element) => element.type === 'button');
  (reset.props.onClick as () => void)();
  tree = await settle();
  expect(state.router!.state.location.search).toBe('?bookId=cet4&view=known&sort=book');
  expect(elements(tree).some((element) => element.type === AudioButton)).toBe(false);
});

it.each([
  { status: 404, code: 'library_anchor_not_found' },
  { status: 404, code: 'book_not_found' },
  { status: 409, code: 'list_changed' },
  { status: 410, code: 'cursor_expired' },
  { status: 400, code: 'invalid_cursor' },
])('hides cached rows when their scope or cursor is invalid: $code', async (error) => {
  let tree = await settle();
  click(tree, '展开 water');
  tree = render();
  expect(find(tree, (element) => element.type === AudioButton)).toBeDefined();
  state.error = error;
  tree = render();
  expect(elements(tree).some((element) => element.props['data-word-id'] === water.word.id)).toBe(
    false,
  );
  expect(
    elements(tree).some(
      (element) => element.type === AudioButton || element.type === WordSaveButton,
    ),
  ).toBe(false);
  expect(post).not.toHaveBeenCalled();
});

it('keeps a cached word readable on an ordinary network error and waits for a fresh list before changing its collection', async () => {
  let tree = await settle();
  click(tree, '展开 water');
  tree = render();
  state.error = new Error('network unavailable');
  tree = render();
  expect(find(tree, (element) => element.type === AudioButton)).toBeDefined();
  const save = find(tree, (element) => element.type === WordSaveButton);
  expect(save.props.disabled).toBe(true);
  (save.props.onClick as () => void)();
  await settle();
  expect(post).not.toHaveBeenCalled();
});

it('applies global book sorting only after confirming the panel', async () => {
  let tree = await settle();
  click(tree, '排序方式：词书顺序');
  tree = render();
  const panel = find(tree, (element) => element.type === Dialog);
  (
    find(panel, (element) => element.type === 'button' && element.props.children === 'Z → A').props
      .onClick as () => void
  )();
  expect(state.router!.state.location.search).toContain('sort=book');
  tree = render();
  (
    find(tree, (element) => element.type === 'button' && element.props.children === '应用排序')
      .props.onClick as () => void
  )();
  tree = await settle();
  expect(state.router!.state.location.search).toBe('?bookId=cet4&view=all&sort=za');
  expect(state.query!.queryKey).toEqual([
    state.scope,
    'library',
    'pages',
    'cet4',
    'all',
    '',
    'za',
    '',
  ]);
});

it('retains the list URL and scroll when returning from complete dictionary details', async () => {
  let tree = await settle();
  click(tree, '展开 water');
  tree = render();
  const screen = { scrollTop: 530 };
  (tree.props.ref as { current: unknown }).current = { closest: () => screen };
  state.scrollY = 90;
  (
    find(
      tree,
      (element) =>
        element.type === 'button' &&
        Array.isArray(element.props.children) &&
        element.props.children[0] === '完整词条 ',
    ).props.onClick as () => void
  )();
  expect(state.router!.state.location.pathname).toBe('/lookup');
  expect(state.router!.state.location.search).toContain('entry=water-id');
  state.active = false;
  render();
  screen.scrollTop = 0;
  state.scrollY = 0;
  await state.router!.navigate(-1);
  state.active = true;
  tree = await settle();
  expect(state.router!.state.location.search).toBe('?bookId=cet4&view=all&sort=book');
  expect(screen.scrollTop).toBe(530);
  expect(state.scrollY).toBe(90);
  expect(find(tree, (element) => element.props['aria-label'] === '收起 water')).toBeDefined();
});

it('uses accepted bookmark receipts without promoting a failed save or retaining stale overrides', async () => {
  let tree = await settle();
  click(tree, '展开 water');
  tree = render();
  vi.mocked(post).mockRejectedValueOnce(new Error('unavailable'));
  await (
    find(tree, (element) => element.type === WordSaveButton).props.onClick as () => Promise<void>
  )();
  tree = await settle();
  expect(find(tree, (element) => element.type === WordSaveButton).props.saved).toBe(false);
  vi.mocked(post).mockResolvedValueOnce({
    item: { id: 'saved-water', wordId: water.word.id, note: '', favorite: true, paused: false },
    collection: { inWordbook: true, wordbookStatus: 'active', known: null },
  });
  await (
    find(tree, (element) => element.type === WordSaveButton).props.onClick as () => Promise<void>
  )();
  tree = await settle();
  expect(find(tree, (element) => element.type === WordSaveButton).props.saved).toBe(true);
  // A later fresh list response is authoritative, including a removal from another screen.
  state.response = {
    ...state.response!,
    items: [{ ...water, collection: { inWordbook: false, wordbookStatus: null } }],
  };
  tree = render();
  expect(find(tree, (element) => element.type === WordSaveButton).props.saved).toBe(false);
});
