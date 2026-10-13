import fs from 'node:fs';
import { readConfig } from './config.js';
import { createDatabase } from './db.js';
import { maintenanceTick } from './maintenance.js';
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const config = readConfig();
const databases = config.sites.map((site) => ({
  id: site.id,
  prisma: createDatabase(site.databaseUrl, config.poolSize),
}));
let stopping = false;
let wake: (() => void) | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    stopping = true;
    wake?.();
  });
while (!stopping) {
  for (const { id, prisma } of databases) {
    try {
      await maintenanceTick(prisma, id);
    } catch (error) {
      console.error(
        JSON.stringify({ siteId: id, error: error instanceof Error ? error.name : 'worker_error' }),
      );
    }
  }
  if (!stopping)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
}
await Promise.all(databases.map(({ prisma }) => prisma.$disconnect()));
