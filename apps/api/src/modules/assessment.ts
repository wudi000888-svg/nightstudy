import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { HttpError, requireUser, type ContextResolver } from '../context.js';
import {
  parse,
  id,
  goal,
  commandId,
  wordInclude,
  json,
  obj,
  digest,
  normalize,
  transact,
  getReceipt,
} from './shared.js';

type AssessmentView = Prisma.AssessmentGetPayload<{ include: { items: true } }>;
type SampleWord = { id: string; difficulty: number };
export function stratifiedSample<T extends SampleWord>(
  words: T[],
  size: number,
  seed: string,
): T[] {
  const groups = [...new Set(words.map((w) => w.difficulty))]
    .sort((a, b) => a - b)
    .map((d) =>
      words
        .filter((w) => w.difficulty === d)
        .sort((a, b) => digest(`${seed}:${a.id}`).localeCompare(digest(`${seed}:${b.id}`))),
    );
  const result: T[] = [];
  for (let index = 0; result.length < size; index++) {
    let added = false;
    for (const group of groups) {
      const word = group[index];
      if (word && result.length < size) {
        result.push(word);
        added = true;
      }
    }
    if (!added) break;
  }
  return result;
}
function assessmentDto(value: AssessmentView) {
  const current = value.items.find((i) => !i.answeredAt);
  return {
    id: value.id,
    goal: value.goal,
    status: value.status,
    version: value.blueprintVersion,
    currentItemId: current?.id ?? null,
    items: value.items.map((item) => {
      const q = obj(item.questionJson),
        visible = current?.id === item.id || !!item.answeredAt;
      return {
        id: item.id,
        type: item.type,
        ordinal: item.ordinal,
        answered: !!item.answeredAt,
        ...(visible
          ? {
              question: {
                id: item.id,
                type: item.type,
                prompt: q.prompt,
                ...(Array.isArray(q.options) ? { options: q.options } : {}),
              },
            }
          : {}),
      };
    }),
  };
}
export function suggestedPlan(recognition: number, spelling: number, reviewPressure = 0) {
  const newWordSuggestion = recognition >= 0.8 && spelling >= 0.7 ? 12 : recognition < 0.4 ? 8 : 16;
  return {
    dailyTotalGoal: Math.min(100, Math.max(20, reviewPressure + newWordSuggestion)),
    newWordSuggestion,
    reviewPressure,
    countBasis: 'daily-unique-words',
    // Older assessment reports and clients retain their original new-word suggestion.
    dailyNewLimit: newWordSuggestion,
    groupSize: 5,
  };
}
export async function registerAssessment(app: FastifyInstance, getContext: ContextResolver) {
  app.post('/assessments', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      input = parse(
        z.object({ goal, size: z.number().int().min(1).max(20).default(12) }).strict(),
        req.body,
      );
    const strata = await ctx.prisma.$queryRaw<{ difficulty: number; population: number }[]>`
      SELECT w."difficulty", COUNT(*)::int AS population FROM "Word" w
      WHERE w."status" = 'published' AND w."goalTags" @> ARRAY[${input.goal}]::text[]
      AND EXISTS (SELECT 1 FROM "Sense" s WHERE s."wordId"=w."id" AND btrim(s."definitionZh", E' \\t\\r\\n') <> '')
      GROUP BY w."difficulty"
    `;
    if (!strata.length)
      throw new HttpError(409, 'assessment_content_unavailable', '该目标尚无可用题目');
    const seed = crypto.randomUUID();
    const sampledIds = (
      await Promise.all(
        strata.map(
          (stratum) =>
            ctx.prisma.$queryRaw<{ id: string; difficulty: number }[]>`
        SELECT w."id", w."difficulty" FROM "Word" w
        WHERE w."status" = 'published' AND w."goalTags" @> ARRAY[${input.goal}]::text[]
        AND w."difficulty" = ${stratum.difficulty}
        AND EXISTS (SELECT 1 FROM "Sense" s WHERE s."wordId" = w."id" AND btrim(s."definitionZh", E' \\t\\r\\n') <> '')
        ORDER BY md5(w."id" || ${seed}) LIMIT ${input.size}
      `,
        ),
      )
    ).flat();
    const eligible = await ctx.prisma.word.findMany({
      where: { id: { in: sampledIds.map((word) => word.id) } },
      include: wordInclude,
    });
    const usable = eligible.filter((word) =>
      word.senses.some((sense) => sense.definitionZh.trim()),
    );
    const selected = stratifiedSample(usable, Math.min(input.size, usable.length), seed);
    if (!selected.length) throw new HttpError(409, 'assessment_content_unavailable');
    const population = Object.fromEntries(strata.map((s) => [String(s.difficulty), s.population]));
    const distractors =
      eligible.length >= 4
        ? eligible
        : await ctx.prisma.word.findMany({
            where: { status: 'published', senses: { some: { definitionZh: { not: '' } } } },
            include: wordInclude,
            orderBy: { normalizedLemma: 'asc' },
            take: 50,
          });
    const scopeVersions = await ctx.prisma.$queryRaw<{ contentVersion: string }[]>`
      SELECT DISTINCT w."contentVersion" FROM "Word" w
      WHERE w."status" = 'published' AND w."goalTags" @> ARRAY[${input.goal}]::text[]
      AND EXISTS (SELECT 1 FROM "Sense" s WHERE s."wordId"=w."id" AND btrim(s."definitionZh", E' \\t\\r\\n') <> '')
    `;
    const items = selected.map((word, ordinal) => ({
      wordId: word.id,
      type: 'spelling',
      stratum: String(word.difficulty),
      ordinal,
      questionJson: json({
        prompt: `请拼写对应的英文词：${word.senses.find((sense) => sense.definitionZh.trim())!.definitionZh}`,
        answer: word.lemma,
        wordVersion: word.contentVersion,
      }),
    }));
    for (const [index, word] of selected.entries()) {
      const correct = word.senses.find((sense) => sense.definitionZh.trim())!,
        seen = new Set([correct.definitionZh]);
      const wrong = distractors
        .filter((w) => w.id !== word.id)
        .map((w) => w.senses.find((sense) => sense.definitionZh.trim()))
        .filter(
          (sense): sense is NonNullable<typeof sense> =>
            !!sense && !seen.has(sense.definitionZh) && !!seen.add(sense.definitionZh),
        )
        .slice(0, 3);
      const options = [correct, ...wrong]
        .map((s) => ({ id: s.id, text: s.definitionZh }))
        .sort((a, b) => digest(`${seed}:${a.id}`).localeCompare(digest(`${seed}:${b.id}`)));
      if (options.length < 2)
        throw new HttpError(409, 'assessment_content_unavailable', '题库不足以生成认知题');
      items.push({
        wordId: word.id,
        type: 'recognition',
        stratum: String(word.difficulty),
        ordinal: selected.length + index,
        questionJson: json({
          prompt: `请选择 “${word.lemma}” 的主要含义`,
          options,
          answer: correct.id,
          wordVersion: word.contentVersion,
        }),
      });
    }
    const assessment = await ctx.prisma.assessment.create({
      data: {
        userId: user.id,
        goal: input.goal,
        blueprintVersion: 'stratified-goal-v2',
        seed: JSON.stringify({
          random: seed,
          population,
          demo: scopeVersions.every((w) => w.contentVersion.startsWith('demo-')),
          scopeVersion: scopeVersions
            .map((w) => w.contentVersion)
            .sort()
            .join('|'),
        }),
        items: { create: items },
      },
      include: { items: { orderBy: { ordinal: 'asc' } } },
    });
    return { assessment: assessmentDto(assessment) };
  });
  app.get('/assessments/:id', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    const assessment = await ctx.prisma.assessment.findFirst({
      where: { id: params.id, userId: user.id },
      include: { items: { orderBy: { ordinal: 'asc' } } },
    });
    if (!assessment) throw new HttpError(404, 'assessment_not_found');
    return {
      assessment: assessmentDto(assessment),
      ...(assessment.status === 'completed' ? { report: assessment.reportJson } : {}),
    };
  });
  app.post('/assessments/:id/answers', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    const input = parse(
        z.object({ commandId, itemId: id, answer: z.string().max(160) }).strict(),
        req.body,
      ),
      hash = digest({ assessmentId: params.id, ...input });
    return transact(ctx.prisma, async (tx) => {
      const lock = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "Assessment" WHERE "id"=${params.id} AND "userId"=${user.id} FOR UPDATE`;
      if (!lock.length) throw new HttpError(404, 'assessment_not_found');
      let assessment = await tx.assessment.findUniqueOrThrow({
        where: { id: params.id },
        include: { items: { orderBy: { ordinal: 'asc' } } },
      });
      const previous = await getReceipt(tx, user.id, input.commandId, hash);
      if (previous)
        return { accepted: true, duplicate: true, assessment: assessmentDto(assessment) };
      const current = assessment.items.find((i) => !i.answeredAt);
      if (assessment.status !== 'in_progress' || current?.id !== input.itemId)
        throw new HttpError(409, 'assessment_item_not_current');
      const answer = String(obj(current.questionJson).answer ?? '');
      const correct =
        current.type === 'spelling'
          ? normalize(input.answer) === normalize(answer)
          : input.answer === answer;
      await tx.assessmentItem.update({
        where: { id: current.id },
        data: {
          answerJson: json({ answer: input.answer }),
          correct,
          score: correct ? 1 : 0,
          answeredAt: new Date(),
        },
      });
      assessment = await tx.assessment.findUniqueOrThrow({
        where: { id: params.id },
        include: { items: { orderBy: { ordinal: 'asc' } } },
      });
      const response = { accepted: true, assessment: assessmentDto(assessment) };
      await tx.commandReceipt.create({
        data: {
          userId: user.id,
          commandId: input.commandId,
          requestHash: hash,
          responseJson: json(response),
        },
      });
      return response;
    });
  });
  app.post('/assessments/:id/finish', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    return transact(ctx.prisma, async (tx) => {
      const lock = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "Assessment" WHERE "id"=${params.id} AND "userId"=${user.id} FOR UPDATE`;
      if (!lock.length) throw new HttpError(404, 'assessment_not_found');
      const assessment = await tx.assessment.findUniqueOrThrow({
        where: { id: params.id },
        include: { items: true },
      });
      if (assessment.status === 'completed') {
        const report = obj(assessment.reportJson);
        return { report, plan: report.suggestedPlan };
      }
      if (assessment.items.some((i) => !i.answeredAt))
        throw new HttpError(409, 'assessment_incomplete');
      const metadata = obj(JSON.parse(assessment.seed)),
        population = obj(metadata.population);
      const byStratum = Object.entries(population).map(([stratum, total]) => {
        const recognition = assessment.items.filter(
            (i) => i.stratum === stratum && i.type === 'recognition',
          ),
          spelling = assessment.items.filter((i) => i.stratum === stratum && i.type === 'spelling');
        return {
          stratum,
          population: Number(total),
          sample: recognition.length,
          recognition: recognition.length
            ? recognition.filter((i) => i.correct).length / recognition.length
            : null,
          spelling: spelling.length
            ? spelling.filter((i) => i.correct).length / spelling.length
            : null,
        };
      });
      const sampled = byStratum.filter((s) => s.sample),
        coveredPopulation = sampled.reduce((sum, s) => sum + s.population, 0);
      const totalCandidates = byStratum.reduce((sum, s) => sum + s.population, 0);
      const accuracy = {
        recognition: coveredPopulation
          ? sampled.reduce((sum, s) => sum + s.population * (s.recognition ?? 0), 0) /
            coveredPopulation
          : 0,
        spelling: coveredPopulation
          ? sampled.reduce((sum, s) => sum + s.population * (s.spelling ?? 0), 0) /
            coveredPopulation
          : 0,
      };
      const testedWordIds = [...new Set(assessment.items.map((i) => i.wordId))];
      const verifiedWordIds = testedWordIds.filter((wordId) =>
        assessment.items.filter((i) => i.wordId === wordId).every((i) => i.correct),
      );
      const reviewPressure = await tx.studyProgress.count({
        where: {
          userId: user.id,
          lastReviewAt: { not: null },
          dueAt: { lte: new Date() },
          word: { status: 'published', userWords: { none: { userId: user.id, paused: true } } },
        },
      });
      const plan = suggestedPlan(accuracy.recognition, accuracy.spelling, reviewPressure);
      const report = {
        goal: assessment.goal,
        version: assessment.blueprintVersion,
        scopeVersion: metadata.scopeVersion,
        sampledWords: testedWordIds.length,
        totalCandidates,
        coveredPopulation,
        accuracy,
        confidence: metadata.demo === false ? 'limited_sample' : 'limited_demo',
        estimateScope:
          coveredPopulation === totalCandidates
            ? metadata.demo === false
              ? 'goal_word_range'
              : 'demo_goal_range'
            : 'sampled_strata_only',
        verifiedWordIds,
        byStratum,
        suggestedPlan: plan,
        disclaimer:
          metadata.demo === false
            ? '基于已安装目标词表的小样本诊断，不是标准化考试能力评估。未测试词不会被标为掌握。'
            : '原创演示词表诊断，不是完整词汇量或考试能力评估。未测试词不会被标为掌握。',
      };
      const old = await tx.masteryProfile.findUnique({
        where: { userId_goal: { userId: user.id, goal: assessment.goal } },
      });
      const oldVerified = obj(old?.evidenceJson).verifiedWordIds;
      const verified = new Set(
        Array.isArray(oldVerified)
          ? oldVerified.map(String).filter((wordId) => !testedWordIds.includes(wordId))
          : [],
      );
      verifiedWordIds.forEach((wordId) => verified.add(wordId));
      await tx.masteryProfile.upsert({
        where: { userId_goal: { userId: user.id, goal: assessment.goal } },
        create: {
          userId: user.id,
          goal: assessment.goal,
          evidenceJson: json({
            ...report,
            verifiedWordIds: [...verified],
            assessmentId: assessment.id,
          }),
        },
        update: {
          evidenceJson: json({
            ...report,
            verifiedWordIds: [...verified],
            assessmentId: assessment.id,
          }),
        },
      });
      await tx.assessment.update({
        where: { id: assessment.id },
        data: { status: 'completed', reportJson: json(report) },
      });
      return { report, plan };
    });
  });
  app.get('/mastery/plan', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      query = parse(z.object({ goal: goal.default('daily') }), req.query);
    const profile = await ctx.prisma.masteryProfile.findUnique({
      where: { userId_goal: { userId: user.id, goal: query.goal } },
    });
    return {
      profile: profile
        ? { goal: profile.goal, updatedAt: profile.updatedAt, evidence: profile.evidenceJson }
        : null,
    };
  });
}
