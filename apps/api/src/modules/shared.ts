import crypto from 'node:crypto';
import {
  Prisma,
  type PrismaClient,
  type Word,
  type Sense,
  type StudyProgress,
  type WordAudio,
} from '@prisma/client';
import { z } from 'zod';
import { createEmptyCard, fsrs, Rating, type Card } from 'ts-fsrs';
import { HttpError } from '../context.js';

export type Db = PrismaClient | Prisma.TransactionClient;
export type WordWithSenses = Word & { senses: Sense[]; audio?: WordAudio[] };
export const wordInclude = {
  senses: { orderBy: { ordinal: 'asc' as const } },
  audio: { where: { status: 'ready' }, orderBy: { accent: 'asc' as const } },
};
export const scheduler = fsrs({ request_retention: 0.9, enable_fuzz: false });
export const ratingValues = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
} as const;
export const goalValues = ['daily', 'ielts', 'cet4', 'cet6', 'high-school'] as const;
export const goal = z.enum(goalValues);
export const commandId = z.string().min(8).max(120);
export const id = z.string().min(1).max(160);
export const normalize = (value: string) =>
  value.normalize('NFKC').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new HttpError(400, 'invalid_input', '请求格式不正确', result.error.flatten());
  return result.data;
}
export function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
export function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function hydrateCard(value: unknown): Card {
  const raw = obj(value);
  return {
    ...raw,
    due: new Date(String(raw.due)),
    ...(raw.last_review ? { last_review: new Date(String(raw.last_review)) } : {}),
  } as Card;
}
export function freshCard(now = new Date()): Card {
  return createEmptyCard(now);
}
export function wordDto(word: WordWithSenses) {
  return {
    id: word.id,
    lemma: word.lemma,
    phonetic: word.phonetic,
    phoneticUs: word.phoneticUs,
    phoneticUk: word.phoneticUk,
    phoneticSource: word.phoneticSource,
    difficulty: word.difficulty,
    status: word.status,
    goalTags: word.goalTags,
    contentVersion: word.contentVersion,
    sourceRef: word.sourceRef,
    audio: (word.audio ?? []).map((audio) => ({
      id: audio.id,
      accent: audio.accent,
      kind: audio.kind,
      status: 'ready',
      url: `/api/v2/pronunciation/${encodeURIComponent(word.id)}/audio/${audio.accent}`,
      sourceName: audio.sourceName,
      sourceUrl: audio.sourceUrl,
      license: audio.license,
      attribution: audio.attribution,
      mimeType: audio.mimeType,
    })),
    senses: word.senses.map((s) => ({
      id: s.id,
      pos: s.pos,
      definitionZh: s.definitionZh,
      definitionEn: s.definitionEn,
      exampleEn: s.exampleEn,
      exampleZh: s.exampleZh,
    })),
  };
}
export function progressDto(progress: StudyProgress | null) {
  if (!progress) return null;
  const state = obj(progress.fsrsJson);
  return {
    wordId: progress.wordId,
    revision: progress.revision,
    dueAt: progress.dueAt.toISOString(),
    lastReviewAt: progress.lastReviewAt?.toISOString() ?? null,
    firstLearnedAt: progress.firstLearnedAt?.toISOString() ?? null,
    reps: Number(state.reps ?? 0),
    state: Number(state.state ?? 0),
    algorithmVersion: progress.algorithmVersion,
  };
}
export async function settings(db: Db, userId: string) {
  await db.userSettings.createMany({
    data: [{ userId }],
    skipDuplicates: true,
  });
  const current = await db.userSettings.findUniqueOrThrow({ where: { userId } });
  if (
    current.pendingTimeZone &&
    current.timeZoneEffectiveAt &&
    current.timeZoneEffectiveAt <= new Date()
  ) {
    await db.userSettings.updateMany({
      where: { userId, revision: current.revision, pendingTimeZone: current.pendingTimeZone },
      data: {
        timeZone: current.pendingTimeZone,
        pendingTimeZone: null,
        timeZoneEffectiveAt: null,
        revision: { increment: 1 },
      },
    });
    return db.userSettings.findUniqueOrThrow({ where: { userId } });
  }
  return current;
}
export function retryableTransactionError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (['P2034', 'P2002'].includes(error.code)) return true;
  if (error.code !== 'P2010') return false;
  const meta = obj(error.meta),
    adapter = obj(meta.driverAdapterError),
    cause = obj(adapter.cause);
  return [meta.code, cause.originalCode].some((code) => code === '40001' || code === '40P01');
}
export async function transact<T>(
  prisma: PrismaClient,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(action, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5000,
        timeout: 15000,
      });
    } catch (error) {
      if (attempt < 3 && retryableTransactionError(error)) {
        await new Promise((resolve) => setTimeout(resolve, 15 + attempt * 25));
        continue;
      }
      throw error;
    }
  }
}
export async function getReceipt(db: Db, userId: string, key: string, hash: string) {
  const receipt = await db.commandReceipt.findUnique({
    where: { userId_commandId: { userId, commandId: key } },
  });
  if (receipt && receipt.requestHash !== hash)
    throw new HttpError(409, 'idempotency_conflict', '同一动作编号不能提交不同内容');
  return receipt;
}
export async function audit(
  db: Db,
  actorId: string,
  action: string,
  targetId: string,
  detail: unknown,
) {
  await db.adminAuditLog.create({ data: { actorId, action, targetId, detail: json(detail) } });
}
export function quantile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(1, p)) * (sorted.length - 1);
  const low = sorted[Math.floor(position)] ?? 0,
    high = sorted[Math.ceil(position)] ?? low;
  return low + (high - low) * (position - Math.floor(position));
}
export function isoDay(date: Date, timeZone = 'Asia/Shanghai') {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const learningFormatters = new Map<string, Intl.DateTimeFormat>();
const learningBoundaries = new Map<string, number>();
function localParts(date: Date, timeZone: string) {
  let formatter = learningFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    if (learningFormatters.size >= 128)
      learningFormatters.delete(learningFormatters.keys().next().value!);
    learningFormatters.set(timeZone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}
function shiftedDate(label: string, days: number) {
  const value = new Date(`${label}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
/** Fast display label. UTC timestamps remain untouched; local learning days start at 04:00. */
export function learningDay(date: Date, timeZone = 'Asia/Shanghai') {
  const parts = localParts(date, timeZone);
  const label = `${parts.year}-${parts.month}-${parts.day}`;
  return Number(parts.hour) < 4 ? shiftedDate(label, -1) : label;
}
function fourOClock(label: string, timeZone: string) {
  const key = `${timeZone}:${label}`;
  const cached = learningBoundaries.get(key);
  if (cached !== undefined) return cached;
  const target = new Date(`${label}T04:00:00Z`).getTime();
  const localClock = (at: number) => {
    const p = localParts(new Date(at), timeZone);
    return Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
    );
  };
  let candidate = target;
  for (let attempt = 0; attempt < 6; attempt++) {
    const delta = target - localClock(candidate);
    if (!delta) break;
    candidate += delta;
  }
  if (localClock(candidate) === target) {
    // Prefer the first occurrence if a historical offset change repeated the 04:00 hour.
    for (const offset of [120, 90, 60, 30])
      if (localClock(candidate - offset * 60000) === target) candidate -= offset * 60000;
  } else {
    // A skipped local boundary starts at the first real minute after 04:00, never UTC-4h.
    let found: number | undefined;
    for (let at = candidate - 4 * 3600000; at <= candidate + 4 * 3600000; at += 60000)
      if (localClock(at) >= target && localClock(at) < target + 20 * 3600000) {
        found = at;
        break;
      }
    if (found === undefined) throw new HttpError(400, 'invalid_timezone_day');
    candidate = found;
  }
  if (learningBoundaries.size >= 512)
    learningBoundaries.delete(learningBoundaries.keys().next().value!);
  learningBoundaries.set(key, candidate);
  return candidate;
}
export function learningDayWindow(now: Date, timeZone = 'Asia/Shanghai') {
  const localDate = learningDay(now, timeZone);
  return {
    localDate,
    startsAt: new Date(fourOClock(localDate, timeZone)),
    endsAt: new Date(fourOClock(shiftedDate(localDate, 1), timeZone)),
  };
}
export function mergedSeconds(intervals: { startAt: Date; endAt: Date }[]): number {
  const sorted = intervals
    .map((x) => [x.startAt.getTime(), x.endAt.getTime()] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  let total = 0,
    start = 0,
    end = 0;
  for (const [a, b] of sorted) {
    if (a > end) {
      total += Math.max(0, end - start);
      start = a;
      end = b;
    } else end = Math.max(end, b);
  }
  return Math.floor((total + Math.max(0, end - start)) / 1000);
}
