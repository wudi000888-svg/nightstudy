import fs from 'node:fs';
import { fetchContentSource, loadContentManifest } from './content-lib.js';
if (fs.existsSync('.env')) process.loadEnvFile('.env');
try {
  const file = await fetchContentSource();
  console.log(
    JSON.stringify({
      action: 'content.fetch',
      packId: loadContentManifest().id,
      file,
      verified: true,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      action: 'content.fetch.failed',
      error: error instanceof Error ? error.message : 'unknown_error',
    }),
  );
  process.exitCode = 1;
}
