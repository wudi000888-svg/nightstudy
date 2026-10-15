import type { PageInfo, Progress, Word } from './types';

export interface LearningStats {
  today: LearningDay;
  timeZone: string;
  dayStartHour: number;
  totalLearned: number;
  totalReviews: number;
  knownClaimCount: number;
  activeDays: number;
  streak: number;
  trends: LearningDay[];
  dataLimited?: boolean;
}
export interface LearningDay {
  date: string;
  newWords: number;
  reviews: number;
  seconds: number;
  minutes: number;
  checkedIn: boolean;
  uniqueWords: number;
  reviewWords: number;
}
export interface LibraryWord {
  word: Word;
  progress: Progress;
  learnedAt: string | null;
  reviewedAt: string | null;
  dueAt: string | null;
  reviewCount: number;
  paused: boolean;
}
export interface SavedSentence {
  id: string;
  wordId: string | null;
  sourceType: 'word-example' | 'sense';
  sourceId: string;
  exampleEn: string;
  exampleZh: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
export interface SentencePage {
  items: SavedSentence[];
  page: PageInfo;
}
export interface LearningNote {
  id: string;
  title: string;
  body: string;
  wordId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface NotePage {
  items: LearningNote[];
  page: PageInfo;
}
export type AcademyCategory = 'reading' | 'shadowing' | 'listening' | 'topic';
export interface LessonSummary {
  id: string;
  title: string;
  description: string;
  category: AcademyCategory;
  level: 'starter' | 'elementary';
  durationMinutes: number;
  version: string;
  original: true;
  license: 'MIT';
  completedAttempts: number;
  lastCompletedAt: string | null;
  audioAvailable: boolean | null;
}
export interface AcademyLesson extends Omit<
  LessonSummary,
  'completedAttempts' | 'lastCompletedAt' | 'audioAvailable'
> {
  completedAttempts?: number;
  lastCompletedAt?: string | null;
  audioAvailable?: boolean | null;
  body: { id: string; en: string; zh: string }[];
  vocabulary: string[];
  listeningTargets: string[];
  speech: { kind: 'pack'; requiresAvailableAudio: true } | null;
  completionPolicy: 'objective-listening' | 'completion-only';
}
export interface AcademyAttempt {
  id: string;
  lessonId: string;
  lessonVersion: string;
  lesson: AcademyLesson;
  kind: AcademyCategory;
  status: string;
  revision: number;
  startedAt: string;
  completedAt: string | null;
  items: {
    id: string;
    prompt: string;
    audioUrl: string;
    options: { id: string; text: string }[];
  }[];
  result: null | {
    completed: true;
    score: number | null;
    total: number | null;
    correct: number | null;
    feedback: { itemId: string; correct: boolean; correctAnswer: string }[];
    assessmentKind: 'objective-listening' | 'completion-only';
  };
}
export interface LibraryResponse {
  items: LibraryWord[];
  page: PageInfo;
}
