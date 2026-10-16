import React, { type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SentenceAudioButton } from './SentenceAudio';
import { AudioButton } from './Pronunciation';
import { sentenceAudioHash } from '../lib/sentence-audio';
import type { Word } from '../lib/types';

interface Effect {
  deps?: readonly unknown[];
  cleanup?: () => void;
}
const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  refs: [] as { current: unknown }[],
  refCursor: 0,
  effects: [] as Effect[],
  effectCursor: 0,
  pending: [] as { index: number; deps?: readonly unknown[]; setup: () => unknown }[],
  remote: { data: undefined as unknown, error: null as Error | null, isFetching: false },
  requests: [] as { path: string; enabled: boolean }[],
  refetch: vi.fn(),
  play: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = state.cursor++;
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
  useEffect: (setup: () => unknown, deps?: readonly unknown[]) => {
    const index = state.effectCursor++,
      previous = state.effects[index];
    if (
      !previous ||
      !deps ||
      !previous.deps ||
      deps.length !== previous.deps.length ||
      deps.some((value, i) => !Object.is(value, previous.deps![i]))
    )
      state.pending.push({ index, deps, setup });
  },
}));
vi.mock('../AppContext', () => ({
  useApp: () => ({ scope: 'audio-ui-test:mount-a:guest' }),
  useRemote: (_key: string, path: string, enabled = true) => {
    state.requests.push({ path, enabled });
    return { ...state.remote, refetch: state.refetch };
  },
}));
vi.mock('../LearningPreferences', () => ({
  useLearningPreferences: () => ({ preferences: { accent: 'us', autoPlay: false }, loaded: true }),
}));
vi.mock('../lib/screen-lifecycle', () => ({ useScreenActive: () => true }));
vi.mock('../lib/api', () => ({ mountUrl: (url: string) => '/study' + url }));
vi.mock('../lib/sentence-audio', async (original) => ({
  ...(await original<typeof import('../lib/sentence-audio')>()),
  sentenceAudioHash: vi.fn(),
}));
vi.mock('./usePackedAudio', () => ({
  usePackedAudio: () => ({ phase: 'idle', playing: false, play: state.play, stop: state.stop }),
}));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (!React.isValidElement<Record<string, unknown>>(node))
    return Array.isArray(node) ? node.flatMap(elements) : [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const buttons = (tree: ReactNode) => elements(tree).filter((entry) => entry.type === 'button');
function render(component: () => ReactNode) {
  state.cursor = state.refCursor = state.effectCursor = 0;
  state.pending = [];
  const tree = component();
  for (const entry of elements(tree)) {
    const ref = entry.props.ref as { current: unknown } | undefined;
    if (ref) ref.current = { testNode: true };
  }
  for (const effect of [...state.pending]) {
    state.effects[effect.index]?.cleanup?.();
    const cleanup = effect.setup();
    state.effects[effect.index] = {
      deps: effect.deps,
      cleanup: typeof cleanup === 'function' ? (cleanup as () => void) : undefined,
    };
  }
  return tree;
}
const observers: {
  callback: (entries: { isIntersecting: boolean }[]) => void;
  disconnect: ReturnType<typeof vi.fn>;
}[] = [];
const hashA = 'a'.repeat(64),
  hashB = 'b'.repeat(64);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
  state.values = [];
  state.refs = [];
  state.effects = [];
  state.pending = [];
  state.requests = [];
  state.remote = { data: undefined, error: null, isFetching: false };
  state.refetch.mockReset();
  state.play.mockReset();
  state.stop.mockReset();
  observers.length = 0;
  vi.stubGlobal('React', React);
  vi.stubGlobal('crypto', { subtle: {} });
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(public callback: (entries: { isIntersecting: boolean }[]) => void) {
        observers.push(this);
      }
    },
  );
  vi.mocked(sentenceAudioHash).mockReset().mockResolvedValue(hashA);
});
afterEach(() => {
  for (const effect of state.effects) effect?.cleanup?.();
  vi.unstubAllGlobals();
});
async function visible(component: () => ReactNode) {
  render(component);
  observers[0]!.callback([{ isIntersecting: true }]);
  render(component);
  await tick();
  return render(component);
}

it('defers hashing and metadata until visible, without announcing that unloaded audio is missing', async () => {
  const component = () => SentenceAudioButton({ text: 'A quiet evening.' });
  let tree = render(component);
  expect(sentenceAudioHash).not.toHaveBeenCalled();
  expect(state.requests.every((request) => !request.enabled)).toBe(true);
  expect(buttons(tree).map((button) => button.props['aria-label'])).toEqual([
    '正在读取美式例句发音',
    '正在读取英式例句发音',
  ]);
  observers[0]!.callback([{ isIntersecting: true }]);
  render(component);
  await tick();
  state.remote.isFetching = true;
  tree = render(component);
  expect(sentenceAudioHash).toHaveBeenCalledExactlyOnceWith('A quiet evening.');
  expect(state.requests.at(-1)).toEqual({ path: `sentence-audio/${hashA}`, enabled: true });
  expect(buttons(tree).every((button) => button.props.disabled && button.props['aria-busy'])).toBe(
    true,
  );
});

it('offers metadata retry after failure and only marks an accent missing after a successful empty response', async () => {
  const component = () => SentenceAudioButton({ text: 'A quiet evening.' });
  await visible(component);
  state.remote.error = new Error('offline');
  let tree = render(component),
    button = buttons(tree)[0]!;
  expect(button.props['aria-label']).toBe('重新读取美式例句发音');
  expect(button.props.disabled).toBe(false);
  (button.props.onClick as () => void)();
  expect(state.refetch).toHaveBeenCalledOnce();
  expect(state.play).not.toHaveBeenCalled();
  state.remote = {
    data: { sentence: { textHash: hashA, text: null, audio: [] } },
    error: null,
    isFetching: false,
  };
  tree = render(component);
  expect(buttons(tree).map((entry) => entry.props['aria-label'])).toEqual([
    '暂无美式例句发音',
    '暂无英式例句发音',
  ]);
  expect(buttons(tree).every((entry) => entry.props.disabled && !entry.props['aria-busy'])).toBe(
    true,
  );
});

it('ignores a previous sentence hash finishing late after the visible sentence changes', async () => {
  const resolves = new Map<string, (hash: string) => void>();
  vi.mocked(sentenceAudioHash).mockImplementation(
    (text) => new Promise((resolve) => resolves.set(text, resolve)),
  );
  let text = 'First sentence.';
  const component = () => SentenceAudioButton({ text });
  render(component);
  observers[0]!.callback([{ isIntersecting: true }]);
  render(component);
  text = 'Second sentence.';
  render(component);
  resolves.get('First sentence.')!(hashA);
  await tick();
  render(component);
  expect(state.requests.some((entry) => entry.enabled && entry.path.endsWith(hashA))).toBe(false);
  resolves.get('Second sentence.')!(hashB);
  await tick();
  render(component);
  expect(state.requests.at(-1)).toEqual({ path: `sentence-audio/${hashB}`, enabled: true });
});

it('plays only the matching accent and cannot reuse old metadata or a cross-accent URL', async () => {
  let text = 'A quiet evening.';
  const component = () => SentenceAudioButton({ text });
  await visible(component);
  state.remote.data = {
    sentence: {
      textHash: hashA,
      text,
      audio: [
        { accent: 'US', status: 'ready', url: `/api/v2/sentence-audio/${hashA}/audio/US` },
        { accent: 'UK', status: 'ready', url: `/api/v2/sentence-audio/${hashA}/audio/US` },
      ],
    },
  };
  let tree = render(component);
  expect(buttons(tree)[1]!.props.disabled).toBe(true);
  (buttons(tree)[0]!.props.onClick as () => void)();
  expect(state.play).toHaveBeenCalledExactlyOnceWith(
    `/study/api/v2/sentence-audio/${hashA}/audio/US`,
  );
  text = 'Changed sentence.';
  vi.mocked(sentenceAudioHash).mockResolvedValue(hashB);
  tree = render(component);
  await tick();
  tree = render(component);
  expect(
    buttons(tree).some((button) => String(button.props['aria-label']).startsWith('播放')),
  ).toBe(false);
  (buttons(tree)[0]!.props.onClick as () => void)();
  expect(state.play).toHaveBeenCalledTimes(1);
});

it('accepts a published paragraph above the old 2000-character UI limit', async () => {
  const text = 'A '.repeat(1100).trim();
  await visible(() => SentenceAudioButton({ text }));
  expect(sentenceAudioHash).toHaveBeenCalledWith(text);
  expect(state.requests.at(-1)!.enabled).toBe(true);
});

it('word pronunciation keeps pending and retry distinct from confirmed missing audio', () => {
  const component = () => AudioButton({ word: { id: 'rain', lemma: 'rain' } });
  let tree = render(component);
  expect(
    buttons(tree).every((button) => String(button.props['aria-label']).startsWith('正在读取')),
  ).toBe(true);
  state.remote.error = new Error('offline');
  tree = render(component);
  expect(buttons(tree)[0]!.props.disabled).toBe(false);
  (buttons(tree)[0]!.props.onClick as () => void)();
  expect(state.refetch).toHaveBeenCalledOnce();
  state.remote = {
    data: { pronunciation: { audio: [], phonetics: [] } },
    error: null,
    isFetching: false,
  };
  tree = render(component);
  expect(
    buttons(tree).every(
      (button) => button.props.disabled && String(button.props['aria-label']).startsWith('暂无'),
    ),
  ).toBe(true);
});

it('uses already complete word audio without another request, but still resolves incomplete IPA', () => {
  const word: Word = {
    id: 'rain',
    lemma: 'rain',
    phoneticUs: '/reɪn/',
    phoneticUk: '/reɪn/',
    audio: (['US', 'UK'] as const).map((accent) => ({
      id: `rain-${accent}`,
      accent,
      kind: 'recorded',
      status: 'ready',
      url: `/api/v2/pronunciation/rain/audio/${accent}`,
      sourceName: 'test recording',
      sourceUrl: null,
      license: null,
      attribution: null,
      mimeType: 'audio/mpeg',
    })),
  };
  const component = () => AudioButton({ word });
  const tree = render(component);
  expect(state.requests.at(-1)).toEqual({ path: 'pronunciation/rain', enabled: false });
  (buttons(tree)[0]!.props.onClick as () => void)();
  expect(state.play).toHaveBeenCalledExactlyOnceWith('/study/api/v2/pronunciation/rain/audio/US');
  word.phoneticUk = '';
  render(component);
  expect(state.requests.at(-1)).toEqual({ path: 'pronunciation/rain', enabled: true });
});
