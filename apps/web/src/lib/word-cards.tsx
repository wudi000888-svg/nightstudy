import { createContext, useContext } from 'react';

export const WordCardContext = createContext<{
  openWord: (text: string, anchor: HTMLElement) => void;
} | null>(null);

export function useWordCards() {
  return useContext(WordCardContext);
}
