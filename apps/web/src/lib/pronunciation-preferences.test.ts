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
    remoteEnabled: undefined as boolean | undefined,
    remoteCompatible: undefined as boolean | undefined,
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
  useRemote: (_key: string, _path: string, enabled: boolean) => {
    state.remoteEnabled = enabled;
    return {
      data: { pronunciation: { audio, pronunciationCompatible: state.remoteCompatible } },
      isPending: false,
      error: null,
    };
  },
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
function render(autoPlay = true, value: Word = word) {
  state.cursor = 0;
  state.refCursor = 0;
  state.effects = [];
  state.effectCursor = 0;
  return AudioButton({ word: value, autoPlay });
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
  state.remoteEnabled = undefined;
  state.remoteCompatible = undefined;
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

it('blocks incompatible word-level audio and cached metadata without starting another request', () => {
  state.autoPlay = true;
  const tree = render(true, { ...word, audio, pronunciationCompatible: false });
  runAutomaticEffect();
  expect(state.remoteEnabled).toBe(false);
  expect(instances).toHaveLength(0);
  const buttons = elements(tree).filter((item) => item.type === 'button');
  expect(buttons).toHaveLength(2);
  expect(buttons.every((item) => item.props.disabled === true)).toBe(true);
  expect(buttons.every((item) => String(item.props['aria-label']).startsWith('暂无'))).toBe(true);
  const ipa = elements(tree).filter((item) => item.props.className === 'pronunciation-ipa');
  expect(ipa.map((item) => item.props.children)).toEqual(['暂无音标', '暂无音标']);
});

it('stops a playing word recording when its pronunciation compatibility is revoked', () => {
  state.autoPlay = true;
  render();
  runAutomaticEffect();
  expect(instances).toHaveLength(1);
  render(true, { ...word, pronunciationCompatible: false });
  runAutomaticEffect();
  expect(instances[0]!.pause).toHaveBeenCalled();
  expect(instances).toHaveLength(1);
});

it('honours a negative pronunciation response over stale embedded audio and IPA', () => {
  state.remoteCompatible = false;
  state.autoPlay = true;
  for (const value of [word, { ...word, audio }]) {
    const tree = render(true, value);
    runAutomaticEffect();
    const buttons = elements(tree).filter((item) => item.type === 'button');
    expect(buttons.every((item) => item.props.disabled === true)).toBe(true);
    expect(buttons.every((item) => String(item.props['aria-label']).startsWith('暂无'))).toBe(true);
    expect(
      elements(tree)
        .filter((item) => item.props.className === 'pronunciation-ipa')
        .map((item) => item.props.children),
    ).toEqual(['暂无音标', '暂无音标']);
  }
  expect(instances).toHaveLength(0);
});

it('stops the current recording when pronunciation metadata changes to incompatible', () => {
  state.autoPlay = true;
  render();
  runAutomaticEffect();
  expect(instances).toHaveLength(1);
  state.remoteCompatible = false;
  render();
  runAutomaticEffect();
  expect(instances[0]!.pause).toHaveBeenCalled();
  expect(instances).toHaveLength(1);
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
