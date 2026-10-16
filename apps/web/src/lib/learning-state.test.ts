import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import {
  acceptBookPlan,
  bookChangedEvent,
  learningGeneration,
  mergeStudySession,
  resumableTasks,
} from './learning-state';
import type { TaskPlanResponse } from '../components/tasks/types';
import type { StudySession } from './types';

const fixture = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {}, dispatchEvent: vi.fn() });
  return { api: vi.fn() };
});
vi.mock('./api', () => ({ api: fixture.api }));
beforeEach(() => {
  fixture.api.mockReset().mockImplementation(async (path: string) => ({ fresh: path }));
  vi.mocked(window.dispatchEvent).mockClear();
});
afterAll(() => vi.unstubAllGlobals());
const committed = {
  settings: { currentBookId: 'new', revision: 2 },
  plan: { bookId: 'new', revision: 8, completedUnique: 7 },
} as TaskPlanResponse;
const makeClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

it('replaces a disabled retained Home snapshot before reloading and preserves accepted plan counts', async () => {
  const client = makeClient();
  const scope = 'book-cache';
  const key = [scope, 'app-home', 'app/home'];
  const old = { sessionId: 'old-active', plan: { bookId: 'old' } };
  client.setQueryData(key, old);
  client.setQueryData([scope, 'plan', 'study/plan'], { plan: { bookId: 'old' } });
  client.setQueryData([scope, 'stats', 'stats'], { completed: 7 });
  client.setQueryData(['another-user', 'app-home', 'app/home'], old);
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: () => fixture.api('app/home'),
    enabled: false,
  });
  const seen: unknown[] = [];
  const unsubscribe = observer.subscribe((value) => seen.push(value.data));
  let finish!: (value: unknown) => void;
  fixture.api.mockImplementation((path: string) =>
    path === 'app/home'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ items: [] }),
  );
  const previousGeneration = learningGeneration(scope);
  const saving = acceptBookPlan(client, scope, 'old', committed);
  await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith('app/home'));
  expect(client.getQueryData(key)).toBeUndefined();
  expect(client.getQueryData([scope, 'plan', 'study/plan'])).toEqual(committed);
  expect(learningGeneration(scope)).toBe(previousGeneration + 1);
  expect(vi.mocked(window.dispatchEvent).mock.calls[0]?.[0].type).toBe(bookChangedEvent);
  finish({ plan: { bookId: 'new' }, learn: { sessionId: null } });
  expect(await saving).toBe(true);
  expect(client.getQueryData(key)).toEqual({ plan: { bookId: 'new' }, learn: { sessionId: null } });
  expect(client.getQueryState([scope, 'stats', 'stats'])?.isInvalidated).toBe(true);
  expect(client.getQueryData(['another-user', 'app-home', 'app/home'])).toEqual(old);
  expect(seen).toContain(undefined);
  unsubscribe();
  client.clear();
});

it('keeps the committed plan and clears unsafe old entries if the follow-up reads fail', async () => {
  const client = makeClient(),
    scope = 'book-cache-offline';
  client.setQueryData([scope, 'app-home', 'app/home'], { oldTask: 'old' });
  client.setQueryData([scope, 'study-tasks-active', 'study/tasks?status=active&limit=50'], {
    items: ['old'],
  });
  fixture.api.mockRejectedValue(new Error('offline after accepted confirmation'));
  expect(await acceptBookPlan(client, scope, 'old', committed)).toBe(false);
  expect(client.getQueryData([scope, 'plan', 'study/plan'])).toEqual(committed);
  expect(client.getQueryData([scope, 'app-home', 'app/home'])).toBeUndefined();
  expect(
    client.getQueryData([scope, 'study-tasks-active', 'study/tasks?status=active&limit=50']),
  ).toBeUndefined();
  client.clear();
});

it('does not invalidate local restore generation for a same-book goal change', async () => {
  const client = makeClient(),
    scope = 'same-book-goal';
  const generation = learningGeneration(scope);
  await acceptBookPlan(client, scope, 'new', committed);
  expect(learningGeneration(scope)).toBe(generation);
  expect(window.dispatchEvent).not.toHaveBeenCalled();
  client.clear();
});

it('does not issue private refresh reads after the account changes while cancellation settles', async () => {
  const client = makeClient(),
    scope = 'scope-leaves';
  let current = true,
    finish!: () => void;
  vi.spyOn(client, 'cancelQueries').mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const saving = acceptBookPlan(client, scope, 'old', committed, () => current);
  current = false;
  finish();
  expect(await saving).toBe(false);
  expect(fixture.api).not.toHaveBeenCalled();
  expect(client.getQueryData([scope, 'plan', 'study/plan'])).toBeUndefined();
  client.clear();
});

it('does not let a pre-switch Home request replace the new snapshot when it finishes late', async () => {
  const client = makeClient(),
    scope = 'late-old-home';
  const key = [scope, 'app-home', 'app/home'];
  let late!: (value: unknown) => void;
  const oldRequest = client
    .fetchQuery({
      queryKey: key,
      queryFn: () =>
        new Promise((resolve) => {
          late = resolve;
        }),
    })
    .catch(() => null);
  await acceptBookPlan(client, scope, 'old', committed);
  late({ sessionId: 'ended-old-task' });
  await oldRequest;
  expect(client.getQueryData(key)).toEqual({ fresh: 'app/home' });
  client.clear();
});

it('rejects an older confirmation from another picker before touching current caches', async () => {
  const client = makeClient(),
    scope = 'old-confirmation';
  const later = {
    ...committed,
    settings: { ...committed.settings, currentBookId: 'later', revision: 3 },
  };
  client.setQueryData([scope, 'plan', 'study/plan'], later);
  client.setQueryData([scope, 'app-home', 'app/home'], { bookId: 'later' });
  const cancel = vi.spyOn(client, 'cancelQueries');
  const generation = learningGeneration(scope);
  expect(await acceptBookPlan(client, scope, 'old', committed)).toBe(false);
  expect(cancel).not.toHaveBeenCalled();
  expect(fixture.api).not.toHaveBeenCalled();
  expect(window.dispatchEvent).not.toHaveBeenCalled();
  expect(learningGeneration(scope)).toBe(generation);
  expect(client.getQueryData([scope, 'plan', 'study/plan'])).toEqual(later);
  expect(client.getQueryData([scope, 'app-home', 'app/home'])).toEqual({ bookId: 'later' });
  client.clear();
});

it('rechecks settings revision after a delayed cancellation settles', async () => {
  const client = makeClient(),
    scope = 'confirmation-during-cancel';
  let finish!: () => void;
  vi.spyOn(client, 'cancelQueries').mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const older = acceptBookPlan(client, scope, 'old', committed);
  const later = {
    ...committed,
    settings: { ...committed.settings, currentBookId: 'later', revision: 3 },
  };
  expect(await acceptBookPlan(client, scope, 'new', later)).toBe(true);
  const calls = fixture.api.mock.calls.length;
  finish();
  expect(await older).toBe(false);
  expect(fixture.api).toHaveBeenCalledTimes(calls);
  expect(client.getQueryData([scope, 'plan', 'study/plan'])).toEqual(later);
  expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
  client.clear();
});

it('does not let an earlier confirmation refresh overwrite a later accepted choice', async () => {
  const client = makeClient(),
    scope = 'confirmation-refresh-race';
  let finishOld!: (value: unknown) => void;
  fixture.api.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  const older = acceptBookPlan(client, scope, 'old', committed);
  await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith('app/home'));
  const later = {
    ...committed,
    settings: { ...committed.settings, currentBookId: 'later', revision: 3 },
  };
  expect(await acceptBookPlan(client, scope, 'new', later)).toBe(true);
  finishOld({ bookId: 'new', sessionId: 'old-refresh' });
  expect(await older).toBe(false);
  expect(client.getQueryData([scope, 'plan', 'study/plan'])).toEqual(later);
  expect(client.getQueryData([scope, 'app-home', 'app/home'])).toEqual({ fresh: 'app/home' });
  client.clear();
});

it('never resurrects a cancelled session or regresses an accepted session revision', () => {
  const cancelled = { id: 'old', status: 'cancelled', revision: 5 } as StudySession;
  expect(mergeStudySession(cancelled, { ...cancelled, status: 'in_progress', revision: 9 })).toBe(
    cancelled,
  );
  expect(mergeStudySession(cancelled, { ...cancelled, revision: 4 })).toBe(cancelled);
  const active = { ...cancelled, status: 'in_progress', revision: 4 } as StudySession;
  expect(mergeStudySession(active, cancelled)).toBe(cancelled);
});

it('keeps Learn on the selected new-word book and Review on global review groups', () => {
  const group = (id: string, bookId: string | null, bucket: 'new' | 'review', status = 'paused') =>
    ({ id, bookId, mode: 'daily', taskKind: 'daily', status, items: [{ bucket }] }) as StudySession;
  const tasks = [
    group('wrong', 'old', 'new'),
    group('closed', 'new', 'new', 'cancelled'),
    group('current', 'new', 'new'),
    group('global', null, 'review'),
  ];
  expect(resumableTasks(tasks, 'learn', 'new').map((task) => task.id)).toEqual(['current']);
  expect(resumableTasks(tasks, 'review', 'new').map((task) => task.id)).toEqual(['global']);
});
