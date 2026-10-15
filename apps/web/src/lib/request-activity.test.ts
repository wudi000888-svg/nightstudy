import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, auth, post, setup } from './api';
import {
  activeWriteRequests,
  beginWriteRequest,
  subscribeRequestActivity,
} from './request-activity';

vi.hoisted(() => vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} }));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  vi.stubGlobal('fetch', vi.fn());
  expect(activeWriteRequests()).toBe(0);
});
afterEach(() => {
  expect(activeWriteRequests()).toBe(0);
  vi.unstubAllGlobals();
});

it('keeps writes busy through response-body acknowledgement, independently of a pending read', async () => {
  const body = deferred<{ saved: boolean }>();
  const read = deferred<Response>();
  const parse = vi.fn(() => body.promise);
  vi.mocked(fetch)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: parse,
    } as unknown as Response)
    .mockImplementationOnce(() => read.promise);
  const saving = post('notes', { title: 'Rain', body: 'The rain falls.' });
  const reading = api('app/home');
  expect(activeWriteRequests()).toBe(1);
  await Promise.resolve();
  expect(parse).toHaveBeenCalledOnce();
  expect(activeWriteRequests()).toBe(1);
  body.resolve({ saved: true });
  expect(await saving).toEqual({ saved: true });
  expect(activeWriteRequests()).toBe(0);
  read.resolve(Response.json({ localDate: '2026-10-16' }));
  await reading;
});

it('tracks auth, setup, PATCH, DELETE and arbitrary non-read methods and releases every owner exactly once', async () => {
  const pending = Array.from({ length: 5 }, () => deferred<Response>());
  pending.forEach((value) => vi.mocked(fetch).mockImplementationOnce(() => value.promise));
  const calls = [
    auth('sign-in/email', { email: 'unit@example.test' }),
    setup({}),
    post('notes/id', {}, 'PATCH'),
    post('notes/id', {}, 'DELETE'),
    api('unit', { method: 'CUSTOM-WRITE' }),
  ];
  expect(activeWriteRequests()).toBe(5);
  for (let index = 0; index < pending.length; index++) {
    pending[index]!.resolve(Response.json({ ok: true }));
    await calls[index];
    expect(activeWriteRequests()).toBe(4 - index);
  }
  const seen: number[] = [];
  const unsubscribe = subscribeRequestActivity(() => seen.push(activeWriteRequests()));
  const first = beginWriteRequest('put'),
    second = beginWriteRequest('POST');
  first();
  first();
  second();
  second();
  expect(seen).toEqual([1, 2, 1, 0]);
  unsubscribe();
});

it('does not block reads and releases network, HTTP and body-reader failures', async () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'TRACE']) {
    const finish = beginWriteRequest(method);
    expect(activeWriteRequests()).toBe(0);
    finish();
  }
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError('network unavailable'));
  await expect(post('notes', {})).rejects.toMatchObject({ status: 0 });
  expect(activeWriteRequests()).toBe(0);
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code: 'note_conflict' }, { status: 409 }));
  await expect(post('notes/id', {}, 'PATCH')).rejects.toMatchObject({ status: 409 });
  expect(activeWriteRequests()).toBe(0);
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/plain' }),
    text: () => Promise.reject(Error('body lost')),
  } as unknown as Response);
  await expect(post('notes', {})).rejects.toThrow('body lost');
});
