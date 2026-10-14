import { createContext, useContext } from 'react';

export const WordCardContext = createContext<{
  openWord: (text: string, anchor: HTMLElement, mode?: 'hover' | 'pinned') => void;
  leaveWord: (anchor: HTMLElement) => void;
} | null>(null);

export function useWordCards() {
  return useContext(WordCardContext);
}
