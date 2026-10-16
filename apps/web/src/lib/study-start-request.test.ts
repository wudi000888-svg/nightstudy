import React from 'react';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { StudyPage } from '../pages/Study';

const fixture = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  vi.stubGlobal('navigator', { onLine: true });
  return {
    start: null as ((resumeId?: string, extra?: boolean) => Promise<void>) | null,
    resumeId: undefined as string | undefined,
    tasks: [] as {
      id: string;
      bookId?: string;
      status: string;
      mode: string;
      taskKind: string;
      items: { bucket: 'new' | 'review' }[];
    }[],
    post: vi.fn(),
    read: vi.fn(),
    invalidate: vi.fn(),
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (value: unknown) => [typeof value === 'function' ? value() : value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: () => undefined,
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: fixture.invalidate }),
}));
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));
vi.mock('../AppContext', () => ({
  useApp: () => ({
    user: { id: 'study-start-fixture' },
    scope: 'site:instance:fixture',
    pending: 0,
    conflicts: [],
  }),
  useRemote: (key: string) => ({
    data:
      key === 'plan'
        ? { plan: { revision: 7, bookId: 'current-book' } }
        : key === 'study-tasks-active'
          ? { items: fixture.tasks }
          : undefined,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('../components/AppNavigation', () => ({ useAppNavigation: () => ({ goBack: vi.fn() }) }));
vi.mock('../components/study/useStudyViewport', () => ({ useStudyViewport: () => undefined }));
vi.mock('../components/study/useQuickStudyStart', () => ({
  useQuickStudyStart: (options: {
    start: (resumeId?: string, extra?: boolean) => Promise<void>;
    resumeId?: string;
  }) => {
    fixture.start = options.start;
    fixture.resumeId = options.resumeId;
  },
}));
vi.mock('./outbox', () => ({
  flushCommands: async () => ({ pending: 0, applied: 0 }),
  command: vi.fn(),
}));
vi.mock('./api', () => ({
  api: fixture.read,
  post: fixture.post,
  ApiError: class extends Error {},
  newId: () => 'start-command-fixture',
}));
vi.stubGlobal('React', React);
beforeEach(() => {
  fixture.start = null;
  fixture.resumeId = undefined;
  fixture.tasks = [];
  fixture.post.mockReset().mockResolvedValue({ session: null, reason: 'nothing_due' });
  fixture.read.mockReset();
  fixture.invalidate.mockReset().mockResolvedValue(undefined);
});
afterAll(() => vi.unstubAllGlobals());

it.each([
  {
    entry: 'review' as const,
    extra: false,
    body: { mode: 'review', bookId: 'current-book', expectedPlanRevision: 7 },
  },
  {
    entry: 'learn' as const,
    extra: false,
    body: { mode: 'daily', bookId: 'current-book', expectedPlanRevision: 7 },
  },
  { entry: 'review' as const, extra: true, body: { mode: 'review', taskKind: 'extra-review' } },
  { entry: 'learn' as const, extra: true, body: { mode: 'review', taskKind: 'extra-review' } },
])(
  'sends the real $entry start request with extra=$extra to its intended server policy',
  async ({ entry, extra, body }) => {
    StudyPage({ mode: entry });
    await fixture.start!(undefined, extra);
    expect(fixture.post).toHaveBeenCalledExactlyOnceWith('study/sessions', {
      ...body,
      commandId: 'start-command-fixture',
    });
    expect(fixture.read).not.toHaveBeenCalled();
  },
);

it('loads an explicit linked task without issuing a different group from either entry', async () => {
  fixture.read.mockResolvedValue({ session: { id: 'issued-task', status: 'in_progress' } });
  StudyPage({ mode: 'review' });
  await fixture.start!('issued-task');
  expect(fixture.read).toHaveBeenCalledExactlyOnceWith('study/sessions/issued-task');
  expect(fixture.post).not.toHaveBeenCalled();
});

it.each([
  { label: 'pure new', buckets: ['new'] as const },
  { label: 'mixed new and review', buckets: ['review', 'new'] as const },
])('does not let a Review shortcut silently resume a paused $label group', async ({ buckets }) => {
  fixture.tasks = [
    {
      id: 'paused-learning',
      status: 'paused',
      mode: 'daily',
      taskKind: 'daily',
      items: buckets.map((bucket) => ({ bucket })),
    },
  ];
  StudyPage({ mode: 'review' });
  expect(fixture.resumeId).toBeUndefined();
  await fixture.start!(fixture.resumeId);
  expect(fixture.post).toHaveBeenCalledExactlyOnceWith('study/sessions', {
    mode: 'review',
    bookId: 'current-book',
    expectedPlanRevision: 7,
    commandId: 'start-command-fixture',
  });
  expect(fixture.read).not.toHaveBeenCalled();
});

it('continues the matching paused review group while retaining the existing Learn resume behavior', async () => {
  const learning = {
    id: 'paused-learning',
    bookId: 'current-book',
    status: 'paused',
    mode: 'daily',
    taskKind: 'daily',
    items: [{ bucket: 'new' as const }],
  };
  const review = {
    id: 'paused-review',
    status: 'paused',
    mode: 'review',
    taskKind: 'daily',
    items: [{ bucket: 'review' as const }],
  };
  fixture.tasks = [learning, review];
  fixture.read.mockResolvedValue({ session: review });
  StudyPage({ mode: 'review' });
  expect(fixture.resumeId).toBe(review.id);
  await fixture.start!(fixture.resumeId);
  expect(fixture.read).toHaveBeenCalledExactlyOnceWith('study/sessions/paused-review');
  expect(fixture.post).toHaveBeenCalledWith(
    'study/tasks/paused-review/state',
    expect.objectContaining({ action: 'resume' }),
  );
  fixture.read.mockResolvedValue({ session: learning });
  StudyPage({ mode: 'learn' });
  expect(fixture.resumeId).toBe(learning.id);
});

it('does not restore a cancelled group or another book from the Learn shortcut', () => {
  fixture.tasks = [
    {
      id: 'old-book',
      bookId: 'previous-book',
      status: 'paused',
      mode: 'daily',
      taskKind: 'daily',
      items: [{ bucket: 'new' }],
    },
    {
      id: 'ended',
      bookId: 'current-book',
      status: 'cancelled',
      mode: 'daily',
      taskKind: 'daily',
      items: [{ bucket: 'new' }],
    },
    {
      id: 'pure-review',
      status: 'paused',
      mode: 'review',
      taskKind: 'daily',
      items: [{ bucket: 'review' }],
    },
  ];
  StudyPage({ mode: 'learn' });
  expect(fixture.resumeId).toBeUndefined();
});

it('opens a cancelled deep-linked task read-only without attempting to resume it', async () => {
  fixture.read.mockResolvedValue({ session: { id: 'ended', status: 'cancelled', revision: 3 } });
  StudyPage({ mode: 'learn' });
  await fixture.start!('ended');
  expect(fixture.read).toHaveBeenCalledExactlyOnceWith('study/sessions/ended');
  expect(fixture.post).not.toHaveBeenCalled();
});
