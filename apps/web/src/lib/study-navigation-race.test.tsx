import React from 'react';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { StudyPage } from '../pages/Study';
import { StudySessionView, type StudySessionViewProps } from '../components/study/StudySessionView';
import type { StudySession } from './types';

const fixture = vi.hoisted(() => {
  const window = Object.assign(new EventTarget(), { __NIGHTSTUDY_CONFIG__: {} });
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('navigator', { onLine: true });
  return {
    params: new URLSearchParams(),
    location: { key: 'entry', pathname: '/learn', search: '' },
    slots: [] as unknown[],
    cursor: 0,
    refs: [] as { current: unknown }[],
    refCursor: 0,
    effects: [] as { deps?: unknown[]; cleanup?: () => void }[],
    effectCursor: 0,
    pendingEffects: [] as (() => void)[],
    shortcut: null as null | {
      blocked: boolean;
      consume: () => void;
      start: (id?: string) => Promise<void>;
    },
    post: vi.fn(),
    read: vi.fn(),
    command: vi.fn(),
    invalidate: vi.fn(),
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = fixture.cursor++;
    if (!(index in fixture.slots))
      fixture.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      fixture.slots[index],
      (value: unknown) => {
        fixture.slots[index] = typeof value === 'function' ? value(fixture.slots[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => (fixture.refs[fixture.refCursor++] ??= { current: initial }),
  useEffect: (setup: () => void | (() => void), deps?: unknown[]) => {
    const index = fixture.effectCursor++,
      previous = fixture.effects[index];
    if (
      !previous ||
      !deps ||
      !previous.deps ||
      deps.some((value, i) => value !== previous.deps?.[i])
    ) {
      fixture.pendingEffects.push(() => {
        previous?.cleanup?.();
        const cleanup = setup();
        fixture.effects[index] = {
          deps,
          cleanup: typeof cleanup === 'function' ? cleanup : undefined,
        };
      });
    }
  },
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: fixture.invalidate }),
}));
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useLocation: () => fixture.location,
  useSearchParams: () => [
    fixture.params,
    (value: Record<string, string> | URLSearchParams) => {
      fixture.params = new URLSearchParams(value);
      fixture.location = {
        ...fixture.location,
        key: `own-${fixture.location.key}`,
        search: fixture.params.size ? `?${fixture.params}` : '',
      };
    },
  ],
}));
vi.mock('../AppContext', () => ({
  useApp: () => ({
    user: { id: 'navigation-fixture' },
    scope: 'navigation-fixture',
    pending: 0,
    conflicts: [],
  }),
  useRemote: (key: string) => ({
    data:
      key === 'plan'
        ? { plan: { revision: 7, bookId: 'book' } }
        : key === 'study-tasks-active'
          ? { items: [] }
          : undefined,
    isPending: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('../components/AppNavigation', () => ({ useAppNavigation: () => ({ goBack: vi.fn() }) }));
vi.mock('../components/study/useStudyViewport', () => ({ useStudyViewport: () => undefined }));
vi.mock('../components/study/useQuickStudyStart', () => ({
  useQuickStudyStart: (value: typeof fixture.shortcut) => {
    fixture.shortcut = value;
  },
}));
vi.mock('./outbox', () => ({
  command: fixture.command,
  flushCommands: async () => ({ pending: 0, applied: 0 }),
}));
vi.mock('./api', () => ({
  api: fixture.read,
  post: fixture.post,
  ApiError: class extends Error {},
  newId: () => 'navigation-command',
}));
const issued = {
  id: 'issued',
  bookId: 'book',
  status: 'in_progress',
  revision: 1,
  phase: 'recall',
  currentItemId: 'item',
  items: [{ id: 'item', ordinal: 0, progressRevision: 0, revealed: false, bucket: 'new' }],
} as StudySession;
function render() {
  fixture.cursor = fixture.refCursor = fixture.effectCursor = 0;
  fixture.pendingEffects = [];
  const tree = StudyPage({ mode: 'learn' });
  for (const run of fixture.pendingEffects) run();
  return tree;
}
function focused(node: unknown): StudySessionViewProps | null {
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return null;
  if (node.type === StudySessionView) return node.props as StudySessionViewProps;
  for (const child of React.Children.toArray(node.props.children)) {
    const result = focused(child);
    if (result) return result;
  }
  return null;
}
beforeEach(() => {
  for (const effect of fixture.effects) effect.cleanup?.();
  fixture.slots = [];
  fixture.refs = [];
  fixture.effects = [];
  fixture.params = new URLSearchParams();
  fixture.location = { key: 'entry', pathname: '/learn', search: '' };
  fixture.shortcut = null;
  fixture.post.mockReset().mockResolvedValue({ session: issued });
  fixture.read.mockReset().mockResolvedValue({ session: issued });
  fixture.command.mockReset();
  fixture.invalidate.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('React', React);
});
afterAll(() => {
  for (const effect of fixture.effects) effect.cleanup?.();
  vi.unstubAllGlobals();
});

it('rejects a late start after a POP to the same pathname and query, and releases its busy lock', async () => {
  let finish!: (value: unknown) => void;
  fixture.post.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render();
  const starting = fixture.shortcut!.start();
  await vi.waitFor(() => expect(fixture.post).toHaveBeenCalledOnce());
  fixture.location = { ...fixture.location, key: 'pop-same-url' };
  render();
  fixture.invalidate.mockClear();
  finish({ session: issued });
  await starting;
  expect(focused(render())).toBeNull();
  expect(fixture.params.get('session')).toBeNull();
  expect(fixture.shortcut!.blocked).toBe(false);
  expect(fixture.invalidate).toHaveBeenCalledWith({ queryKey: ['navigation-fixture'] });
});

it('keeps a successfully accepted session focused when its own URL synchronization changes the key', async () => {
  render();
  await fixture.shortcut!.start();
  expect(fixture.params.get('session')).toBe(issued.id);
  expect(focused(render())?.session.id).toBe(issued.id);
  await vi.waitFor(() => expect(fixture.read).toHaveBeenCalledWith('study/sessions/issued'));
  expect(focused(render())?.session.id).toBe(issued.id);
});

it('allows its explicit start shortcut to consume the URL without cancelling that request or unlocking early', async () => {
  fixture.params = new URLSearchParams('start=1');
  fixture.location.search = '?start=1';
  let finish!: (value: unknown) => void;
  fixture.post.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render();
  const intent = fixture.shortcut!;
  intent.consume();
  const starting = intent.start();
  render();
  expect(fixture.shortcut!.blocked).toBe(true);
  await vi.waitFor(() => expect(fixture.post).toHaveBeenCalledOnce());
  finish({ session: issued });
  await starting;
  expect(focused(render())?.session.id).toBe(issued.id);
});

it('reads the accepted server snapshot after same-URL navigation while ignoring an older command response', async () => {
  render();
  await fixture.shortcut!.start();
  render();
  await vi.waitFor(() => expect(fixture.read).toHaveBeenCalledOnce());
  let finish!: (value: unknown) => void;
  fixture.command.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  focused(render())!.onAct('reveal');
  const latest = {
    ...issued,
    revision: 2,
    items: issued.items.map((item) => ({ ...item, revealed: true })),
  };
  fixture.read.mockResolvedValue({ session: latest });
  fixture.location = { ...fixture.location, key: 'pop-after-command' };
  render();
  await vi.waitFor(() => expect(fixture.read).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  finish({ session: issued });
  await Promise.resolve();
  await Promise.resolve();
  expect(focused(render())?.session.revision).toBe(2);
  expect(focused(render())?.session.items[0]?.revealed).toBe(true);
});
