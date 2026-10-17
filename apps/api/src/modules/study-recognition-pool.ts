import type { Db } from './shared.js';
import {
  recognitionFocus,
  recognitionPosVariants,
  type RecognitionWord,
} from './study-recognition.js';

/** Query each issued grammatical class within this book, rather than letting
 * frequent nouns consume the whole bounded pool. No examples/audio are loaded. */
export async function loadRecognitionPool(
  db: Pick<Db, 'word'>,
  bookId: string | null,
  targets: { word: RecognitionWord; focusId: string | null }[],
): Promise<RecognitionWord[]> {
  const parts = new Map<string, string[]>();
  for (const target of targets) {
    const focus = recognitionFocus(target.word, target.focusId);
    if (!focus) continue;
    const variants = recognitionPosVariants(focus.pos);
    parts.set(variants.join('|'), variants);
  }
  const words = new Map<string, RecognitionWord>();
  for (const variants of parts.values()) {
    const rows = await db.word.findMany({
      where: {
        status: 'published',
        learningSenses: { some: { status: 'published', pos: { in: variants } } },
        ...(bookId
          ? { bookItems: { some: { bookId } } }
          : { id: { in: targets.map((target) => target.word.id) } }),
      },
      orderBy: { id: 'asc' },
      take: 160,
      select: {
        id: true,
        lemma: true,
        learningSenses: {
          where: { status: 'published', pos: { in: variants } },
          select: {
            id: true,
            wordId: true,
            pos: true,
            definitionZh: true,
            definitionEn: true,
            contentVersion: true,
            status: true,
            bindingHash: true,
            sourceBindings: {
              select: {
                wordId: true,
                learningSenseId: true,
                sourceSenseId: true,
                relation: true,
                sourcePosSha256: true,
                sourceDefinitionZhSha256: true,
                sourceDefinitionEnSha256: true,
                sourceSense: {
                  select: {
                    id: true,
                    wordId: true,
                    pos: true,
                    definitionZh: true,
                    definitionEn: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    for (const row of rows) {
      const previous = words.get(row.id);
      if (!previous) words.set(row.id, row);
      else {
        const senses = new Map(
          (previous.learningSenses ?? []).map((sense) => [sense.id, sense] as const),
        );
        for (const sense of row.learningSenses) senses.set(sense.id, sense);
        previous.learningSenses = [...senses.values()];
      }
    }
  }
  return [...words.values()];
}
