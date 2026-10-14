import { createHash } from 'node:crypto';
import type { Sense } from '@prisma/client';
import { learningDefinitionView } from './learning-definitions.js';
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

function mergeMissingText(
  original: Record<string, unknown>,
  current: Record<string, unknown>,
  fields: readonly string[],
  allowed: boolean,
) {
  const merged = { ...original };
  const metadata = { ...obj(original.contentMetadata) };
  const currentMetadata = obj(current.contentMetadata);
  let changed = false;
  for (const field of fields) {
    if (allowed && !textPresent(original[field]) && textPresent(current[field])) {
      merged[field] = current[field];
      if (currentMetadata[field]) metadata[field] = currentMetadata[field];
      else delete metadata[field];
      changed = true;
    } else if (
      !metadata[field] &&
      sameText(original[field], current[field]) &&
      currentMetadata[field]
    ) {
      // A provenance label is safe only for the exact visible text it describes.
      metadata[field] = currentMetadata[field];
      changed = true;
    }
  }
  if (Object.keys(metadata).length) {
    if (!metadata.packId && currentMetadata.packId) metadata.packId = currentMetadata.packId;
    merged.contentMetadata = metadata;
  }
  return { merged, changed };
}
function compatibleMeaning(original: Record<string, unknown>, current: Record<string, unknown>) {
  for (const field of [...definitionFields, 'pos']) {
    if (textPresent(original[field]) && !sameText(original[field], current[field])) return false;
  }
  return true;
}
function compatibleExample(original: Record<string, unknown>, current: Record<string, unknown>) {
  return exampleFields.every(
    (field) => !textPresent(original[field]) || sameText(original[field], current[field]),
  );
}

/** Presentation only: never edits issued snapshots, questions, identity or accepted review history. */
export function supplementIssuedWord(
  snapshot: Record<string, unknown>,
  current: Record<string, unknown>,
  wordId: string,
): Record<string, unknown> {
  if (
    current.id !== wordId ||
    current.status !== 'published' ||
    (textPresent(snapshot.id) && snapshot.id !== wordId)
  )
    return snapshot;
  const exclusions = Array.isArray(current.learningExclusions)
    ? current.learningExclusions.map(obj)
    : [];
  const existingSenses = (Array.isArray(snapshot.senses) ? snapshot.senses.map(obj) : []).filter(
    (sense) =>
      !exclusions.some((exclusion) => {
        const field = exclusion.field;
        return (
          exclusion.id === sense.id &&
          exclusion.excludeFromLearning === true &&
          (field === 'definitionZh' || field === 'definitionEn') &&
          typeof sense[field] === 'string' &&
          createHash('sha256').update(sense[field], 'utf8').digest('hex') ===
            exclusion.sourceTextSha256
        );
      }),
  );
  const currentSenses = Array.isArray(current.senses) ? current.senses.map(obj) : [];
  const currentById = new Map(
    currentSenses.filter((sense) => textPresent(sense.id)).map((sense) => [sense.id, sense]),
  );
  const usedSenseIds = new Set(existingSenses.map((sense) => sense.id));
  let supplemented = false;
  const senses = existingSenses.map((stored) => {
    const original = learningDefinitionView(stored as unknown as Sense) as unknown as Record<
      string,
      unknown
    >;
    supplemented ||= original !== stored;
    const fresh = currentById.get(original.id);
    if (!fresh) return original;
    const definitions = mergeMissingText(
      original,
      fresh,
      definitionFields,
      compatibleMeaning(original, fresh),
    );
    const examples = mergeMissingText(
      definitions.merged,
      fresh,
      exampleFields,
      compatibleMeaning(original, fresh) && compatibleExample(original, fresh),
    );
    supplemented ||= definitions.changed || examples.changed;
    if (!textPresent(original.pos) && textPresent(fresh.pos)) {
      examples.merged.pos = fresh.pos;
      supplemented = true;
    }
    return examples.merged;
  });
  for (const sense of currentSenses)
    if (!usedSenseIds.has(sense.id)) {
      senses.push(sense);
      usedSenseIds.add(sense.id);
      supplemented = true;
    }
  const existingExamples = Array.isArray(snapshot.examples) ? snapshot.examples.map(obj) : [];
  const currentExamples = Array.isArray(current.examples) ? current.examples.map(obj) : [];
  const examplesById = new Map(
    currentExamples
      .filter((example) => textPresent(example.id))
      .map((example) => [example.id, example]),
  );
  const usedExampleIds = new Set(existingExamples.map((example) => example.id));
  const examples = existingExamples.map((original) => {
    const fresh = examplesById.get(original.id);
    if (!fresh) return original;
    const result = mergeMissingText(
      original,
      fresh,
      exampleFields,
      compatibleExample(original, fresh),
    );
    supplemented ||= result.changed;
    return result.merged;
  });
  for (const example of currentExamples)
    if (!usedExampleIds.has(example.id)) {
      examples.push(example);
      usedExampleIds.add(example.id);
      supplemented = true;
    }
  const oldWarnings = mergeLexicalWarnings(snapshot.lexicalWarnings);
  const lexicalWarnings = mergeLexicalWarnings(oldWarnings, current.lexicalWarnings);
  supplemented ||= lexicalWarnings.length !== oldWarnings.length;
  return {
    ...snapshot,
    ...(current.dictionaryName ? { dictionaryName: current.dictionaryName } : {}),
    ...(current.entryKind ? { entryKind: current.entryKind } : {}),
    ...(Array.isArray(current.collocations) && !Array.isArray(snapshot.collocations)
      ? { collocations: current.collocations }
      : {}),
    senses,
    examples,
    lexicalWarnings,
    senseCount: senses.length,
    contentCoverage: contentCoverage(senses, examples),
    contentView: {
      snapshotVersion: typeof snapshot.contentVersion === 'string' ? snapshot.contentVersion : null,
      currentVersion: typeof current.contentVersion === 'string' ? current.contentVersion : null,
      supplemented,
    },
  };
}
