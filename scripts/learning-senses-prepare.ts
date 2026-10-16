import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { readConfig } from '../apps/api/src/config.js';
import { importLearningSensesRows, loadLearningSensesFiles } from './learning-senses-lib.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const { values } = parseArgs({
  options: { site: { type: 'string' }, manifest: { type: 'string' } },
  strict: true,
});
const { manifest, rows } = loadLearningSensesFiles(values.manifest);
const sites = readConfig().sites.filter((site) => !values.site || site.id === values.site);
if (!sites.length) throw new Error('Select a configured --site');
for (const site of sites)
  console.log(
    JSON.stringify({
      action: 'learning-senses.prepare',
      ...(await importLearningSensesRows(site, rows, manifest)),
    }),
  );
