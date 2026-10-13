import { HttpError } from '../context.js';

export function encodeCursor(scope: string, after: string | number) {
  return Buffer.from(JSON.stringify({ version: 1, scope, after })).toString('base64url');
}

export function decodeCursor(
  scope: string,
  cursor: string | undefined,
  type: 'string',
): string | null;
export function decodeCursor(
  scope: string,
  cursor: string | undefined,
  type: 'number',
): number | null;
export function decodeCursor(scope: string, cursor: string | undefined, type: 'string' | 'number') {
  if (!cursor) return null;
  try {
    if (cursor.length > 1200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('cursor');
    const raw: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('cursor');
    const value = raw as Record<string, unknown>;
    if (value.version !== 1 || value.scope !== scope || typeof value.after !== type)
      throw new Error('cursor');
    if (
      type === 'string' &&
      (!(value.after as string).length || (value.after as string).length > 320)
    )
      throw new Error('cursor');
    if (type === 'number' && (!Number.isSafeInteger(value.after) || (value.after as number) < 0))
      throw new Error('cursor');
    return value.after as string | number;
  } catch {
    throw new HttpError(400, 'invalid_cursor', '分页游标无效，请从第一页重新加载');
  }
}

export function pageInfo<T>(
  rows: T[],
  limit: number,
  total: number,
  scope: string,
  after: (row: T) => string | number,
) {
  const items = rows.slice(0, limit),
    hasMore = rows.length > limit;
  return {
    items,
    page: {
      total,
      hasMore,
      nextCursor:
        hasMore && items.length ? encodeCursor(scope, after(items[items.length - 1]!)) : null,
    },
  };
}
