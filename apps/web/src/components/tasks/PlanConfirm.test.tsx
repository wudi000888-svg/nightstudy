import React, { type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PlanConfirm } from './PlanConfirm';
import type { Book } from '../../lib/types';
import { api } from '../../lib/api';

interface Effect {
  deps?: readonly unknown[];
  cleanup?: () => void;
}
const fixture = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  return {
    states: [] as unknown[],
    refs: [] as { current: unknown }[],
    effects: [] as Effect[],
    pending: [] as { index: number; deps?: readonly unknown[]; setup: () => unknown }[],
    cursor: 0,
    refCursor: 0,
    effectCursor: 0,
    confirm: vi.fn(),
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = fixture.cursor++;
    if (!(index in fixture.states))
      fixture.states[index] = typeof initial === 'function' ? initial() : initial;
    return [
      fixture.states[index],
      (value: unknown) => {
        fixture.states[index] = typeof value === 'function' ? value(fixture.states[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => (fixture.refs[fixture.refCursor++] ??= { current: initial }),
  useId: () => 'plan-input',
  useEffect: (setup: () => unknown, deps?: readonly unknown[]) => {
    const index = fixture.effectCursor++,
      prior = fixture.effects[index];
    if (
      !prior ||
      !deps ||
      !prior.deps ||
      deps.length !== prior.deps.length ||
      deps.some((entry, order) => !Object.is(entry, prior.deps![order]))
    )
      fixture.pending.push({ index, deps, setup });
  },
}));
vi.mock('../../AppContext', () => ({ useApp: () => ({ scope: 'plan-scope' }) }));
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  api: vi.fn(),
  newId: () => 'plan-command',
}));
vi.mock('../UI', () => ({
  Dialog: () => null,
  ErrorNotice: () => null,
  Loading: () => null,
  Notice: () => null,
}));
type Element = ReactElement<Record<string, unknown>>;
function all(node: ReactNode): Element[] {
  if (!React.isValidElement<Record<string, unknown>>(node))
    return Array.isArray(node) ? node.flatMap(all) : [];
  return [node, ...all(node.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return React.isValidElement<Record<string, unknown>>(node)
    ? text(node.props.children as ReactNode)
    : '';
}
function render(component: () => ReactNode) {
  fixture.cursor = fixture.refCursor = fixture.effectCursor = 0;
  fixture.pending = [];
  const tree = component();
  for (const effect of fixture.pending) {
    fixture.effects[effect.index]?.cleanup?.();
    const cleanup = effect.setup();
    fixture.effects[effect.index] = {
      deps: effect.deps,
      cleanup: typeof cleanup === 'function' ? (cleanup as () => void) : undefined,
    };
  }
  return tree;
}
function find(tree: ReactNode, predicate: (element: Element) => boolean) {
  const element = all(tree).find(predicate);
  expect(element).toBeDefined();
  return element!;
}
const book: Book = {
  id: 'book',
  title: '测试词书',
  slug: 'book',
  description: '',
  goal: 'cet4',
  version: 1,
  wordCount: 200,
  learnedCount: 20,
  coveredCount: 20,
  claimedKnownCount: 0,
  isDemo: false,
};
const initial = { dailyTotalGoal: 30, groupSize: 10, timeZone: 'Asia/Shanghai' };
const component = (switchingBook = false) =>
  PlanConfirm({
    open: true,
    book,
    initial,
    switchingBook,
    onClose: vi.fn(),
    onConfirm: fixture.confirm,
  });
async function ready(switchingBook = false) {
  render(() => component(switchingBook));
  render(() => component(switchingBook));
  await vi.advanceTimersByTimeAsync(300);
  return render(() => component(switchingBook));
}
beforeEach(() => {
  fixture.states = [];
  fixture.refs = [];
  fixture.effects = [];
  fixture.pending = [];
  fixture.confirm.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('React', React);
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path) => {
      const total = Number(new URLSearchParams(String(path).split('?')[1]).get('dailyTotalGoal'));
      return {
        settingsRevision: 5,
        preview: {
          reviewPlanned: 10,
          newPlanned: Math.max(0, total - 12),
          completedUnique: 2,
          retainedAssignedCount: 3,
          unplannedOverdueCount: 0,
        },
      } as never;
    });
});
afterEach(() => {
  for (const effect of fixture.effects) effect?.cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('requires a preview for the current draft and never confirms a newly edited target with the old response', async () => {
  let tree: ReactNode = await ready();
  expect(find(tree, (element) => element.props.type === 'submit').props.disabled).toBe(false);
  const preset = find(tree, (element) => element.type === 'button' && text(element) === '20 词');
  (preset.props.onClick as () => void)();
  tree = render(() => component());
  expect(find(tree, (element) => element.props.type === 'submit').props.disabled).toBe(true);
  const submit = find(tree, (element) => element.type === 'form').props.onSubmit as (
    event: unknown,
  ) => void;
  submit({ preventDefault() {} });
  expect(fixture.confirm).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300);
  tree = render(() => component());
  (find(tree, (element) => element.type === 'form').props.onSubmit as typeof submit)({
    preventDefault() {},
  });
  await Promise.resolve();
  expect(fixture.confirm).toHaveBeenCalledExactlyOnceWith(
    { ...initial, dailyTotalGoal: 20 },
    5,
    'plan-command',
  );
});

it('keeps the switch impact visible and guards a double confirmation while its request is pending', async () => {
  let release!: () => void;
  fixture.confirm.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let tree: ReactNode = await ready(true);
  expect(text(find(tree, (element) => element.props.role === 'note'))).toContain(
    '结束原词书全部未完成任务',
  );
  const submit = find(tree, (element) => element.type === 'form').props.onSubmit as (
    event: unknown,
  ) => void;
  submit({ preventDefault() {} });
  submit({ preventDefault() {} });
  expect(fixture.confirm).toHaveBeenCalledTimes(1);
  tree = render(() => component(true));
  expect(find(tree, (element) => element.type === 'fieldset').props.disabled).toBe(true);
  release();
  await Promise.resolve();
});
