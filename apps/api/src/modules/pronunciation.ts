import { sendVerifiedAudio } from '../audio-response.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, type ContextResolver } from '../context.js';
import { id, parse } from './shared.js';
import type { WordAudio } from '@prisma/client';
import { verifiedAudioBytes } from '../audio.js';

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
  };
}

export async function registerPronunciation(app: FastifyInstance, getContext: ContextResolver) {
  const sentenceParams = z.object({ textHash: z.string().regex(/^[a-f0-9]{64}$/) });
  app.get('/sentence-audio/:textHash', async (req) => {
    const ctx = await getContext(req);
    const { textHash } = parse(sentenceParams, req.params);
    const entries = await ctx.prisma.sentenceAudio.findMany({
      where: { textHash, status: 'ready' },
      orderBy: { accent: 'asc' },
    });
    return {
      sentence: {
        textHash,
        text: entries[0]?.text ?? null,
        audio: entries.map((entry) => ({
          accent: entry.accent,
          kind: entry.kind,
          status: 'ready',
          url: `/api/v2/sentence-audio/${textHash}/audio/${entry.accent}`,
          mimeType: entry.mimeType,
        })),
      },
    };
  });
  app.get('/sentence-audio/:textHash/audio/:accent', async (req, reply) => {
    const ctx = await getContext(req);
    const { textHash, accent } = parse(
      sentenceParams.extend({ accent: z.enum(['US', 'UK']) }),
      req.params,
    );
    const entry = await ctx.prisma.sentenceAudio.findFirst({
      where: { textHash, accent, status: 'ready' },
    });
    if (!entry) throw new HttpError(404, 'audio_not_ready');
    const bytes = await verifiedAudioBytes(entry);
    return sendVerifiedAudio(req, reply, bytes, entry);
  });
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
    return sendVerifiedAudio(req, reply, bytes, entry);
  });
}
