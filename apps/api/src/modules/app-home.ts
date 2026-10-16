import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { requireUser, type ContextResolver } from '../context.js';
import { obj, transact, type Db } from './shared.js';
import { eligibleWord, ensureDailyPlan, lockLearningPreferences, planView } from './tasks.js';
import { findEligibleProgress } from './learning-eligibility.js';

type EntryState =
  'setup' | 'resume' | 'ready' | 'waiting' | 'review_first' | 'other_task' | 'complete' | 'empty';
const openStatuses = ['in_progress', 'paused'];
const taskInclude = {
  items: { orderBy: { ordinal: 'asc' as const } },
  plan: { include: { words: true } },
};
type Task = Prisma.StudySessionGetPayload<{ include: typeof taskInclude }>;

function entry(state: EntryState, count = 0, task: Task | null = null, at: Date | null = null) {
  return {
    state,
    count,
    sessionId: task?.id ?? null,
    sessionRevision: task?.revision ?? null,
    phase: task?.phase ?? null,
    availableAt: at?.toISOString() ?? null,
  };
}
function unfinished(task: Task) {
  return task.items.filter(
    (item) =>
      !item.rated || (obj(item.questionJson).spellingEnabled !== false && !item.exerciseDone),
  );
}
function buckets(task: Task) {
  return new Set(
    task.items.map((item) => {
      const bucket = obj(item.questionJson).taskBucket;
      return bucket === 'new' || bucket === 'review'
        ? bucket
        : (task.plan?.words.find((word) => word.wordId === item.wordId)?.bucket ?? 'review');
    }),
  );
}
function shiftDay(label: string, days: number) {
  const date = new Date(`${label}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Completion, not a click or a pending client event, owns the check-in calendar. */
async function completionCalendar(
  db: Db,
  userId: string,
  timeZone: string,
  localDate: string,
  now: Date,
) {
  const rows = await db.$queryRaw<{ localDate: string; groups: number }[]>`
    SELECT COALESCE(day."localDate", to_char(s."updatedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone} - INTERVAL '4 hours', 'YYYY-MM-DD')) AS "localDate",
           COUNT(*)::integer AS groups
    FROM "StudySession" s
    LEFT JOIN LATERAL (
      SELECT p."localDate" FROM "DailyPlan" p
      WHERE p."userId" = ${userId} AND p."startsAt" <= s."updatedAt" AND p."endsAt" > s."updatedAt"
      ORDER BY p."startsAt" DESC LIMIT 1
    ) day ON TRUE
    WHERE s."userId" = ${userId} AND s.status = 'completed' AND s.phase = 'completed' AND s."updatedAt" <= ${now}
      AND EXISTS (SELECT 1 FROM "SessionItem" i WHERE i."sessionId" = s.id)
      AND NOT EXISTS (
        SELECT 1 FROM "SessionItem" i WHERE i."sessionId" = s.id
          AND (NOT i.rated OR (i."questionJson"->>'spellingEnabled' IS DISTINCT FROM 'false' AND NOT i."exerciseDone"))
      )
    GROUP BY 1
  `;
  const groups = new Map(rows.map((row) => [row.localDate, row.groups]));
  const days = Array.from({ length: 30 }, (_, index) => {
    const date = shiftDay(localDate, index - 29);
    const completedGroups = groups.get(date) ?? 0;
    return { localDate: date, checkedIn: completedGroups > 0, completedGroups };
  });
  let at = groups.has(localDate) ? localDate : shiftDay(localDate, -1),
    streak = 0;
  while (groups.has(at)) {
    streak++;
    at = shiftDay(at, -1);
  }
  return { days, streak };
}

/** Caller holds the same serializable transaction and settings lock used by task commands. */
export async function appHomeSnapshot(db: Db, userId: string, at?: Date) {
  await lockLearningPreferences(db, userId);
  // Capture the clock after the task lock: a command committed while this read waited is included.
  const now = at ?? new Date();
  const daily = await ensureDailyPlan(db, userId, now);
  const summary = await planView(db, userId, daily, now);
  const [tasks, words, calendar] = await Promise.all([
    db.studySession.findMany({
      where: { userId, status: { in: openStatuses } },
      include: taskInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    db.dailyPlanWord.findMany({ where: { planId: daily.id } }),
    completionCalendar(db, userId, daily.timeZone, daily.localDate, now),
  ]);
  const pending = tasks.filter((task) => unfinished(task).length > 0);
  const blocked = new Set(
    pending.flatMap((task) => task.items.filter((item) => !item.rated).map((item) => item.wordId)),
  );
  const assigned = new Set(words.filter((word) => word.activeSessionId).map((word) => word.wordId));
  const [reviewCandidates, futureReviews] = await Promise.all([
    findEligibleProgress(
      db,
      {
        userId,
        firstLearnedAt: { not: null },
        wordId: {
          in: words.filter((word) => !assigned.has(word.wordId)).map((word) => word.wordId),
          notIn: [...blocked],
        },
        dueAt: { lte: now },
        word: eligibleWord(userId),
      },
      [{ dueAt: 'asc' }, { wordId: 'asc' }],
    ),
    findEligibleProgress(
      db,
      {
        userId,
        firstLearnedAt: { not: null },
        dueAt: { gt: now },
        word: eligibleWord(userId),
      },
      [{ dueAt: 'asc' }, { wordId: 'asc' }],
      1,
    ),
  ]);
  const nextReview = futureReviews[0];
  const reviewNow = reviewCandidates.length;
  const active = pending.find(
    (task) => task.status === 'in_progress' && task.taskKind !== 'extra-review',
  );
  const available = (task: Task) => !task.deferredUntil || task.deferredUntil <= now;
  const choose = (kind: 'new' | 'review') =>
    pending.find((task) => task.status === 'in_progress' && buckets(task).has(kind)) ??
    pending.find((task) => available(task) && buckets(task).has(kind)) ??
    pending.find((task) => buckets(task).has(kind));
  const learnTask = choose('new'),
    reviewTask = choose('review');
  const taskEntry = (task: Task | undefined) => {
    if (!task) return null;
    if (active && active.id !== task.id && task.taskKind !== 'extra-review')
      return entry('other_task', unfinished(active).length, active);
    return available(task)
      ? entry('resume', unfinished(task).length, task)
      : entry('waiting', unfinished(task).length, task, task.deferredUntil);
  };
  const checkedIn = calendar.days.at(-1)!.checkedIn;
  const dailyGoalComplete =
    summary.completedUnique >= summary.dailyTotalGoal &&
    summary.assignedUnique === 0 &&
    summary.pendingSpellingCount === 0 &&
    summary.pendingConsolidationCount === 0;
  let review = taskEntry(reviewTask);
  if (!review) {
    if (active) review = entry('other_task', unfinished(active).length, active);
    else if (reviewNow) review = entry('ready', reviewNow);
    else if (nextReview) review = entry('waiting', summary.reviewRemaining, null, nextReview.dueAt);
    else review = entry(dailyGoalComplete ? 'complete' : 'empty');
  }
  let learn = taskEntry(learnTask);
  if (!learn) {
    if (active) learn = entry('review_first', unfinished(active).length, active);
    else if (!summary.bookId) learn = entry('setup');
    else if (reviewNow || review.state === 'resume')
      learn = entry('review_first', review.count, reviewTask ?? null);
    else if (summary.newRemaining > 0) learn = entry('ready', summary.newRemaining);
    else if (summary.reviewRemaining > 0)
      learn = entry(
        nextReview ? 'waiting' : 'review_first',
        summary.reviewRemaining,
        null,
        nextReview?.dueAt ?? null,
      );
    else learn = entry(dailyGoalComplete ? 'complete' : 'empty');
  }
  return {
    asOf: now.toISOString(),
    localDate: daily.localDate,
    timeZone: daily.timeZone,
    startsAt: daily.startsAt.toISOString(),
    endsAt: daily.endsAt.toISOString(),
    checkedIn,
    dailyGoalComplete,
    plan: {
      id: summary.id,
      revision: summary.revision,
      bookId: summary.bookId,
      bookTitle: summary.bookTitle,
      dailyTotalGoal: summary.dailyTotalGoal,
      completedUnique: summary.completedUnique,
      completedNew: summary.completedNew,
      completedReview: summary.completedReview,
      newRemaining: summary.newRemaining,
      reviewRemaining: summary.reviewRemaining,
      pendingSpellingCount: summary.pendingSpellingCount,
      pendingConsolidationCount: summary.pendingConsolidationCount,
      nextDueAt: nextReview?.dueAt.toISOString() ?? null,
    },
    learn,
    review,
    calendar,
  };
}

export async function registerAppHome(app: FastifyInstance, getContext: ContextResolver) {
  app.get('/app/home', async (req, reply) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    reply.header('Cache-Control', 'no-store');
    return transact(ctx.prisma, (tx) => appHomeSnapshot(tx, user.id));
  });
}
