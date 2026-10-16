import type { LearningSense, SenseSourceBinding, Sense, WordExample } from '@prisma/client';
import {
  learningSenseBindingHash,
  learningSenseSourceMatches,
} from './learning-sense-integrity.js';

export type AtomicLearningSense = LearningSense & {
  sourceBindings: (SenseSourceBinding & { sourceSense: Sense })[];
  examples: WordExample[];
};
export const learningSensesInclude = {
  orderBy: [{ ordinal: 'asc' as const }, { id: 'asc' as const }],
  include: {
    sourceBindings: { include: { sourceSense: true } },
    examples: {
      where: { status: 'published' },
      orderBy: [{ ordinal: 'asc' as const }, { id: 'asc' as const }],
    },
  },
};

/** Held heteronyms remain blocked until an accent/meaning-specific asset is reviewed. */
export function wordPronunciationCompatible(word: {
  learningSenses?: { status: string; contentMetadata: unknown }[];
}) {
  return !(word.learningSenses ?? []).some((sense) => {
    if (!['published', 'held'].includes(sense.status)) return false;
    const metadata = sense.contentMetadata as Record<string, unknown> | null;
    const pronunciation = metadata?.pronunciation as Record<string, unknown> | undefined;
    return pronunciation?.wordAudioCompatible === false;
  });
}

/** Invalid source evidence cannot be turned into current learning content. */
export function verifiedLearningSenses(word: {
  id: string;
  learningSenses?: AtomicLearningSense[];
}) {
  return (word.learningSenses ?? []).filter(
    (sense) =>
      sense.wordId === word.id &&
      sense.status === 'published' &&
      sense.sourceBindings.length > 0 &&
      sense.bindingHash === learningSenseBindingHash(sense) &&
      sense.sourceBindings.every(
        (binding) =>
          binding.wordId === word.id &&
          binding.learningSenseId === sense.id &&
          learningSenseSourceMatches(binding, binding.sourceSense),
      ),
  );
}

export function atomicSenseView(sense: AtomicLearningSense) {
  return {
    ...sense,
    kind: 'learning' as const,
    exampleEn: '',
    exampleZh: '',
    sourceSenseIds: sense.sourceBindings.map((binding) => binding.sourceSenseId),
    examples: sense.examples.filter(
      (example) =>
        example.wordId === sense.wordId &&
        example.learningSenseId === sense.id &&
        example.status === 'published' &&
        example.contentVersion === sense.contentVersion &&
        example.exampleEn.trim() &&
        example.exampleZh.trim() &&
        example.contextLabel.trim(),
    ),
  };
}
