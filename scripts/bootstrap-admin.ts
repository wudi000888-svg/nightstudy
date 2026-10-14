import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from '../apps/api/src/config.js';
import { createDatabase } from '../apps/api/src/db.js';
import { bootstrapAdministrator } from '../apps/api/src/bootstrap-admin.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const mode = process.env.ADMIN_BOOTSTRAP || 'auto';
if (!['auto', 'manual'].includes(mode)) throw new Error('ADMIN_BOOTSTRAP must be auto or manual');
if (mode === 'manual') {
  console.log(JSON.stringify({ action: 'admin.bootstrap', status: 'manual-setup-selected' }));
} else {
  const config = readConfig();
  if (
    config.sites.length > 1 &&
    (process.env.INITIAL_ADMIN_PASSWORD || process.env.INITIAL_ADMIN_EMAIL)
  )
    throw new Error('Initial administrator overrides support single-site installs only');
  const directory = path.resolve(process.env.ADMIN_CREDENTIALS_DIR || '.local/admin');
  for (const site of config.sites) {
    const prisma = createDatabase(site.databaseUrl);
    try {
      const result = await bootstrapAdministrator(prisma, site, directory, {
        initialPassword: process.env.INITIAL_ADMIN_PASSWORD || undefined,
        initialEmail: process.env.INITIAL_ADMIN_EMAIL || undefined,
      });
      console.log(JSON.stringify({ action: 'admin.bootstrap', ...result }));
    } finally {
      await prisma.$disconnect();
    }
  }
}
