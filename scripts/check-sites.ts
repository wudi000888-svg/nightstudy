import fs from 'node:fs';
import { readConfig } from '../apps/api/src/config.js';
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const config = readConfig();
console.log(
  JSON.stringify(
    {
      valid: true,
      sites: config.sites.map((site) => ({
        id: site.id,
        hosts: site.hosts,
        basePath: site.basePath,
        publicUrl: site.publicUrl,
      })),
      poolBudget: config.sites.length * config.poolSize,
      maxActiveSites: config.maxSites,
    },
    null,
    2,
  ),
);
