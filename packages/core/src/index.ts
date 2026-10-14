import { z } from 'zod';

export const goals = ['daily', 'ielts', 'cet4', 'cet6', 'high-school'] as const;
export const goalSchema = z.enum(goals);
export type Goal = z.infer<typeof goalSchema>;
export const goalLabels: Record<Goal, string> = {
  daily: '日常英语',
  ielts: '雅思',
  cet4: '四级',
  cet6: '六级',
  'high-school': '高中',
};
export const ratings = ['again', 'hard', 'good', 'easy'] as const;
export const ratingSchema = z.enum(ratings);
export type RatingName = z.infer<typeof ratingSchema>;

export function normalizeLemma(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
}

export function localDate(value: Date, timeZone = 'Asia/Shanghai'): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(value)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export const appVersion = '0.5.0-alpha.1';
