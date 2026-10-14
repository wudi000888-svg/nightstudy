import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createDatabase } from './db.js';
import { checkForUpdates, getUpdateState } from './updates.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('persistent bounded update detection', () => {
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Use an isolated _test database');
  const db = createDatabase(url);
  beforeAll(async () => {
    await db.systemUpdateCheck.deleteMany();
  });
  afterAll(async () => {
    await db.systemUpdateCheck.deleteMany();
    await db.$disconnect();
  });
  it('shares a concurrent DB claim, caches the result and preserves the last successful result on failure', async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async (input) => {
      calls++;
      expect(String(input)).toBe(
        'https://api.github.com/repos/wudi000888-svg/nightstudy/releases?per_page=50',
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(
        JSON.stringify([
          {
            tag_name: 'v9.0.0',
            draft: false,
            prerelease: false,
            html_url: 'https://github.com/wudi000888-svg/nightstudy/releases/tag/v9.0.0',
          },
        ]),
        { headers: { 'Content-Type': 'application/json' } },
      );
    };
    const results = await Promise.all([
      checkForUpdates(db, { fetchFn }),
      checkForUpdates(db, { fetchFn }),
    ]);
    expect(calls).toBe(1);
    expect(results.some((result) => result.status === 'available')).toBe(true);
    expect(results.some((result) => result.cached)).toBe(true);
    const successful = await getUpdateState(db);
    expect(successful.latestVersion).toBe('9.0.0');
    await checkForUpdates(db, { fetchFn });
    expect(calls).toBe(1);
    await db.systemUpdateCheck.update({
      where: { id: 'singleton' },
      data: { lastAttemptedAt: new Date(Date.now() - 61000) },
    });
    const failed = await checkForUpdates(db, {
      fetchFn: async () => {
        throw new Error('private-provider-detail');
      },
    });
    expect(failed).toMatchObject({ status: 'failed', latestVersion: '9.0.0', stale: true });
    expect((await getUpdateState(db)).lastSuccessfulAt).toBe(successful.lastSuccessfulAt);
    expect(
      JSON.stringify(await db.systemUpdateCheck.findUnique({ where: { id: 'singleton' } })),
    ).not.toContain('private-provider-detail');
  });
});
