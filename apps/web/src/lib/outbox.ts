import { api, ApiError } from './api';
interface Pending {
  id: string;
  scope: string;
  path: string;
  body: unknown;
  createdAt: string;
  conflict?: { code: string; detectedAt: string };
}
export interface CommandConflict {
  id: string;
  createdAt: string;
  code: string;
  sessionId: string | null;
  action: 'reveal' | 'rate' | 'answer' | 'unknown';
}
const flushing = new Map<
  string,
  Promise<{ applied: number; pending: number; conflicts: number }>
>();
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('nightstudy-alpha-commands', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('commands', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function write(row: Pending | string, remove = false) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('commands', 'readwrite');
    const store = tx.objectStore('commands');
    remove ? store.delete(row as string) : store.put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
export async function pendingCommands(scope: string): Promise<Pending[]> {
  const db = await database();
  const rows = await new Promise<Pending[]>((resolve, reject) => {
    const request = db.transaction('commands').objectStore('commands').getAll();
    request.onsuccess = () => resolve(request.result as Pending[]);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return rows
    .filter((row) => row.scope === scope)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export async function conflictingCommands(scope: string): Promise<CommandConflict[]> {
  return (await pendingCommands(scope))
    .filter((row) => row.conflict)
    .map((row) => {
      const action =
        row.body && typeof row.body === 'object'
          ? (row.body as Record<string, unknown>).action
          : null;
      return {
        id: row.id,
        createdAt: row.createdAt,
        code: row.conflict!.code,
        sessionId: row.path.match(/(?:^|\/)study\/sessions\/([^/]+)\/commands$/)?.[1] ?? null,
        action:
          action === 'reveal' || action === 'rate' || action === 'answer' ? action : 'unknown',
      };
    });
}
export async function discardConflictedCommand(scope: string, id: string): Promise<void> {
  await flushing.get(scope);
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('commands', 'readwrite');
      const store = tx.objectStore('commands');
      const request = store.get(id);
      request.onsuccess = () => {
        const row = request.result as Pending | undefined;
        if (!row || row.scope !== scope || !row.conflict) {
          tx.abort();
          return;
        }
        store.delete(id);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(
          new ApiError(
            409,
            '这条操作不是当前账户已确认的同步冲突，请重新读取任务。',
            'local_conflict_changed',
          ),
        );
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function command<T>(
  scope: string,
  path: string,
  body: { commandId: string } & Record<string, unknown>,
): Promise<T> {
  try {
    const result = await api<T>(path, { method: 'POST', body: JSON.stringify(body) });
    await write(`${scope}:${body.commandId}`, true).catch(() => {});
    return result;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) {
      try {
        await write({
          id: `${scope}:${body.commandId}`,
          scope,
          path,
          body,
          createdAt: new Date().toISOString(),
        });
      } catch {
        throw new ApiError(0, '连接中断，暂存失败。请保留页面并重试。');
      }
      throw new ApiError(
        error.status,
        '这次操作已暂存，连接恢复后可重试同步。',
        error.code,
        error.details,
        true,
      );
    }
    throw error;
  }
}
export function flushCommands(
  scope: string,
  isCurrent: () => boolean = () => true,
): Promise<{ applied: number; pending: number; conflicts: number }> {
  const existing = flushing.get(scope);
  if (existing) return existing;
  const promise = flush(scope, isCurrent).finally(() => {
    if (flushing.get(scope) === promise) flushing.delete(scope);
  });
  flushing.set(scope, promise);
  return promise;
}
async function flush(scope: string, isCurrent: () => boolean) {
  const rows = await pendingCommands(scope);
  let applied = 0;
  let conflicts = 0;
  for (const row of rows) {
    if (!isCurrent()) break;
    if (row.conflict) {
      conflicts++;
      break;
    }
    try {
      await api(row.path, { method: 'POST', body: JSON.stringify(row.body) });
      await write(row.id, true);
      applied++;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await write({
          ...row,
          conflict: {
            code: error.code || 'session_conflict',
            detectedAt: new Date().toISOString(),
          },
        });
        conflicts++;
      }
      break;
    }
  }
  return { applied, pending: (await pendingCommands(scope)).length, conflicts };
}
