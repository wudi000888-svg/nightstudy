import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

export function createDatabase(databaseUrl: string, max = 5): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: databaseUrl,
      max,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    }),
  });
}
