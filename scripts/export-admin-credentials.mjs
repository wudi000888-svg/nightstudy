import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const directory = path.resolve(process.env.ADMIN_CREDENTIALS_DIR || '.local/admin');
const credentials = [];
const excluded = [];
const sites = readConfig().sites;
if (fs.existsSync(directory)) {
  for (const name of fs.readdirSync(directory)) {
    if (!/^[a-z0-9][a-z0-9-]{0,47}\.credentials\.json$/.test(name)) continue;
    const file = path.join(directory, name),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
      throw new Error('unsafe_credentials_file');
    const candidate = JSON.parse(fs.readFileSync(file, 'utf8'));
    const site = sites.find((site) => site.id === candidate.siteId);
    if (!site) {
      excluded.push({ siteId: candidate.siteId, reason: 'not-configured' });
      continue;
    }
    const db = createDatabase(site.databaseUrl);
    try {
      const state = await db.siteState.findUnique({ where: { id: 'singleton' } });
      const user =
        typeof candidate.userId === 'string'
          ? await db.user.findUnique({ where: { id: candidate.userId } })
          : null;
      const initializedHere =
        user &&
        (await db.adminAuditLog.count({
          where: { actorId: user.id, action: 'site.initialize.auto', targetId: site.id },
        }));
      if (
        state?.initialized &&
        state.siteId === site.id &&
        user?.role === 'admin' &&
        user.username === candidate.username &&
        initializedHere
      )
        credentials.push(candidate);
      else excluded.push({ siteId: site.id, reason: 'unconfirmed-candidate' });
    } finally {
      await db.$disconnect();
    }
  }
}
// This command is intended only for an operator redirecting stdout into a private host file.
process.stdout.write(
  JSON.stringify(
    {
      credentials,
      excluded,
      note: 'Initial generated credentials only; existing accounts and later password changes are never reset.',
    },
    null,
    2,
  ) + '\n',
);
