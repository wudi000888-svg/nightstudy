import React from 'react';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { useBookPlan } from './useBookPlan';
import { post } from '../../lib/api';
import type { Book } from '../../lib/types';

const state = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  return {
    selected: null as Book | null,
    navigate: vi.fn(),
    accept: vi.fn(),
    active: true,
    refCursor: 0,
    refs: [] as { current: unknown }[],
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: () => [
    state.selected,
    (value: Book | null) => {
      state.selected = value;
    },
  ],
  useRef: (initial: unknown) => (state.refs[state.refCursor++] ??= { current: initial }),
  useEffect: () => {},
}));
vi.mock('../../AppContext', () => ({
  useApp: () => ({ user: { id: 'learner' }, scope: 'test:learner' }),
  useRemote: () => ({
    data: {
      plan: { assignedUnique: 0 },
      settings: {
        currentBookId: 'book-before',
        dailyTotalGoal: 30,
        groupSize: 5,
        timeZone: 'Asia/Shanghai',
      },
    },
    isPending: false,
  }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => state.navigate,
  useLocation: () => ({ key: 'books' }),
}));
vi.mock('../../lib/screen-lifecycle', () => ({ useScreenActive: () => state.active }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ testClient: true }),
}));
vi.mock('../../lib/api', () => ({ post: vi.fn() }));
vi.mock('../../lib/learning-state', () => ({ acceptBookPlan: state.accept }));
vi.mock('./PlanConfirm', () => ({ PlanConfirm: () => null }));
beforeEach(() => {
  vi.stubGlobal('React', React);
  state.selected = { id: 'book-rain' } as Book;
  state.active = true;
  state.refCursor = 0;
  state.refs = [];
  state.navigate.mockReset();
  state.accept.mockReset().mockResolvedValue(true);
  vi.mocked(post)
    .mockReset()
    .mockResolvedValue({ settings: { currentBookId: 'book-rain' }, plan: { revision: 9 } });
});
afterAll(() => vi.unstubAllGlobals());
it('returns to the fixed home only after the server confirms the chosen book and daily target', async () => {
  const view = useBookPlan();
  await view.dialog.props.onConfirm(
    { dailyTotalGoal: 30, groupSize: 5, timeZone: 'Asia/Shanghai' },
    2,
    'confirm-id',
  );
  expect(post).toHaveBeenCalledExactlyOnceWith('study/plan/confirm', {
    bookId: 'book-rain',
    dailyTotalGoal: 30,
    groupSize: 5,
    timeZone: 'Asia/Shanghai',
    expectedRevision: 2,
    commandId: 'confirm-id',
  });
  expect(state.accept).toHaveBeenCalledWith(
    { testClient: true },
    'test:learner',
    'book-before',
    {
      settings: { currentBookId: 'book-rain' },
      plan: { revision: 9 },
    },
    expect.any(Function),
  );
  expect(view.dialog.props.switchingBook).toBe(true);
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith('/');
  expect(state.selected).toBeNull();
});
it('keeps the confirmation open and stays in the setup flow on a rejected plan', async () => {
  vi.mocked(post).mockRejectedValue(Error('Plan changed'));
  const view = useBookPlan();
  await expect(
    view.dialog.props.onConfirm(
      { dailyTotalGoal: 30, groupSize: 5, timeZone: 'Asia/Shanghai' },
      2,
      'confirm-id',
    ),
  ).rejects.toThrow('Plan changed');
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.selected?.id).toBe('book-rain');
});
it('settles an accepted plan without taking over navigation after the user left and reopened the screen', async () => {
  let finishRefresh!: () => void;
  state.accept.mockReturnValue(
    new Promise<void>((resolve) => {
      finishRefresh = resolve;
    }),
  );
  const view = useBookPlan();
  const saving = view.dialog.props.onConfirm(
    { dailyTotalGoal: 30, groupSize: 5, timeZone: 'Asia/Shanghai' },
    2,
    'confirm-id',
  );
  await Promise.resolve();
  expect(state.selected).toBeNull();
  state.active = false;
  state.refCursor = 0;
  useBookPlan();
  state.active = true;
  state.refCursor = 0;
  useBookPlan();
  finishRefresh();
  await saving;
  expect(state.accept).toHaveBeenCalledOnce();
  expect(state.navigate).not.toHaveBeenCalled();
});

it('does not close a newer book choice or navigate when an earlier accepted refresh finishes', async () => {
  let finishRefresh!: (value: boolean) => void;
  state.accept.mockReturnValue(
    new Promise<boolean>((resolve) => {
      finishRefresh = resolve;
    }),
  );
  const view = useBookPlan();
  const saving = view.dialog.props.onConfirm(
    { dailyTotalGoal: 30, groupSize: 5, timeZone: 'Asia/Shanghai' },
    2,
    'first-confirm',
  );
  await Promise.resolve();
  expect(state.selected).toBeNull();
  view.choose({ id: 'book-second' } as Book);
  const stillCurrent = state.accept.mock.calls[0]![4] as () => boolean;
  expect(stillCurrent()).toBe(false);
  finishRefresh(true);
  await saving;
  expect(state.selected?.id).toBe('book-second');
  expect(state.navigate).not.toHaveBeenCalled();
});

it('ignores a delayed earlier response after a newer confirmation starts in the same scope', async () => {
  let finishOlder!: (value: unknown) => void;
  vi.mocked(post).mockReturnValueOnce(
    new Promise((resolve) => {
      finishOlder = resolve;
    }),
  );
  const view = useBookPlan();
  const older = view.dialog.props.onConfirm(
    { dailyTotalGoal: 30, groupSize: 5, timeZone: 'Asia/Shanghai' },
    2,
    'first-confirm',
  );
  view.choose({ id: 'book-second' } as Book);
  state.refCursor = 0;
  const next = useBookPlan();
  const result = {
    settings: { currentBookId: 'book-second', revision: 4 },
    plan: { revision: 10 },
  };
  vi.mocked(post).mockResolvedValueOnce(result);
  await next.dialog.props.onConfirm(
    { dailyTotalGoal: 30, groupSize: 5, timeZone: 'Asia/Shanghai' },
    3,
    'second-confirm',
  );
  finishOlder({ settings: { currentBookId: 'book-rain', revision: 3 }, plan: { revision: 9 } });
  await older;
  expect(state.accept).toHaveBeenCalledTimes(1);
  expect(state.accept.mock.calls[0]?.[3]).toBe(result);
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith('/');
});

it('does not navigate when the shared cache rejects a stale committed response', async () => {
  state.accept.mockResolvedValue(false);
  const view = useBookPlan();
  await view.dialog.props.onConfirm(
    { dailyTotalGoal: 30, groupSize: 5, timeZone: 'Asia/Shanghai' },
    2,
    'old-confirm',
  );
  expect(state.navigate).not.toHaveBeenCalled();
});
