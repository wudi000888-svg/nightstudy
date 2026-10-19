import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { readConfig } from '../apps/api/src/config.js';
import {
  importPreparedLearningSenses,
  prepareLearningSensesInstall,
} from './learning-senses-lib.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const { values } = parseArgs({
  options: { site: { type: 'string' }, manifest: { type: 'string' } },
  strict: true,
});
const plan = prepareLearningSensesInstall(
  values.manifest ??
    (fs.existsSync(new URL('../data/learning-senses-collection-v2.manifest.json', import.meta.url))
      ? new URL('../data/learning-senses-collection-v2.manifest.json', import.meta.url)
      : new URL('../data/learning-senses-v1.manifest.json', import.meta.url)),
);
const sites = readConfig().sites.filter((site) => !values.site || site.id === values.site);
if (!sites.length) throw new Error('Select a configured --site');
for (const site of sites)
  console.log(
    JSON.stringify({
      action: 'learning-senses.prepare',
      ...(await importPreparedLearningSenses(site, plan)),
    }),
  );
