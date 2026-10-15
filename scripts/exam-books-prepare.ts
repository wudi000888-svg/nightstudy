import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readConfig } from '../apps/api/src/config.js';
import { importExamBookRows, loadExamBookManifest, readExamBookRows } from './exam-books-lib.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const { values } = parseArgs({
  options: { site: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
  strict: true,
});
const manifest = loadExamBookManifest();
const rows = readExamBookRows(
  fs.readFileSync(path.join(import.meta.dirname, '../data', manifest.fileName)),
  manifest,
);
const sites = readConfig().sites.filter((site) => !values.site || values.site === site.id);
if (!sites.length) throw new Error('Select a configured --site');
for (const site of sites)
  console.log(
    JSON.stringify({
      action: 'exam-books.prepare',
      ...(await importExamBookRows(site, rows, manifest, { dryRun: values['dry-run'] })),
    }),
  );
