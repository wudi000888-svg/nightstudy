import { expect, it } from 'vitest';
import { libraryConditions, libraryParams, libraryRequest } from './library-state';

it('separates a full book browser from cross-book learning history', () => {
  expect(libraryConditions(new URLSearchParams('bookId=cet4'))).toEqual({
    bookId: 'cet4',
    view: 'all',
    sort: 'book',
    q: '',
    anchor: '',
  });
  expect(libraryConditions(new URLSearchParams('view=unlearned&sort=book'))).toEqual({
    bookId: '',
    view: 'learning',
    sort: 'recent',
    q: '',
    anchor: '',
  });
  expect(libraryConditions(new URLSearchParams('bookId=cet4&view=known&sort=za')).view).toBe(
    'known',
  );
});

it('searches within the selected status and book without silently opening a detail', () => {
  const conditions = libraryConditions(
    new URLSearchParams('bookId=cet4&view=learned&q=CLAIM&sort=az&anchor=old'),
  );
  expect(conditions.anchor).toBe('');
  const path = libraryRequest(conditions);
  expect(path).toBe('library/words?bookId=cet4&view=learned&sort=az&q=CLAIM&limit=30');
  expect(path).not.toContain('words/');
});

it('locates the first page and then follows the signed server cursor without relocating every page', () => {
  const conditions = libraryConditions(
    new URLSearchParams('bookId=ielts&view=all&sort=za&anchor=word-claim'),
  );
  expect(String(libraryParams(conditions))).toBe('bookId=ielts&view=all&sort=za&anchor=word-claim');
  expect(libraryRequest(conditions)).toBe(
    'library/words?bookId=ielts&view=all&sort=za&locate=word-claim&limit=30',
  );
  expect(libraryRequest(conditions, 'signed+cursor')).toBe(
    'library/words?bookId=ielts&view=all&sort=za&limit=30&cursor=signed%2Bcursor',
  );
});

it('retains unicode queries and explicit sorting across route restoration', () => {
  const original = libraryConditions(new URLSearchParams('view=recent&q=%E6%B0%B4&sort=az'));
  expect(libraryConditions(libraryParams(original))).toEqual(original);
  expect(
    libraryConditions(new URLSearchParams('bookId=book&sort=javascript:alert(1)&view=unknown'))
      .sort,
  ).toBe('book');
});
