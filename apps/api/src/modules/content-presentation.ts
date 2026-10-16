const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const definitionFields = ['definitionZh', 'definitionEn'] as const;
const exampleFields = ['exampleEn', 'exampleZh'] as const;
const textPresent = (value: unknown): value is string =>
  typeof value === 'string' && Boolean(value.trim());
const sameText = (left: unknown, right: unknown) =>
  textPresent(left) && textPresent(right) && left === right;

export function mergeLexicalWarnings(
  ...lists: unknown[]
): Array<{ code: string; message: string }> {
  const result: Array<{ code: string; message: string }> = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const warning = obj(raw);
      if (!textPresent(warning.code) || !textPresent(warning.message)) continue;
      const value = { code: warning.code.trim(), message: warning.message.trim() };
      const key = JSON.stringify(value);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(value);
      }
    }
  }
  return result;
}
export function senseLexicalWarnings(senses: readonly { contentMetadata?: unknown }[]) {
  return mergeLexicalWarnings(...senses.map((sense) => obj(sense.contentMetadata).lexicalWarnings));
}

type ContentText = {
  definitionZh?: unknown;
  definitionEn?: unknown;
  exampleEn?: unknown;
  exampleZh?: unknown;
};
export function contentCoverage(
  senses: readonly ContentText[],
  examples: readonly ContentText[] = [],
) {
  return {
    definitionZh: senses.some((sense) => textPresent(sense.definitionZh)),
    definitionEn: senses.some((sense) => textPresent(sense.definitionEn)),
    exampleEn: [...senses, ...examples].some((example) => textPresent(example.exampleEn)),
    exampleZh: [...senses, ...examples].some((example) => textPresent(example.exampleZh)),
    bilingualSenseCount: senses.filter(
      (sense) => textPresent(sense.definitionZh) && textPresent(sense.definitionEn),
    ).length,
    bilingualExampleCount: [...senses, ...examples].filter(
      (example) => textPresent(example.exampleEn) && textPresent(example.exampleZh),
    ).length,
  };
}

/** Include available languages without claiming that independent senses are translations of each other. */
export function summarySenses<T extends ContentText>(senses: T[], limit = 3): T[] {
  const selected = new Set<T>();
  const take = (sense: T | undefined) => {
    if (sense && selected.size < limit) selected.add(sense);
  };
  take(senses.find((sense) => textPresent(sense.definitionZh) && textPresent(sense.definitionEn)));
  if (![...selected].some((sense) => textPresent(sense.definitionZh)))
    take(senses.find((sense) => textPresent(sense.definitionZh)));
  if (![...selected].some((sense) => textPresent(sense.definitionEn)))
    take(senses.find((sense) => textPresent(sense.definitionEn)));
  take(senses.find((sense) => textPresent(sense.exampleEn) && textPresent(sense.exampleZh)));
  for (const sense of senses) take(sense);
  return senses.filter((sense) => selected.has(sense));
}

/** Current media withdrawal is a display policy, never a mutation of issued questions. */
export function applyCurrentPronunciationPolicy(
  snapshot: Record<string, unknown>,
  compatible: boolean | undefined,
): Record<string, unknown> {
  if (compatible !== false && snapshot.pronunciationCompatible !== false) return snapshot;
  return {
    ...snapshot,
    pronunciationCompatible: false,
    phonetic: '',
    phoneticUs: '',
    phoneticUk: '',
    phoneticSource: '',
    phonetics: [],
    audio: [],
  };
}

/** Only augment a signed meaning's display when its exact identity and evidence still match. */
export function supplementIssuedWord(
  snapshot: Record<string, unknown>,
  current: Record<string, unknown>,
  wordId: string,
): Record<string, unknown> {
  if (current.id !== wordId || current.status !== 'published' || snapshot.id !== wordId)
    return snapshot;
  const stored = Array.isArray(snapshot.senses) ? snapshot.senses.map(obj) : [];
  const fresh = new Map(
    (Array.isArray(current.senses) ? current.senses.map(obj) : [])
      .filter((sense) => textPresent(sense.id))
      .map((sense) => [sense.id, sense]),
  );
  let supplemented = false;
  const senses = stored.map((original) => {
    const live = fresh.get(original.id);
    if (
      !live ||
      original.kind !== 'learning' ||
      live.kind !== 'learning' ||
      !textPresent(original.bindingHash) ||
      original.bindingHash !== live.bindingHash ||
      !textPresent(original.contentVersion) ||
      original.contentVersion !== live.contentVersion ||
      ![...definitionFields, 'pos'].every((field) => sameText(original[field], live[field]))
    )
      return original;
    const examples = Array.isArray(original.examples) ? original.examples.map(obj) : [];
    const used = new Set(examples.map((example) => example.id));
    const extra = (Array.isArray(live.examples) ? live.examples.map(obj) : []).filter(
      (example) =>
        textPresent(example.id) &&
        !used.has(example.id) &&
        example.learningSenseId === original.id &&
        example.contentVersion === original.contentVersion &&
        exampleFields.every((field) => textPresent(example[field])),
    );
    if (!extra.length) return original;
    supplemented = true;
    return { ...original, examples: [...examples, ...extra] };
  });
  const oldWarnings = mergeLexicalWarnings(snapshot.lexicalWarnings);
  const lexicalWarnings = mergeLexicalWarnings(oldWarnings, current.lexicalWarnings);
  supplemented ||= lexicalWarnings.length !== oldWarnings.length;
  return {
    ...applyCurrentPronunciationPolicy(
      snapshot,
      current.pronunciationCompatible as boolean | undefined,
    ),
    senses,
    lexicalWarnings,
    senseCount: senses.length,
    contentCoverage: contentCoverage(
      senses,
      senses.flatMap((sense) => (Array.isArray(sense.examples) ? sense.examples.map(obj) : [])),
    ),
    contentView: {
      snapshotVersion: typeof snapshot.contentVersion === 'string' ? snapshot.contentVersion : null,
      currentVersion: typeof current.contentVersion === 'string' ? current.contentVersion : null,
      supplemented,
    },
  };
}
