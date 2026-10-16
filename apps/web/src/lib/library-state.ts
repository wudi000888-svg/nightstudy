export type LibraryView = 'all' | 'unlearned' | 'learning' | 'recent' | 'learned' | 'known';
export type LibrarySort = 'book' | 'az' | 'za' | 'recent';
export interface LibraryConditions {
  bookId: string;
  view: LibraryView;
  q: string;
  sort: LibrarySort;
  anchor: string;
}

export function libraryConditions(params: URLSearchParams): LibraryConditions {
  const bookId = params.get('bookId')?.trim() ?? '';
  const rawView = params.get('view');
  const views: LibraryView[] = bookId
    ? ['all', 'unlearned', 'learning', 'recent', 'learned', 'known']
    : ['learning', 'recent', 'learned'];
  const rawSort = params.get('sort');
  const sort = ['az', 'za', 'recent'].includes(rawSort ?? '')
    ? (rawSort as LibrarySort)
    : bookId && rawSort === 'book'
      ? 'book'
      : bookId
        ? 'book'
        : 'recent';
  const q = params.get('q')?.trim() ?? '';
  return {
    bookId,
    view: views.includes(rawView as LibraryView)
      ? (rawView as LibraryView)
      : bookId
        ? 'all'
        : 'learning',
    q,
    sort,
    // A search is a candidate list. It cannot also jump into the unfiltered list.
    anchor: q ? '' : (params.get('anchor')?.trim() ?? ''),
  };
}

export function libraryParams(conditions: LibraryConditions) {
  const params = new URLSearchParams();
  if (conditions.bookId) params.set('bookId', conditions.bookId);
  params.set('view', conditions.view);
  params.set('sort', conditions.sort);
  if (conditions.q) params.set('q', conditions.q);
  else if (conditions.anchor) params.set('anchor', conditions.anchor);
  return params;
}

export function libraryRequest(conditions: LibraryConditions, cursor?: string | null) {
  const params = libraryParams(conditions);
  params.delete('anchor');
  if (conditions.anchor && !conditions.q && !cursor) params.set('locate', conditions.anchor);
  params.set('limit', '30');
  if (cursor) params.set('cursor', cursor);
  return `library/words?${params}`;
}
