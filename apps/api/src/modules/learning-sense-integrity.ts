import { createHash } from 'node:crypto';

export const learningSenseTextHash = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** Recursively sort object keys; arrays retain their declared order. */
export function learningSenseCanonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(learningSenseCanonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + learningSenseCanonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

export interface LearningSenseBindingIdentity {
  sourceSenseId: string;
  relation: string;
  sourcePosSha256: string;
  sourceDefinitionZhSha256: string;
  sourceDefinitionEnSha256: string;
}
export interface LearningSenseIdentity {
  id: string;
  wordId: string;
  pos: string;
  definitionZh: string;
  definitionEn: string;
  contentVersion: string;
  sourceBindings: LearningSenseBindingIdentity[];
}

/** Must match learning-senses-compile.py; hashes raw UTF-8, including whitespace. */
export function learningSenseBindingHash(sense: LearningSenseIdentity): string {
  return learningSenseTextHash(
    learningSenseCanonical({
      id: sense.id,
      wordId: sense.wordId,
      pos: sense.pos,
      definitionZh: sense.definitionZh,
      definitionEn: sense.definitionEn,
      contentVersion: sense.contentVersion,
      sourceBindings: [...sense.sourceBindings]
        .sort((a, b) =>
          a.sourceSenseId < b.sourceSenseId ? -1 : a.sourceSenseId > b.sourceSenseId ? 1 : 0,
        )
        .map((binding) => ({
          sourceSenseId: binding.sourceSenseId,
          relation: binding.relation,
          sourcePosSha256: binding.sourcePosSha256,
          sourceDefinitionZhSha256: binding.sourceDefinitionZhSha256,
          sourceDefinitionEnSha256: binding.sourceDefinitionEnSha256,
        })),
    }),
  );
}

export function learningSenseSourceMatches(
  binding: LearningSenseBindingIdentity & { wordId: string },
  source: { id: string; wordId: string; pos: string; definitionZh: string; definitionEn: string },
): boolean {
  return (
    binding.sourceSenseId === source.id &&
    binding.wordId === source.wordId &&
    binding.sourcePosSha256 === learningSenseTextHash(source.pos) &&
    binding.sourceDefinitionZhSha256 === learningSenseTextHash(source.definitionZh) &&
    binding.sourceDefinitionEnSha256 === learningSenseTextHash(source.definitionEn)
  );
}
