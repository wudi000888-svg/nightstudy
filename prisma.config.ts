import { defineConfig } from 'prisma/config';
import fs from 'node:fs';
if (fs.existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url:
      process.env.DATABASE_URL || 'postgresql://nightstudy:development@127.0.0.1:5432/nightstudy',
  },
});
