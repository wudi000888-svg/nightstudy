import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { goals } from '../packages/core/src/index.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = fileURLToPath(new URL('../', import.meta.url));

async function runScript(script: string, environment: NodeJS.ProcessEnv) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: root,
      env: environment,
      // Migration failures must not print database URLs or inherited secrets.
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('seed_test_subprocess_timeout'));
    }, 45000);
    child.once('error', () => {
      clearTimeout(timeout);
      reject(new Error('seed_test_subprocess_failed'));
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error('seed_test_subprocess_failed'));
    });
  });
}

async function fullSnapshot(client: Client) {
  const tables = (
    await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
    )
  ).rows;
  const result: Record<string, unknown[]> = {};
  for (const { table_name: table } of tables) {
    const identifier = '"' + table.replaceAll('"', '""') + '"';
    result[table] = (
      await client.query<{ value: unknown }>(
        `SELECT to_jsonb(t) AS value FROM public.${identifier} t ORDER BY to_jsonb(t)::text`,
      )
    ).rows.map((row) => row.value);
  }
  return result;
}

it.skipIf(!databaseUrl)(
  'archives exact active demo books once and preserves all existing rows and metadata on repeated seed',
  async () => {
    const base = new URL(databaseUrl!);
    if (!['postgres:', 'postgresql:'].includes(base.protocol) || !base.pathname.endsWith('_test'))
      throw new Error('seed_test_requires_disposable_test_database');
    const nonce = randomUUID().replaceAll('-', '');
    const name = `nightstudy_seed_${nonce}_test`;
    if (!/^nightstudy_seed_[a-f0-9]{32}_test$/.test(name) || base.pathname === '/' + name)
      throw new Error('seed_test_exact_database_guard');
    const isolated = new URL(base);
    isolated.pathname = '/' + name;
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: isolated.href,
      SITES_FILE: '',
      NODE_ENV: 'test',
      PUBLIC_URL: 'http://127.0.0.1:5198',
      BASE_PATH: '',
      BETTER_AUTH_SECRET: 'synthetic-seed-authentication-secret-' + nonce,
      BOOTSTRAP_TOKEN: 'synthetic-seed-bootstrap-token-' + nonce,
      TRANSLATION_MODE: 'website-official',
      CLIENT_IP_PROFILE: 'socket',
    };
    const owner = new Client({ connectionString: base.href });
    const fixture = new Client({ connectionString: isolated.href });
    let created = false;
    await owner.connect();
    try {
      // A fresh, unique database prevents the five fixed demo IDs from touching
      // pre-existing fixtures, native data, or any other test's users/settings.
      await owner.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created = true;
      await runScript(path.join(root, 'scripts/migrate.ts'), environment);
      await runScript(path.join(root, 'scripts/seed.ts'), { ...environment, CONTENT_PACK: 'demo' });
      await fixture.connect();
      const old = '2001-02-03T04:05:06.123Z';
      const bookIds = goals.map((goal) => `demo-book-${goal}`);
      const active = bookIds.slice(0, 2);
      const userIds = ['demo-selected', 'already-null', 'real-selected', 'private-selected'].map(
        (part) => `seed-${nonce}-${part}`,
      );
      const realBook = `seed-${nonce}-real`;
      const similarBook = 'demo-book-daily-extra';
      const privateBook = `seed-${nonce}-private`;
      for (const [index, id] of bookIds.entries()) {
        await fixture.query(
          `UPDATE "Book" SET status=$2,title=$3,description=$4,version=$5,"updatedAt"=$6 WHERE id=$1`,
          [
            id,
            index === 0 ? 'published' : index === 1 ? 'draft' : 'archived',
            'Preserved admin title ' + index,
            'Preserved admin description ' + index,
            'preserved-admin-version-' + index,
            old,
          ],
        );
      }
      for (const id of userIds) {
        await fixture.query(
          `INSERT INTO "User"(id,name,email,"updatedAt") VALUES($1,'Seed synthetic fixture',$2,$3)`,
          [id, id + '@example.test', old],
        );
      }
      await fixture.query(
        `INSERT INTO "Book"(id,slug,title,description,goal,version,"ownerId","updatedAt")
         VALUES($1,$1,'Real source book','Preserve real content','daily','real-v1',NULL,$4),
               ($2,$2,'Similar name is not a demo ID','Preserve similar ID','daily','real-v1',NULL,$4),
               ($3,$3,'Private source book','Preserve private content','daily','private-v1',$5,$4)`,
        [realBook, similarBook, privateBook, old, userIds[3]],
      );
      const selections = [bookIds[0], null, realBook, privateBook];
      for (const [index, id] of userIds.entries()) {
        await fixture.query(
          `INSERT INTO "UserSettings"("userId","currentBookId","dailyTotalGoal","dailyNewLimit","groupSize",revision,"pendingTimeZone","timeZoneEffectiveAt","updatedAt")
           VALUES($1,$2,17,11,3,8,'Europe/London','2030-01-01T04:00:00Z',$3)`,
          [id, selections[index], old],
        );
      }
      await fixture.query(
        `UPDATE "Word" SET "sourceRef"='Synthetic retained administrator source',"contentVersion"='admin-word-v1',"updatedAt"=$1 WHERE id='demo-word-001'`,
        [old],
      );
      await fixture.query(
        `UPDATE "Sense" SET "definitionZh"='管理员保留的测试原义',"contentMetadata"='{"customNote":"preserve","definitionZh":{"kind":"site-authored","review":"source"}}' WHERE id='demo-word-001-sense-1'`,
      );
      await fixture.query(
        `INSERT INTO "StudyProgress"(id,"userId","wordId","fsrsJson","dueAt",revision,"updatedAt")
         VALUES($1,$2,'demo-word-001','{"state":2,"reps":7,"lapses":1,"stability":12.5}',
                '2030-01-01T04:00:00Z',12,$3)`,
        [`seed-${nonce}-progress`, userIds[0], old],
      );
      await fixture.query(
        `INSERT INTO "StudySession"(id,"userId","bookId",mode,"updatedAt") VALUES($1,$2,$3,'learn',$4)`,
        [`seed-${nonce}-session`, userIds[0], bookIds[0], old],
      );
      const before = await fullSnapshot(fixture);
      await runScript(path.join(root, 'scripts/seed.ts'), {
        ...environment,
        CONTENT_PACK: 'ecdict',
      });
      const afterFirst = await fullSnapshot(fixture);
      for (const table of Object.keys(before).filter(
        (table) => !['Book', 'UserSettings'].includes(table),
      ))
        expect(afterFirst[table], table).toEqual(before[table]);
      const beforeBooks = before.Book as Record<string, unknown>[];
      const firstBooks = afterFirst.Book as Record<string, unknown>[];
      for (const original of beforeBooks) {
        const current = firstBooks.find((book) => book.id === original.id)!;
        if (active.includes(String(original.id))) {
          expect(current.status).toBe('archived');
          expect(current.updatedAt).not.toBe(original.updatedAt);
          expect({ ...current, status: original.status, updatedAt: original.updatedAt }).toEqual(
            original,
          );
        } else expect(current).toEqual(original);
      }
      const beforeSettings = before.UserSettings as Record<string, unknown>[];
      const firstSettings = afterFirst.UserSettings as Record<string, unknown>[];
      for (const original of beforeSettings) {
        const current = firstSettings.find((setting) => setting.userId === original.userId)!;
        if (original.userId === userIds[0]) {
          expect(current.currentBookId).toBeNull();
          expect(current.updatedAt).not.toBe(original.updatedAt);
          expect({
            ...current,
            currentBookId: original.currentBookId,
            updatedAt: original.updatedAt,
          }).toEqual(original);
        } else expect(current).toEqual(original);
      }
      await runScript(path.join(root, 'scripts/seed.ts'), {
        ...environment,
        CONTENT_PACK: 'ecdict',
      });
      expect(await fullSnapshot(fixture)).toEqual(afterFirst);
    } finally {
      try {
        await fixture.end();
        if (created) {
          // Drop only the exact fresh database created by this test. No force drop,
          // connection termination, truncation, or changes to the source database.
          await owner.query(`DROP DATABASE "${name}"`);
        }
      } finally {
        await owner.end();
      }
    }
  },
  90000,
);
