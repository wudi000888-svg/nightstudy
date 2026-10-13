import fs from 'node:fs';
import { readConfig } from '../apps/api/src/config.js';
import { importContentIntoSites } from './content-lib.js';
if (fs.existsSync('.env')) process.loadEnvFile('.env');
try {
  for (const result of await importContentIntoSites(readConfig().sites))
    console.log(JSON.stringify({ action: 'content.import', ...result }));
} catch (error) {
  console.error(
    JSON.stringify({
      action: 'content.import.failed',
      error: error instanceof Error ? error.name : 'unknown_error',
      code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
    }),
  );
  process.exitCode = 1;
}
