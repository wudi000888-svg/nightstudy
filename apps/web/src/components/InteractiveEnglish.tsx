import { Fragment } from 'react';
import { useWordCards } from '../lib/word-cards';

interface EnglishPart {
  text: string;
  word: boolean;
  offset: number;
}

// Scan complete words before validating ASCII English. Scanning ASCII fragments
// directly would turn café into a misleading "caf" dictionary lookup.
export function englishParts(text: string): EnglishPart[] {
  const parts: EnglishPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(
    /[\p{L}\p{M}\p{N}_]+(?:['’\-\u2010\u2011][\p{L}\p{M}\p{N}_]+)*/gu,
  )) {
    const start = match.index;
    if (start > cursor)
      parts.push({ text: text.slice(cursor, start), word: false, offset: cursor });
    parts.push({
      text: match[0],
      word: /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(match[0]),
      offset: start,
    });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), word: false, offset: cursor });
  return parts;
}

export function InteractiveEnglish({ text, enabled = true }: { text: string; enabled?: boolean }) {
  const cards = useWordCards();
  if (!enabled || !cards) return <>{text}</>;
  return (
    <>
      {englishParts(text).map((part) =>
        part.word ? (
          <button
            key={part.offset}
            type="button"
            className="word-token"
            aria-label={`查词 ${part.text}`}
            aria-haspopup="dialog"
            onPointerEnter={(event) => {
              if (
                event.pointerType === 'mouse' &&
                window.matchMedia('(hover: hover) and (pointer: fine)').matches
              )
                cards.openWord(part.text, event.currentTarget, 'hover');
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === 'mouse') cards.leaveWord(event.currentTarget);
            }}
            onClick={(event) => cards.openWord(part.text, event.currentTarget, 'pinned')}
          >
            {part.text}
          </button>
        ) : (
          <Fragment key={part.offset}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
