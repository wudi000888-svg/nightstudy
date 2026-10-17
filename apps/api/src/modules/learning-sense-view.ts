import type { LearningSense, SenseSourceBinding, Sense, WordExample } from '@prisma/client';
import {
  learningSenseBindingHash,
  learningSenseSourceMatches,
  learningSenseTextHash,
} from './learning-sense-integrity.js';

export type AtomicLearningSense = LearningSense & {
  sourceBindings: (SenseSourceBinding & { sourceSense: Sense })[];
  examples: WordExample[];
};
/** The proof needed to verify a meaning, without loading editorial metadata or examples. */
export type VerifiableLearningSense = Pick<
  LearningSense,
  | 'id'
  | 'wordId'
  | 'pos'
  | 'definitionZh'
  | 'definitionEn'
  | 'contentVersion'
  | 'status'
  | 'bindingHash'
> & {
  sourceBindings: (Pick<
    SenseSourceBinding,
    | 'wordId'
    | 'learningSenseId'
    | 'sourceSenseId'
    | 'relation'
    | 'sourcePosSha256'
    | 'sourceDefinitionZhSha256'
    | 'sourceDefinitionEnSha256'
  > & {
    sourceSense: Pick<Sense, 'id' | 'wordId' | 'pos' | 'definitionZh' | 'definitionEn'>;
  })[];
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
export function verifiedLearningSenses<T extends VerifiableLearningSense>(word: {
  id: string;
  learningSenses?: T[];
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

/** Reviewed case variants remain the same lexical identity; no title-casing inference. */
export function reviewedSenseDisplayLemma(
  sense: { contentMetadata?: unknown },
  lemma: string,
): string | undefined {
  const metadata = sense.contentMetadata as Record<string, unknown> | null;
  const raw = metadata?.orthography;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const orthography = raw as Record<string, unknown>;
  const normalizedLemma = lemma.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
  const display = orthography.displayLemma;
  if (
    Object.keys(orthography).sort().join('|') !==
      'decision|displayLemma|displayLemmaSha256|expertCertified|normalizedLemma|reason|reviewer' ||
    typeof display !== 'string' ||
    !display.length ||
    display.length > 500 ||
    display !== display.normalize('NFKC').trim().replace(/\s+/gu, ' ') ||
    display.toLowerCase() !== normalizedLemma ||
    orthography.normalizedLemma !== normalizedLemma ||
    orthography.displayLemmaSha256 !== learningSenseTextHash(display) ||
    orthography.reviewer !== 'Codex' ||
    orthography.decision !== 'publish' ||
    orthography.expertCertified !== false ||
    typeof orthography.reason !== 'string' ||
    orthography.reason.length < 15 ||
    orthography.reason.length > 4000
  )
    return undefined;
  return display;
}

export function atomicSenseView(sense: AtomicLearningSense, lemma?: string) {
  const displayLemma = lemma ? reviewedSenseDisplayLemma(sense, lemma) : undefined;
  return {
    ...sense,
    ...(displayLemma ? { displayLemma } : {}),
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
