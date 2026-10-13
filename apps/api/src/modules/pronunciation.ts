import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, type ContextResolver } from '../context.js';
import { id, parse } from './shared.js';

export function pronunciationDto(word: {
  id: string;
  lemma: string;
  phonetic: string;
  sourceRef: string;
  phoneticUs?: string;
  phoneticUk?: string;
  phoneticSource?: string;
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
    audio: [],
    recordedAudioAvailable: false,
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
      },
    });
    if (!word) throw new HttpError(404, 'word_not_found');
    return { pronunciation: pronunciationDto(word) };
  });
}
