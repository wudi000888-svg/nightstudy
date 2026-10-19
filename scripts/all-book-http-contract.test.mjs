import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasExactPublicWordIdentity,
  normalizeDictionaryLemma,
} from './all-book-http-contract.mjs';

const fixed = {
  wordId: 'pinned-word-id',
  normalizedLemma: "one's own",
  senses: [{ id: 'meaning-one' }, { id: 'meaning-two' }],
};
const publicWord = {
  id: fixed.wordId,
  lemma: "one's own",
  senses: [{ id: 'meaning-one' }, { id: 'meaning-two' }],
};

test('the actual public DTO need not expose normalizedLemma', () => {
  assert.equal(Object.hasOwn(publicWord, 'normalizedLemma'), false);
  assert.equal(hasExactPublicWordIdentity(publicWord, fixed), true);
});

test('lemma identity follows the importer and shared API normalization', () => {
  assert.equal(normalizeDictionaryLemma('  ＯＮＥ’S\t  ＯＷＮ  '), "one's own");
  assert.equal(normalizeDictionaryLemma('ONE‘S\nOWN'), "one's own");
  assert.equal(
    hasExactPublicWordIdentity({ ...publicWord, lemma: '  ＯＮＥ’S\t  ＯＷＮ  ' }, fixed),
    true,
  );
});

test('a different public word id fails even when lemma and count match', () => {
  assert.equal(hasExactPublicWordIdentity({ ...publicWord, id: 'other-id' }, fixed), false);
});

test('a different or absent public lemma fails even when id and count match', () => {
  for (const lemma of ['another lemma', '', '   ', null, undefined])
    assert.equal(hasExactPublicWordIdentity({ ...publicWord, lemma }, fixed), false);
});

test('missing, empty, fewer and additional public senses all fail', () => {
  for (const senses of [
    undefined,
    null,
    {},
    [],
    [publicWord.senses[0]],
    [...publicWord.senses, { id: 'unpublished-meaning' }],
  ])
    assert.equal(hasExactPublicWordIdentity({ ...publicWord, senses }, fixed), false);
});

test('empty or malformed pinned identities cannot validate an empty response', () => {
  for (const malformed of [
    null,
    {},
    { ...fixed, wordId: '' },
    { ...fixed, normalizedLemma: '' },
    { ...fixed, senses: [] },
    { ...fixed, senses: null },
  ])
    assert.equal(hasExactPublicWordIdentity(publicWord, malformed), false);
  assert.equal(
    hasExactPublicWordIdentity({ ...publicWord, senses: [] }, { ...fixed, senses: [] }),
    false,
  );
});

test('null, absent and array responses fail without throwing', () => {
  for (const word of [null, undefined, [], 'word'])
    assert.equal(hasExactPublicWordIdentity(word, fixed), false);
});

test('an invented normalizedLemma cannot replace the public lemma check', () => {
  assert.equal(
    hasExactPublicWordIdentity(
      { ...publicWord, lemma: 'wrong', normalizedLemma: fixed.normalizedLemma },
      fixed,
    ),
    false,
  );
});
