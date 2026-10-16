import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { HttpError } from '../context.js';
import { goal, id, settings, learningDayWindow, type Db } from './shared.js';
import { visibleBookWhere } from './book-access.js';

export const learningPreferencesInput = z
  .object({
    goal: goal.optional(),
    currentBookId: id.nullable().optional(),
    dailyTotalGoal: z.number().int().min(1).max(100).optional(),
    dailyNewLimit: z.number().int().min(1).max(100).optional(),
    groupSize: z.number().int().min(1).max(20).optional(),
    timeZone: z.string().min(1).max(80).optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Settings row lock and caller transaction make task invalidation and a book
 * selection one atomic transition. Memory evidence is deliberately untouched. */
export async function cancelOpenStudyTasks(
  db: Db,
  userId: string,
  extraWhere: Prisma.StudySessionWhereInput = {},
) {
  const sessions = await db.studySession.findMany({
    where: { ...extraWhere, userId, status: { in: ['in_progress', 'paused'] } },
    select: { id: true },
  });
  const ids = sessions.map((session) => session.id);
  if (!ids.length) return [];
  const assignments = await db.dailyPlanWord.findMany({
    where: { activeSessionId: { in: ids }, plan: { userId } },
    select: { planId: true },
  });
  await db.studySession.updateMany({
    where: { id: { in: ids }, userId },
    data: { status: 'cancelled', pausedAt: null, deferredUntil: null, revision: { increment: 1 } },
  });
  await db.dailyPlanWord.deleteMany({
    where: { activeSessionId: { in: ids }, firstRatedAt: null, plan: { userId } },
  });
  await db.dailyPlanWord.updateMany({
    where: { activeSessionId: { in: ids }, firstRatedAt: { not: null }, plan: { userId } },
    data: { activeSessionId: null, deferredUntil: null, status: 'completed' },
  });
  const planIds = [...new Set(assignments.map((word) => word.planId))];
  if (planIds.length)
    await db.dailyPlan.updateMany({
      where: { id: { in: planIds }, userId },
      data: { revision: { increment: 1 } },
    });
  return ids;
}

export async function updateLearningPreferences(
  db: Db,
  userId: string,
  input: z.infer<typeof learningPreferencesInput>,
  now = new Date(),
) {
  await settings(db, userId);
  await db.$queryRaw`SELECT "userId" FROM "UserSettings" WHERE "userId"=${userId} FOR UPDATE`;
  const current = await settings(db, userId);
  if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision)
    throw new HttpError(409, 'settings_conflict', '设置已被更新，请重新确认计划', {
      settings: current,
    });
  if (
    input.dailyTotalGoal !== undefined &&
    input.dailyNewLimit !== undefined &&
    input.dailyTotalGoal !== input.dailyNewLimit
  )
    throw new HttpError(400, 'conflicting_daily_goal', '每日总目标与兼容字段不能不同');
  if (
    input.currentBookId &&
    !(await db.book.findFirst({ where: { id: input.currentBookId, ...visibleBookWhere(userId) } }))
  )
    throw new HttpError(404, 'book_not_found');
  if (input.timeZone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timeZone });
    } catch {
      throw new HttpError(400, 'invalid_timezone');
    }
  }
  const total = input.dailyTotalGoal ?? input.dailyNewLimit;
  const {
    timeZone,
    expectedRevision: _revision,
    dailyNewLimit: _legacy,
    dailyTotalGoal: _total,
    ...other
  } = input;
  const timezoneChange =
    timeZone !== undefined
      ? timeZone === current.timeZone
        ? { pendingTimeZone: null, timeZoneEffectiveAt: null }
        : {
            pendingTimeZone: timeZone,
            timeZoneEffectiveAt:
              (
                await db.dailyPlan.findFirst({
                  where: { userId, startsAt: { lte: now }, endsAt: { gt: now } },
                  orderBy: { startsAt: 'desc' },
                })
              )?.endsAt ?? learningDayWindow(now, current.timeZone).endsAt,
          }
      : {};
  if (input.currentBookId !== undefined && input.currentBookId !== current.currentBookId)
    await cancelOpenStudyTasks(db, userId);
  return db.userSettings.update({
    where: { userId },
    data: {
      ...other,
      ...timezoneChange,
      ...(total === undefined ? {} : { dailyTotalGoal: total, dailyNewLimit: total }),
      revision: { increment: 1 },
    },
  });
}
