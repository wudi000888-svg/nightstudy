import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { readConfig } from '../apps/api/src/config.js';
import { loadBilingualManifest, readBilingualRows, importBilingualRows } from './bilingual-lib.js';
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const { values } = parseArgs({ options: { site: { type: 'string' } }, strict: true });
const manifest = loadBilingualManifest();
const rows = readBilingualRows(
  fs.readFileSync(new URL('../data/' + manifest.fileName, import.meta.url)),
  manifest,
);
const sites = readConfig().sites.filter((site) => !values.site || site.id === values.site);
if (!sites.length) throw new Error('Select a configured --site');
for (const site of sites)
  console.log(
    JSON.stringify({
      action: 'bilingual.prepare',
      ...(await importBilingualRows(site, rows, manifest)),
    }),
  );
