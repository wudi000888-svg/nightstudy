import { learningDayWindow, obj, type Db } from './shared.js';
import { evaluateFamiliarity, familiarityPolicyVersion } from './familiarity-policy.js';

export async function collectionState(db: Db, userId: string, wordId: string) {
  const [state] = await db.$queryRaw<
    { saved: boolean; consolidated: boolean; manual: boolean; automatic: boolean }[]
  >`
    SELECT
      EXISTS(SELECT 1 FROM "UserWord" WHERE "userId"=${userId} AND "wordId"=${wordId}
        AND "graduatedAt" IS NULL) AS saved,
      EXISTS(SELECT 1 FROM "UserWord" WHERE "userId"=${userId} AND "wordId"=${wordId}
        AND "graduatedAt" IS NOT NULL) AS consolidated,
      EXISTS(SELECT 1 FROM "KnownClaim" c JOIN "KnownImport" i ON i."id"=c."importId"
        WHERE c."userId"=${userId} AND c."wordId"=${wordId} AND i."status"='confirmed') AS manual,
      EXISTS(SELECT 1 FROM "AutoKnownWord" WHERE "userId"=${userId} AND "wordId"=${wordId}
        AND "revokedAt" IS NULL) AS automatic
  `;
  return {
    inWordbook: state!.saved,
    wordbookStatus: state!.saved
      ? ('active' as const)
      : state!.consolidated
        ? ('consolidated' as const)
        : null,
    known: state!.manual ? ('manual' as const) : state!.automatic ? ('automatic' as const) : null,
  };
}

/** Run after writing a real ReviewLog, inside its existing user-locked rating transaction. */
export async function applyFamiliarityPolicy(
  db: Db,
  userId: string,
  wordId: string,
  rating: string,
  card: unknown,
  now: Date,
) {
  let transition: 'graduated' | 'auto-known' | 'auto-known-withdrawn' | 'restored' | null = null;
  if (rating === 'again') {
    const revoked = await db.autoKnownWord.updateMany({
      where: { userId, wordId, revokedAt: null },
      data: { revokedAt: now },
    });
    const restored = await db.userWord.updateMany({
      where: { userId, wordId, graduatedAt: { not: null } },
      data: { graduatedAt: null },
    });
    if (revoked.count) {
      // A deleted manual membership is recreated only when an automatic known status was withdrawn.
      await db.userWord.createMany({ data: [{ userId, wordId }], skipDuplicates: true });
      transition = 'auto-known-withdrawn';
    } else if (restored.count) transition = 'restored';
  } else {
    const prefs = await db.userSettings.findUniqueOrThrow({
      where: { userId },
      select: { timeZone: true },
    });
    const logs = await db.reviewLog.findMany({
      where: { userId, wordId, rating: { in: ['again', 'good', 'easy'] } },
      select: {
        rating: true,
        reviewedAt: true,
        wasNew: true,
        afterState: true,
        plan: { select: { startsAt: true } },
      },
    });
    const evidence = logs.map((log) => {
      const reps = obj(log.afterState).reps;
      return {
        rating: log.rating,
        reviewedAt: log.reviewedAt,
        wasNew: log.wasNew,
        afterReps: typeof reps === 'number' && Number.isSafeInteger(reps) && reps > 0 ? reps : null,
        learningDayKey: (
          log.plan?.startsAt ?? learningDayWindow(log.reviewedAt, prefs.timeZone).startsAt
        ).toISOString(),
      };
    });
    const state = obj(card);
    const decision = evaluateFamiliarity(
      { state: state.state, stability: state.stability },
      evidence,
    );
    if (decision.graduate) {
      const graduated = await db.userWord.updateMany({
        where: { userId, wordId, graduatedAt: null },
        data: { graduatedAt: now },
      });
      if (graduated.count) transition = 'graduated';
    }
    if (decision.automaticKnown) {
      const manual = await db.knownClaim.findFirst({
        where: { userId, wordId, import: { status: 'confirmed' } },
        select: { id: true },
      });
      if (!manual) {
        const current = await db.autoKnownWord.findUnique({
          where: { userId_wordId: { userId, wordId } },
        });
        if (!current || current.revokedAt) {
          await db.autoKnownWord.upsert({
            where: { userId_wordId: { userId, wordId } },
            create: { userId, wordId, confirmedAt: now, policyVersion: familiarityPolicyVersion },
            update: { confirmedAt: now, revokedAt: null, policyVersion: familiarityPolicyVersion },
          });
          transition = 'auto-known';
        }
      }
    }
  }
  return { ...(await collectionState(db, userId, wordId)), transition };
}
