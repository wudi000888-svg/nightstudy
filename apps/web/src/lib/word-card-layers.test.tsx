import React, { type ReactElement, type ReactNode } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WordCardContent, WordCardProvider, WordCardSummary } from '../components/WordCards';
import { api } from './api';
import {
  consumeTopLayer,
  createAppBackHandler,
  installAppBackBridge,
  registerAppBackHandler,
  screenDeactivateEvent,
} from './screen-lifecycle';
import type { Word } from './types';

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as { current: unknown }[],
  memos: [] as { deps: unknown[]; value: unknown }[],
  effects: [] as { deps: unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  valueCursor: 0,
  refCursor: 0,
  memoCursor: 0,
  effectCursor: 0,
  scope: 'card-layer:user-a',
  locationKey: 'learning-screen',
  client: null as QueryClient | null,
  surfaceHeight: 330,
  scrollHeight: 200,
  scrollClientHeight: 200,
  triggerConnected: true,
}));
function sameDeps(previous: unknown[], next: unknown[]) {
  return (
    previous.length === next.length &&
    next.every((value, index) => Object.is(value, previous[index]))
  );
}
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const memo = (factory: () => unknown, deps: unknown[]) => {
    const index = state.memoCursor++;
    const previous = state.memos[index];
    if (!previous || !sameDeps(previous.deps, deps))
      state.memos[index] = { deps, value: factory() };
    return state.memos[index]!.value;
  };
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = state.valueCursor++;
      if (!(index in state.values))
        state.values[index] = typeof initial === 'function' ? initial() : initial;
      return [
        state.values[index],
        (next: unknown) => {
          state.values[index] = typeof next === 'function' ? next(state.values[index]) : next;
        },
      ];
    },
    useRef: (initial: unknown) => (state.refs[state.refCursor++] ??= { current: initial }),
    useMemo: memo,
    useCallback: (callback: unknown, deps: unknown[]) => memo(() => callback, deps),
    useId: () => 'layer-test-title',
    useEffect: (setup: () => (() => void) | undefined, deps: unknown[]) => {
      const index = state.effectCursor++;
      const previous = state.effects[index];
      if (previous && sameDeps(previous.deps, deps)) return;
      state.pending.push(() => {
        previous?.cleanup?.();
        state.effects[index] = { deps, cleanup: setup() };
      });
    },
  };
});
vi.mock('react-dom', async (original) => ({
  ...(await original<typeof import('react-dom')>()),
  createPortal: (node: ReactNode) => node,
}));
vi.mock('../AppContext', () => ({
  useApp: () => ({ user: { id: 'user-a' }, scope: state.scope }),
  useRemote: () => ({ data: { item: null }, error: null, isFetching: false, refetch: vi.fn() }),
}));
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useLocation: () => ({ key: state.locationKey }),
}));
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => state.client,
}));
vi.mock('./api', () => ({ api: vi.fn(), errorText: (error: Error) => error.message }));

const word: Word = {
  id: 'card-water',
  lemma: 'water',
  senses: [{ id: 'water-n', pos: 'n.', definitionZh: '水', definitionEn: 'A clear liquid.' }],
};
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function find(tree: ReactNode, className: string) {
  const result = elements(tree).find((element) => element.props.className === className);
  if (!result) throw new Error(`Missing ${className}`);
  return result;
}
const focus = vi.fn();
const nativeDialog = {
  open: false,
  contains: () => false,
  showModal: vi.fn(() => {
    nativeDialog.open = true;
  }),
  close: vi.fn(() => {
    nativeDialog.open = false;
  }),
};
function render() {
  state.valueCursor = state.refCursor = state.memoCursor = state.effectCursor = 0;
  const tree = WordCardProvider({ children: null });
  for (const element of elements(tree)) {
    const ref = element.props.ref as { current: unknown } | undefined;
    if (!ref) continue;
    if (element.props.className === 'word-card-layer')
      ref.current = {
        contains: () => false,
        getBoundingClientRect: () => ({ left: 12, right: 372, top: 300, bottom: 630 }),
        querySelector: (selector: string) =>
          selector === '.word-card-panel'
            ? { scrollHeight: state.surfaceHeight }
            : {
                focus,
                scrollTop: 0,
                scrollHeight: state.scrollHeight,
                clientHeight: state.scrollClientHeight,
              },
      };
    if (element.props.className === 'word-card-detail-trigger')
      ref.current = { focus, isConnected: state.triggerConnected };
    if (element.props.className === 'word-card-detail-dialog') ref.current = nativeDialog;
  }
  for (const effect of state.pending.splice(0)) effect();
  return tree;
}
const anchor = {
  getBoundingClientRect: () => ({ left: 20, right: 65, top: 260, bottom: 282 }),
  setAttribute: vi.fn(),
  removeAttribute: vi.fn(),
  focus,
  isConnected: true,
};
async function openCard(source = anchor) {
  const tree = render();
  (tree.props.value as { openWord: (text: string, source: unknown) => void }).openWord(
    'water',
    source,
  );
  await Promise.resolve();
  return render();
}
beforeEach(() => {
  state.values = [];
  state.refs = [];
  state.memos = [];
  state.effects = [];
  state.pending = [];
  state.scope = 'card-layer:user-a';
  state.locationKey = 'learning-screen';
  state.surfaceHeight = 330;
  state.scrollHeight = state.scrollClientHeight = 200;
  state.triggerConnected = true;
  state.client = new QueryClient();
  nativeDialog.open = false;
  vi.clearAllMocks();
  vi.stubGlobal('React', React);
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      innerWidth: 390,
      innerHeight: 844,
      setTimeout: () => 1,
      clearTimeout: vi.fn(),
    }),
  );
  vi.stubGlobal('document', Object.assign(new EventTarget(), { body: {}, activeElement: null }));
  vi.mocked(api).mockResolvedValue({
    word,
    queried: 'water',
    matchedLemma: 'water',
    matchType: 'exact',
  });
});
afterEach(() => {
  for (const effect of state.effects) effect?.cleanup?.();
  state.client?.clear();
  vi.unstubAllGlobals();
});

it('uses a compact first layer and consumes back as details, compact card, then screen', async () => {
  let tree = await openCard();
  expect(elements(tree).some((element) => element.type === WordCardSummary)).toBe(true);
  expect(elements(tree).some((element) => element.type === WordCardContent)).toBe(false);
  (find(tree, 'word-card-detail-trigger').props.onClick as () => void)();
  tree = render();
  expect(nativeDialog.showModal).toHaveBeenCalledOnce();
  expect(nativeDialog.open).toBe(true);
  expect(elements(tree).some((element) => element.type === WordCardContent)).toBe(true);
  expect(consumeTopLayer()).toBe(true);
  tree = render();
  expect(nativeDialog.open).toBe(false);
  expect(find(tree, 'word-card-layer')).toBeDefined();
  expect(
    elements(tree).some((element) => element.props.className === 'word-card-detail-dialog'),
  ).toBe(false);
  expect(consumeTopLayer()).toBe(true);
  tree = render();
  expect(elements(tree).some((element) => element.props.className === 'word-card-layer')).toBe(
    false,
  );
  expect(consumeTopLayer()).toBe(false);
  expect(anchor.removeAttribute).toHaveBeenCalledWith('data-word-card-active');
});

it('browser back after a page reload closes details then the compact card before routing to the earlier screen', async () => {
  const removeBridge = installAppBackBridge();
  let position = { index: 7, key: 'reloaded-study' };
  const restore = vi.fn();
  // There is deliberately no remembered earlier page after this simulated reload.
  const removeHandler = registerAppBackHandler(createAppBackHandler(() => position, restore));
  const router = vi.fn((event: Event) => {
    const index = (event as PopStateEvent).state.idx;
    position = { index, key: index === 7 ? 'reloaded-study' : 'earlier-home' };
  });
  window.addEventListener('popstate', router);
  const pop = (index: number) =>
    window.dispatchEvent(Object.assign(new Event('popstate'), { state: { idx: index } }));
  try {
    let tree = await openCard();
    (find(tree, 'word-card-detail-trigger').props.onClick as () => void)();
    render();
    pop(6);
    tree = render();
    expect(nativeDialog.open).toBe(false);
    expect(find(tree, 'word-card-layer')).toBeDefined();
    expect(router).not.toHaveBeenCalled();
    expect(restore).toHaveBeenLastCalledWith(1);
    pop(7);
    expect(router).toHaveBeenCalledOnce();
    pop(6);
    tree = render();
    expect(elements(tree).some((element) => element.props.className === 'word-card-layer')).toBe(
      false,
    );
    expect(router).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledTimes(2);
    pop(7);
    pop(6);
    expect(position).toEqual({ index: 6, key: 'earlier-home' });
    expect(restore).toHaveBeenCalledTimes(2);
  } finally {
    window.removeEventListener('popstate', router);
    removeHandler();
    removeBridge();
  }
});

it('native Escape returns to the compact card with focus without losing its resolved word', async () => {
  let tree = await openCard();
  (find(tree, 'word-card-detail-trigger').props.onClick as () => void)();
  tree = render();
  const preventDefault = vi.fn();
  (find(tree, 'word-card-detail-dialog').props.onCancel as (event: unknown) => void)({
    preventDefault,
  });
  tree = render();
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(nativeDialog.open).toBe(false);
  expect(find(tree, 'word-card-heading').props.children).toMatchObject({
    props: { children: 'water' },
  });
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(api).toHaveBeenCalledOnce();
});

it('a dismissed pending lookup cannot reopen the card after its response arrives', async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await openCard();
  expect(consumeTopLayer()).toBe(true);
  resolve({ word, queried: 'water', matchedLemma: 'water', matchType: 'exact' });
  await Promise.resolve();
  const tree = render();
  expect(elements(tree).some((element) => element.props.className === 'word-card-layer')).toBe(
    false,
  );
});

it('screen deactivation closes both layers and leaves no trapped native modal', async () => {
  let tree = await openCard();
  (find(tree, 'word-card-detail-trigger').props.onClick as () => void)();
  render();
  window.dispatchEvent(new Event(screenDeactivateEvent));
  tree = render();
  expect(nativeDialog.open).toBe(false);
  expect(elements(tree).some((element) => element.props.className === 'word-card-layer')).toBe(
    false,
  );
  expect(consumeTopLayer()).toBe(false);
});

it('the compact summary uses plain bilingual text under a disabled word-card context', () => {
  const tree = WordCardSummary({ word });
  expect(tree.props.value).toBeNull();
  expect(find(tree, 'word-card-summary-zh').props.children).toBe('水');
  expect(find(tree, 'word-card-summary-en').props.children).toBe('A clear liquid.');
  expect(find(tree, 'sense-pos').props.children).toBe('n.');
  expect(elements(tree).some((element) => element.props.className === 'word-token')).toBe(false);
});

it('never restores focus to a detached detail trigger or source word', async () => {
  const sourceFocus = vi.fn();
  let tree = await openCard({ ...anchor, isConnected: false, focus: sourceFocus });
  (find(tree, 'word-card-detail-trigger').props.onClick as () => void)();
  render();
  state.triggerConnected = false;
  tree = render();
  focus.mockClear();
  expect(consumeTopLayer()).toBe(true);
  expect(focus).not.toHaveBeenCalled();
  render();
  expect(consumeTopLayer()).toBe(true);
  expect(sourceFocus).not.toHaveBeenCalled();
});

it('measures resolved scroll content so a short loading skeleton cannot trap the card at its old height', async () => {
  await openCard();
  state.surfaceHeight = 200;
  state.scrollClientHeight = 80;
  state.scrollHeight = 280;
  window.dispatchEvent(new Event('resize'));
  const tree = render();
  expect(find(tree, 'word-card-layer').props.style).toMatchObject({ maxHeight: 400 });
});
