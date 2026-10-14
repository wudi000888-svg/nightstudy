import type { PrismaClient } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import type { TranslationConfig } from './config.js';

export interface UserView {
  id: string;
  name: string;
  email: string;
  role: string;
}
export interface RequestContext {
  siteId: string;
  basePath: string;
  publicUrl: string;
  instanceId: string;
  title: string;
  fleetSecret: string;
  registrationOpen: boolean;
  prisma: PrismaClient;
  user: UserView | null;
  translation?: TranslationConfig;
}
export type ContextResolver = (request: FastifyRequest) => Promise<RequestContext>;

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message = code,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function requireUser(context: RequestContext): UserView {
  if (!context.user) throw new HttpError(401, 'authentication_required');
  return context.user;
}

export function requireAdmin(context: RequestContext): UserView {
  const user = requireUser(context);
  if (user.role !== 'admin') throw new HttpError(403, 'admin_required');
  return user;
}
