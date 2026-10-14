import type { Prisma } from '@prisma/client';

/** ownerId=null is the public catalog; administrative role never grants personal-book access. */
export function visibleBookWhere(userId?: string | null): Prisma.BookWhereInput {
  return {
    status: 'published',
    ...(userId ? { OR: [{ ownerId: null }, { ownerId: userId }] } : { ownerId: null }),
  };
}
