/** Public word DTO checks; canonical lemma identity comes from the pinned content. */
export const normalizeDictionaryLemma = (value) =>
  value.normalize('NFKC').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');

export function hasExactPublicWordIdentity(word, fixed) {
  return (
    word !== null &&
    typeof word === 'object' &&
    !Array.isArray(word) &&
    fixed !== null &&
    typeof fixed === 'object' &&
    typeof fixed.wordId === 'string' &&
    fixed.wordId.length > 0 &&
    word.id === fixed.wordId &&
    typeof word.lemma === 'string' &&
    typeof fixed.normalizedLemma === 'string' &&
    fixed.normalizedLemma.length > 0 &&
    normalizeDictionaryLemma(word.lemma) === fixed.normalizedLemma &&
    Array.isArray(word.senses) &&
    Array.isArray(fixed.senses) &&
    fixed.senses.length > 0 &&
    word.senses.length === fixed.senses.length
  );
}
