import React, { type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AudioButton } from '../components/Pronunciation';
import type { Word, WordAudio } from './types';
import { stopApplicationAudio } from './audio-manager';

const state = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  return {
    accent: 'uk' as 'us' | 'uk',
    autoPlay: false,
    loaded: true,
    active: true,
    slots: [] as unknown[],
    cursor: 0,
    refs: [] as { current: unknown }[],
    refCursor: 0,
    effects: [] as (() => unknown)[],
    effectCursor: 0,
    effectSlots: [] as { deps?: readonly unknown[]; cleanup?: () => void }[],
    rejectAudio: false,
  };
});
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = state.cursor++;
      if (!(index in state.slots))
        state.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        state.slots[index],
        (value: unknown) => {
          state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value;
        },
      ];
    },
    useRef: (initial: unknown) => (state.refs[state.refCursor++] ??= { current: initial }),
    useCallback: (callback: unknown) => callback,
    useEffect: (callback: () => unknown, deps: readonly unknown[] = []) => {
      const index = state.effectCursor++,
        previous = state.effectSlots[index];
      if (
        previous?.deps &&
        deps.length === previous.deps.length &&
        deps.every((value, i) => Object.is(value, previous.deps![i]))
      )
        return;
      state.effects.push(() => {
        previous?.cleanup?.();
        const cleanup = callback();
        state.effectSlots[index] = {
          deps,
          cleanup: typeof cleanup === 'function' ? (cleanup as () => void) : undefined,
        };
      });
    },
  };
});
vi.mock('../LearningPreferences', () => ({
  useLearningPreferences: () => ({
    preferences: { accent: state.accent, autoPlay: state.autoPlay },
    loaded: state.loaded,
  }),
}));
vi.mock('./screen-lifecycle', async (original) => ({
  ...(await original<typeof import('./screen-lifecycle')>()),
  useScreenActive: () => state.active,
}));
const word: Word = {
  id: 'audio-preference-water',
  lemma: 'water',
  phoneticUs: 'us-test',
  phoneticUk: 'uk-test',
};
const audio: WordAudio[] = (['US', 'UK'] as const).map((accent) => ({
  id: `audio-${accent}`,
  accent,
  kind: 'synthesized',
  url: `/api/v2/pronunciation/${word.id}/audio/${accent}`,
  status: 'ready',
  sourceName: 'Component test',
  sourceUrl: null,
  license: null,
  attribution: null,
  mimeType: 'audio/wav',
}));
vi.mock('../AppContext', () => ({
  useApp: () => ({ user: { id: 'audio-test-user' }, scope: 'audio-test:user' }),
  useRemote: () => ({ data: { pronunciation: { audio } }, isPending: false, error: null }),
}));
const instances: FakeAudio[] = [];
class FakeAudio {
  src: string;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  removeAttribute = vi.fn();
  play = vi.fn(() =>
    state.rejectAudio ? Promise.reject(new Error('mock autoplay denied')) : Promise.resolve(),
  );
  constructor(url: string) {
    this.src = url;
    instances.push(this);
  }
}
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (!React.isValidElement<Record<string, unknown>>(node))
    return Array.isArray(node) ? node.flatMap(elements) : [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function render(autoPlay = true) {
  state.cursor = 0;
  state.refCursor = 0;
  state.effects = [];
  state.effectCursor = 0;
  return AudioButton({ word, autoPlay });
}
function runAutomaticEffect() {
  for (const effect of state.effects) effect();
  state.effects = [];
}
beforeAll(() =>
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected audio network'))),
);
beforeEach(() => {
  stopApplicationAudio();
  state.accent = 'uk';
  state.autoPlay = false;
  state.loaded = true;
  state.active = true;
  state.slots = [];
  state.refs = [];
  state.effects = [];
  state.effectSlots = [];
  state.effectCursor = 0;
  state.rejectAudio = false;
  instances.length = 0;
  vi.stubGlobal('React', React);
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubGlobal('window', {
    __NIGHTSTUDY_CONFIG__: {},
    clearTimeout: vi.fn(),
    setTimeout: vi.fn().mockReturnValue(1),
  });
});
afterAll(() => {
  stopApplicationAudio();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('orders exactly two independently labelled audio buttons by the saved accent', () => {
  const buttons = elements(render()).filter((element) => element.type === 'button');
  expect(buttons).toHaveLength(2);
  expect(buttons[0]!.props['aria-label']).toContain('英式');
  expect(buttons[1]!.props['aria-label']).toContain('美式');
  expect(
    elements(render())
      .filter((element) => element.props.className === 'pronunciation-region-label')
      .map((element) => element.props.children),
  ).toEqual(['英', '美']);
  runAutomaticEffect();
  expect(instances).toHaveLength(0);
});

it('requires loaded opt-in and the study surface before attempting any automatic audio', () => {
  state.autoPlay = true;
  render(false);
  runAutomaticEffect();
  expect(instances).toHaveLength(0);
  state.loaded = false;
  render();
  runAutomaticEffect();
  expect(instances).toHaveLength(0);
  state.loaded = true;
  state.active = false;
  render();
  runAutomaticEffect();
  expect(instances).toHaveLength(0);
  state.active = true;
  render();
  runAutomaticEffect();
  expect(instances).toHaveLength(1);
  expect(instances[0]!.src).toBe(`/api/v2/pronunciation/${word.id}/audio/UK`);
  render();
  runAutomaticEffect();
  expect(instances).toHaveLength(1);
});

it('shows a failed autoplay attempt without retrying on render or silently switching the source', async () => {
  state.autoPlay = true;
  state.rejectAudio = true;
  render();
  runAutomaticEffect();
  await Promise.resolve();
  let tree = render();
  expect(
    elements(tree).some(
      (element) =>
        element.props.role === 'alert' &&
        String(element.props.children).includes('请检查网络后重试'),
    ),
  ).toBe(true);
  runAutomaticEffect();
  expect(instances).toHaveLength(1);
  state.rejectAudio = false;
  const us = elements(tree).find(
    (element) => element.type === 'button' && String(element.props['aria-label']).includes('美式'),
  )!;
  (us.props.onClick as () => void)();
  expect(instances).toHaveLength(2);
  expect(instances[0]!.pause).toHaveBeenCalled();
  expect(instances[1]!.src).toBe(`/api/v2/pronunciation/${word.id}/audio/US`);
  tree = render();
  runAutomaticEffect();
  expect(instances).toHaveLength(2);
});
