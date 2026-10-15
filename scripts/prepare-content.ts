import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../apps/api/src/config.js';
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const pack = process.env.CONTENT_PACK || 'ecdict';
if (!['demo', 'ecdict'].includes(pack)) throw new Error('CONTENT_PACK must be demo or ecdict');
if (pack === 'ecdict') {
  const commands = [
    ['scripts/content-prepare.ts'],
    ['scripts/exam-books-prepare.ts'],
    ...readConfig().sites.map((site) => ['scripts/phonetics-prepare.ts', '--site', site.id]),
    ['scripts/phrase-prepare.ts'],
    ['scripts/bilingual-prepare.ts'],
  ];
  for (const args of commands) {
    const command = spawnSync(process.execPath, ['--import', 'tsx', ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    if (command.status !== 0) process.exit(command.status ?? 1);
  }
} else
  console.log(
    JSON.stringify({
      action: 'content.demo',
      note: 'Explicit minimal content profile; full dictionary not installed.',
    }),
  );
