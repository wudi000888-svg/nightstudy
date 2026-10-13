import { api, ApiError } from './api';
interface Pending {
  id: string;
  scope: string;
  path: string;
  body: unknown;
  createdAt: string;
}
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
  return rows.filter((row) => row.scope === scope);
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
export async function flushCommands(
  scope: string,
): Promise<{ applied: number; pending: number; conflicts: number }> {
  const rows = await pendingCommands(scope);
  let applied = 0;
  let conflicts = 0;
  for (const row of rows) {
    try {
      await api(row.path, { method: 'POST', body: JSON.stringify(row.body) });
      await write(row.id, true);
      applied++;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) conflicts++;
      break;
    }
  }
  return { applied, pending: (await pendingCommands(scope)).length, conflicts };
}
