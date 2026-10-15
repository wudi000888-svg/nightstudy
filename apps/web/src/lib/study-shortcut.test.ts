import { beforeEach, expect, it, vi } from 'vitest';
import { useQuickStudyStart } from '../components/study/useQuickStudyStart';

interface Effect {
  deps: unknown[];
  cleanup?: () => void;
}
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  cursor: 0,
  effect: null as Effect | null,
  pending: null as { deps: unknown[]; setup: () => void | (() => void) } | null,
}));
vi.mock('react', () => ({
  useRef: (value: unknown) => (hooks.refs[hooks.cursor++] ??= { current: value }),
  useEffect: (setup: () => void | (() => void), deps: unknown[]) => {
    if (!hooks.effect || deps.some((value, index) => !Object.is(value, hooks.effect!.deps[index])))
      hooks.pending = { deps, setup };
  },
}));
type Options = Parameters<typeof useQuickStudyStart>[0];
function render(options: Options) {
  hooks.cursor = 0;
  useQuickStudyStart(options);
  if (hooks.pending) {
    const next = hooks.pending;
    hooks.pending = null;
    hooks.effect?.cleanup?.();
    hooks.effect = { deps: next.deps, cleanup: next.setup() || undefined };
  }
}
function reset() {
  hooks.effect?.cleanup?.();
  hooks.refs = [];
  hooks.effect = null;
  hooks.pending = null;
}
beforeEach(reset);

it('waits for the plan and tasks, consumes the navigation intent before one real start, and never retries an empty/failed result', async () => {
  const url = new URLSearchParams('start=1');
  const consume = vi.fn(() => url.delete('start'));
  const start = vi.fn(async () => {
    expect(url.has('start')).toBe(false);
    // The page owns server/no-word/error handling. Returning without a session
    // must not turn a refetch or loading transition into an automatic retry.
  });
  const options: Options = {
    scope: 'site:user-a',
    requested: true,
    ready: false,
    blocked: false,
    consume,
    start,
  };
  render(options);
  await Promise.resolve();
  expect(start).not.toHaveBeenCalled();
  render({ ...options, ready: true });
  await Promise.resolve();
  expect(start).toHaveBeenCalledExactlyOnceWith(undefined);
  for (const blocked of [true, false, false]) {
    render({ ...options, ready: true, blocked });
    await Promise.resolve();
  }
  expect(start).toHaveBeenCalledTimes(1);
  expect(consume).toHaveBeenCalledTimes(1);
});

it('resumes the existing server group and does not introduce an extra-review or separate daily budget', async () => {
  const start = vi.fn(async (_id?: string) => {});
  const options: Options = {
    scope: 'site:user-a',
    requested: true,
    ready: true,
    blocked: false,
    resumeId: 'server-task',
    consume: vi.fn(),
    start,
  };
  render(options);
  await Promise.resolve();
  expect(start).toHaveBeenCalledExactlyOnceWith('server-task');
  render({ ...options, requested: false });
  render(options);
  await Promise.resolve();
  expect(start).toHaveBeenCalledTimes(2);
});

it('cancels the first StrictMode setup and any pre-start account change without losing or duplicating the URL intent', async () => {
  const start = vi.fn(async (_id?: string) => {});
  const consume = vi.fn();
  const options: Options = {
    scope: 'site:user-a',
    requested: true,
    ready: true,
    blocked: false,
    consume,
    start,
  };
  render(options);
  hooks.effect?.cleanup?.();
  hooks.effect = null;
  render(options);
  await Promise.resolve();
  expect(start).toHaveBeenCalledTimes(1);
  reset();
  start.mockClear();
  consume.mockClear();
  render(options);
  render({ ...options, scope: 'site:user-b', requested: false });
  await Promise.resolve();
  expect(start).not.toHaveBeenCalled();
  expect(consume).not.toHaveBeenCalled();
});

it('does not auto-open while an explicit linked session, sync, or plan error blocks the shortcut', async () => {
  const start = vi.fn(async () => {});
  render({
    scope: 'site:user-a',
    requested: true,
    ready: true,
    blocked: true,
    consume: vi.fn(),
    start,
  });
  await Promise.resolve();
  expect(start).not.toHaveBeenCalled();
});
