import type { FastifyInstance } from 'fastify';
import { Prisma, type DailyPlan, type UserSettings } from '@prisma/client';
import { z } from 'zod';
import { HttpError, requireUser, type ContextResolver } from '../context.js';
import {
  settings,
  learningDayWindow,
  parse,
  id,
  commandId,
  digest,
  json,
  obj,
  getReceipt,
  transact,
  type Db,
} from './shared.js';
import { visibleBookWhere } from './book-access.js';
import { updateLearningPreferences } from './learning-preferences.js';
import { decodeCursor, pageInfo } from './pagination.js';

export const eligibleWord = (userId: string): Prisma.WordWhereInput => ({
  status: 'published',
  userWords: { none: { userId, paused: true } },
});
const openStatuses = ['in_progress', 'paused'];

export async function lockLearningPreferences(db: Db, userId: string) {
  await settings(db, userId);
  await db.$queryRaw`SELECT "userId" FROM "UserSettings" WHERE "userId"=${userId} FOR UPDATE`;
  return settings(db, userId);
}

/** Called in a serializable transaction with the settings row lock held. */
export async function ensureDailyPlan(db: Db, userId: string, now = new Date()) {
  const prefs = await lockLearningPreferences(db, userId);
  const book = prefs.currentBookId
    ? await db.book.findFirst({ where: { id: prefs.currentBookId, ...visibleBookWhere(userId) } })
    : null;
  let plan = await db.dailyPlan.findFirst({
    where: { userId, startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { startsAt: 'desc' },
  });
  if (!plan) {
    const window = learningDayWindow(now, prefs.timeZone);
    const previous = await db.dailyPlan.findFirst({
      where: { userId, endsAt: { lte: now } },
      orderBy: { endsAt: 'desc' },
    });
    // A pending timezone never overlaps a previously persisted learning day.
    if (previous && previous.endsAt > window.startsAt) window.startsAt = previous.endsAt;
    plan = await db.dailyPlan.create({
      data: {
        userId,
        ...window,
        timeZone: prefs.timeZone,
        targetTotal: prefs.dailyTotalGoal,
        sourceBookId: book?.id ?? null,
        sourceBookTitle: book?.title ?? null,
        goal: prefs.goal,
        prefsRevision: prefs.revision,
      },
    });
  } else if (
    plan.prefsRevision !== prefs.revision ||
    plan.targetTotal !== prefs.dailyTotalGoal ||
    plan.sourceBookId !== (book?.id ?? null)
  ) {
    plan = await db.dailyPlan.update({
      where: { id: plan.id },
      data: {
        targetTotal: prefs.dailyTotalGoal,
        sourceBookId: book?.id ?? null,
        sourceBookTitle: book?.title ?? null,
        goal: prefs.goal,
        prefsRevision: prefs.revision,
        revision: { increment: 1 },
      },
    });
  }
  let words = await db.dailyPlanWord.findMany({
    where: { planId: plan.id },
    orderBy: { ordinal: 'asc' },
  });
  const logs = await db.$queryRaw<{ wordId: string; wasNew: boolean; reviewedAt: Date }[]>`
    SELECT "wordId", BOOL_OR("wasNew") AS "wasNew", MIN("reviewedAt") AS "reviewedAt"
    FROM "ReviewLog"
    WHERE "userId"=${userId} AND "reviewedAt">=${plan.startsAt} AND "reviewedAt"<${plan.endsAt}
    GROUP BY "wordId"
  `;
  const newIds = new Set(logs.filter((log) => log.wasNew).map((log) => log.wordId));
  let ordinal = Math.max(-1, ...words.map((word) => word.ordinal)) + 1;
  let changed = false;
  const byWord = new Map(words.map((word) => [word.wordId, word]));
  for (const log of logs) {
    const existing = byWord.get(log.wordId);
    if (!existing?.firstRatedAt) {
      const saved = await db.dailyPlanWord.upsert({
        where: { planId_wordId: { planId: plan.id, wordId: log.wordId } },
        create: {
          planId: plan.id,
          wordId: log.wordId,
          bucket: newIds.has(log.wordId) ? 'new' : 'review',
          status: 'completed',
          firstRatedAt: log.reviewedAt,
          ordinal: ordinal++,
        },
        update: { status: 'completed', firstRatedAt: log.reviewedAt },
      });
      byWord.set(log.wordId, saved);
      changed = true;
    }
  }
  // Issued unfinished groups remain a promise across midnight, goal changes and book changes.
  const outstanding = await db.studySession.findMany({
    where: { userId, status: { in: openStatuses } },
    include: { items: { where: { exerciseDone: false } } },
    orderBy: { createdAt: 'asc' },
  });
  const blocked = new Set<string>();
  for (const session of outstanding) {
    const deferred = session.deferredUntil && session.deferredUntil > now;
    for (const item of session.items) {
      if (item.rated) continue; // Yesterday's remaining spelling is practice, never a new-day word reservation.
      blocked.add(item.wordId);
      if (deferred || byWord.has(item.wordId)) continue;
      const progress = await db.studyProgress.findUnique({
        where: { userId_wordId: { userId, wordId: item.wordId } },
        select: { firstLearnedAt: true, dueAt: true },
      });
      const saved = await db.dailyPlanWord.create({
        data: {
          planId: plan.id,
          wordId: item.wordId,
          bucket: progress?.firstLearnedAt ? 'review' : 'new',
          status: 'assigned',
          activeSessionId: session.id,
          dueAtSnapshot: progress?.dueAt,
          ordinal: ordinal++,
        },
      });
      byWord.set(item.wordId, saved);
      changed = true;
    }
  }
  words = [...byWord.values()];
  const held = words.filter(
    (word) => word.firstRatedAt || word.activeSessionId || word.status === 'deferred',
  );
  const slots = Math.max(0, plan.targetTotal - held.length);
  const candidates = await db.studyProgress.findMany({
    where: {
      userId,
      firstLearnedAt: { not: null },
      dueAt: { lt: plan.endsAt },
      wordId: { notIn: [...new Set([...held.map((word) => word.wordId), ...blocked])] },
      word: eligibleWord(userId),
    },
    orderBy: [{ dueAt: 'asc' }, { wordId: 'asc' }],
    take: slots,
  });
  const candidateIds = new Set(candidates.map((progress) => progress.wordId));
  const queued = words.filter(
    (word) => word.status === 'queued' && !word.activeSessionId && !word.firstRatedAt,
  );
  const obsolete = queued.filter((word) => !candidateIds.has(word.wordId));
  if (obsolete.length) {
    await db.dailyPlanWord.deleteMany({ where: { id: { in: obsolete.map((word) => word.id) } } });
    changed = true;
  }
  for (const candidate of candidates) {
    if (byWord.has(candidate.wordId) && !obsolete.some((word) => word.wordId === candidate.wordId))
      continue;
    await db.dailyPlanWord.create({
      data: {
        planId: plan.id,
        wordId: candidate.wordId,
        bucket: 'review',
        dueAtSnapshot: candidate.dueAt,
        ordinal: ordinal++,
      },
    });
    changed = true;
  }
  if (changed)
    plan = await db.dailyPlan.update({
      where: { id: plan.id },
      data: { revision: { increment: 1 } },
    });
  return plan;
}

export async function planView(db: Db, userId: string, plan: DailyPlan, now = new Date()) {
  const prefs = await settings(db, userId);
  const words = await db.dailyPlanWord.findMany({ where: { planId: plan.id } });
  const complete = words.filter((word) => word.firstRatedAt);
  const assigned = words.filter((word) => !word.firstRatedAt && word.activeSessionId);
  const review = words.filter((word) => word.bucket === 'review');
  const dueWhere: Prisma.StudyProgressWhereInput = {
    userId,
    firstLearnedAt: { not: null },
    word: eligibleWord(userId),
  };
  const [
    dueNowCount,
    dueTodayCount,
    overdueCount,
    unplannedOverdueCount,
    consolidation,
    nextDue,
    spelling,
    active,
    availableNew,
  ] = await Promise.all([
    db.studyProgress.count({ where: { ...dueWhere, dueAt: { lte: now } } }),
    db.studyProgress.count({ where: { ...dueWhere, dueAt: { lt: plan.endsAt } } }),
    db.studyProgress.count({ where: { ...dueWhere, dueAt: { lt: plan.startsAt } } }),
    db.studyProgress.count({
      where: {
        ...dueWhere,
        dueAt: { lt: plan.startsAt },
        wordId: { notIn: review.map((word) => word.wordId) },
      },
    }),
    db.studyProgress.findMany({
      where: {
        ...dueWhere,
        wordId: { in: complete.map((word) => word.wordId) },
        dueAt: { lt: plan.endsAt },
        OR: [
          { fsrsJson: { path: ['state'], equals: 1 } },
          { fsrsJson: { path: ['state'], equals: 3 } },
        ],
      },
      select: { wordId: true },
    }),
    db.studyProgress.findFirst({
      where: { ...dueWhere, dueAt: { gt: now, lt: plan.endsAt } },
      orderBy: { dueAt: 'asc' },
      select: { dueAt: true },
    }),
    db.sessionItem.findMany({
      where: {
        session: { userId, status: { in: openStatuses } },
        rated: true,
        exerciseDone: false,
      },
      select: { wordId: true },
    }),
    db.studySession.findFirst({
      where: { userId, taskKind: { not: 'extra-review' }, status: 'in_progress' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    }),
    plan.sourceBookId
      ? db.bookItem.count({
          where: {
            bookId: plan.sourceBookId,
            wordId: { notIn: words.map((word) => word.wordId) },
            word: {
              ...eligibleWord(userId),
              progress: { none: { userId, firstLearnedAt: { not: null } } },
              senses: { some: { definitionZh: { not: '' } } },
            },
          },
        })
      : Promise.resolve(0),
  ]);
  const occupied = words.length;
  const newRemaining = Math.min(availableNew, Math.max(0, plan.targetTotal - occupied));
  return {
    id: plan.id,
    revision: plan.revision,
    localDate: plan.localDate,
    timeZone: plan.timeZone,
    startsAt: plan.startsAt.toISOString(),
    endsAt: plan.endsAt.toISOString(),
    goal: plan.goal,
    bookId: plan.sourceBookId,
    bookTitle: plan.sourceBookTitle,
    dailyTotalGoal: plan.targetTotal,
    groupSize: prefs.groupSize,
    completedUnique: complete.length,
    completedNew: complete.filter((word) => word.bucket === 'new').length,
    completedReview: complete.filter((word) => word.bucket === 'review').length,
    assignedUnique: assigned.length,
    plannedReview: review.length,
    plannedNew: words.filter((word) => word.bucket === 'new').length + newRemaining,
    dueNowCount,
    dueTodayCount,
    overdueCount,
    unplannedOverdueCount,
    pendingConsolidationCount: consolidation.length,
    pendingSpellingCount: new Set(spelling.map((item) => item.wordId)).size,
    newRemaining,
    reviewRemaining: new Set([
      ...review.filter((word) => !word.firstRatedAt).map((word) => word.wordId),
      ...consolidation.map((word) => word.wordId),
    ]).size,
    nextDueAt: nextDue?.dueAt.toISOString() ?? null,
    activeTaskId: active?.id ?? null,
    recommendedTotal: prefs.dailyTotalGoal,
    // Read-only compatibility aliases; the legacy name now mirrors the total-word goal.
    dailyNewLimit: plan.targetTotal,
    dueCount: dueNowCount,
    reservedNewCount: assigned.filter((word) => word.bucket === 'new').length,
    learnedToday: complete.filter((word) => word.bucket === 'new').length,
    recommendedNew: newRemaining,
  };
}

export async function recordPlanRating(
  db: Db,
  userId: string,
  wordId: string,
  wasNew: boolean,
  now: Date,
  sessionId: string,
) {
  const plan = await ensureDailyPlan(db, userId, now);
  const existing = await db.dailyPlanWord.findUnique({
    where: { planId_wordId: { planId: plan.id, wordId } },
  });
  const max = await db.dailyPlanWord.aggregate({
    where: { planId: plan.id },
    _max: { ordinal: true },
  });
  await db.dailyPlanWord.upsert({
    where: { planId_wordId: { planId: plan.id, wordId } },
    create: {
      planId: plan.id,
      wordId,
      bucket: wasNew ? 'new' : 'review',
      status: 'completed',
      firstRatedAt: now,
      activeSessionId: sessionId,
      ordinal: (max._max.ordinal ?? -1) + 1,
    },
    update: {
      ...(!existing?.firstRatedAt ? { bucket: wasNew ? 'new' : 'review' } : {}),
      status: 'completed',
      firstRatedAt: existing?.firstRatedAt ?? now,
      activeSessionId: sessionId,
    },
  });
  await db.dailyPlan.update({ where: { id: plan.id }, data: { revision: { increment: 1 } } });
  return plan;
}
export async function clearSessionAssignment(db: Db, sessionId: string) {
  await db.dailyPlanWord.updateMany({
    where: { activeSessionId: sessionId, firstRatedAt: { not: null } },
    data: { activeSessionId: null, deferredUntil: null, status: 'completed' },
  });
  await db.dailyPlanWord.updateMany({
    where: { activeSessionId: sessionId, firstRatedAt: null },
    data: { activeSessionId: null, deferredUntil: null, status: 'queued' },
  });
}

export async function previewPlan(
  db: Db,
  userId: string,
  prefs: UserSettings,
  input: { bookId?: string; dailyTotalGoal?: number; groupSize?: number; timeZone?: string },
  now = new Date(),
) {
  const bookId = input.bookId ?? prefs.currentBookId;
  const book = bookId
    ? await db.book.findFirst({ where: { id: bookId, ...visibleBookWhere(userId) } })
    : null;
  if (bookId && !book) throw new HttpError(404, 'book_not_found');
  if (input.timeZone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timeZone });
    } catch {
      throw new HttpError(400, 'invalid_timezone');
    }
  }
  const existing = await db.dailyPlan.findFirst({
    where: { userId, startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { startsAt: 'desc' },
  });
  const window = existing ?? learningDayWindow(now, prefs.timeZone);
  if (!existing) {
    const previous = await db.dailyPlan.findFirst({
      where: { userId, endsAt: { lte: now } },
      orderBy: { endsAt: 'desc' },
    });
    if (previous && previous.endsAt > window.startsAt) window.startsAt = previous.endsAt;
  }
  const words = existing ? await db.dailyPlanWord.findMany({ where: { planId: existing.id } }) : [];
  const retained = words.filter(
    (word) => word.firstRatedAt || word.activeSessionId || word.status === 'deferred',
  );
  const where: Prisma.StudyProgressWhereInput = {
    userId,
    firstLearnedAt: { not: null },
    word: eligibleWord(userId),
  };
  const [
    dueNowCount,
    dueTodayCount,
    overdueCount,
    remainingReview,
    remainingOverdue,
    availableNew,
  ] = await Promise.all([
    db.studyProgress.count({ where: { ...where, dueAt: { lte: now } } }),
    db.studyProgress.count({ where: { ...where, dueAt: { lt: window.endsAt } } }),
    db.studyProgress.count({ where: { ...where, dueAt: { lt: window.startsAt } } }),
    db.studyProgress.count({
      where: {
        ...where,
        dueAt: { lt: window.endsAt },
        wordId: { notIn: retained.map((word) => word.wordId) },
      },
    }),
    db.studyProgress.count({
      where: {
        ...where,
        dueAt: { lt: window.startsAt },
        wordId: { notIn: retained.map((word) => word.wordId) },
      },
    }),
    book
      ? db.bookItem.count({
          where: {
            bookId: book.id,
            wordId: { notIn: retained.map((word) => word.wordId) },
            word: {
              ...eligibleWord(userId),
              progress: { none: { userId, firstLearnedAt: { not: null } } },
              senses: { some: { definitionZh: { not: '' } } },
            },
          },
        })
      : Promise.resolve(0),
  ]);
  const target = input.dailyTotalGoal ?? prefs.dailyTotalGoal;
  const slots = Math.max(0, target - retained.length);
  const reservedReview = Math.min(slots, remainingReview);
  const reviewPlanned = retained.filter((word) => word.bucket === 'review').length + reservedReview;
  return {
    preview: {
      bookId: book?.id ?? null,
      bookTitle: book?.title ?? null,
      dailyTotalGoal: target,
      groupSize: input.groupSize ?? prefs.groupSize,
      timeZone: existing?.timeZone ?? prefs.timeZone,
      pendingTimeZone:
        input.timeZone && input.timeZone !== prefs.timeZone
          ? input.timeZone
          : prefs.pendingTimeZone,
      startsAt: window.startsAt.toISOString(),
      endsAt: window.endsAt.toISOString(),
      completedUnique: retained.filter((word) => word.firstRatedAt).length,
      retainedAssignedCount: retained.filter((word) => !word.firstRatedAt).length,
      reviewPlanned,
      newPlanned:
        retained.filter((word) => word.bucket === 'new').length +
        Math.min(availableNew, Math.max(0, slots - reservedReview)),
      dueNowCount,
      dueTodayCount,
      overdueCount,
      unplannedOverdueCount: Math.max(0, remainingOverdue - reservedReview),
    },
    settingsRevision: prefs.revision,
  };
}

export async function registerTaskRoutes(
  app: FastifyInstance,
  getContext: ContextResolver,
  viewSession: (db: Db, userId: string, sessionId: string) => Promise<unknown>,
) {
  app.get('/study/plan/preview', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    const input = parse(
      z
        .object({
          bookId: id.optional(),
          dailyTotalGoal: z.coerce.number().int().min(1).max(100).optional(),
          groupSize: z.coerce.number().int().min(1).max(20).optional(),
          timeZone: z.string().min(1).max(80).optional(),
        })
        .strict(),
      req.query,
    );
    let prefs = (await ctx.prisma.userSettings.findUnique({ where: { userId: user.id } })) ?? {
      userId: user.id,
      goal: 'daily',
      currentBookId: null,
      dailyNewLimit: 20,
      dailyTotalGoal: 20,
      groupSize: 5,
      timeZone: 'Asia/Shanghai',
      pendingTimeZone: null,
      timeZoneEffectiveAt: null,
      revision: 0,
      updatedAt: new Date(),
    };
    // Preview stays read-only while matching the deterministic activation performed at confirmation.
    if (
      prefs.pendingTimeZone &&
      prefs.timeZoneEffectiveAt &&
      prefs.timeZoneEffectiveAt <= new Date()
    )
      prefs = {
        ...prefs,
        timeZone: prefs.pendingTimeZone,
        pendingTimeZone: null,
        timeZoneEffectiveAt: null,
        revision: prefs.revision + 1,
      };
    return previewPlan(ctx.prisma, user.id, prefs, input);
  });
  app.post('/study/plan/confirm', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    const input = parse(
      z
        .object({
          bookId: id,
          dailyTotalGoal: z.number().int().min(1).max(100),
          groupSize: z.number().int().min(1).max(20),
          timeZone: z.string().min(1).max(80).optional(),
          expectedRevision: z.number().int().nonnegative(),
          commandId,
        })
        .strict(),
      req.body,
    );
    const hash = digest({ action: 'plan-confirm', ...input });
    return transact(ctx.prisma, async (tx) => {
      await lockLearningPreferences(tx, user.id);
      const old = await getReceipt(tx, user.id, input.commandId, hash);
      if (old) return { ...obj(old.responseJson), duplicate: true };
      const book = await tx.book.findFirst({
        where: { id: input.bookId, ...visibleBookWhere(user.id) },
      });
      if (!book) throw new HttpError(404, 'book_not_found');
      const prefs = await updateLearningPreferences(tx, user.id, {
        currentBookId: book.id,
        goal: book.goal as 'daily',
        dailyTotalGoal: input.dailyTotalGoal,
        groupSize: input.groupSize,
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
        expectedRevision: input.expectedRevision,
      });
      const current = await ensureDailyPlan(tx, user.id);
      const response = {
        settings: prefs,
        plan: await planView(tx, user.id, current),
        duplicate: false,
      };
      await tx.commandReceipt.create({
        data: {
          userId: user.id,
          commandId: input.commandId,
          requestHash: hash,
          responseJson: json(response),
        },
      });
      return response;
    });
  });
  app.get('/study/tasks', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    const query = parse(
      z
        .object({
          status: z.enum(['active', 'completed', 'all']).default('active'),
          limit: z.coerce.number().int().min(1).max(50).default(20),
          cursor: z.string().min(1).max(1200).optional(),
        })
        .strict(),
      req.query,
    );
    const scope = `tasks:${ctx.siteId}:${user.id}:${query.status}`,
      cursor = decodeCursor(scope, query.cursor, 'string');
    let after: { createdAt: Date; id: string } | null = null;
    if (cursor) {
      try {
        const value = z
          .object({ at: z.string().datetime(), id })
          .strict()
          .parse(JSON.parse(cursor));
        after = { createdAt: new Date(value.at), id: value.id };
      } catch {
        throw new HttpError(400, 'invalid_cursor');
      }
    }
    const where: Prisma.StudySessionWhereInput = {
      userId: user.id,
      ...(query.status === 'active'
        ? { status: { in: openStatuses } }
        : query.status === 'completed'
          ? { status: 'completed' }
          : {}),
    };
    const [rows, total] = await Promise.all([
      ctx.prisma.studySession.findMany({
        where: {
          ...where,
          ...(after
            ? {
                OR: [
                  { createdAt: { lt: after.createdAt } },
                  { createdAt: after.createdAt, id: { lt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
      ctx.prisma.studySession.count({ where }),
    ]);
    const page = pageInfo(rows, query.limit, total, scope, (row) =>
      JSON.stringify({ at: row.createdAt.toISOString(), id: row.id }),
    );
    const items: unknown[] = [];
    for (const session of page.items)
      items.push(await viewSession(ctx.prisma, user.id, session.id));
    return { items, page: page.page };
  });
  app.post('/study/tasks/:id/state', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    const input = parse(
      z
        .object({
          action: z.enum(['pause', 'resume', 'defer']),
          commandId,
          expectedSessionRevision: z.number().int().nonnegative(),
          deferUntil: z.string().datetime().optional(),
        })
        .strict(),
      req.body,
    );
    const hash = digest({ operation: 'task-state', id: params.id, ...input });
    return transact(ctx.prisma, async (tx) => {
      await lockLearningPreferences(tx, user.id);
      const session = await tx.studySession.findFirst({
        where: { id: params.id, userId: user.id },
      });
      if (!session) throw new HttpError(404, 'session_not_found');
      const old = await getReceipt(tx, user.id, input.commandId, hash);
      if (old)
        return {
          session: await viewSession(tx, user.id, session.id),
          plan: await planView(tx, user.id, await ensureDailyPlan(tx, user.id)),
          duplicate: true,
        };
      if (session.revision !== input.expectedSessionRevision)
        throw new HttpError(409, 'session_conflict', '任务已在另一设备更新', {
          session: await viewSession(tx, user.id, session.id),
        });
      if (session.status === 'completed') throw new HttpError(409, 'task_already_completed');
      const now = new Date();
      if (input.action === 'defer') {
        const until = input.deferUntil ? new Date(input.deferUntil) : null;
        if (!until || until <= now || until.getTime() > now.getTime() + 7 * 86400000)
          throw new HttpError(400, 'invalid_task_defer_time');
        await ensureDailyPlan(tx, user.id, now);
        await tx.dailyPlanWord.updateMany({
          where: { activeSessionId: session.id },
          data: { deferredUntil: until, status: 'deferred' },
        });
      } else if (input.action === 'resume') {
        const active = await tx.studySession.findFirst({
          where: {
            userId: user.id,
            status: 'in_progress',
            taskKind:
              session.taskKind === 'extra-review' ? 'extra-review' : { not: 'extra-review' },
            id: { not: session.id },
          },
        });
        if (active)
          throw new HttpError(409, 'another_task_active', '请先暂停或完成正在进行的任务', {
            sessionId: active.id,
          });
        await tx.dailyPlanWord.updateMany({
          where: { activeSessionId: session.id },
          data: { deferredUntil: null, status: 'assigned' },
        });
      }
      await tx.studySession.update({
        where: { id: session.id },
        data: {
          status: input.action === 'resume' ? 'in_progress' : 'paused',
          pausedAt: input.action === 'resume' ? null : now,
          deferredUntil: input.action === 'defer' ? new Date(input.deferUntil!) : null,
          revision: { increment: 1 },
        },
      });
      const plan = await ensureDailyPlan(tx, user.id, now);
      const response = {
        session: await viewSession(tx, user.id, session.id),
        plan: await planView(tx, user.id, plan, now),
        duplicate: false,
      };
      await tx.commandReceipt.create({
        data: {
          userId: user.id,
          commandId: input.commandId,
          requestHash: hash,
          responseJson: json(response),
        },
      });
      return response;
    });
  });
  app.get('/study/forecast', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      now = new Date();
    return transact(ctx.prisma, async (tx) => {
      const plan = await ensureDailyPlan(tx, user.id, now),
        days = [];
      let at = now;
      for (let day = 0; day < 7; day++) {
        const window = day === 0 ? plan : learningDayWindow(at, plan.timeZone);
        const where: Prisma.StudyProgressWhereInput = {
          userId: user.id,
          firstLearnedAt: { not: null },
          word: eligibleWord(user.id),
        };
        const [dueUnique, overdueCarry] = await Promise.all([
          tx.studyProgress.count({
            where: { ...where, dueAt: { gte: window.startsAt, lt: window.endsAt } },
          }),
          tx.studyProgress.count({ where: { ...where, dueAt: { lt: window.startsAt } } }),
        ]);
        days.push({
          localDate: window.localDate,
          startsAt: window.startsAt.toISOString(),
          endsAt: window.endsAt.toISOString(),
          dueUnique,
          overdueCarry,
        });
        at = new Date(window.endsAt.getTime() + 1000);
      }
      return { days, asOf: now.toISOString(), assumption: 'current_due_dates_no_future_reviews' };
    });
  });
}
