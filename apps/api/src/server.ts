import fs from 'node:fs';
import { readConfig } from './config.js';
import { buildApp } from './app.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const config = readConfig();
const { app } = await buildApp(config);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
await app.listen({ host: config.host, port: config.port });
