import type { FastifyInstance } from 'fastify';
import { Prisma, type StudyProgress } from '@prisma/client';
import { z } from 'zod';
import { HttpError, requireUser, type ContextResolver } from '../context.js';
import {
  parse,
  id,
  commandId,
  settings,
  wordInclude,
  wordDto,
  progressDto,
  json,
  obj,
  digest,
  freshCard,
  hydrateCard,
  scheduler,
  ratingValues,
  transact,
  getReceipt,
  normalize,
  isoDay,
  type Db,
} from './shared.js';

export const sessionInclude = { items: { orderBy: { ordinal: 'asc' as const } } };
type FullSession = Prisma.StudySessionGetPayload<{ include: typeof sessionInclude }>;

export function spellingQuestion(word: ReturnType<typeof wordDto>, focusSenseId?: string | null) {
  const sense = word.senses.find((x) => x.id === focusSenseId) ?? word.senses[0];
  return {
    type: 'spelling',
    prompt: `请拼写对应单词：${sense?.definitionZh ?? ''}`,
    answer: word.lemma,
    explanation: sense?.definitionZh ?? '',
  };
}
export function sessionDto(session: FullSession, progress: StudyProgress[] = []) {
  const items = session.items.map((item) => {
    const snapshot = obj(item.contentSnapshot),
      question = obj(item.questionJson);
    const latest = progress.find((x) => x.wordId === item.wordId);
    const visible = item.revealed || session.phase === 'practice' || session.status === 'completed';
    return {
      id: item.id,
      wordId: item.wordId,
      focusSenseId: item.focusSenseId,
      ordinal: item.ordinal,
      revealed: item.revealed,
      rated: item.rated,
      exerciseDone: item.exerciseDone,
      status: item.status,
      progressRevision: latest?.revision ?? item.progressRevision,
      word: visible
        ? snapshot
        : { id: item.wordId, lemma: snapshot.lemma, phonetic: snapshot.phonetic },
      ...(session.phase === 'practice'
        ? { question: { id: `spelling-${item.id}`, type: 'spelling', prompt: question.prompt } }
        : {}),
    };
  });
  return {
    id: session.id,
    bookId: session.bookId,
    mode: session.mode,
    status: session.status,
    phase: session.phase,
    cursor: session.cursor,
    step: session.step,
    revision: session.revision,
    currentItemId: session.status === 'completed' ? null : (items[session.cursor]?.id ?? null),
    items,
  };
}
async function readSession(db: Db, userId: string, sessionId: string) {
  const session = await db.studySession.findFirst({
    where: { id: sessionId, userId },
    include: sessionInclude,
  });
  if (!session) throw new HttpError(404, 'session_not_found');
  return session;
}
async function sessionView(db: Db, userId: string, session: FullSession) {
  const progress = await db.studyProgress.findMany({
    where: { userId, wordId: { in: session.items.map((x) => x.wordId) } },
  });
  return sessionDto(session, progress);
}
type PendingReservation = {
  bookId: string | null;
  createdAt: Date;
  items: { wordId: string; rated: boolean }[];
};
export function reservedWordIds(
  learned: Set<string>,
  sessions: PendingReservation[],
  now: Date,
  timeZone: string,
) {
  const today = isoDay(now, timeZone);
  return new Set(
    sessions
      .filter((session) => isoDay(session.createdAt, timeZone) === today)
      .flatMap((session) => session.items)
      .filter((item) => !item.rated && !learned.has(item.wordId))
      .map((item) => item.wordId),
  );
}
export function admitReservedCandidates<T extends { wordId: string }>(
  candidates: T[],
  size: number,
  reserved: Set<string>,
  newSlots: number,
) {
  const chosen: T[] = [],
    seen = new Set<string>();
  let remaining = Math.max(0, newSlots);
  for (const candidate of candidates) {
    if (chosen.length >= size) break;
    if (seen.has(candidate.wordId)) continue;
    const costsSlot = !reserved.has(candidate.wordId);
    if (costsSlot && remaining === 0) continue;
    chosen.push(candidate);
    seen.add(candidate.wordId);
    if (costsSlot) remaining--;
  }
  return chosen;
}
async function dailyAdmission(db: Db, userId: string, timeZone: string, limit: number) {
  const now = new Date(),
    today = isoDay(now, timeZone);
  const since = new Date(now.getTime() - 48 * 3600000);
  const [logs, progress, pending] = await Promise.all([
    db.reviewLog.findMany({
      where: { userId, wasNew: true, reviewedAt: { gte: since } },
      select: { reviewedAt: true, wordId: true },
    }),
    db.studyProgress.findMany({
      where: { userId, firstLearnedAt: { not: null } },
      select: { wordId: true },
    }),
    db.studySession.findMany({
      where: { userId, mode: 'learn', status: 'in_progress', createdAt: { gte: since } },
      select: { bookId: true, createdAt: true, items: { select: { wordId: true, rated: true } } },
    }),
  ]);
  const learnedToday = new Set(
    logs.filter((log) => isoDay(log.reviewedAt, timeZone) === today).map((log) => log.wordId),
  ).size;
  const todaySessions = pending.filter((session) => isoDay(session.createdAt, timeZone) === today);
  const reserved = reservedWordIds(
    new Set(progress.map((p) => p.wordId)),
    todaySessions,
    now,
    timeZone,
  );
  return {
    learnedToday,
    reserved,
    pending: todaySessions,
    newRemaining: Math.max(0, limit - learnedToday - reserved.size),
    localDate: today,
  };
}
export async function dailyPlan(db: Db, userId: string) {
  const prefs = await settings(db, userId);
  const admission = await dailyAdmission(db, userId, prefs.timeZone, prefs.dailyNewLimit);
  const dueCount = await db.studyProgress.count({
    where: {
      userId,
      lastReviewAt: { not: null },
      dueAt: { lte: new Date() },
      word: { status: 'published', userWords: { none: { userId, paused: true } } },
    },
  });
  const claims = await db.knownClaim.findMany({
    where: { userId, import: { status: 'confirmed' } },
    select: { wordId: true },
  });
  const profile = await db.masteryProfile.findUnique({
    where: { userId_goal: { userId, goal: prefs.goal } },
  });
  const recommendation = obj(obj(profile?.evidenceJson).suggestedPlan);
  return {
    goal: prefs.goal,
    bookId: prefs.currentBookId,
    dailyNewLimit: prefs.dailyNewLimit,
    groupSize: prefs.groupSize,
    dueCount,
    newRemaining: admission.newRemaining,
    reservedNewCount: admission.reserved.size,
    knownCount: new Set(claims.map((x) => x.wordId)).size,
    learnedToday: admission.learnedToday,
    recommendedNew: Number(recommendation.dailyNewLimit ?? prefs.dailyNewLimit),
    localDate: admission.localDate,
  };
}
export async function registerStudy(app: FastifyInstance, getContext: ContextResolver) {
  app.get('/study/plan', async (req) => {
    const ctx = await getContext(req);
    return { plan: await dailyPlan(ctx.prisma, requireUser(ctx).id) };
  });
  app.get('/study/sessions', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    const sessions = await ctx.prisma.studySession.findMany({
      where: { userId: user.id, status: 'in_progress' },
      include: sessionInclude,
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });
    return { items: await Promise.all(sessions.map((x) => sessionView(ctx.prisma, user.id, x))) };
  });
  app.post('/study/sessions', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    const input = parse(
      z
        .object({
          mode: z.enum(['learn', 'review']).default('learn'),
          bookId: id.optional(),
          size: z.number().int().min(1).max(20).optional(),
        })
        .strict(),
      req.body ?? {},
    );
    return transact(ctx.prisma, async (tx) => {
      await settings(tx, user.id);
      await tx.$queryRaw`SELECT "userId" FROM "UserSettings" WHERE "userId"=${user.id} FOR UPDATE`;
      const prefs = await tx.userSettings.findUniqueOrThrow({ where: { userId: user.id } });
      const admission = await dailyAdmission(tx, user.id, prefs.timeZone, prefs.dailyNewLimit);
      const size = input.size ?? prefs.groupSize;
      const progress = await tx.studyProgress.findMany({ where: { userId: user.id } });
      const paused = new Set(
        (
          await tx.userWord.findMany({
            where: { userId: user.id, paused: true },
            select: { wordId: true },
          })
        ).map((x) => x.wordId),
      );
      let chosen: {
        word: Prisma.WordGetPayload<{ include: typeof wordInclude }>;
        focusSenseId: string | null;
      }[] = [];
      let selectedBookId: string | null = input.bookId ?? prefs.currentBookId;
      if (input.mode === 'review') {
        const due = await tx.studyProgress.findMany({
          where: {
            userId: user.id,
            lastReviewAt: { not: null },
            dueAt: { lte: new Date() },
            word: { status: 'published', userWords: { none: { userId: user.id, paused: true } } },
          },
          include: { word: { include: wordInclude } },
          orderBy: { dueAt: 'asc' },
          take: size,
        });
        chosen = due.map((p) => ({ word: p.word, focusSenseId: p.word.senses[0]?.id ?? null }));
        selectedBookId = null;
      } else {
        const book = await tx.book.findFirst({
          where: {
            ...(selectedBookId ? { id: selectedBookId } : { goal: prefs.goal }),
            status: 'published',
          },
          include: {
            items: {
              include: { word: { include: wordInclude } },
              orderBy: { ordinal: 'asc' },
              take: 1000,
            },
          },
          orderBy: { title: 'asc' },
        });
        if (!book) throw new HttpError(404, 'book_not_found');
        selectedBookId = book.id;
        const learned = new Set(progress.filter((p) => p.firstLearnedAt).map((p) => p.wordId));
        const claims = await tx.knownClaim.findMany({
          where: { userId: user.id, import: { status: 'confirmed' } },
          select: { wordId: true },
        });
        const profile = await tx.masteryProfile.findUnique({
          where: { userId_goal: { userId: user.id, goal: book.goal } },
        });
        const verified = obj(profile?.evidenceJson).verifiedWordIds;
        const familiar = new Set([
          ...claims.map((c) => c.wordId),
          ...(Array.isArray(verified) ? verified.map(String) : []),
        ]);
        const reservedInThisBook = new Set(
          admission.pending
            .filter((session) => session.bookId === book.id)
            .flatMap((session) => session.items)
            .filter((item) => admission.reserved.has(item.wordId))
            .map((item) => item.wordId),
        );
        const candidates = book.items.filter(
          (i) =>
            i.word.status === 'published' &&
            !learned.has(i.wordId) &&
            !paused.has(i.wordId) &&
            !reservedInThisBook.has(i.wordId),
        );
        const ordinary = candidates.filter((i) => !familiar.has(i.wordId));
        const known = candidates.filter((i) => familiar.has(i.wordId));
        const day = isoDay(new Date(), prefs.timeZone);
        known.sort((a, b) =>
          digest(`${day}:${a.wordId}`).localeCompare(digest(`${day}:${b.wordId}`)),
        );
        const normal = admitReservedCandidates(
          ordinary,
          size,
          admission.reserved,
          admission.newRemaining,
        );
        const remainingSlots =
          admission.newRemaining -
          normal.filter((item) => !admission.reserved.has(item.wordId)).length;
        const probe = admitReservedCandidates(
          known,
          Math.min(size - normal.length, Math.max(1, Math.floor(size * 0.2))),
          admission.reserved,
          remainingSlots,
        );
        chosen = [...normal, ...probe].map((i) => ({ word: i.word, focusSenseId: i.focusSenseId }));
      }
      if (!chosen.length)
        return {
          session: null,
          reason:
            input.mode === 'review'
              ? 'nothing_due'
              : admission.newRemaining === 0
                ? 'daily_goal_complete'
                : 'no_new_words',
        };
      const session = await tx.studySession.create({
        data: {
          userId: user.id,
          bookId: selectedBookId,
          mode: input.mode,
          items: {
            create: chosen.map((item, ordinal) => {
              const snapshot = wordDto(item.word);
              return {
                wordId: item.word.id,
                focusSenseId: item.focusSenseId,
                ordinal,
                contentSnapshot: json(snapshot),
                questionJson: json(spellingQuestion(snapshot, item.focusSenseId)),
                progressRevision: progress.find((p) => p.wordId === item.word.id)?.revision ?? 0,
              };
            }),
          },
        },
        include: sessionInclude,
      });
      return { session: await sessionView(tx, user.id, session) };
    });
  });
  app.get('/study/sessions/:id', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    return {
      session: await sessionView(
        ctx.prisma,
        user.id,
        await readSession(ctx.prisma, user.id, params.id),
      ),
    };
  });
  app.post('/study/sessions/:id/commands', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    const input = parse(
      z
        .object({
          commandId,
          itemId: id,
          action: z.enum(['reveal', 'rate', 'answer']),
          rating: z.enum(['again', 'hard', 'good', 'easy']).optional(),
          answer: z.string().max(160).optional(),
          expectedSessionRevision: z.number().int().nonnegative(),
          expectedProgressRevision: z.number().int().nonnegative().optional(),
        })
        .strict(),
      req.body,
    );
    const hash = digest({ sessionId: params.id, ...input });
    return transact(ctx.prisma, async (tx) => {
      const lock = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "StudySession" WHERE "id"=${params.id} AND "userId"=${user.id} FOR UPDATE`;
      if (!lock.length) throw new HttpError(404, 'session_not_found');
      let session = await readSession(tx, user.id, params.id);
      const previous = await getReceipt(tx, user.id, input.commandId, hash);
      if (previous) {
        const response = obj(previous.responseJson);
        const item = session.items.find((x) => x.id === input.itemId);
        const latest = item
          ? await tx.studyProgress.findUnique({
              where: { userId_wordId: { userId: user.id, wordId: item.wordId } },
            })
          : null;
        return {
          ...response,
          session: await sessionView(tx, user.id, session),
          ...(latest ? { progress: progressDto(latest) } : {}),
          duplicate: true,
        };
      }
      if (session.revision !== input.expectedSessionRevision)
        throw new HttpError(409, 'session_conflict', '学习任务已更新，请确认当前任务', {
          session: await sessionView(tx, user.id, session),
        });
      const item = session.items[session.cursor];
      if (session.status !== 'in_progress' || !item || item.id !== input.itemId)
        throw new HttpError(409, 'item_not_current', '只能操作当前固定任务项', {
          session: await sessionView(tx, user.id, session),
        });
      let nextProgress: StudyProgress | null = null;
      let result: Record<string, unknown> | undefined;
      if (input.action === 'reveal') {
        if (session.phase !== 'recall' || item.rated)
          throw new HttpError(409, 'invalid_study_phase');
        await tx.sessionItem.update({
          where: { id: item.id },
          data: { revealed: true, status: 'revealed' },
        });
        await tx.studySession.update({
          where: { id: session.id },
          data: { step: 'revealed', revision: { increment: 1 } },
        });
      } else if (input.action === 'rate') {
        if (session.phase !== 'recall' || !item.revealed || item.rated)
          throw new HttpError(409, 'reveal_before_rating');
        if (!input.rating || input.expectedProgressRevision === undefined)
          throw new HttpError(400, 'rating_revision_required');
        const now = new Date(),
          initial = freshCard(now);
        await tx.studyProgress.upsert({
          where: { userId_wordId: { userId: user.id, wordId: item.wordId } },
          create: { userId: user.id, wordId: item.wordId, fsrsJson: json(initial), dueAt: now },
          update: {},
        });
        await tx.$queryRaw`SELECT "id" FROM "StudyProgress" WHERE "userId"=${user.id} AND "wordId"=${item.wordId} FOR UPDATE`;
        const current = await tx.studyProgress.findUniqueOrThrow({
          where: { userId_wordId: { userId: user.id, wordId: item.wordId } },
        });
        if (current.revision !== input.expectedProgressRevision)
          throw new HttpError(409, 'progress_conflict', '该词已在另一任务更新，请确认最新进度', {
            progress: progressDto(current),
            session: await sessionView(tx, user.id, session),
          });
        const before = hydrateCard(current.fsrsJson),
          rating = ratingValues[input.rating];
        const beforeSnapshot = json(before);
        const retrievabilityBefore = current.lastReviewAt
          ? scheduler.get_retrievability(before, now, false)
          : null;
        const outcome = scheduler.next(before, now, rating);
        const wasNew = !current.firstLearnedAt;
        nextProgress = await tx.studyProgress.update({
          where: { id: current.id },
          data: {
            fsrsJson: json(outcome.card),
            dueAt: outcome.card.due,
            lastReviewAt: now,
            firstLearnedAt: current.firstLearnedAt ?? now,
            revision: { increment: 1 },
          },
        });
        await tx.reviewLog.create({
          data: {
            userId: user.id,
            wordId: item.wordId,
            commandId: input.commandId,
            rating: input.rating,
            reviewedAt: now,
            beforeState: beforeSnapshot,
            afterState: json(outcome.card),
            retrievabilityBefore,
            wasNew,
          },
        });
        await tx.sessionItem.update({
          where: { id: item.id },
          data: { rated: true, status: 'rated', progressRevision: nextProgress.revision },
        });
        const last = session.cursor + 1 === session.items.length;
        await tx.studySession.update({
          where: { id: session.id },
          data: {
            cursor: last ? 0 : session.cursor + 1,
            phase: last ? 'practice' : 'recall',
            step: last ? 'exercise' : 'prompt',
            revision: { increment: 1 },
          },
        });
      } else {
        if (
          session.phase !== 'practice' ||
          !item.rated ||
          item.exerciseDone ||
          input.answer === undefined
        )
          throw new HttpError(409, 'invalid_practice_phase');
        const question = obj(item.questionJson),
          correctAnswer = String(question.answer ?? '');
        const correct = normalize(input.answer) === normalize(correctAnswer);
        result = { correct, correctAnswer, explanation: String(question.explanation ?? '') };
        await tx.sessionItem.update({
          where: { id: item.id },
          data: {
            exerciseDone: true,
            status: 'completed',
            questionJson: json({ ...question, result }),
          },
        });
        const last = session.cursor + 1 === session.items.length;
        await tx.studySession.update({
          where: { id: session.id },
          data: {
            cursor: last ? session.items.length : session.cursor + 1,
            phase: last ? 'completed' : 'practice',
            status: last ? 'completed' : 'in_progress',
            step: last ? 'completed' : 'exercise',
            revision: { increment: 1 },
          },
        });
      }
      session = await readSession(tx, user.id, session.id);
      const response = {
        session: await sessionView(tx, user.id, session),
        ...(nextProgress ? { progress: progressDto(nextProgress) } : {}),
        ...(result ? { result } : {}),
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
}
