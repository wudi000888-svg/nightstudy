import { createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { browseLibrary, libraryBrowseCursor, readLibraryBrowseCursor } from './library-browse.js';
import type { RequestContext } from '../context.js';

const ctx = { fleetSecret: 'original-library-cursor-test-secret'.repeat(3) };
const key = { id: 'book-item-a', lemma: 'rain', ordinal: 8, at: '2026-10-16T06:00:00.000Z' };
const now = Date.parse('2026-10-16T07:00:00.000Z');
const token = () => libraryBrowseCursor(ctx, 'account-and-query-a', 'revision-a', key, now);

it('round-trips signed typed ordering keys and accepts an absent first-page cursor', () => {
  expect(readLibraryBrowseCursor(ctx, token(), 'account-and-query-a', 'revision-a', now)).toEqual(
    key,
  );
  expect(
    readLibraryBrowseCursor(ctx, undefined, 'account-and-query-a', 'revision-a', now),
  ).toBeNull();
});

it('rejects tokens from another user/query scope and signing secret before disclosing revision status', () => {
  expect(() =>
    readLibraryBrowseCursor(ctx, token(), 'account-and-query-b', 'revision-b', now),
  ).toThrow(expect.objectContaining({ statusCode: 400, code: 'invalid_cursor' }));
  expect(() =>
    readLibraryBrowseCursor(
      { fleetSecret: 'another-instance-secret' },
      token(),
      'account-and-query-a',
      'revision-a',
      now,
    ),
  ).toThrow(expect.objectContaining({ statusCode: 400, code: 'invalid_cursor' }));
});

it('rejects bit flips, extra segments, malformed signatures and excessively long tokens', () => {
  const valid = token();
  for (const invalid of [
    valid.replace(/^./, valid[0] === 'a' ? 'b' : 'a'),
    `${valid}.extra`,
    'not-a-token',
    '.missing',
    'bad.$invalid',
    `a.${'x'.repeat(1600)}`,
  ]) {
    expect(() =>
      readLibraryBrowseCursor(ctx, invalid, 'account-and-query-a', 'revision-a', now),
    ).toThrow(expect.objectContaining({ statusCode: 400, code: 'invalid_cursor' }));
  }
});

it('rejects invalid or extended payloads even when their signatures are valid', () => {
  const signed = (value: unknown) => {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${body}.${createHmac('sha256', ctx.fleetSecret).update('nightstudy:library:v2:').update(body).digest('base64url')}`;
  };
  const base = {
    v: 1,
    scope: 'account-and-query-a',
    revision: 'revision-a',
    expires: now + 1000,
    key,
  };
  for (const invalid of [
    { ...base, v: 2 },
    { ...base, extra: 'hidden' },
    { ...base, key: { ...key, ordinal: -1 } },
    { ...base, key: { ...key, at: 'yesterday' } },
    { ...base, key: { ...key, userId: 'another-user' } },
  ]) {
    expect(() =>
      readLibraryBrowseCursor(ctx, signed(invalid), base.scope, base.revision, now),
    ).toThrow(expect.objectContaining({ statusCode: 400, code: 'invalid_cursor' }));
  }
});

it('expires at the exact boundary and distinguishes an authenticated stale revision', () => {
  expect(() =>
    readLibraryBrowseCursor(
      ctx,
      token(),
      'account-and-query-a',
      'revision-a',
      now + 15 * 60 * 1000,
    ),
  ).toThrow(expect.objectContaining({ statusCode: 410, code: 'cursor_expired' }));
  expect(() =>
    readLibraryBrowseCursor(ctx, token(), 'account-and-query-a', 'revision-b', now),
  ).toThrow(expect.objectContaining({ statusCode: 409, code: 'list_changed' }));
});

it('rejects anonymous and invalid filter requests before accessing a database', async () => {
  const transaction = vi.fn();
  const context = {
    ...ctx,
    prisma: { $transaction: transaction },
    user: { id: 'user-a' },
  } as unknown as RequestContext;
  await expect(browseLibrary({ ...context, user: null }, {})).rejects.toMatchObject({
    statusCode: 401,
    code: 'authentication_required',
  });
  for (const invalid of [
    { view: 'all' },
    { view: 'unlearned' },
    { sort: 'book' },
    { cursor: 'abc', locate: 'word-a' },
    { userId: 'user-b' },
    { limit: 0 },
    { limit: 101 },
    { q: 'x'.repeat(121) },
    { q: '\0' },
    { sort: 'unsupported' },
  ]) {
    await expect(browseLibrary(context, invalid)).rejects.toMatchObject({
      statusCode: 400,
      code: 'invalid_input',
    });
  }
  expect(transaction).not.toHaveBeenCalled();
});
