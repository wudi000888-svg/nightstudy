import Fastify from 'fastify';
import { afterAll, expect, it } from 'vitest';
import { sendVerifiedAudio } from './audio-response.js';
const app = Fastify(),
  bytes = Buffer.from('0123456789'),
  sha = 'a'.repeat(64),
  etag = `"${sha}"`;
app.get('/audio', (req, reply) =>
  sendVerifiedAudio(req, reply, bytes, { fileSha256: sha, mimeType: 'audio/mpeg' }),
);
afterAll(() => app.close());
it('serves complete bytes and a matching HEAD without synthesizing anything', async () => {
  const result = await app.inject('/audio');
  expect(result.statusCode).toBe(200);
  expect(result.rawPayload).toEqual(bytes);
  expect(result.headers['accept-ranges']).toBe('bytes');
  const head = await app.inject({ method: 'HEAD', url: '/audio', headers: { range: 'bytes=0-1' } });
  expect(head.statusCode).toBe(200);
  expect(head.headers['content-length']).toBe('10');
  expect(head.body).toBe('');
});
it.each([
  ['bytes=0-1', '01', 'bytes 0-1/10'],
  ['bytes=4-', '456789', 'bytes 4-9/10'],
  ['bytes=-3', '789', 'bytes 7-9/10'],
  ['bytes=-100', '0123456789', 'bytes 0-9/10'],
  ['bytes=8-9999999999999999999999', '89', 'bytes 8-9/10'],
])('supports mobile media range %s', async (range, expected, contentRange) => {
  const result = await app.inject({ url: '/audio', headers: { range } });
  expect(result.statusCode).toBe(206);
  expect(result.body).toBe(expected);
  expect(result.headers['content-range']).toBe(contentRange);
  expect(result.headers['content-length']).toBe(String(expected.length));
});
it.each(['bytes=10-', 'bytes=8-2', 'bytes=-0', 'bytes=999999999999999999999999-'])(
  'rejects an unsatisfiable range %s',
  async (range) => {
    const result = await app.inject({ url: '/audio', headers: { range } });
    expect(result.statusCode).toBe(416);
    expect(result.headers['content-range']).toBe('bytes */10');
    expect(result.body).toBe('');
  },
);
it.each(['bytes=0-1,4-5', 'items=0-1', 'bytes=abc-2', 'bytes=-'])(
  'ignores unsupported or malformed range %s',
  async (range) => {
    const result = await app.inject({ url: '/audio', headers: { range } });
    expect(result.statusCode).toBe(200);
    expect(result.rawPayload).toEqual(bytes);
  },
);
it('uses full bytes for a stale If-Range and validates conditional GET before ranges', async () => {
  const stale = await app.inject({
    url: '/audio',
    headers: { range: 'bytes=0-1', 'if-range': '"other"' },
  });
  expect(stale.statusCode).toBe(200);
  const matched = await app.inject({
    url: '/audio',
    headers: { range: 'bytes=0-1', 'if-range': etag },
  });
  expect(matched.statusCode).toBe(206);
  const unchanged = await app.inject({
    url: '/audio',
    headers: { range: 'bytes=0-1', 'if-none-match': `"other", W/${etag}` },
  });
  expect(unchanged.statusCode).toBe(304);
  expect(unchanged.body).toBe('');
});
