import type { FastifyInstance } from 'fastify';
import type { AcademyAttempt } from '@prisma/client';
import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireUser, type ContextResolver } from '../context.js';
import { verifiedAudioBytes } from '../audio.js';
import {
  commandId,
  digest,
  getReceipt,
  id,
  json,
  obj,
  parse,
  transact,
  type Db,
} from './shared.js';
import { libraryCursor, lockLibraryUser } from './learning-library.js';
import { pageInfo } from './pagination.js';
import { academyLessons, type AcademyLesson } from './academy-content.js';
const category = z.enum(['reading', 'shadowing', 'listening', 'topic']);
const shuffled = <T>(values: readonly T[]) => {
  const result = [...values];
  for (let n = result.length - 1; n > 0; n--) {
    const other = randomInt(n + 1);
    [result[n], result[other]] = [result[other]!, result[n]!];
  }
  return result;
};
function attemptDto(row: AcademyAttempt) {
  const snapshot = obj(row.itemsJson),
    items = Array.isArray(snapshot.items) ? snapshot.items.map(obj) : [];
  return {
    id: row.id,
    lessonId: row.lessonId,
    lessonVersion: row.lessonVersion,
    kind: row.kind,
    status: row.status,
    revision: row.revision,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    lesson: snapshot.lesson,
    items: items.map((item) => ({
      id: item.id,
      prompt: item.prompt,
      audioUrl: item.audioUrl,
      accent: item.accent,
      options: item.options,
    })),
    result: row.status === 'completed' ? row.resultJson : null,
  };
}
async function targetAudio(db: Db, lesson: AcademyLesson, accent: 'us' | 'uk', verify: boolean) {
  const words = await db.word.findMany({
    where: { normalizedLemma: { in: lesson.listeningTargets }, status: 'published' },
    select: {
      id: true,
      lemma: true,
      normalizedLemma: true,
      audio: { where: { accent: accent.toUpperCase(), status: 'ready' } },
    },
  });
  const ordered = lesson.listeningTargets.map((lemma) =>
    words.find((word) => word.normalizedLemma === lemma),
  );
  if (ordered.some((word) => !word?.audio.length)) return null;
  if (verify) {
    try {
      await Promise.all(ordered.map((word) => verifiedAudioBytes(word!.audio[0]!)));
    } catch {
      return null;
    }
  }
  return ordered.map((word) => word!);
}
export async function registerAcademy(
  app: FastifyInstance,
  getContext: ContextResolver,
  options: { lessons?: readonly AcademyLesson[] } = {},
) {
  const lessons = options.lessons ?? academyLessons;
  const lessonById = (lessonId: string) => {
    const value = lessons.find((lesson) => lesson.id === lessonId);
    if (!value) throw new HttpError(404, 'academy_lesson_not_found');
    return value;
  };
  const lessonView = async (db: Db, userId: string, lesson: AcademyLesson) => {
    const [completed, last] = await Promise.all([
      db.academyAttempt.count({ where: { userId, lessonId: lesson.id, status: 'completed' } }),
      db.academyAttempt.findFirst({
        where: { userId, lessonId: lesson.id, status: 'completed' },
        orderBy: { completedAt: 'desc' },
        select: { completedAt: true },
      }),
    ]);
    const audioAvailable =
      lesson.category === 'listening'
        ? Boolean(
            (await targetAudio(db, lesson, 'us', false)) &&
            (await targetAudio(db, lesson, 'uk', false)),
          )
        : null;
    return {
      ...lesson,
      completedAttempts: completed,
      lastCompletedAt: last?.completedAt?.toISOString() ?? null,
      audioAvailable,
    };
  };
  app.get('/academy', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      query = parse(z.object({ category: category.optional() }).strict(), req.query);
    const items = await Promise.all(
      lessons
        .filter((lesson) => !query.category || lesson.category === query.category)
        .map(async (lesson) => {
          const {
            body: _body,
            vocabulary: _vocab,
            listeningTargets: _targets,
            speech: _speech,
            completionPolicy: _policy,
            ...summary
          } = await lessonView(ctx.prisma, user.id, lesson);
          return summary;
        }),
    );
    return { items };
  });
  app.get('/academy/attempts', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      query = parse(
        z
          .object({
            limit: z.coerce.number().int().min(1).max(100).default(20),
            cursor: z.string().max(1200).optional(),
          })
          .strict(),
        req.query,
      );
    const scope = `academy-attempts:${ctx.siteId}:${ctx.instanceId}:${user.id}`,
      cursor = libraryCursor(scope, query.cursor);
    const [rows, total] = await Promise.all([
      ctx.prisma.academyAttempt.findMany({
        where: {
          userId: user.id,
          ...(cursor
            ? {
                OR: [
                  { startedAt: { lt: cursor.at } },
                  { startedAt: cursor.at, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
      ctx.prisma.academyAttempt.count({ where: { userId: user.id } }),
    ]);
    const page = pageInfo(rows, query.limit, total, scope, (row) =>
      JSON.stringify({ at: row.startedAt.toISOString(), id: row.id }),
    );
    return { items: page.items.map(attemptDto), page: page.page };
  });
  app.get('/academy/attempts/:id', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    const attempt = await ctx.prisma.academyAttempt.findFirst({
      where: { id: params.id, userId: user.id },
    });
    if (!attempt) throw new HttpError(404, 'academy_attempt_not_found');
    return { attempt: attemptDto(attempt) };
  });
  app.get('/academy/:id', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    return { lesson: await lessonView(ctx.prisma, user.id, lessonById(params.id)) };
  });
  app.post('/academy/:id/attempts', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params),
      input = parse(
        z.object({ commandId, accent: z.enum(['us', 'uk']).default('us') }).strict(),
        req.body,
      );
    const lesson = lessonById(params.id),
      hash = digest({ action: 'academy.start', lessonId: lesson.id, ...input });
    return transact(ctx.prisma, async (tx) => {
      await lockLibraryUser(tx, user.id);
      const receipt = await getReceipt(tx, user.id, input.commandId, hash);
      if (receipt) {
        const old = await tx.academyAttempt.findFirst({
          where: { id: String(obj(receipt.responseJson).attemptId), userId: user.id },
        });
        if (!old) throw new HttpError(404, 'academy_attempt_not_found');
        return { attempt: attemptDto(old), duplicate: true };
      }
      if ((await tx.academyAttempt.count({ where: { userId: user.id } })) >= 1000)
        throw new HttpError(429, 'academy_attempt_limit', '练习记录已达到1000条上限');
      let items: unknown[] = [];
      if (lesson.category === 'listening') {
        const targets = await targetAudio(tx, lesson, input.accent, true);
        if (!targets)
          throw new HttpError(503, 'academy_audio_not_ready', '本课音源尚未就绪，请稍后重试');
        items = shuffled(targets).map((word) => {
          const options = shuffled(targets).map((target) => ({
            id: randomUUID(),
            text: target.lemma,
          }));
          return {
            id: randomUUID(),
            prompt: '听音后选择正确的单词',
            audioUrl: `/api/v2/pronunciation/${encodeURIComponent(word.id)}/audio/${input.accent.toUpperCase()}`,
            accent: input.accent,
            options,
            answerId: options.find((option) => option.text === word.lemma)!.id,
            answerText: word.lemma,
            wordId: word.id,
          };
        });
      }
      const saved = await tx.academyAttempt.create({
        data: {
          userId: user.id,
          lessonId: lesson.id,
          lessonVersion: lesson.version,
          kind: lesson.category,
          itemsJson: json({ lesson, items }),
        },
      });
      await tx.commandReceipt.create({
        data: {
          userId: user.id,
          commandId: input.commandId,
          requestHash: hash,
          responseJson: json({ attemptId: saved.id }),
        },
      });
      return { attempt: attemptDto(saved), duplicate: false };
    });
  });
  app.post('/academy/attempts/:id/submit', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    const input = parse(
      z
        .object({
          commandId,
          expectedRevision: z.number().int().nonnegative(),
          answers: z
            .array(z.object({ itemId: id, answer: z.string().min(1).max(160) }).strict())
            .max(20)
            .optional(),
        })
        .strict(),
      req.body,
    );
    const hash = digest({ action: 'academy.submit', attemptId: params.id, ...input });
    return transact(ctx.prisma, async (tx) => {
      await lockLibraryUser(tx, user.id);
      const old = await tx.academyAttempt.findFirst({ where: { id: params.id, userId: user.id } });
      if (!old) throw new HttpError(404, 'academy_attempt_not_found');
      const receipt = await getReceipt(tx, user.id, input.commandId, hash);
      if (receipt) return { attempt: attemptDto(old), duplicate: true };
      if (old.status !== 'in_progress')
        throw new HttpError(409, 'academy_already_submitted', '本次练习已提交', {
          attempt: attemptDto(old),
        });
      if (old.revision !== input.expectedRevision)
        throw new HttpError(409, 'academy_attempt_conflict', '练习已更新', {
          attempt: attemptDto(old),
        });
      const snapshot = obj(old.itemsJson),
        items = Array.isArray(snapshot.items) ? snapshot.items.map(obj) : [],
        answers = input.answers ?? [];
      if (
        old.kind === 'listening' &&
        (!items.length ||
          answers.length !== items.length ||
          new Set(answers.map((answer) => answer.itemId)).size !== items.length ||
          items.some((item) => {
            const answer = answers.find((row) => row.itemId === item.id);
            return (
              !answer ||
              !(Array.isArray(item.options) ? item.options.map(obj) : []).some(
                (option) => option.id === answer.answer,
              )
            );
          }))
      )
        throw new HttpError(400, 'academy_answers_incomplete', '请完成每一道听力题');
      if (old.kind !== 'listening' && answers.length)
        throw new HttpError(400, 'academy_answers_not_applicable');
      const feedback =
        old.kind === 'listening'
          ? items.map((item) => ({
              itemId: item.id,
              correct:
                answers.find((answer) => answer.itemId === item.id)!.answer === item.answerId,
              correctAnswer: item.answerText,
              wordId: item.wordId,
            }))
          : [];
      const correct = feedback.filter((item) => item.correct).length;
      const result = {
        completed: true,
        assessmentKind: old.kind === 'listening' ? 'objective-listening' : 'completion-only',
        score: old.kind === 'listening' ? Math.round((correct / items.length) * 100) : null,
        total: old.kind === 'listening' ? items.length : null,
        correct: old.kind === 'listening' ? correct : null,
        feedback,
      };
      const saved = await tx.academyAttempt.update({
        where: { id: old.id },
        data: {
          status: 'completed',
          revision: { increment: 1 },
          completedAt: new Date(),
          resultJson: json(result),
        },
      });
      await tx.commandReceipt.create({
        data: {
          userId: user.id,
          commandId: input.commandId,
          requestHash: hash,
          responseJson: json({ attemptId: saved.id }),
        },
      });
      return { attempt: attemptDto(saved), duplicate: false };
    });
  });
}
