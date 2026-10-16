import React, { type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudySessionView } from '../components/study/StudySessionView';
import { StudyWordDetails } from '../components/study/StudyWordDetails';
import type { StudySession, Word } from './types';

interface Effect {
  deps?: readonly unknown[];
  cleanup?: () => void;
}
const state = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  return {
    values: [] as unknown[],
    refs: [] as { current: unknown }[],
    effects: [] as Effect[],
    pending: [] as { index: number; deps?: readonly unknown[]; setup: () => unknown }[],
    cursor: 0,
    refCursor: 0,
    effectCursor: 0,
    act: vi.fn(),
    stopAudio: vi.fn(),
  };
});
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
  useId: () => 'study-test-id',
  useEffect: (setup: () => unknown, deps?: readonly unknown[]) => {
    const index = state.effectCursor++;
    const previous = state.effects[index];
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
vi.mock('../components/UI', () => ({
  Empty: () => null,
  WordView: () => null,
  IconActionHint: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../components/study/StudyBookmark', () => ({ StudyBookmark: () => null }));
vi.mock('../lib/audio-manager', () => ({ stopApplicationAudio: state.stopAudio }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (!React.isValidElement<Record<string, unknown>>(node))
    return Array.isArray(node) ? node.flatMap(elements) : [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function render(component: () => ReactNode) {
  state.cursor = state.refCursor = state.effectCursor = 0;
  state.pending = [];
  const tree = component();
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
function button(tree: ReactNode, label: string) {
  const found = elements(tree).find(
    (entry) => entry.type === 'button' && entry.props['aria-label'] === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
const options = [
  { id: 'water', text: '水', pos: 'n.' },
  { id: 'earth', text: '土地', pos: 'n.' },
  { id: 'air', text: '空气', pos: 'n.' },
  { id: 'fire', text: '火', pos: 'n.' },
];
const word: Word = {
  id: 'water',
  lemma: 'water',
  senses: [
    { id: 'noun', definitionZh: '水', definitionEn: 'A liquid.', pos: 'n.' },
    {
      id: 'verb',
      definitionZh: '给植物浇水',
      definitionEn: 'To give a plant water.',
      pos: 'v.',
      examples: [
        {
          id: 'verb-context',
          learningSenseId: 'verb',
          exampleEn: 'Water the plants.',
          exampleZh: '给植物浇水。',
        },
      ],
    },
  ],
};
function session(): StudySession {
  return {
    id: 'group',
    bookId: 'book',
    mode: 'daily',
    phase: 'recall',
    status: 'in_progress',
    revision: 0,
    cursor: 0,
    step: 'recall',
    currentItemId: 'item',
    planId: 'plan',
    taskKind: 'daily',
    pausedAt: null,
    deferredUntil: null,
    learningDate: '2026-10-16',
    learnRecallMode: 'recognition',
    items: [
      {
        id: 'item',
        wordId: word.id,
        ordinal: 0,
        word,
        progressRevision: 0,
        revealed: false,
        rated: false,
        exerciseDone: false,
        status: 'pending',
        bucket: 'new',
        recognition: { options },
      },
    ],
  };
}
function view(current: StudySession, patch: { busy?: boolean; waitingSync?: boolean } = {}) {
  return StudySessionView({
    session: current,
    busy: false,
    waitingSync: false,
    answer: '',
    onAnswer: vi.fn(),
    onAct: state.act,
    onState: vi.fn(),
    onRead: vi.fn(),
    onBack: vi.fn(),
    onTasks: vi.fn(),
    onNext: vi.fn(),
    onFeedbackDone: vi.fn(),
    ...patch,
  });
}
const choiceButtons = (tree: ReactNode) =>
  elements(tree).filter(
    (entry) =>
      entry.type === 'button' && String(entry.props.className).includes('study-choice-option'),
  );
const hiddenMeanings = (tree: ReactNode) =>
  elements(tree).find((entry) => 'hideMeanings' in entry.props)?.props.hideMeanings;

beforeEach(() => {
  state.values = [];
  state.refs = [];
  state.effects = [];
  state.pending = [];
  state.act.mockReset();
  state.stopAudio.mockReset();
  vi.useFakeTimers();
  vi.stubGlobal('React', React);
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout,
    clearTimeout,
  });
});
afterEach(() => {
  for (const effect of state.effects) effect?.cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('reveals the selected fixed option without rating and unfolds only after the server feedback', () => {
  const current = session();
  let tree = render(() => view(current));
  expect(choiceButtons(tree)).toHaveLength(4);
  expect(hiddenMeanings(tree)).toBe(true);
  (choiceButtons(tree)[1]!.props.onClick as () => void)();
  expect(state.act).toHaveBeenCalledExactlyOnceWith('reveal', undefined, undefined, 'earth');
  tree = render(() => view(current, { busy: true }));
  expect(choiceButtons(tree).every((entry) => entry.props.disabled)).toBe(true);
  expect(hiddenMeanings(tree)).toBe(true);
  current.items[0] = {
    ...current.items[0]!,
    revealed: true,
    recognition: { options, selectedOptionId: 'earth', correctOptionId: 'water' },
  };
  tree = render(() => view(current));
  expect(choiceButtons(tree)[0]!.props.className).toContain('is-correct');
  expect(choiceButtons(tree)[1]!.props.className).toContain('is-incorrect');
  expect(hiddenMeanings(tree)).toBe(true);
  vi.advanceTimersByTime(449);
  expect(hiddenMeanings(render(() => view(current)))).toBe(true);
  vi.advanceTimersByTime(1);
  tree = render(() => view(current));
  expect(choiceButtons(tree)).toHaveLength(0);
  expect(hiddenMeanings(tree)).toBe(false);
  expect(state.act).toHaveBeenCalledTimes(1);
  expect(button(tree, '记住了，下一词').props.disabled).toBe(false);
});

it('restores a revealed item immediately without replaying the choice or changing memory', () => {
  const current = session();
  current.items[0]!.revealed = true;
  current.items[0]!.recognition = { options, selectedOptionId: 'water', correctOptionId: 'water' };
  const tree = render(() => view(current));
  expect(choiceButtons(tree)).toHaveLength(0);
  expect(hiddenMeanings(tree)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(state.act).not.toHaveBeenCalled();
});

it.each(['review', 'extra-review'] as const)('keeps %s in recall mode', (mode) => {
  const current = session();
  current.mode = mode;
  const tree = render(() => view(current));
  expect(choiceButtons(tree)).toHaveLength(0);
  expect(hiddenMeanings(tree)).toBe(true);
});

it('falls back to recall for an issued review bucket or insufficient fixed choices', () => {
  const current = session();
  current.items[0]!.bucket = 'review';
  expect(choiceButtons(render(() => view(current)))).toHaveLength(0);
  current.items[0]!.bucket = 'new';
  current.items[0]!.recognition = { options: options.slice(0, 2) };
  expect(choiceButtons(render(() => view(current)))).toHaveLength(0);
});

it('cancels a pending feedback timer on leaving and never submits an automatic rating', () => {
  const current = session();
  let tree = render(() => view(current));
  (choiceButtons(tree)[0]!.props.onClick as () => void)();
  current.items[0]!.revealed = true;
  current.items[0]!.recognition = { options, selectedOptionId: 'water', correctOptionId: 'water' };
  tree = render(() => view(current));
  expect(hiddenMeanings(tree)).toBe(true);
  for (const effect of state.effects) effect?.cleanup?.();
  expect(vi.getTimerCount()).toBe(0);
  expect(state.act).toHaveBeenCalledTimes(1);
});

it('lets a server-focused word change meaning without a controlled callback and binds its own example', () => {
  const component = () =>
    StudyWordDetails({
      word,
      senses: word.senses!,
      englishSenses: [],
      interactive: true,
      selectedSenseId: 'verb',
    });
  let tree = render(component);
  const context = () => elements(tree).find((entry) => 'examples' in entry.props)!;
  expect(context().props.examples).toMatchObject([{ id: 'verb-context' }]);
  (button(tree, '上一义项').props.onClick as () => void)();
  tree = render(component);
  expect(context().props.examples).toEqual([]);
  expect(state.stopAudio).toHaveBeenCalled();
  (button(tree, '下一义项').props.onClick as () => void)();
  tree = render(component);
  expect(context().props.examples).toMatchObject([{ id: 'verb-context' }]);
});

it('only offers extension labels for content that exists', () => {
  const component = () =>
    StudyWordDetails({
      word,
      senses: word.senses!,
      englishSenses: [],
      interactive: false,
    });
  expect(elements(render(component)).filter((entry) => entry.props.role === 'tab')).toHaveLength(0);
  word.collocations = [
    {
      id: 'water-plant',
      lemma: 'water the plants',
      definitionZh: '给植物浇水',
      definitionEn: 'Give the plants water.',
      pos: 'v.',
      wordId: null,
    },
  ];
  try {
    const tabs = elements(render(component)).filter((entry) => entry.props.role === 'tab');
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.props.children).toBe('词组搭配');
  } finally {
    delete word.collocations;
  }
});
