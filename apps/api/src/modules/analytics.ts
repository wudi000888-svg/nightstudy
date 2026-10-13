import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireUser, type ContextResolver } from '../context.js';
import {
  parse,
  id,
  goal,
  obj,
  hydrateCard,
  scheduler,
  quantile,
  isoDay,
  mergedSeconds,
  transact,
} from './shared.js';

export function splitInterval(
  startAt: Date,
  endAt: Date,
  timeZone: string,
): { date: string; startAt: Date; endAt: Date }[] {
  const result: { date: string; startAt: Date; endAt: Date }[] = [];
  let start = startAt.getTime(),
    end = endAt.getTime();
  while (start < end) {
    const date = isoDay(new Date(start), timeZone);
    if (isoDay(new Date(end - 1), timeZone) === date) {
      result.push({ date, startAt: new Date(start), endAt: new Date(end) });
      break;
    }
    let low = start,
      high = Math.min(end, start + 26 * 3600000);
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (isoDay(new Date(middle), timeZone) === date) low = middle;
      else high = middle;
    }
    result.push({ date, startAt: new Date(start), endAt: new Date(high) });
    start = high;
  }
  return result;
}
export function recallBins(logs: { beforeState: unknown; reviewedAt: Date; rating: string }[]) {
  const bins = [
    { label: '0–1天', min: 0, max: 1 },
    { label: '1–3天', min: 1, max: 3 },
    { label: '3–7天', min: 3, max: 7 },
    { label: '7–14天', min: 7, max: 14 },
    { label: '14–30天', min: 14, max: 30 },
    { label: '30天以上', min: 30, max: Infinity },
  ];
  return bins.map((bin) => {
    const included = logs.filter((log) => {
      const previous = obj(log.beforeState).last_review;
      if (!previous) return false;
      const gap = (log.reviewedAt.getTime() - new Date(String(previous)).getTime()) / 86400000;
      return Number.isFinite(gap) && gap >= bin.min && gap < bin.max;
    });
    return {
      label: bin.label,
      count: included.length,
      againRate: included.length
        ? included.filter((log) => log.rating === 'again').length / included.length
        : null,
    };
  });
}
export async function registerAnalytics(app: FastifyInstance, getContext: ContextResolver) {
  app.post('/activity', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    const input = parse(
      z
        .object({
          eventId: z.string().min(8).max(120),
          startAt: z.string().datetime(),
          endAt: z.string().datetime(),
        })
        .strict(),
      req.body,
    );
    const startAt = new Date(input.startAt),
      endAt = new Date(input.endAt);
    const duration = endAt.getTime() - startAt.getTime();
    if (!Number.isFinite(duration)) throw new HttpError(400, 'invalid_activity_interval');
    return transact(ctx.prisma, async (tx) => {
      const previous = await tx.activityInterval.findUnique({
        where: { userId_eventId: { userId: user.id, eventId: input.eventId } },
      });
      if (previous) {
        if (
          previous.startAt.getTime() !== startAt.getTime() ||
          previous.endAt.getTime() !== endAt.getTime()
        )
          throw new HttpError(409, 'idempotency_conflict');
        return { accepted: true, duplicate: true };
      }
      const now = Date.now();
      if (
        duration <= 0 ||
        duration > 60000 ||
        startAt.getTime() < now - 120000 ||
        endAt.getTime() > now + 3000
      )
        throw new HttpError(400, 'invalid_activity_interval', '仅接受最近的1–60秒前台活动心跳');
      await tx.activityInterval.create({
        data: {
          userId: user.id,
          eventId: input.eventId,
          startAt,
          endAt,
          validatedSeconds: Math.floor(duration / 1000),
        },
      });
      return { accepted: true, duplicate: false };
    });
  });
  app.get('/stats', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    const prefs = await ctx.prisma.userSettings.findUnique({ where: { userId: user.id } }),
      timeZone = prefs?.timeZone ?? 'Asia/Shanghai';
    const [logs, intervals, totalLearned, totalReviews, totalRatings, claims] = await Promise.all([
      ctx.prisma.reviewLog.findMany({
        where: { userId: user.id },
        orderBy: { reviewedAt: 'desc' },
        take: 20000,
      }),
      ctx.prisma.activityInterval.findMany({
        where: { userId: user.id },
        orderBy: { startAt: 'desc' },
        take: 20000,
      }),
      ctx.prisma.studyProgress.count({ where: { userId: user.id, firstLearnedAt: { not: null } } }),
      ctx.prisma.reviewLog.count({ where: { userId: user.id, wasNew: false } }),
      ctx.prisma.reviewLog.count({ where: { userId: user.id } }),
      ctx.prisma.knownClaim.findMany({
        where: { userId: user.id, import: { status: 'confirmed' } },
        select: { wordId: true },
      }),
    ]);
    const buckets = new Map<
      string,
      {
        date: string;
        newWords: number;
        reviews: number;
        seconds: number;
        minutes: number;
        checkedIn: boolean;
      }
    >();
    const newSets = new Map<string, Set<string>>(),
      segments = new Map<string, { startAt: Date; endAt: Date }[]>();
    const getDay = (date: string) => {
      if (!buckets.has(date))
        buckets.set(date, {
          date,
          newWords: 0,
          reviews: 0,
          seconds: 0,
          minutes: 0,
          checkedIn: false,
        });
      return buckets.get(date)!;
    };
    for (const log of logs) {
      const day = isoDay(log.reviewedAt, timeZone);
      if (!log.wasNew) getDay(day).reviews++;
      if (log.wasNew) {
        if (!newSets.has(day)) newSets.set(day, new Set());
        newSets.get(day)!.add(log.wordId);
      }
    }
    for (const interval of intervals)
      for (const segment of splitInterval(interval.startAt, interval.endAt, timeZone)) {
        if (!segments.has(segment.date)) segments.set(segment.date, []);
        segments.get(segment.date)!.push(segment);
      }
    for (const [day, list] of segments) {
      const row = getDay(day);
      row.seconds = mergedSeconds(list);
      row.minutes = Math.floor(row.seconds / 60);
      row.checkedIn = row.seconds >= 300;
    }
    for (const [day, words] of newSets) getDay(day).newWords = words.size;
    const today = isoDay(new Date(), timeZone),
      trends = [];
    for (let n = 29; n >= 0; n--) {
      const anchor = new Date(`${today}T12:00:00Z`);
      anchor.setUTCDate(anchor.getUTCDate() - n);
      trends.push(getDay(anchor.toISOString().slice(0, 10)));
    }
    let streak = 0;
    for (let n = 0; ; n++) {
      const anchor = new Date(`${today}T12:00:00Z`);
      anchor.setUTCDate(anchor.getUTCDate() - n);
      if (!buckets.get(anchor.toISOString().slice(0, 10))?.checkedIn) break;
      streak++;
    }
    return {
      today: getDay(today),
      totalLearned,
      totalReviews,
      totalRatings,
      knownClaimCount: new Set(claims.map((c) => c.wordId)).size,
      activeDays: [...buckets.values()].filter((x) => x.checkedIn).length,
      streak,
      trends,
      dataLimited: logs.length === 20000 || intervals.length === 20000,
    };
  });
  app.get('/memory/curve', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      query = parse(z.object({ bookId: id.optional(), goal: goal.optional() }), req.query);
    if (query.bookId && !(await ctx.prisma.book.findUnique({ where: { id: query.bookId } })))
      throw new HttpError(404, 'book_not_found');
    const where = {
      userId: user.id,
      firstLearnedAt: { not: null },
      ...(query.bookId
        ? { word: { bookItems: { some: { bookId: query.bookId } } } }
        : query.goal
          ? { word: { goalTags: { has: query.goal } } }
          : {}),
    };
    const [progress, total, logs] = await Promise.all([
      ctx.prisma.studyProgress.findMany({ where, take: 2000, orderBy: { wordId: 'asc' } }),
      ctx.prisma.studyProgress.count({ where }),
      ctx.prisma.reviewLog.findMany({
        where: {
          userId: user.id,
          ...(query.bookId
            ? { word: { bookItems: { some: { bookId: query.bookId } } } }
            : query.goal
              ? { word: { goalTags: { has: query.goal } } }
              : {}),
        },
        orderBy: { reviewedAt: 'desc' },
        take: 500,
      }),
    ]);
    const asOf = new Date();
    const eligible = progress.filter(
      (p) =>
        p.lastReviewAt &&
        Number(obj(p.fsrsJson).stability) > 0 &&
        p.algorithmVersion === 'ts-fsrs-5.4.2',
    );
    const points = [0, 1, 3, 7, 14, 30, 60].flatMap((day) => {
      const at = new Date(asOf.getTime() + day * 86400000);
      const predictions = eligible
        .map((p) => Number(scheduler.get_retrievability(hydrateCard(p.fsrsJson), at, false)))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 1);
      return predictions.length
        ? [
            {
              day,
              retention: predictions.reduce((sum, n) => sum + n, 0) / predictions.length,
              lower: quantile(predictions, 0.25),
              upper: quantile(predictions, 0.75),
            },
          ]
        : [];
    });
    return {
      empty: points.length === 0,
      asOf: asOf.toISOString(),
      scope: query,
      coverage: { total, eligible: eligible.length },
      points,
      observations: logs.map((log) => ({
        reviewedAt: log.reviewedAt.toISOString(),
        rating: log.rating,
        expectedRetrievability: log.retrievabilityBefore,
        remembered: log.rating !== 'again',
      })),
      recallBins: recallBins(logs),
      algorithmVersion: 'ts-fsrs-5.4.2',
      paramVersion: 'retention-0.9-v1',
      assumption: 'no_future_reviews',
      dataLimited: total > 2000,
      disclaimer:
        '基于当前真实复习状态，假设未来不再复习。阴影为词间预测分布，非科学保证或准确率置信区间；反馈点来自个人自评。熟词声明不生成记忆曲线。',
    };
  });
}
