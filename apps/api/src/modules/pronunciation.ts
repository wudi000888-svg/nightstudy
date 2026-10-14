import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireUser, type ContextResolver } from '../context.js';
import { id, parse } from './shared.js';
import type { WordAudio } from '@prisma/client';
import { prepareWordAudio, synthesisAvailable, verifiedAudioBytes } from '../audio.js';

export function pronunciationDto(word: {
  id: string;
  lemma: string;
  phonetic: string;
  sourceRef: string;
  phoneticUs?: string;
  phoneticUk?: string;
  phoneticSource?: string;
  audio?: WordAudio[];
}) {
  return {
    wordId: word.id,
    text: word.lemma,
    phonetics: [
      ...(word.phoneticUs
        ? [
            {
              ipa: word.phoneticUs,
              region: 'US',
              notation: 'ipa',
              sourceRef: word.phoneticSource ?? '',
            },
          ]
        : []),
      ...(word.phoneticUk
        ? [
            {
              ipa: word.phoneticUk,
              region: 'UK',
              notation: 'ipa',
              sourceRef: word.phoneticSource ?? '',
            },
          ]
        : []),
      ...(word.phonetic
        ? [
            {
              ipa: word.phonetic,
              region: 'unspecified',
              notation: 'source-transcription',
              sourceRef: word.sourceRef,
            },
          ]
        : []),
    ],
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
    recordedAudioAvailable: (word.audio ?? []).some((audio) => audio.kind === 'recorded'),
    generationAvailable: synthesisAvailable(),
    speech: {
      provider: 'browser',
      languageChoices: ['en-US', 'en-GB'],
      requiresAvailableVoice: true,
    },
  };
}

export async function registerPronunciation(app: FastifyInstance, getContext: ContextResolver) {
  app.get('/pronunciation/:wordId', async (req) => {
    const ctx = await getContext(req),
      params = parse(z.object({ wordId: id }), req.params);
    const word = await ctx.prisma.word.findFirst({
      where: { id: params.wordId, status: 'published' },
      select: {
        id: true,
        lemma: true,
        phonetic: true,
        sourceRef: true,
        phoneticUs: true,
        phoneticUk: true,
        phoneticSource: true,
        audio: { where: { status: 'ready' } },
      },
    });
    if (!word) throw new HttpError(404, 'word_not_found');
    return { pronunciation: pronunciationDto(word) };
  });
  app.get('/pronunciation/:wordId/audio/:accent', async (req, reply) => {
    const ctx = await getContext(req);
    const params = parse(z.object({ wordId: id, accent: z.enum(['US', 'UK']) }), req.params);
    const entry = await ctx.prisma.wordAudio.findFirst({
      where: {
        wordId: params.wordId,
        accent: params.accent,
        status: 'ready',
        word: { status: 'published' },
      },
    });
    if (!entry) throw new HttpError(404, 'audio_not_ready');
    const bytes = await verifiedAudioBytes(entry);
    const etag = `"${entry.fileSha256}"`;
    reply
      .type(entry.mimeType)
      .header('ETag', etag)
      .header('Cache-Control', 'public, max-age=0, must-revalidate');
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.send(bytes);
  });
  app.post('/pronunciation/:wordId/prepare', async (req, reply) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    parse(z.object({}).strict(), req.body ?? {});
    const { wordId } = parse(z.object({ wordId: id }), req.params);
    const key = `audio:${ctx.siteId}:${user.id}:${Math.floor(Date.now() / 60000)}`;
    const rows = await ctx.prisma.$queryRaw<
      Array<{ count: number }>
    >`INSERT INTO "RateBucket" ("key","count","expiresAt") VALUES (${key},1,NOW()+INTERVAL '2 minutes') ON CONFLICT ("key") DO UPDATE SET "count"="RateBucket"."count"+1 RETURNING "count"`;
    if ((rows[0]?.count ?? 0) > 20) {
      reply.header('Retry-After', '60');
      throw new HttpError(429, 'audio_generation_rate_limit');
    }
    const word = await ctx.prisma.word.findFirst({ where: { id: wordId, status: 'published' } });
    if (!word) throw new HttpError(404, 'word_not_found');
    await prepareWordAudio(ctx.prisma, word);
    return {
      pronunciation: pronunciationDto({
        ...word,
        audio: await ctx.prisma.wordAudio.findMany({ where: { wordId, status: 'ready' } }),
      }),
    };
  });
}
