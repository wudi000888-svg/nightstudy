import { expect, it } from 'vitest';
import { senseDisplayLemma, wordDisplayLemma, wordSpellingLabel } from './word-spelling';
import type { Word } from './types';

const word: Word = {
  id: 'case-shared-word',
  lemma: 'Polish',
  senses: [
    { id: 'polish-surface', displayLemma: 'polish', definitionZh: '擦亮' },
    { id: 'polish-language', displayLemma: 'Polish', definitionZh: '波兰语' },
  ],
};

it('uses the explicit spelling of the selected meaning without changing word identity', () => {
  expect(wordDisplayLemma(word, word.senses![0])).toBe('polish');
  expect(wordDisplayLemma(word, word.senses![1])).toBe('Polish');
  expect(word.id).toBe('case-shared-word');
  expect(wordSpellingLabel(word)).toBe('polish / Polish');
});

it('accepts only case-equivalent API spellings and ignores unchecked metadata', () => {
  for (const displayLemma of [
    'polished',
    'Polish people',
    'Polish\n',
    'Ｐｏｌｉｓｈ',
    '',
    'another',
  ])
    expect(senseDisplayLemma(word, { displayLemma })).toBeUndefined();
  const value = {
    ...word,
    senses: [
      {
        id: 'raw',
        definitionZh: '擦亮',
        contentMetadata: { orthography: { displayLemma: 'polish' } },
      },
    ],
  };
  expect(wordSpellingLabel(value)).toBe('Polish');
  expect(wordDisplayLemma({ lemma: 'AM', displayLemma: 'am' })).toBe('am');
  expect(wordDisplayLemma({ lemma: 'AM', displayLemma: 'am' }, {})).toBe('AM');
  expect(wordDisplayLemma({ lemma: 'AM', displayLemma: 'anything' })).toBe('AM');
  expect(senseDisplayLemma({ lemma: 'carry on' }, { displayLemma: 'carry  on' })).toBeUndefined();
});

it('shows a reviewed proper name alone and never invents title case from examples', () => {
  expect(
    wordSpellingLabel({
      lemma: 'william',
      senses: [{ id: 'name', displayLemma: 'William', definitionZh: '威廉' }],
    }),
  ).toBe('William');
  expect(
    wordSpellingLabel({
      lemma: 'polish',
      senses: [{ id: 'verb', definitionZh: '擦亮', exampleEn: 'Polish the glass.' }],
    }),
  ).toBe('polish');
});
