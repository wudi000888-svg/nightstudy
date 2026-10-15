/** One authenticated, server-confirmed snapshot. A home read never issues a study group. */
export interface H5HomeEntry {
  state:
    'setup' | 'resume' | 'ready' | 'waiting' | 'review_first' | 'other_task' | 'complete' | 'empty';
  count: number;
  sessionId: string | null;
  sessionRevision: number | null;
  phase: string | null;
  availableAt: string | null;
}

export interface H5HomeSummary {
  asOf: string;
  localDate: string;
  timeZone: string;
  startsAt: string;
  endsAt: string;
  checkedIn: boolean;
  dailyGoalComplete: boolean;
  plan: {
    id: string;
    revision: number;
    bookId: string | null;
    bookTitle: string | null;
    dailyTotalGoal: number;
    completedUnique: number;
    completedNew: number;
    completedReview: number;
    newRemaining: number;
    reviewRemaining: number;
    pendingSpellingCount: number;
    pendingConsolidationCount: number;
    nextDueAt: string | null;
  };
  learn: H5HomeEntry;
  review: H5HomeEntry;
  calendar: {
    days: { localDate: string; checkedIn: boolean; completedGroups: number }[];
    /** Consecutive learning days, ending today or yesterday if today has not yet been completed. */
    streak: number;
  };
}
