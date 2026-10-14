import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {}, dispatchEvent: vi.fn() });
const { command, flushCommands, pendingCommands, conflictingCommands, discardConflictedCommand } =
  await import('./outbox');
const scope = 'site:user-a';
const other = 'site:user-b';
const path = 'study/sessions/task-1/commands';
function reply(status = 200, body: unknown = { accepted: true }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
async function queue(owner: string, id: string, action = 'reveal') {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
  await expect(command(owner, path, { commandId: id, action })).rejects.toMatchObject({
    queued: true,
  });
}
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});
afterEach(() => {
  vi.restoreAllMocks();
});

it('persists only confirmed 409 conflicts and stops retries until that exact row is handled', async () => {
  await queue(scope, 'one', 'rate');
  const fetch = vi.fn().mockResolvedValue(reply(409, { code: 'progress_conflict' }));
  vi.stubGlobal('fetch', fetch);
  expect(await flushCommands(scope)).toEqual({ applied: 0, pending: 1, conflicts: 1 });
  const blocked = await conflictingCommands(scope);
  expect(blocked).toMatchObject([
    { id: `${scope}:one`, code: 'progress_conflict', sessionId: 'task-1', action: 'rate' },
  ]);
  expect(blocked[0]).not.toHaveProperty('body');
  await flushCommands(scope);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe('/api/v2/study/sessions/task-1/commands');
});

it('discards one rejected row while preserving another queued command and another account', async () => {
  await queue(scope, 'one');
  await new Promise((resolve) => setTimeout(resolve, 2));
  await queue(scope, 'two', 'answer');
  await queue(other, 'one');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(409, { code: 'session_conflict' })));
  await flushCommands(scope);
  await expect(discardConflictedCommand(other, `${scope}:one`)).rejects.toMatchObject({
    code: 'local_conflict_changed',
  });
  await expect(discardConflictedCommand(scope, `${scope}:two`)).rejects.toMatchObject({
    code: 'local_conflict_changed',
  });
  await discardConflictedCommand(scope, `${scope}:one`);
  expect((await pendingCommands(scope)).map((row) => row.id)).toEqual([`${scope}:two`]);
  expect((await pendingCommands(other)).map((row) => row.id)).toEqual([`${other}:one`]);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply()));
  expect(await flushCommands(scope)).toEqual({ applied: 1, pending: 0, conflicts: 0 });
  expect(await pendingCommands(other)).toHaveLength(1);
});

it('retries an uncertain accepted command with its original id and removes it on receipt replay', async () => {
  await queue(scope, 'stable', 'rate');
  const fetch = vi.fn().mockResolvedValue(reply(200, { duplicate: true }));
  vi.stubGlobal('fetch', fetch);
  expect(await flushCommands(scope)).toEqual({ applied: 1, pending: 0, conflicts: 0 });
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({
    commandId: 'stable',
    action: 'rate',
  });
  expect(await conflictingCommands(scope)).toEqual([]);
});

it('does not label an outage or authentication failure as a discardable conflict', async () => {
  await queue(scope, 'one');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(503)));
  expect(await flushCommands(scope)).toEqual({ applied: 0, pending: 1, conflicts: 0 });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(reply(401, { code: 'authentication_required' })),
  );
  await flushCommands(scope);
  expect(await conflictingCommands(scope)).toEqual([]);
  await expect(discardConflictedCommand(scope, `${scope}:one`)).rejects.toMatchObject({
    code: 'local_conflict_changed',
  });
});

it('serializes concurrent sync and stops before sending a row when account scope has changed', async () => {
  await queue(scope, 'one');
  const fetch = vi.fn().mockResolvedValue(reply());
  vi.stubGlobal('fetch', fetch);
  expect(await flushCommands(scope, () => false)).toEqual({ applied: 0, pending: 1, conflicts: 0 });
  expect(fetch).not.toHaveBeenCalled();
  const a = flushCommands(scope);
  const b = flushCommands(scope);
  expect(a).toBe(b);
  expect(await a).toEqual({ applied: 1, pending: 0, conflicts: 0 });
  expect(fetch).toHaveBeenCalledTimes(1);
});
