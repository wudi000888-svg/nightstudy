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
}
export interface Settings {
  goal: Goal;
  currentBookId: string | null;
  dailyNewLimit: number;
  groupSize: number;
  timeZone: string;
  revision: number;
}
export interface Plan {
  goal: Goal;
  bookId: string | null;
  dailyNewLimit: number;
  groupSize: number;
  dueCount: number;
  newRemaining: number;
  reservedNewCount: number;
  knownCount: number;
  recommendedNew: number;
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
  question?: Question;
}
export interface StudySession {
  id: string;
  bookId: string | null;
  mode: 'learn' | 'review';
  phase: 'recall' | 'practice' | 'completed';
  status: string;
  revision: number;
  cursor: number;
  step: string;
  currentItemId: string | null;
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
