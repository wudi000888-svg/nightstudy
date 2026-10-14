export type Goal = 'daily' | 'ielts' | 'cet4' | 'cet6' | 'high-school';
export const goalLabels: Record<Goal, string> = {
  daily: '日常英语',
  ielts: '雅思',
  cet4: '四级',
  cet6: '六级',
  'high-school': '高中',
};
export const goalNames = Object.keys(goalLabels) as Goal[];
export type Rating = 'again' | 'hard' | 'good' | 'easy';
export interface Site {
  siteId: string;
  title: string;
  basePath: string;
  publicUrl: string;
  version: string;
  contentVersion: string;
  initialized: boolean;
  registrationOpen: boolean;
}
export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}
export interface Me {
  user: User | null;
  siteId: string;
}
export interface SystemUpdate {
  status: 'unchecked' | 'up-to-date' | 'available' | 'ahead' | 'no-release' | 'failed';
  checkedAt: string | null;
  latestVersion: string | null;
  releaseUrl: string | null;
  message: string;
  channel: 'prerelease' | 'stable';
  cached?: boolean;
  stale?: boolean;
  lastSuccessfulAt?: string | null;
}
export interface AdminSystemInfo {
  version: string;
  siteId: string;
  instanceId: string;
  initialized: boolean;
  registrationOpen: boolean;
  update: SystemUpdate;
}
export type FleetScope =
  'status:read' | 'users:read' | 'users:write' | 'settings:write' | 'announcements:write';
export interface FleetPairingToken {
  id: string;
  label: string;
  scopes: FleetScope[];
  expiresAt: string;
  createdAt: string;
  status: 'active' | 'used' | 'revoked' | 'expired';
}
export interface FleetController {
  id: string;
  label: string;
  controllerInstanceId: string;
  controllerSiteId: string;
  controllerUrl: string;
  scopes: FleetScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface FleetSnapshot {
  site: {
    instanceId: string;
    siteId: string;
    title: string;
    publicUrl: string;
    basePath: string;
    version: string;
    contentVersion: string;
  };
  registrationOpen: boolean;
  counts: { users: number; disabledUsers: number; books: number; words: number };
  wordCountBasis: 'installed-pack-metadata';
  checkedAt: string;
  update?: SystemUpdate;
}
export interface FleetSite {
  id: string;
  label: string;
  remoteUrl: string;
  remoteInstanceId: string;
  remoteSiteId: string;
  scopes: FleetScope[];
  status: 'active' | 'unreachable' | 'revoked' | 'disconnect_pending' | 'forgotten';
  lastSnapshot: FleetSnapshot | null;
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
}
export interface FleetSummary {
  pairingTokens: FleetPairingToken[];
  controllers: FleetController[];
  sites: FleetSite[];
}
export interface FleetUser {
  id: string;
  name: string;
  email: string;
  role: string;
  disabled: boolean;
  createdAt: string;
}
export interface AdminAnnouncement {
  id: string;
  title: string;
  body: string;
  status: string;
}
export interface ContentAttribution {
  kind: 'dictionary' | 'original-demo' | 'site-authored' | 'unknown';
  reference: string;
  packId: string | null;
  license: string | null;
  sourceUrl: string | null;
  wordHasSiteEdits: boolean;
  siteEditVersion: string | null;
}
export interface Sense {
  id: string;
  pos?: string;
  definitionZh: string;
  definitionEn?: string;
  exampleEn?: string;
  exampleZh?: string;
  sourceRef?: string;
  source?: ContentAttribution;
  exampleSource?: ContentAttribution | null;
}
export interface Word {
  id: string;
  status?: string;
  lemma: string;
  phonetic?: string;
  phoneticUs?: string;
  phoneticUk?: string;
  phoneticSource?: string;
  phonetics?: {
    text: string;
    ipa?: string;
    region: 'US' | 'UK' | 'unspecified';
    notation: 'ipa' | 'source-transcription';
    sourceRef?: string;
  }[];
  audioUrl?: string;
  audio?: WordAudio[];
  difficulty?: number;
  goalTags?: string[];
  contentVersion?: string;
  sourceRef?: string;
  source?: {
    reference: string;
    packId: string | null;
    license: string | null;
    sourceUrl: string | null;
    wordHasSiteEdits?: boolean;
    siteEditVersion?: string | null;
  } | null;
  sources?: { id: string; version: string; license: string; sourceUrl: string }[];
  senses?: Sense[];
  senseCount?: number;
  detailAvailable?: boolean;
}
export interface WordAudio {
  id: string;
  accent: 'US' | 'UK';
  kind: 'recorded' | 'synthesized';
  url: string;
  status: 'ready';
  sourceName: string;
  sourceUrl: string | null;
  license: string | null;
  attribution: string | null;
  mimeType: string;
}
export interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
}
export interface Book {
  id: string;
  slug: string;
  title: string;
  description: string;
  goal: Goal;
  version: number | string;
  wordCount: number;
  learnedCount: number;
  coveredCount: number;
  claimedKnownCount: number;
  isDemo: boolean;
  status?: 'published' | 'archived';
  visibility?: 'public' | 'private';
  ownedByMe?: boolean;
}
export type BookFileFormat = 'txt' | 'docx' | 'pdf';
export interface CustomBookImport {
  id: string;
  title: string;
  description: string;
  goal: Goal;
  filename: string;
  format: BookFileFormat;
  formatVersion: string;
  status: 'preview' | 'confirmed';
  counts: {
    totalRows: number;
    ready: number;
    failed: number;
    duplicates: number;
    missingPronunciation: number;
    notFound: number;
    missingDefinition: number;
  };
  expiresAt: string;
  createdAt: string;
  confirmedAt: string | null;
  bookId: string | null;
}
export interface CustomBookRow {
  lineNumber: number;
  text: string;
  normalizedLemma: string;
  status: 'ready' | 'failed' | 'duplicate';
  wordId?: string;
  lemma?: string;
  reasons: { code: string; message: string }[];
  readiness?: {
    phoneticUs: boolean;
    phoneticUk: boolean;
    audioUs: boolean;
    audioUk: boolean;
    definition: boolean;
  };
  duplicateOfLine?: number;
}
export interface CustomBookPreview {
  import: CustomBookImport;
  items: CustomBookRow[];
  page: PageInfo;
}
export interface CustomBookTemplate {
  formatVersion: string;
  header: string;
  text: string;
  limits: {
    maxEntries: number;
    maxFileBytes: number;
    maxTxtBytes: number;
    maxPages: number;
    maxTextCharacters: number;
  };
  requirements: string[];
  downloadUrls: Record<BookFileFormat, string>;
}
export interface Settings {
  goal: Goal;
  currentBookId: string | null;
  dailyTotalGoal: number;
  dailyNewLimit?: number;
  groupSize: number;
  timeZone: string;
  pendingTimeZone?: string | null;
  timeZoneEffectiveAt?: string | null;
  revision: number;
}
export interface Plan {
  id: string;
  revision: number;
  localDate: string;
  timeZone: string;
  startsAt: string;
  endsAt: string;
  goal: Goal;
  bookId: string | null;
  bookTitle: string | null;
  dailyTotalGoal: number;
  groupSize: number;
  completedUnique: number;
  completedNew: number;
  completedReview: number;
  assignedUnique: number;
  plannedReview: number;
  plannedNew: number;
  dueNowCount: number;
  dueTodayCount: number;
  overdueCount: number;
  unplannedOverdueCount: number;
  pendingConsolidationCount: number;
  pendingSpellingCount: number;
  newRemaining: number;
  reviewRemaining: number;
  nextDueAt: string | null;
  activeTaskId: string | null;
  recommendedTotal: number;
}
export interface Progress {
  wordId: string;
  revision: number;
  dueAt: string;
  lastReviewAt: string | null;
  firstLearnedAt: string | null;
  reps: number;
  state: number;
}
export interface Question {
  id: string;
  type: string;
  prompt: string;
  hint?: string;
  options?: { id: string; text: string }[];
}
export interface SessionItem {
  id: string;
  wordId: string;
  focusSenseId?: string;
  ordinal: number;
  word: Word;
  progressRevision: number;
  revealed: boolean;
  rated: boolean;
  exerciseDone: boolean;
  status: string;
  bucket: 'new' | 'review' | null;
  question?: Question;
}
export interface StudySession {
  id: string;
  bookId: string | null;
  mode: 'learn' | 'review' | 'daily' | 'extra-review';
  phase: 'recall' | 'practice' | 'completed';
  status: string;
  revision: number;
  cursor: number;
  step: string;
  currentItemId: string | null;
  planId: string | null;
  taskKind: 'daily' | 'extra-review' | 'legacy';
  pausedAt: string | null;
  deferredUntil: string | null;
  learningDate: string | null;
  timeZone?: string | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  bookTitle?: string | null;
  items: SessionItem[];
}
export interface CommandResult {
  session: StudySession;
  progress?: Progress;
  result?: { correct: boolean; correctAnswer: string; explanation: string };
  duplicate?: boolean;
}
export interface WordbookItem {
  id: string;
  wordId: string;
  word: Word;
  note: string;
  favorite: boolean;
  paused: boolean;
  progress: Progress | null;
}
