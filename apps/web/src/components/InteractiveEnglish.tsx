import { Fragment } from 'react';
import { useWordCards } from '../lib/word-cards';

export function InteractiveEnglish({ text }: { text: string }) {
  const cards = useWordCards();
  if (!cards) return <>{text}</>;
  const parts: { text: string; word: boolean; offset: number }[] = [];
  let cursor = 0;
  for (const match of text.matchAll(
    /\p{Script=Latin}[\p{Script=Latin}\p{M}]*(?:['’]\p{Script=Latin}[\p{Script=Latin}\p{M}]*)*(?:-\p{Script=Latin}[\p{Script=Latin}\p{M}]*(?:['’]\p{Script=Latin}[\p{Script=Latin}\p{M}]*)*)*/gu,
  )) {
    const start = match.index;
    if (start > cursor)
      parts.push({ text: text.slice(cursor, start), word: false, offset: cursor });
    parts.push({ text: match[0], word: true, offset: start });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), word: false, offset: cursor });
  return (
    <>
      {parts.map((part) =>
        part.word ? (
          <button
            key={part.offset}
            type="button"
            className="word-token"
            aria-label={`查词 ${part.text}`}
            aria-haspopup="dialog"
            onClick={(event) => cards.openWord(part.text, event.currentTarget)}
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
