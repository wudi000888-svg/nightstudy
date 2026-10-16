import type { PageInfo, WordbookItem } from './types';

export type LookupMatch = 'smart' | 'prefix' | 'contains' | 'exact';
export type LookupSort = 'relevance' | 'az' | 'za' | 'updated-desc';
export type LookupKind = 'lookup' | 'wordbook';
export interface LookupConditions {
  q: string;
  match: LookupMatch;
  sort: LookupSort;
  status: 'active' | 'consolidated' | 'all';
}
export interface DictionaryBrief {
  id: string;
  lemma: string;
  normalizedLemma: string;
  pos: string[];
  definitionZh: string;
  definitionEn: string;
  matchType: 'exact' | 'prefix' | 'contains' | null;
  collection: { inWordbook: boolean; wordbookStatus: 'active' | 'consolidated' | null };
}
export interface LookupSuggestion {
  id: string;
  lemma: string;
  matchType: 'spelling';
}
export type WordbookBrief = Omit<WordbookItem, 'word'> & { word: DictionaryBrief };
export interface LookupResponse {
  items: (DictionaryBrief | WordbookBrief)[];
  page: Omit<PageInfo, 'total'> & { total: number | null };
  suggestions: LookupSuggestion[];
  query: Omit<LookupConditions, 'status'> & {
    status?: LookupConditions['status'];
    effectiveMatch?: LookupMatch | 'all' | 'none';
  };
  revision: { catalog: string; collection?: string };
}
export function lookupConditions(params: URLSearchParams, kind: LookupKind): LookupConditions {
  const q = (params.get('q') ?? '').trim();
  const match = params.get('match');
  const sort = params.get('sort');
  const status = params.get('status');
  return {
    q,
    match: match === 'prefix' || match === 'contains' || match === 'exact' ? match : 'smart',
    sort:
      sort === 'az' ||
      sort === 'za' ||
      sort === 'relevance' ||
      (kind === 'wordbook' && sort === 'updated-desc')
        ? sort
        : kind === 'wordbook' && !q
          ? 'updated-desc'
          : 'relevance',
    status: status === 'consolidated' || status === 'all' ? status : 'active',
  };
}
export function lookupParams(
  conditions: LookupConditions,
  kind: LookupKind,
  entry?: string,
  sense?: string,
) {
  const next = new URLSearchParams();
  if (conditions.q) next.set('q', conditions.q);
  next.set('match', conditions.match);
  next.set('sort', conditions.sort);
  if (kind === 'wordbook') next.set('status', conditions.status);
  if (entry) next.set('entry', entry);
  if (entry && sense) next.set('sense', sense);
  return next;
}
export function lookupRequest(
  conditions: LookupConditions,
  kind: LookupKind,
  cursor?: string | null,
) {
  const params = lookupParams(conditions, kind);
  params.set('limit', '20');
  if (cursor) params.set('cursor', cursor);
  return `${kind === 'wordbook' ? 'wordbook' : 'dictionary'}?${params}`;
}
export function isWordbookBrief(item: DictionaryBrief | WordbookBrief): item is WordbookBrief {
  return 'wordId' in item;
}
