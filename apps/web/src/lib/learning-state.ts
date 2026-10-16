import type { QueryClient } from '@tanstack/react-query';
import type { TaskPlanResponse } from '../components/tasks/types';
import type { StudySession } from './types';
import { api } from './api';

export const bookChangedEvent = 'nightstudy-book-changed';
const generations = new Map<string, number>();
export function learningGeneration(scope: string) {
  return generations.get(scope) ?? 0;
}

/** A committed book change invalidates local restore intents, never the durable outbox. */
export async function acceptBookPlan(
  client: QueryClient,
  scope: string,
  previousBookId: string | null,
  result: TaskPlanResponse,
  isCurrent: () => boolean = () => true,
) {
  if (!mayApply()) return false;
  await client.cancelQueries({ queryKey: [scope] });
  // Another retained picker may have accepted a later settings revision while
  // this response or query cancellation was pending.
  if (!mayApply()) return false;
  if (previousBookId !== result.settings.currentBookId) {
    generations.set(scope, learningGeneration(scope) + 1);
    window.dispatchEvent(new CustomEvent(bookChangedEvent, { detail: { scope } }));
  }
  client.setQueryData([scope, 'plan', 'study/plan'], result);
  // Retained screens can have disabled observers: invalidate alone leaves old actionable data.
  const reset = ['app-home', 'study-tasks-active'].map((key) =>
    client.resetQueries({ queryKey: [scope, key] }),
  );
  await client.invalidateQueries({ queryKey: [scope], refetchType: 'none' });
  const refreshed = await Promise.allSettled([
    ...reset,
    client.fetchQuery({
      queryKey: [scope, 'app-home', 'app/home'],
      queryFn: () => readCurrent('app/home'),
      staleTime: 0,
    }),
    client.fetchQuery({
      queryKey: [scope, 'study-tasks-active', 'study/tasks?status=active&limit=50'],
      queryFn: () => readCurrent('study/tasks?status=active&limit=50'),
      staleTime: 0,
    }),
  ]);
  // The settings are already committed. A read failure must not invite another confirmation.
  return mayApply() && refreshed.every((value) => value.status === 'fulfilled');

  function mayApply() {
    const latest = client.getQueryData<TaskPlanResponse>([scope, 'plan', 'study/plan']);
    return isCurrent() && !(latest && latest.settings?.revision > result.settings.revision);
  }

  async function readCurrent(path: string) {
    if (!mayApply()) throw new Error('学习计划已更新，请重新读取。');
    const value = await api(path);
    if (!mayApply()) throw new Error('学习计划已更新，请重新读取。');
    return value;
  }
}

export function mergeStudySession(current: StudySession | null, incoming: StudySession) {
  if (current?.id !== incoming.id) return incoming;
  if (current.status === 'cancelled' && incoming.status !== 'cancelled') return current;
  return incoming.revision >= current.revision ? incoming : current;
}

export function resumableTasks(
  tasks: StudySession[],
  mode: 'learn' | 'review',
  bookId: string | null | undefined,
) {
  return tasks.filter((task) => {
    if (!['in_progress', 'paused'].includes(task.status)) return false;
    const hasNew = task.items.some((item) => item.bucket === 'new');
    return mode === 'learn'
      ? hasNew && !!bookId && task.bookId === bookId
      : !hasNew &&
          (task.mode === 'review' ||
            task.taskKind === 'extra-review' ||
            task.items.some((item) => item.bucket === 'review'));
  });
}
