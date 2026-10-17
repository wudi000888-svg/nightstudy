import type { Sense, Word } from './types';

const normalized = (value: string) => value.toLowerCase();

/** Only accept the explicit API spelling; never infer it from sentence case or metadata. */
export function senseDisplayLemma(word: Pick<Word, 'lemma'>, sense?: Pick<Sense, 'displayLemma'>) {
  const value = sense?.displayLemma;
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 300 &&
    value.trim() === value &&
    value.normalize('NFKC') === value &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    normalized(value) === normalized(word.lemma)
    ? value
    : undefined;
}

export function wordDisplayLemma(
  word: Pick<Word, 'lemma' | 'displayLemma'>,
  sense?: Pick<Sense, 'displayLemma'>,
) {
  return (
    senseDisplayLemma(word, sense) ??
    (sense ? word.lemma : (senseDisplayLemma(word, word) ?? word.lemma))
  );
}

/** Lists describe all explicitly reviewed case variants instead of choosing an arbitrary meaning. */
export function wordSpellingVariants(word: Pick<Word, 'lemma' | 'displayLemma' | 'senses'>) {
  const variants = [
    ...new Set(
      (word.senses ?? [])
        .map((sense) => senseDisplayLemma(word, sense))
        .filter((value): value is string => !!value),
    ),
  ];
  return variants.length ? variants : [wordDisplayLemma(word)];
}

export function wordSpellingLabel(word: Pick<Word, 'lemma' | 'displayLemma' | 'senses'>) {
  return wordSpellingVariants(word).join(' / ');
}
