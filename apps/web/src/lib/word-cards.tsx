import { createContext, useContext } from 'react';

export interface WordCardViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface WordCardAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Keep the source sentence visible when there is room; short screens use a small sheet. */
export function wordCardPlacement(
  anchor: WordCardAnchor,
  viewport: WordCardViewport,
  measuredHeight = 330,
) {
  const margin = 12;
  const gap = 8;
  const width = Math.min(viewport.width <= 660 ? 360 : 420, viewport.width - margin * 2);
  const height = Math.min(Math.max(200, measuredHeight), viewport.height - margin * 2);
  const above = anchor.top - viewport.top - margin - gap;
  const below = viewport.top + viewport.height - anchor.bottom - margin - gap;
  const fitsBelow = below >= height;
  const fitsAbove = above >= height;
  const placement = fitsBelow ? 'below' : fitsAbove ? 'above' : 'bottom';
  const top =
    placement === 'below'
      ? anchor.bottom + gap
      : placement === 'above'
        ? anchor.top - height - gap
        : viewport.top + viewport.height - height - margin;
  return {
    placement,
    style: {
      width,
      left: Math.max(
        viewport.left + margin,
        Math.min(anchor.left, viewport.left + viewport.width - width - margin),
      ),
      top: Math.max(viewport.top + margin, top),
      maxHeight: height,
    },
  };
}

export const WordCardContext = createContext<{
  openWord: (text: string, anchor: HTMLElement, mode?: 'hover' | 'pinned') => void;
  leaveWord: (anchor: HTMLElement) => void;
} | null>(null);

export function useWordCards() {
  return useContext(WordCardContext);
}
