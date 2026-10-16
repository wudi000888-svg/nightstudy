import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { readConfig } from '../apps/api/src/config.js';
import { loadBilingualManifest, readBilingualRows, importBilingualRows } from './bilingual-lib.js';
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const { values } = parseArgs({
  options: { site: { type: 'string' }, pack: { type: 'string', default: 'all' } },
  strict: true,
});
if (!['v1', 'v2', 'all'].includes(values.pack!)) throw new Error('Choose --pack v1, v2 or all');
const manifests = values.pack === 'all' ? ['v1', 'v2'] : [values.pack];
const sites = readConfig().sites.filter((site) => !values.site || site.id === values.site);
if (!sites.length) throw new Error('Select a configured --site');
for (const pack of manifests) {
  const manifest = loadBilingualManifest(
    pack === 'v1' ? 'bilingual-pack.manifest.json' : 'bilingual-v2.manifest.json',
  );
  const rows = readBilingualRows(
    fs.readFileSync(new URL('../data/' + manifest.fileName, import.meta.url)),
    manifest,
  );
  for (const site of sites)
    console.log(
      JSON.stringify({
        action: 'bilingual.prepare',
        ...(await importBilingualRows(site, rows, manifest)),
      }),
    );
}
