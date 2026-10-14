import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ContextResolver } from '../context.js';
import { parse, normalize, wordInclude } from './shared.js';
import { catalogWordDto } from './content.js';

export async function registerDictionaryResolver(app: FastifyInstance, context: ContextResolver) {
  app.get('/dictionary/resolve', async (request) => {
    const ctx = await context(request);
    const { text } = parse(
      z.object({ text: z.string().trim().min(1).max(80) }).strict(),
      request.query,
    );
    const queried = normalize(text);
    const word = await ctx.prisma.word.findFirst({
      where: { normalizedLemma: queried, status: 'published' },
      include: wordInclude,
    });
    // Prefix results and guessed stemming are never presented as a confirmed lexical match.
    const packs = word ? await ctx.prisma.contentPack.findMany({ where: { status: 'ready' } }) : [];
    return {
      queried,
      matchedLemma: word?.lemma ?? null,
      matchType: word ? 'exact' : 'not-found',
      word: word ? catalogWordDto(word, packs) : null,
    };
  });
}
