import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export async function maintenanceTick(prisma: PrismaClient, siteId: string) {
  const state = await prisma.siteState.findUnique({ where: { id: 'singleton' } });
  if (!state || state.siteId !== siteId) throw new Error('database_site_binding_mismatch');
  const now = new Date();
  await prisma.$executeRaw`UPDATE "Job" SET "status" = 'failed', "lockedUntil" = NULL, "result" = '{"code":"retry_exhausted"}'::jsonb, "updatedAt" = NOW() WHERE "id" IN (SELECT "id" FROM "Job" WHERE "attempts" >= 5 AND (("status" = 'running' AND "lockedUntil" < NOW()) OR ("status" = 'pending' AND "runAfter" <= NOW())) FOR UPDATE SKIP LOCKED LIMIT 1000)`;
  const minute = Math.floor(now.getTime() / 60000);
  await prisma.job.upsert({
    where: { id: `maintenance-${minute}` },
    create: { id: `maintenance-${minute}`, type: 'maintenance', payload: { siteId } },
    update: {},
  });
  const jobs = await prisma.$queryRaw<
    Array<{ id: string; type: string }>
  >`UPDATE "Job" SET "status" = 'running', "lockedUntil" = NOW() + INTERVAL '60 seconds', "attempts" = "attempts" + 1, "updatedAt" = NOW() WHERE "id" IN (SELECT "id" FROM "Job" WHERE "runAfter" <= NOW() AND ("status" = 'pending' OR ("status" = 'running' AND "lockedUntil" < NOW())) AND "attempts" < 5 ORDER BY "runAfter" FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING "id", "type"`;
  for (const job of jobs) {
    if (job.type !== 'maintenance') {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: 'failed', lockedUntil: null, result: { code: 'unsupported_job_type' } },
      });
      continue;
    }
    // Cleanup is idempotent and each table has a fixed batch size.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM "RateBucket" WHERE "key" IN (SELECT "key" FROM "RateBucket" WHERE "expiresAt" < NOW() LIMIT 5000)`;
      await tx.$executeRaw`DELETE FROM "Session" WHERE "id" IN (SELECT "id" FROM "Session" WHERE "expiresAt" < NOW() LIMIT 1000)`;
      await tx.$executeRaw`DELETE FROM "Verification" WHERE "id" IN (SELECT "id" FROM "Verification" WHERE "expiresAt" < NOW() LIMIT 1000)`;
      await tx.$executeRaw`DELETE FROM "FleetPairingToken" WHERE "id" IN (SELECT "id" FROM "FleetPairingToken" WHERE "expiresAt" < NOW() - INTERVAL '7 days' LIMIT 1000)`;
      await tx.job.update({
        where: { id: job.id },
        data: { status: 'completed', lockedUntil: null, result: { runId: randomUUID() } },
      });
      await tx.$executeRaw`DELETE FROM "Job" WHERE "id" IN (SELECT "id" FROM "Job" WHERE "status" IN ('completed', 'failed') AND "createdAt" < NOW() - INTERVAL '7 days' LIMIT 1000)`;
    });
  }
}
