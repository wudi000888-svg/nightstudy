import fs from 'node:fs';
import { buildTranslationGateway } from './translation-gateway.js';
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const gateway = buildTranslationGateway({
  secret: process.env.TRANSLATION_GATEWAY_SECRET || '',
  requestsPerMinute: Number(process.env.TRANSLATION_REQUESTS_PER_MINUTE || 120),
});
await gateway.listen({
  host: process.env.GATEWAY_HOST || '127.0.0.1',
  port: Number(process.env.GATEWAY_PORT || 3099),
});
for (const event of ['SIGINT', 'SIGTERM'] as const)
  process.once(event, async () => {
    await gateway.close();
    process.exit(0);
  });
