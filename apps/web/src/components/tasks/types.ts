import type { PageInfo, Plan, Settings, StudySession } from '../../lib/types';

export interface TaskPlanResponse {
  plan: Plan;
  settings: Settings;
}
export interface TaskPlanPreview {
  bookId: string;
  bookTitle: string;
  dailyTotalGoal: number;
  groupSize: number;
  timeZone: string;
  pendingTimeZone: string | null;
  startsAt: string;
  endsAt: string;
  completedUnique: number;
  retainedAssignedCount: number;
  reviewPlanned: number;
  newPlanned: number;
  dueNowCount: number;
  dueTodayCount: number;
  overdueCount: number;
  unplannedOverdueCount: number;
}
export interface PlanPreviewResponse {
  preview: TaskPlanPreview;
  settingsRevision: number;
}
export interface TaskListResponse {
  items: StudySession[];
  page: PageInfo;
}
export interface TaskForecastResponse {
  days: {
    localDate: string;
    startsAt: string;
    endsAt: string;
    dueUnique: number;
    overdueCarry: number;
  }[];
  asOf: string;
  assumption: 'current_due_dates_no_future_reviews';
}
export interface TaskStartResponse {
  session: StudySession | null;
  plan: Plan;
  reason?: string;
  duplicate: boolean;
}
export interface TaskStateResponse {
  session: StudySession;
  plan: Plan;
  duplicate: boolean;
}
