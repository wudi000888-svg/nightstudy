import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readConfig } from '../apps/api/src/config.js';
if (fs.existsSync('.env')) process.loadEnvFile('.env');
for (const site of readConfig().sites) {
  console.log(JSON.stringify({ action: 'migrate', siteId: site.id }));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      { stdio: 'inherit', env: { ...process.env, DATABASE_URL: site.databaseUrl } },
    );
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Migration failed for site ${site.id}`)),
    );
  });
}
