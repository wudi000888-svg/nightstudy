import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextResolver } from '../context.js';
import { registerPronunciation } from './pronunciation.js';

const mocks = vi.hoisted(() => ({ hash: '1'.repeat(64), bytes: vi.fn() }));
vi.mock('../sentence-audio-policy.js', () => ({
  sentenceAudioHeld: (hash: string, accent: string) => hash === mocks.hash && accent === 'US',
}));
vi.mock('../audio.js', () => ({ verifiedAudioBytes: mocks.bytes }));
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.clearAllMocks();
});
async function fixture() {
  const entries = ['US', 'UK'].map((accent) => ({
    textHash: mocks.hash,
    text: 'Original mock metadata only, not a speech recording.',
    accent,
    status: 'ready',
    kind: 'synthesized',
    mimeType: 'audio/mpeg',
    fileSha256: '2'.repeat(64),
  }));
  const findMany = vi.fn().mockResolvedValue(entries);
  const findFirst = vi.fn().mockResolvedValue(entries[1]);
  const resolver = (async () => ({
    prisma: { sentenceAudio: { findMany, findFirst } },
  })) as unknown as ContextResolver;
  mocks.bytes.mockResolvedValue(Buffer.from('verified mock bytes; not actual audio'));
  const app = Fastify();
  apps.push(app);
  await registerPronunciation(app, resolver);
  return { app, findFirst };
}
describe('sentence audio publication holds at both public routes', () => {
  it('removes the held accent from metadata even when the database still says ready', async () => {
    const { app } = await fixture();
    const response = await app.inject({ url: `/sentence-audio/${mocks.hash}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().sentence.audio.map((row: { accent: string }) => row.accent)).toEqual([
      'UK',
    ]);
  });
  it('rejects GET and HEAD of the held accent before database or media access', async () => {
    const { app, findFirst } = await fixture();
    for (const method of ['GET', 'HEAD'] as const) {
      const response = await app.inject({ method, url: `/sentence-audio/${mocks.hash}/audio/US` });
      expect(response.statusCode).toBe(404);
    }
    expect(findFirst).not.toHaveBeenCalled();
    expect(mocks.bytes).not.toHaveBeenCalled();
  });
  it('continues to serve the other accent through the verified-media path', async () => {
    const { app } = await fixture();
    const response = await app.inject({ url: `/sentence-audio/${mocks.hash}/audio/UK` });
    expect(response.statusCode).toBe(200);
    expect(mocks.bytes).toHaveBeenCalledOnce();
  });
});
