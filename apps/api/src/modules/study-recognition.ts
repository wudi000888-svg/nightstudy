import { randomInt, randomUUID } from 'node:crypto';
import { verifiedLearningSenses, type VerifiableLearningSense } from './learning-sense-view.js';
import { normalize, obj } from './shared.js';
import { recognitionWordsConfusable } from './recognition-confusables.js';

export interface RecognitionQuestion {
  options: { id: string; text: string; pos: string }[];
  correctOptionId: string;
  selectedOptionId?: string;
}
const clean = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
const tokens = (text: string) =>
  clean(text)
    .split(/[，,；;、。.!！?？（）()\s]+/)
    .filter((t) => t.length > 1 || /[\u3400-\u9fff]/u.test(t));
const part = (pos: string) => pos.replace(/[.\s]/g, '').replace(/^v[ti]$/, 'v');
export type RecognitionWord = {
  id: string;
  lemma: string;
  learningSenses?: VerifiableLearningSense[];
};
const usable = (sense: { definitionZh: string; definitionEn: string; pos: string }) =>
  sense.pos.trim() &&
  sense.definitionEn.trim() &&
  /[\u3400-\u9fff]/u.test(sense.definitionZh) &&
  clean(sense.definitionZh).length <= 120 &&
  !/待补|待审核|暂无|TODO/i.test(sense.definitionZh);

export function recognitionFocus(word: RecognitionWord, focusId: string | null) {
  return verifiedLearningSenses(word).find(
    (sense) =>
      usable(sense) &&
      (sense.id === focusId ||
        sense.sourceBindings.some((binding) => binding.sourceSenseId === focusId)),
  );
}

export function recognitionPosVariants(pos: string) {
  return part(pos) === 'v' ? ['v.', 'vt.', 'vi.'] : [pos];
}

/** Only verified, source-bound meanings may enter an issued recognition question. */
export function createRecognitionQuestion(
  word: RecognitionWord,
  focusId: string | null,
  pool: RecognitionWord[],
): RecognitionQuestion | null {
  const meanings = verifiedLearningSenses(word);
  const focus = recognitionFocus(word, focusId);
  if (!focus || !usable(focus)) return null;
  const forbidden = meanings.flatMap((s) => [clean(s.definitionZh), ...tokens(s.definitionZh)]);
  const targetLemma = normalize(word.lemma);
  const candidates: { id: string; text: string; pos: string }[] = [];
  const chosenLemmas: string[] = [];
  const option = (sense: { id: string; definitionZh: string; pos: string }) => ({
    id: randomUUID(),
    text: clean(sense.definitionZh),
    pos: sense.pos,
  });
  const correct = option(focus);
  const shuffled = [...pool];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
  }
  for (const candidate of shuffled) {
    const lemma = normalize(candidate.lemma);
    if (candidate.id === word.id || lemma.includes(targetLemma) || targetLemma.includes(lemma))
      continue;
    if (
      recognitionWordsConfusable(targetLemma, lemma) ||
      chosenLemmas.some((previous) => recognitionWordsConfusable(previous, lemma))
    )
      continue;
    for (const sense of verifiedLearningSenses(candidate)) {
      if (!usable(sense) || part(sense.pos) !== part(focus.pos)) continue;
      const value = option(sense),
        pieces = tokens(value.text);
      if (
        pieces.some((t) => forbidden.some((f) => t.includes(f) || f.includes(t))) ||
        candidates.some(
          (c) => c.text === value.text || tokens(c.text).some((t) => pieces.includes(t)),
        )
      )
        continue;
      candidates.push(value);
      chosenLemmas.push(lemma);
      break;
    }
    if (candidates.length === 3) break;
  }
  if (candidates.length < 2) return null;
  const options = [...candidates, correct].sort((a, b) => a.id.localeCompare(b.id));
  return { options, correctOptionId: correct.id };
}

export function readRecognitionQuestion(value: unknown): RecognitionQuestion | null {
  const raw = obj(value);
  if (
    !Array.isArray(raw.options) ||
    raw.options.length < 3 ||
    raw.options.length > 4 ||
    typeof raw.correctOptionId !== 'string'
  )
    return null;
  const options = raw.options.map(obj);
  if (
    options.some(
      (v) =>
        typeof v.id !== 'string' ||
        typeof v.text !== 'string' ||
        !v.text.trim() ||
        typeof v.pos !== 'string',
    )
  )
    return null;
  if (
    new Set(options.map((v) => v.id)).size !== options.length ||
    !options.some((v) => v.id === raw.correctOptionId)
  )
    return null;
  if (raw.selectedOptionId !== undefined && !options.some((v) => v.id === raw.selectedOptionId))
    return null;
  return {
    options: options as unknown as RecognitionQuestion['options'],
    correctOptionId: raw.correctOptionId,
    ...(typeof raw.selectedOptionId === 'string' ? { selectedOptionId: raw.selectedOptionId } : {}),
  };
}
