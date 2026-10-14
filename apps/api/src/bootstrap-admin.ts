import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashPassword } from 'better-auth/crypto';
import type { PrismaClient } from '@prisma/client';
import type { SiteConfig } from './config.js';

const credentialsSchema = z.object({
  formatVersion: z.literal(1),
  siteId: z.string(),
  publicUrl: z.string(),
  username: z.literal('admin'),
  email: z.email(),
  password: z.string().min(16).max(128),
  userId: z.string().uuid(),
  createdAt: z.string(),
});

export async function bootstrapAdministrator(
  prisma: PrismaClient,
  site: Pick<SiteConfig, 'id' | 'publicUrl'>,
  directory: string,
  options: { initialPassword?: string; initialEmail?: string } = {},
) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(site.id)) throw new Error('Invalid bootstrap site ID');
  const file = path.resolve(directory, `${site.id}.credentials.json`);
  return prisma.$transaction(
    async (tx) => {
      // The manual setup endpoint uses the same lock; neither path may create a second first admin.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(89124612)`;
      const state = await tx.siteState.findUnique({ where: { id: 'singleton' } });
      if (!state || state.siteId !== site.id) throw new Error('database_site_binding_mismatch');
      if (state.initialized) {
        if (fs.existsSync(file)) {
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
            throw new Error('unsafe_credentials_file');
          const candidate = credentialsSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
          const user =
            candidate.success && candidate.data.siteId === site.id
              ? await tx.user.findUnique({ where: { id: candidate.data.userId } })
              : null;
          const confirmed =
            user?.role === 'admin' &&
            user.username === 'admin' &&
            candidate.success &&
            (await tx.adminAuditLog.count({
              where: {
                actorId: candidate.data.userId,
                action: 'site.initialize.auto',
                targetId: site.id,
              },
            })) > 0;
          if (!confirmed) fs.renameSync(file, `${file}.unconfirmed-${randomUUID()}`);
        }
        return { siteId: site.id, status: 'already-initialized', credentialsFile: null };
      }
      if (await tx.user.count({ where: { role: 'admin' } }))
        throw new Error('existing_admin_requires_operator_review');
      fs.mkdirSync(path.resolve(directory), { recursive: true, mode: 0o700 });
      const dirStat = fs.lstatSync(path.resolve(directory));
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink())
        throw new Error('unsafe_credentials_directory');
      fs.chmodSync(path.resolve(directory), 0o700);
      let credentials: z.infer<typeof credentialsSchema>;
      if (fs.existsSync(file)) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
          throw new Error('unsafe_credentials_file');
        credentials = credentialsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (credentials.siteId !== site.id) throw new Error('credentials_site_binding_mismatch');
      } else {
        credentials = credentialsSchema.parse({
          formatVersion: 1,
          siteId: site.id,
          publicUrl: site.publicUrl,
          username: 'admin',
          email: options.initialEmail || 'admin@nightstudy.local',
          password: options.initialPassword || randomBytes(24).toString('base64url'),
          userId: randomUUID(),
          createdAt: new Date().toISOString(),
        });
        const descriptor = fs.openSync(file, 'wx', 0o600);
        try {
          fs.writeFileSync(descriptor, JSON.stringify(credentials, null, 2) + '\n');
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        const directoryDescriptor = fs.openSync(path.resolve(directory), 'r');
        try {
          fs.fsyncSync(directoryDescriptor);
        } finally {
          fs.closeSync(directoryDescriptor);
        }
      }
      // Persist the private candidate before committing the DB. A failed/retried install reuses it.
      const password = await hashPassword(credentials.password);
      await tx.user.create({
        data: {
          id: credentials.userId,
          name: '管理员',
          email: credentials.email,
          username: credentials.username,
          displayUsername: credentials.username,
          role: 'admin',
          accounts: {
            create: {
              id: randomUUID(),
              accountId: credentials.userId,
              providerId: 'credential',
              password,
            },
          },
        },
      });
      await tx.siteState.update({
        where: { id: 'singleton' },
        data: { initialized: true, initializedAt: new Date() },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: credentials.userId,
          action: 'site.initialize.auto',
          targetId: site.id,
          detail: { mode: 'auto', username: 'admin' },
        },
      });
      return { siteId: site.id, status: 'created', credentialsFile: file };
    },
    { maxWait: 10000, timeout: 30000 },
  );
}
