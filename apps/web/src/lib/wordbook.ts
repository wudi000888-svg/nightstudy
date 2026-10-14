import type { QueryClient } from '@tanstack/react-query';
import { post } from './api';
import type { WordbookItem } from './types';

export type WordbookEntry = Pick<WordbookItem, 'id' | 'wordId' | 'note' | 'favorite' | 'paused'>;
export interface WordCollection {
  inWordbook: boolean;
  wordbookStatus: 'active' | 'consolidated' | null;
  known: 'manual' | 'automatic' | null;
}
export interface WordbookEntryResponse {
  item: WordbookEntry | null;
  consolidatedItem?: (WordbookEntry & { graduatedAt: string }) | null;
  collection?: WordCollection;
}
interface WordbookSaveReceipt {
  item: WordbookEntry;
  added: boolean;
  alreadySaved: boolean;
  collection?: WordCollection;
}
interface WordbookRemoveReceipt {
  deleted: boolean;
  progressRetained: boolean;
  collection?: WordCollection;
}
export const wordbookEntryPath = (wordId: string) => `wordbook/${encodeURIComponent(wordId)}`;
export const wordbookEntryKey = (scope: string, wordId: string) => [
  scope,
  'wordbook-entry',
  wordbookEntryPath(wordId),
];
export function isWordbookSaved(entry: WordbookEntryResponse | undefined, wordId: string) {
  return entry?.item?.wordId === wordId || entry?.consolidatedItem?.wordId === wordId;
}

// Publish the accepted mutation receipt before refreshing the list. A later list
// network failure must not turn an accepted save into an apparently failed save.
export async function mutateWordbook(
  client: QueryClient,
  scope: string,
  wordId: string,
  remove: boolean,
  isCurrent: () => boolean,
) {
  const queryKey = wordbookEntryKey(scope, wordId);
  await client.cancelQueries({ queryKey, exact: true });
  if (!isCurrent()) return null;
  const receipt = remove
    ? await post<WordbookRemoveReceipt>(wordbookEntryPath(wordId), {}, 'DELETE')
    : await post<WordbookSaveReceipt>('wordbook', { wordId });
  if (!isCurrent()) return null;
  const entry: WordbookEntryResponse = {
    item: 'item' in receipt ? receipt.item : null,
    consolidatedItem: null,
    collection: receipt.collection,
  };
  client.setQueryData(queryKey, entry);
  void client.resetQueries({ queryKey: [scope, 'wordbook'] }).catch(() => {});
  return receipt;
}
