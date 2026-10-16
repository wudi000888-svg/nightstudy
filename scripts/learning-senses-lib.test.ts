import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import {
  learningSenseBindingHash,
  learningSenseSourceMatches,
  learningSenseTextHash,
} from '../apps/api/src/modules/learning-sense-integrity.js';
import {
  loadLearningSensesManifest,
  loadLearningSensesFiles,
  readLearningSensesRows,
  validateLearningSensesRows,
} from './learning-senses-lib.js';

const manifest = loadLearningSensesManifest();
const packed = fs.readFileSync(new URL('../data/' + manifest.fileName, import.meta.url));
const rows = readLearningSensesRows(packed, manifest);
const changed = () => structuredClone(rows);

it('validates the real authored pack and Python/TypeScript canonical binding hashes', () => {
  expect(rows).toHaveLength(manifest.wordCount);
  for (const row of rows)
    for (const sense of row.senses) {
      expect(learningSenseBindingHash(sense)).toBe(sense.bindingHash);
      expect(new Set(sense.examples.map((e) => e.contextLabel)).size).toBeGreaterThanOrEqual(2);
    }
  const bank = rows.find((r) => r.normalizedLemma === 'bank')!;
  expect(bank.senses.map((s) => s.contentMetadata.semanticKey)).toEqual([
    'financial-institution',
    'river-edge',
  ]);
  const charge = rows.find((r) => r.normalizedLemma === 'charge')!;
  expect(
    charge.senses
      .find((s) => s.contentMetadata.semanticKey === 'service-fee')!
      .examples.every((e) => !/phone|battery/iu.test(e.exampleEn)),
  ).toBe(true);
});

it('rejects byte damage and unknown fields rather than silently accepting a partial pack', () => {
  const bytes = Buffer.from(packed);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  expect(() => readLearningSensesRows(bytes, manifest)).toThrow('checksum');
  const input = changed();
  (input[0]! as unknown as Record<string, unknown>).claimAllBooksComplete = true;
  expect(() => validateLearningSensesRows(input, manifest)).toThrow();
});

it('rejects cross-word bindings, stale meaning text and incomplete context coverage', () => {
  let input = changed();
  input[0]!.senses[0]!.sourceBindings[0]!.wordId = 'another-word';
  expect(() => validateLearningSensesRows(input, manifest)).toThrow('cross_word');
  input = changed();
  input[0]!.senses[0]!.definitionEn += ' Changed.';
  expect(() => validateLearningSensesRows(input, manifest)).toThrow('binding_hash');
  input = changed();
  input[0]!.senses[0]!.examples[1]!.contextLabel = input[0]!.senses[0]!.examples[0]!.contextLabel;
  expect(() => validateLearningSensesRows(input, manifest)).toThrow('two_contexts');
});

it('does not claim expert certification or accept unreviewed inflections', () => {
  let input = changed();
  input[0]!.senses[0]!.contentMetadata.expertCertified = true;
  expect(() => validateLearningSensesRows(input, manifest)).toThrow('semantic_review');
  input = changed();
  input[0]!.senses[0]!.examples[0]!.contentMetadata.targetSurface = {
    lemma: input[0]!.normalizedLemma,
    form: 'invented',
    kind: 'exact',
    review: 'pending',
  };
  expect(() => validateLearningSensesRows(input, manifest)).toThrow('unreviewed_surface');
});

it('source bindings compare exact UTF-8 fields, including empty strings and spaces', () => {
  const source = { id: 'source', wordId: 'word', pos: 'n.', definitionZh: '水', definitionEn: '' };
  const binding = {
    wordId: 'word',
    sourceSenseId: 'source',
    relation: 'narrower',
    sourcePosSha256: learningSenseTextHash(source.pos),
    sourceDefinitionZhSha256: learningSenseTextHash(source.definitionZh),
    sourceDefinitionEnSha256: learningSenseTextHash(source.definitionEn),
  };
  expect(learningSenseSourceMatches(binding, source)).toBe(true);
  expect(learningSenseSourceMatches(binding, { ...source, definitionEn: ' ' })).toBe(false);
  expect(learningSenseSourceMatches(binding, { ...source, pos: 'v.' })).toBe(false);
  expect(learningSenseSourceMatches(binding, { ...source, definitionZh: '水 ' })).toBe(false);
  expect(learningSenseSourceMatches(binding, { ...source, wordId: 'other' })).toBe(false);
});

it('does not accept the same English sentence as two different meanings', () => {
  const input = changed();
  const a = input[0]!.senses[0]!.examples[0]!;
  const b = input[0]!.senses[1]!.examples[0]!;
  b.exampleEn = a.exampleEn;
  b.exampleZh = a.exampleZh;
  b.contentMetadata = structuredClone(a.contentMetadata);
  expect(() => validateLearningSensesRows(input, manifest)).toThrow(
    'duplicate_or_changed_sentence',
  );
});

it('resolves an explicit manifest payload inside its own directory and rejects traversal or checksum drift', () => {
  const scratch = fs.mkdtempSync(
    path.join(process.env.TMPDIR || os.tmpdir(), 'nightstudy-senses-boundary-'),
  );
  try {
    const folder = path.join(scratch, 'a space');
    fs.mkdirSync(folder);
    const filename = path.join(folder, 'external.manifest.json');
    const explicit = { ...manifest, fileName: 'renamed-payload.jsonl.gz' };
    fs.writeFileSync(filename, JSON.stringify(explicit));
    fs.writeFileSync(path.join(folder, explicit.fileName), packed);
    expect(loadLearningSensesFiles(filename).rows).toEqual(rows);
    fs.writeFileSync(
      filename,
      JSON.stringify({ ...explicit, fileName: '../renamed-payload.jsonl.gz' }),
    );
    expect(() => loadLearningSensesFiles(filename)).toThrow();
    fs.writeFileSync(filename, JSON.stringify({ ...explicit, sha256: '0'.repeat(64) }));
    expect(() => loadLearningSensesFiles(filename)).toThrow('pack_checksum');
    fs.writeFileSync(filename, JSON.stringify({ ...explicit, allowUncheckedPayload: true }));
    expect(() => loadLearningSensesFiles(filename)).toThrow();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
