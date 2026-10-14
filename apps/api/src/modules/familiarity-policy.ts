export const familiarityPolicyVersion = 'fsrs-familiarity-v1';

export type FamiliarityEvidence = {
  rating: string;
  reviewedAt: Date;
  wasNew: boolean;
  afterReps: number | null;
  learningDayKey: string;
};

/** Only accepted ratings supply evidence. Practice and membership changes supply none. */
export function evaluateFamiliarity(
  card: { state: unknown; stability: unknown },
  logs: FamiliarityEvidence[],
) {
  const again = logs
    .filter((log) => log.rating === 'again')
    .reduce<FamiliarityEvidence | null>((latest, log) => {
      if (!latest) return log;
      if (log.afterReps !== null && latest.afterReps !== null)
        return log.afterReps > latest.afterReps ? log : latest;
      return log.reviewedAt > latest.reviewedAt ? log : latest;
    }, null);
  const days = new Set(
    logs
      .filter((log) => {
        if (log.wasNew || !['good', 'easy'].includes(log.rating) || !log.learningDayKey)
          return false;
        if (!again) return true;
        // FSRS reps orders accepted ratings even when two server timestamps are identical.
        if (log.afterReps !== null && again.afterReps !== null)
          return log.afterReps > again.afterReps;
        return log.reviewedAt > again.reviewedAt;
      })
      .map((log) => log.learningDayKey),
  );
  const stability =
    typeof card.stability === 'number' && Number.isFinite(card.stability) ? card.stability : 0;
  const review = card.state === 2; // ts-fsrs State.Review; learning/relearning never qualifies.
  return {
    successfulReviewDays: days.size,
    graduate: review && stability >= 14 && days.size >= 3,
    automaticKnown: review && stability >= 90 && days.size >= 5,
  };
}
