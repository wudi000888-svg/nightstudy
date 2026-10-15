import { expect, it } from 'vitest';
import { normalizeSentence, sentenceAudioHash } from './sentence-audio';
import { sentenceTextHash } from '../../../api/src/audio';
it('matches the API and offline identity across Unicode punctuation and whitespace', async () => {
  const text = '  Ｉ’m  “ready”.\nLet’s go!  ';
  expect(normalizeSentence(text)).toBe('I\'m "ready". Let\'s go!');
  expect(await sentenceAudioHash(text)).toBe(sentenceTextHash(text));
});
it('does not confuse differently cased English pronunciation or distinct sentences', async () => {
  expect(await sentenceAudioHash('US')).not.toBe(await sentenceAudioHash('us'));
  expect(await sentenceAudioHash('A good day.')).not.toBe(await sentenceAudioHash('A good day?'));
});
