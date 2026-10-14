import { z } from 'zod';
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
