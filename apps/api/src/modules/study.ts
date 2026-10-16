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
  selectWordLearningSense,
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
import { visibleBookWhere } from './book-access.js';
import { findEligibleBookItems, findEligibleProgress } from './learning-eligibility.js';
import { applyCurrentPronunciationPolicy, supplementIssuedWord } from './content-presentation.js';
import { wordPronunciationCompatible } from './learning-sense-view.js';
import { applyFamiliarityPolicy, collectionState } from './collection-state.js';
import {
  ensureDailyPlan,
  planView,
  lockLearningPreferences,
  eligibleWord,
  recordPlanRating,
  clearSessionAssignment,
  registerTaskRoutes,
} from './tasks.js';

export const sessionInclude = {
  items: { orderBy: { ordinal: 'asc' as const } },
  plan: { include: { words: true } },
  book: { select: { title: true } },
};
type FullSession = Prisma.StudySessionGetPayload<{ include: typeof sessionInclude }>;

// An issued group keeps its original exercise policy even when preferences change.
export function sessionSpellingEnabled(session: Pick<FullSession, 'items'>) {
  return session.items.some((item) => obj(item.questionJson).spellingEnabled !== false);
}

export function spellingQuestion(word: ReturnType<typeof wordDto>, focusSenseId?: string | null) {
  const sense =
    word.senses.find((x) => x.id === focusSenseId && x.definitionZh.trim()) ??
    word.senses.find((x) => x.definitionZh.trim()) ??
    word.senses[0];
  return {
    type: 'spelling',
    prompt: `请拼写对应单词：${sense?.definitionZh ?? ''}`,
    answer: word.lemma,
    explanation: sense?.definitionZh ?? '',
  };
}
export function sessionDto(
  session: FullSession,
  progress: StudyProgress[] = [],
  deferredUntil: Date | null = null,
  currentWords: ReadonlyMap<string, ReturnType<typeof wordDto>> = new Map(),
  pronunciationPolicies: ReadonlyMap<string, boolean> = new Map(),
) {
  const items = session.items.map((item) => {
    const snapshot = applyCurrentPronunciationPolicy(
        obj(item.contentSnapshot),
        pronunciationPolicies.get(item.wordId) ??
          currentWords.get(item.wordId)?.pronunciationCompatible,
      ),
      question = obj(item.questionJson);
    const latest = progress.find((x) => x.wordId === item.wordId);
    const visible = item.revealed || session.phase === 'practice' || session.status === 'completed';
    const currentWord = visible ? currentWords.get(item.wordId) : undefined;
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
      bucket:
        question.taskBucket === 'new' || question.taskBucket === 'review'
          ? question.taskBucket
          : (session.plan?.words.find((word) => word.wordId === item.wordId)?.bucket ?? null),
      word: visible
        ? currentWord
          ? supplementIssuedWord(snapshot, currentWord, item.wordId)
          : snapshot
        : {
            id: item.wordId,
            lemma: snapshot.lemma,
            phonetic: snapshot.phonetic,
            phoneticUs: snapshot.phoneticUs,
            phoneticUk: snapshot.phoneticUk,
            phoneticSource: snapshot.phoneticSource,
            pronunciationCompatible: snapshot.pronunciationCompatible,
          },
      ...(session.phase === 'practice'
        ? { question: { id: `spelling-${item.id}`, type: 'spelling', prompt: question.prompt } }
        : {}),
    };
  });
  return {
    id: session.id,
    bookId: session.bookId,
    bookTitle: session.bookId ? (session.book?.title ?? null) : null,
    planId: session.planId ?? null,
    taskKind: session.taskKind ?? 'legacy',
    pausedAt: session.pausedAt?.toISOString() ?? null,
    createdAt: session.createdAt?.toISOString() ?? null,
    updatedAt: session.updatedAt?.toISOString() ?? null,
    completedAt: session.status === 'completed' ? (session.updatedAt?.toISOString() ?? null) : null,
    learningDate: session.plan?.localDate ?? null,
    timeZone: session.plan?.timeZone ?? null,
    deferredUntil: session.deferredUntil?.toISOString() ?? deferredUntil?.toISOString() ?? null,
    mode: session.mode,
    status: session.status,
    phase: session.phase,
    spellingEnabled: sessionSpellingEnabled(session),
    cursor: session.cursor,
    step: session.step,
    revision: session.revision,
    currentItemId: ['in_progress', 'paused'].includes(session.status)
      ? (items[session.cursor]?.id ?? null)
      : null,
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
  const visibleIds = session.items
    .filter(
      (item) => item.revealed || session.phase === 'practice' || session.status === 'completed',
    )
    .map((item) => item.wordId);
  const hiddenIds = session.items
    .filter((item) => !visibleIds.includes(item.wordId))
    .map((item) => item.wordId);
  const [progress, deferred, currentWords, hiddenPolicies] = await Promise.all([
    db.studyProgress.findMany({
      where: { userId, wordId: { in: session.items.map((x) => x.wordId) } },
    }),
    db.dailyPlanWord.findFirst({
      where: { activeSessionId: session.id, deferredUntil: { not: null }, plan: { userId } },
      orderBy: { deferredUntil: 'desc' },
      select: { deferredUntil: true },
    }),
    visibleIds.length
      ? db.word.findMany({
          where: { id: { in: visibleIds }, status: 'published' },
          include: wordInclude,
        })
      : Promise.resolve([]),
    hiddenIds.length
      ? db.learningSense.findMany({
          where: { wordId: { in: hiddenIds }, status: { in: ['published', 'held'] } },
          select: { wordId: true, status: true, contentMetadata: true },
        })
      : Promise.resolve([]),
  ]);
  return sessionDto(
    session,
    progress,
    deferred?.deferredUntil ?? null,
    new Map(currentWords.map((word) => [word.id, wordDto(word)])),
    new Map(
      hiddenPolicies
        .filter((sense) => !wordPronunciationCompatible({ learningSenses: [sense] }))
        .map((sense) => [sense.wordId, false]),
    ),
  );
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
export async function dailyPlan(db: import('@prisma/client').PrismaClient, userId: string) {
  return transact(db, async (tx) => planView(tx, userId, await ensureDailyPlan(tx, userId)));
}
export async function registerStudy(app: FastifyInstance, getContext: ContextResolver) {
  app.get('/study/plan', async (req) => {
    const ctx = await getContext(req);
    const user = requireUser(ctx);
    return {
      plan: await dailyPlan(ctx.prisma, user.id),
      settings: await settings(ctx.prisma, user.id),
    };
  });
  app.get('/study/sessions', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    return transact(ctx.prisma, async (tx) => {
      await ensureDailyPlan(tx, user.id);
      const sessions = await tx.studySession.findMany({
        where: { userId: user.id, status: { in: ['in_progress', 'paused'] } },
        include: sessionInclude,
        orderBy: { updatedAt: 'desc' },
        take: 10,
      });
      return { items: await Promise.all(sessions.map((x) => sessionView(tx, user.id, x))) };
    });
  });
  app.post('/study/sessions', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    const input = parse(
      z
        .object({
          mode: z.enum(['daily', 'extra-review', 'learn', 'review']).default('daily'),
          taskKind: z.enum(['daily', 'extra-review']).optional(),
          bookId: id.optional(),
          size: z.number().int().min(1).max(20).optional(),
          commandId: commandId.optional(),
          expectedPlanRevision: z.number().int().nonnegative().optional(),
        })
        .strict(),
      req.body ?? {},
    );
    const hash = digest({ action: 'create-study-task', ...input });
    return transact(ctx.prisma, async (tx) => {
      const prefs = await lockLearningPreferences(tx, user.id);
      let plan = await ensureDailyPlan(tx, user.id);
      if (input.commandId) {
        const receipt = await getReceipt(tx, user.id, input.commandId, hash);
        if (receipt) {
          const old = obj(receipt.responseJson),
            oldSession = obj(old.session);
          const session =
            typeof oldSession.id === 'string'
              ? await sessionView(tx, user.id, await readSession(tx, user.id, oldSession.id))
              : null;
          return { ...old, session, plan: await planView(tx, user.id, plan), duplicate: true };
        }
      }
      if (
        input.bookId &&
        !(await tx.book.findFirst({ where: { id: input.bookId, ...visibleBookWhere(user.id) } }))
      )
        throw new HttpError(404, 'book_not_found');
      if (input.bookId !== undefined && input.bookId !== plan.sourceBookId)
        throw new HttpError(409, 'book_selection_changed', '词书已切换，请刷新学习计划', {
          plan: await planView(tx, user.id, plan),
        });
      if (input.expectedPlanRevision !== undefined && input.expectedPlanRevision !== plan.revision)
        throw new HttpError(409, 'plan_conflict', '每日任务已在另一设备更新', {
          plan: await planView(tx, user.id, plan),
        });
      const extra = input.mode === 'extra-review' || input.taskKind === 'extra-review';
      const existing = await tx.studySession.findFirst({
        where: {
          userId: user.id,
          status: 'in_progress',
          taskKind: extra ? 'extra-review' : { not: 'extra-review' },
        },
        include: sessionInclude,
        orderBy: { createdAt: 'asc' },
      });
      if (existing) {
        if (
          !extra &&
          input.mode === 'review' &&
          existing.items.some(
            (item) =>
              existing.plan?.words.find((word) => word.wordId === item.wordId)?.bucket === 'new',
          )
        )
          throw new HttpError(409, 'another_task_active', '当前新学任务需要先暂停或完成', {
            sessionId: existing.id,
          });
        const response = {
          session: await sessionView(tx, user.id, existing),
          plan: await planView(tx, user.id, plan),
          duplicate: true,
        };
        if (input.commandId)
          await tx.commandReceipt.create({
            data: {
              userId: user.id,
              commandId: input.commandId,
              requestHash: hash,
              responseJson: json(response),
            },
          });
        return response;
      }
      if (
        (await tx.studySession.count({
          where: { userId: user.id, status: { in: ['in_progress', 'paused'] } },
        })) >= 20
      )
        throw new HttpError(409, 'too_many_active_tasks');
      const now = new Date(),
        size = input.size ?? prefs.groupSize;
      const held = await tx.sessionItem.findMany({
        where: {
          session: { userId: user.id, status: { in: ['in_progress', 'paused'] } },
          rated: false,
          exerciseDone: false,
        },
        select: { wordId: true },
      });
      const blocked = [...new Set(held.map((item) => item.wordId))];
      const planned = await tx.dailyPlanWord.findMany({
        where: { planId: plan.id },
        orderBy: { ordinal: 'asc' },
      });
      const chosen: Array<{
        word: Prisma.WordGetPayload<{ include: typeof wordInclude }>;
        bucket: 'new' | 'review';
        focusSenseId: string | null;
      }> = [];
      const append = (
        word: Prisma.WordGetPayload<{ include: typeof wordInclude }>,
        bucket: 'new' | 'review',
        focusSenseId: string | null = null,
      ) => {
        const focus = selectWordLearningSense(word, focusSenseId);
        if (focus && chosen.length < size && !chosen.some((item) => item.word.id === word.id))
          chosen.push({
            word,
            bucket,
            focusSenseId: focus.id,
          });
      };
      const appendCandidates = async (
        candidates: Array<{ wordId: string; focusSenseId?: string | null }>,
        bucket: 'new' | 'review',
      ) => {
        if (!candidates.length) return;
        const words = await tx.word.findMany({
          where: { id: { in: candidates.map((entry) => entry.wordId) } },
          include: wordInclude,
        });
        const byId = new Map(words.map((word) => [word.id, word]));
        for (const candidate of candidates) {
          const word = byId.get(candidate.wordId);
          if (word) append(word, bucket, candidate.focusSenseId);
        }
      };
      if (extra) {
        const due = await findEligibleProgress(
          tx,
          {
            userId: user.id,
            firstLearnedAt: { not: null },
            dueAt: { lte: now },
            wordId: { notIn: blocked },
            word: eligibleWord(user.id),
          },
          [{ dueAt: 'asc' }, { wordId: 'asc' }],
          size,
        );
        await appendCandidates(due, 'review');
      } else {
        // Same-day short-term repetitions are real ratings but reuse their single budget word.
        const repeats = await findEligibleProgress(
          tx,
          {
            userId: user.id,
            dueAt: { lte: now },
            wordId: {
              in: planned
                .filter((word) => word.firstRatedAt && !word.activeSessionId)
                .map((word) => word.wordId),
              notIn: blocked,
            },
            word: eligibleWord(user.id),
          },
          [{ dueAt: 'asc' }, { wordId: 'asc' }],
          size,
        );
        await appendCandidates(repeats, 'review');
        const due = await tx.dailyPlanWord.findMany({
          where: {
            planId: plan.id,
            bucket: 'review',
            firstRatedAt: null,
            status: 'queued',
            activeSessionId: null,
            wordId: { notIn: blocked },
            word: {
              ...eligibleWord(user.id),
              progress: { some: { userId: user.id, dueAt: { lte: now } } },
            },
          },
          include: { word: { include: wordInclude } },
          orderBy: { ordinal: 'asc' },
          take: size - chosen.length,
        });
        for (const entry of due) append(entry.word, 'review');
        const free = Math.min(size - chosen.length, Math.max(0, plan.targetTotal - planned.length));
        const bookId = input.bookId ?? plan.sourceBookId;
        if (free && bookId && input.mode !== 'review') {
          const profile = await tx.masteryProfile.findUnique({
            where: { userId_goal: { userId: user.id, goal: plan.goal } },
          });
          const familiar = obj(profile?.evidenceJson).verifiedWordIds;
          const ids = Array.isArray(familiar) ? familiar.map(String) : [];
          const base: Prisma.BookItemWhereInput = {
            bookId,
            wordId: { notIn: [...new Set([...planned.map((word) => word.wordId), ...blocked])] },
            word: {
              ...eligibleWord(user.id),
              progress: { none: { userId: user.id, firstLearnedAt: { not: null } } },
            },
          };
          const normal = await findEligibleBookItems(
            tx,
            {
              AND: [
                base,
                {
                  word: {
                    id: { notIn: ids },
                    claims: { none: { userId: user.id, import: { status: 'confirmed' } } },
                    autoKnownWords: { none: { userId: user.id, revokedAt: null } },
                  },
                },
              ],
            },
            { ordinal: 'asc' },
            free,
          );
          const newCount = planned.filter((word) => word.bucket === 'new').length;
          const probeSize = normal.length
            ? Math.floor((newCount + free) / 5) - Math.floor(newCount / 5)
            : 1;
          const known = probeSize
            ? await findEligibleBookItems(
                tx,
                {
                  AND: [
                    base,
                    {
                      word: {
                        OR: [
                          { id: { in: ids } },
                          {
                            claims: { some: { userId: user.id, import: { status: 'confirmed' } } },
                          },
                          { autoKnownWords: { some: { userId: user.id, revokedAt: null } } },
                        ],
                      },
                    },
                  ],
                },
                { ordinal: 'asc' },
                Math.min(free, probeSize),
              )
            : [];
          await appendCandidates(normal.slice(0, free - known.length), 'new');
          await appendCandidates(known, 'new');
        }
      }
      if (!chosen.length) {
        const summary = await planView(tx, user.id, plan, now);
        const response = {
          session: null,
          plan: summary,
          reason:
            extra || input.mode === 'review'
              ? 'nothing_due'
              : summary.nextDueAt && summary.reviewRemaining
                ? 'planned_reviews_pending'
                : planned.length >= plan.targetTotal
                  ? 'daily_goal_complete'
                  : 'no_new_words',
          duplicate: false,
        };
        if (input.commandId)
          await tx.commandReceipt.create({
            data: {
              userId: user.id,
              commandId: input.commandId,
              requestHash: hash,
              responseJson: json(response),
            },
          });
        return response;
      }
      const progress = await tx.studyProgress.findMany({
        where: { userId: user.id, wordId: { in: chosen.map((item) => item.word.id) } },
      });
      const learningPreference = await tx.userLearningPreference.findUnique({
        where: { userId: user.id },
        select: { spellingEnabled: true },
      });
      const session = await tx.studySession.create({
        data: {
          userId: user.id,
          planId: plan.id,
          taskKind: extra ? 'extra-review' : 'daily',
          mode: extra ? 'extra-review' : input.mode === 'review' ? 'review' : 'daily',
          bookId: chosen.some((item) => item.bucket === 'new')
            ? (input.bookId ?? plan.sourceBookId)
            : null,
          items: {
            create: chosen.map((item, ordinal) => {
              const snapshot = wordDto(item.word);
              return {
                wordId: item.word.id,
                focusSenseId: item.focusSenseId,
                ordinal,
                contentSnapshot: json(snapshot),
                questionJson: json({
                  ...spellingQuestion(snapshot, item.focusSenseId),
                  taskBucket: item.bucket,
                  spellingEnabled: learningPreference?.spellingEnabled ?? true,
                }),
                progressRevision: progress.find((p) => p.wordId === item.word.id)?.revision ?? 0,
              };
            }),
          },
        },
        include: sessionInclude,
      });
      let ordinal = Math.max(-1, ...planned.map((word) => word.ordinal)) + 1;
      for (const item of chosen)
        await tx.dailyPlanWord.upsert({
          where: { planId_wordId: { planId: plan.id, wordId: item.word.id } },
          create: {
            planId: plan.id,
            wordId: item.word.id,
            bucket: item.bucket,
            status: 'assigned',
            activeSessionId: session.id,
            ordinal: ordinal++,
          },
          update: { activeSessionId: session.id, status: 'assigned', deferredUntil: null },
        });
      plan = await tx.dailyPlan.update({
        where: { id: plan.id },
        data: { revision: { increment: 1 } },
      });
      const response = {
        session: await sessionView(tx, user.id, await readSession(tx, user.id, session.id)),
        plan: await planView(tx, user.id, plan, now),
        duplicate: false,
      };
      if (input.commandId)
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
  app.get('/study/sessions/:id', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    return transact(ctx.prisma, async (tx) => {
      await ensureDailyPlan(tx, user.id);
      return {
        session: await sessionView(tx, user.id, await readSession(tx, user.id, params.id)),
      };
    });
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
    const outcome = await transact(ctx.prisma, async (tx) => {
      await lockLearningPreferences(tx, user.id);
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
          plan: await planView(tx, user.id, await ensureDailyPlan(tx, user.id)),
          ...(latest ? { progress: progressDto(latest) } : {}),
          ...(item
            ? {
                collection: {
                  ...(await collectionState(tx, user.id, item.wordId)),
                  transition: null,
                },
              }
            : {}),
          duplicate: true,
        };
      }
      if (session.status === 'cancelled')
        return new HttpError(409, 'task_cancelled', '词书已切换，该任务已结束', {
          session: await sessionView(tx, user.id, session),
        });
      if (session.revision !== input.expectedSessionRevision)
        throw new HttpError(409, 'session_conflict', '学习任务已更新，请确认当前任务', {
          session: await sessionView(tx, user.id, session),
        });
      const item = session.items[session.cursor];
      if (session.status === 'paused')
        throw new HttpError(409, 'task_paused', '请继续该固定任务后再提交');
      if (session.status !== 'in_progress' || !item || item.id !== input.itemId)
        throw new HttpError(409, 'item_not_current', '只能操作当前固定任务项', {
          session: await sessionView(tx, user.id, session),
        });
      let nextProgress: StudyProgress | null = null;
      let collection: Awaited<ReturnType<typeof applyFamiliarityPolicy>> | undefined;
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
        const ratingPlan = await recordPlanRating(
          tx,
          user.id,
          item.wordId,
          wasNew,
          now,
          session.id,
        );
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
            planId: ratingPlan.id,
          },
        });
        collection = await applyFamiliarityPolicy(
          tx,
          user.id,
          item.wordId,
          input.rating,
          outcome.card,
          now,
        );
        await tx.sessionItem.update({
          where: { id: item.id },
          data: { rated: true, status: 'rated', progressRevision: nextProgress.revision },
        });
        const last = session.cursor + 1 === session.items.length;
        const completedWithoutSpelling = last && !sessionSpellingEnabled(session);
        await tx.studySession.update({
          where: { id: session.id },
          data: {
            cursor: completedWithoutSpelling ? session.items.length : last ? 0 : session.cursor + 1,
            phase: completedWithoutSpelling ? 'completed' : last ? 'practice' : 'recall',
            step: completedWithoutSpelling ? 'completed' : last ? 'exercise' : 'prompt',
            ...(completedWithoutSpelling ? { status: 'completed' } : {}),
            revision: { increment: 1 },
          },
        });
        if (completedWithoutSpelling) await clearSessionAssignment(tx, session.id);
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
        if (last) await clearSessionAssignment(tx, session.id);
      }
      session = await readSession(tx, user.id, session.id);
      const response = {
        session: await sessionView(tx, user.id, session),
        plan: await planView(tx, user.id, await ensureDailyPlan(tx, user.id)),
        ...(nextProgress ? { progress: progressDto(nextProgress) } : {}),
        ...(collection ? { collection } : {}),
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
    // Only this terminal rejection commits the settings-lock consistency repair.
    if (outcome instanceof HttpError) throw outcome;
    return outcome;
  });
  await registerTaskRoutes(app, getContext, async (db, userId, sessionId) =>
    sessionView(db, userId, await readSession(db, userId, sessionId)),
  );
}
