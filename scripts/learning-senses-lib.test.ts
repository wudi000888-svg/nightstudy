import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
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
  loadLearningSensesBundle,
  validateLearningSensesBundle,
  learningSensesWordUnionHash,
  learningSensePartsOfSpeech,
  LEARNING_SENSE_MAX_BYTES,
  prepareLearningSensesInstall,
  assertLearningSensesInstallUnchanged,
  type LearningSensesBundle,
  validateLearningSourceAdditions,
  type LearningSenseSourceAddition,
} from './learning-senses-lib.js';

const manifest = loadLearningSensesManifest();
const packed = fs.readFileSync(new URL('../data/' + manifest.fileName, import.meta.url));
const rows = readLearningSensesRows(packed, manifest);
const changed = () => structuredClone(rows);
const sha = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
function withOriginalSource(input = changed()) {
  const row = input[0]!,
    sense = row.senses[0]!,
    key = 'synthetic-original-source';
  const source: LearningSenseSourceAddition = {
    id: 'learning-source-' + sha(row.wordId + '\0' + key),
    wordId: row.wordId,
    normalizedLemma: row.normalizedLemma,
    pos: sense.pos,
    definitionZh: sense.definitionZh,
    definitionEn: sense.definitionEn,
    exampleEn: '',
    exampleZh: '',
    ordinal: 1000000 + parseInt(sha(key).slice(0, 7), 16),
    contentMetadata: {
      kind: 'original-authoring',
      evidenceKind: 'codex-original-source-addition',
      author: 'NightStudy contributors',
      license: 'MIT',
      authoringMethod: 'Direct Codex bilingual writing',
      review: 'codex-reviewed',
      expertCertified: false,
      sourceAdditionVersion: 'codex-original-source-v1',
      semanticKey: key,
      definitionZhSha256: sha(sense.definitionZh),
      definitionEnSha256: sha(sense.definitionEn),
      editorialReview: {
        decision: 'publish',
        reviewer: 'Codex',
        expertCertified: false,
        semanticRationale:
          'Synthetic explicit source authorship review for a standalone test meaning.',
      },
    },
  };
  Object.assign(sense.sourceBindings[0]!, {
    sourceSenseId: source.id,
    sourcePosSha256: sha(source.pos),
    sourceDefinitionZhSha256: sha(source.definitionZh),
    sourceDefinitionEnSha256: sha(source.definitionEn),
  });
  sense.bindingHash = learningSenseBindingHash(sense);
  const sourceRows = [source],
    raw = Buffer.from(JSON.stringify(source) + '\n'),
    packed = gzipSync(raw);
  const reviewed = {
    ...manifest,
    sourceAdditions: {
      fileName: 'learning-sense-sources-fixture.jsonl.gz',
      bytes: packed.length,
      sha256: sha(packed),
      jsonlSha256: sha(raw),
      rowCount: 1,
    },
  };
  return { rows: input, sourceRows, manifest: reviewed, sourcePacked: packed };
}

function collectionFixture(): LearningSensesBundle {
  const bundles = [rows.slice(0, 18), rows.slice(18)].map((part, index) => ({
    rows: structuredClone(part),
    manifest: {
      ...manifest,
      id: `learning-senses-fixture-${index}`,
      fileName: `fixture-${index}.jsonl.gz`,
      wordCount: part.length,
      wordsWithCuratedMeanings: part.length,
      wordsAwaitingAtomicReview: manifest.activeBookWords - part.length,
      senseCount: part.reduce((n, r) => n + r.senses.length, 0),
      exampleCount: part.reduce(
        (n, r) => n + r.senses.reduce((m, s) => m + s.examples.length, 0),
        0,
      ),
    },
  }));
  return {
    kind: 'collection',
    bundles,
    rows: bundles.flatMap((b) => b.rows),
    collection: {
      formatVersion: 2,
      kind: 'learning-senses-collection',
      id: 'learning-senses-collection-fixture',
      version: 'fixture',
      sourceExportSha256: manifest.sourceExportSha256,
      bilingualOverlaySha256: manifest.bilingualOverlaySha256,
      requiredWordCount: rows.length,
      requiredWordsSha256: learningSensesWordUnionHash(rows),
      wordCount: rows.length,
      senseCount: manifest.senseCount,
      exampleCount: manifest.exampleCount,
      editorialReview: 'codex-reviewed',
      semanticQualityCertified: false,
      exhaustiveBookCoverage: false,
      shards: bundles.map((leaf, index) => ({
        manifestFileName: `learning-senses-fixture-${index}.manifest.json`,
        bytes: 1,
        sha256: '0'.repeat(64),
        id: leaf.manifest.id,
        wordCount: leaf.manifest.wordCount,
        senseCount: leaf.manifest.senseCount,
        exampleCount: leaf.manifest.exampleCount,
      })),
    },
  };
}

function writeCollectionFixture(scratch: string, fixture = collectionFixture()) {
  for (const [index, leaf] of fixture.bundles.entries()) {
    const raw = Buffer.from(leaf.rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const packed = gzipSync(raw);
    Object.assign(leaf.manifest, {
      bytes: packed.length,
      sha256: sha(packed),
      jsonlSha256: sha(raw),
    });
    fs.writeFileSync(path.join(scratch, leaf.manifest.fileName), packed);
    const manifestBytes = Buffer.from(JSON.stringify(leaf.manifest));
    const pin = fixture.collection!.shards[index]!;
    Object.assign(pin, { bytes: manifestBytes.length, sha256: sha(manifestBytes) });
    fs.writeFileSync(path.join(scratch, pin.manifestFileName), manifestBytes);
  }
  const file = path.join(scratch, 'collection.manifest.json');
  fs.writeFileSync(file, JSON.stringify(fixture.collection));
  return { file, fixture };
}

it('preflights every leaf and refuses late omissions, cross-leaf identity reuse and changed prepared inputs', () => {
  const scratch = fs.mkdtempSync(
    path.join(process.env.TMPDIR || os.tmpdir(), 'nightstudy-preflight-'),
  );
  try {
    const { file, fixture } = writeCollectionFixture(scratch);
    const plan = prepareLearningSensesInstall(file);
    expect(plan).toMatchObject({
      kind: 'bounded-learning-senses-install',
      leafCount: 2,
      wordCount: 35,
      senseCount: manifest.senseCount,
      exampleCount: manifest.exampleCount,
    });
    expect('rows' in plan).toBe(false);
    expect('bundles' in plan).toBe(false);
    assertLearningSensesInstallUnchanged(plan);
    const last = path.join(scratch, fixture.collection!.shards[1]!.manifestFileName);
    fs.appendFileSync(last, ' ');
    expect(() => assertLearningSensesInstallUnchanged(plan)).toThrow('prepared_input_changed');
    expect(() => prepareLearningSensesInstall(file)).toThrow('shard_pin_mismatch');
    fs.unlinkSync(last);
    expect(() => prepareLearningSensesInstall(file)).toThrow();
    const collision = collectionFixture();
    collision.bundles[1]!.rows[0]!.senses[0]!.examples[0]!.id =
      collision.bundles[0]!.rows[0]!.senses[0]!.examples[0]!.id;
    writeCollectionFixture(scratch, collision);
    expect(() => prepareLearningSensesInstall(file)).toThrow('global_duplicate_identity');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

it('rejects a large collection at the eager entry point before loading a payload', () => {
  const scratch = fs.mkdtempSync(
    path.join(process.env.TMPDIR || os.tmpdir(), 'nightstudy-eager-limit-'),
  );
  try {
    const fixture = collectionFixture();
    fixture.collection!.wordCount = fixture.collection!.requiredWordCount = 1001;
    fixture.collection!.shards[0]!.wordCount = 500;
    fixture.collection!.shards[1]!.wordCount = 501;
    const file = path.join(scratch, 'collection.manifest.json');
    fs.writeFileSync(file, JSON.stringify(fixture.collection));
    expect(() => loadLearningSensesBundle(file)).toThrow('use_bounded_install');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

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

it('accepts reviewed case spelling while rejecting lexical aliases and malformed orthography', () => {
  const input = changed(),
    row = input[0]!,
    sense = row.senses[0]!,
    displayLemma = row.normalizedLemma.toUpperCase();
  const orthography = {
    displayLemma,
    normalizedLemma: row.normalizedLemma,
    displayLemmaSha256: sha(displayLemma),
    reviewer: 'Codex',
    decision: 'publish',
    expertCertified: false,
    reason: 'Explicit author review of the spelling used for this atomic meaning.',
  };
  sense.contentMetadata.orthography = orthography;
  expect(() => validateLearningSensesRows(input, manifest)).not.toThrow();
  for (const patch of [
    { displayLemma: 'another-word', displayLemmaSha256: sha('another-word') },
    { displayLemma: displayLemma + ' ', displayLemmaSha256: sha(displayLemma + ' ') },
    { displayLemmaSha256: '0'.repeat(64) },
    { normalizedLemma: 'another-word' },
    { decision: 'pending' },
    { reviewer: 'automatic-title-case' },
    { expertCertified: true },
    { reason: 'short' },
    { leakedDefinition: 'Not a supported orthography field.' },
  ]) {
    sense.contentMetadata.orthography = { ...orthography, ...patch };
    expect(() => validateLearningSensesRows(input, manifest)).toThrow('orthography');
  }
  sense.contentMetadata.orthography = null;
  expect(() => validateLearningSensesRows(input, manifest)).toThrow('orthography');
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

it('accepts reviewed dots without allowing punctuation to disguise a lexical alias', () => {
  const input = changed(),
    row = input[0]!,
    example = row.senses[0]!.examples[0]!,
    form = row.normalizedLemma + '.';
  example.exampleEn = `A reviewed abbreviation ${form} appears in this synthetic sentence.`;
  example.contentMetadata.exampleEnSha256 = sha(example.exampleEn);
  example.contentMetadata.textHash = sha(example.exampleEn);
  example.contentMetadata.targetSurface = {
    lemma: row.normalizedLemma,
    form,
    kind: 'punctuation-variant',
    review: 'codex-reviewed',
  };
  expect(() => validateLearningSensesRows(input, manifest)).not.toThrow();
  for (const invalid of [row.normalizedLemma, 'another-word.', form + '.', 'b ank.']) {
    example.contentMetadata.targetSurface = {
      lemma: row.normalizedLemma,
      form: invalid,
      kind: 'punctuation-variant',
      review: 'codex-reviewed',
    };
    expect(() => validateLearningSensesRows(input, manifest)).toThrow('punctuation_variant');
  }
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

it('validates a complete independently pinned union and rejects missing, repeated or cross-shard identities', () => {
  expect(validateLearningSensesBundle(collectionFixture()).rows).toHaveLength(35);
  const missing = collectionFixture();
  missing.bundles.pop();
  expect(() => validateLearningSensesBundle(missing)).toThrow('missing_shard');
  const wrongTarget = collectionFixture();
  wrongTarget.collection!.requiredWordsSha256 = '0'.repeat(64);
  expect(() => validateLearningSensesBundle(wrongTarget)).toThrow('union_mismatch');
  const duplicated = collectionFixture();
  duplicated.bundles[1] = duplicated.bundles[0]!;
  duplicated.collection!.shards[1] = {
    ...duplicated.collection!.shards[0]!,
    id: 'learning-senses-fixture-other',
    manifestFileName: 'learning-senses-other.manifest.json',
  };
  duplicated.bundles[1] = structuredClone(duplicated.bundles[1]!);
  duplicated.bundles[1]!.manifest.id = 'learning-senses-fixture-other';
  duplicated.collection!.wordCount = duplicated.collection!.requiredWordCount = 36;
  duplicated.collection!.senseCount = duplicated.collection!.shards.reduce(
    (n, s) => n + s.senseCount,
    0,
  );
  duplicated.collection!.exampleCount = duplicated.collection!.shards.reduce(
    (n, s) => n + s.exampleCount,
    0,
  );
  expect(() => validateLearningSensesBundle(duplicated)).toThrow('word_crosses_shards');
  const collision = collectionFixture();
  collision.bundles[1]!.rows[0]!.senses[0]!.examples[0]!.id =
    collision.bundles[0]!.rows[0]!.senses[0]!.examples[0]!.id;
  expect(() => validateLearningSensesBundle(collision)).toThrow('global_duplicate_identity');
});

it('loads all shard manifests and bounded payloads before accepting a collection; immutable v1 still loads unchanged', () => {
  const scratch = fs.mkdtempSync(
    path.join(process.env.TMPDIR || os.tmpdir(), 'nightstudy-senses-collection-'),
  );
  try {
    const fixture = collectionFixture();
    for (const [index, leaf] of fixture.bundles.entries()) {
      const raw = Buffer.from(leaf.rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      const packed = gzipSync(raw);
      Object.assign(leaf.manifest, {
        bytes: packed.length,
        sha256: sha(packed),
        jsonlSha256: sha(raw),
      });
      fs.writeFileSync(path.join(scratch, leaf.manifest.fileName), packed);
      const manifestBytes = Buffer.from(JSON.stringify(leaf.manifest));
      const pin = fixture.collection!.shards[index]!;
      Object.assign(pin, { bytes: manifestBytes.length, sha256: sha(manifestBytes) });
      fs.writeFileSync(path.join(scratch, pin.manifestFileName), manifestBytes);
    }
    const file = path.join(scratch, 'collection.manifest.json');
    fs.writeFileSync(file, JSON.stringify(fixture.collection));
    expect(loadLearningSensesBundle(file).rows).toHaveLength(35);
    fs.appendFileSync(path.join(scratch, fixture.collection!.shards[1]!.manifestFileName), ' ');
    expect(() => loadLearningSensesBundle(file)).toThrow('shard_manifest_checksum');
    fixture.collection!.shards[1]!.manifestFileName = '../outside.manifest.json';
    fs.writeFileSync(file, JSON.stringify(fixture.collection));
    expect(() => loadLearningSensesBundle(file)).toThrow();
    expect(
      loadLearningSensesBundle(new URL('../data/learning-senses-v1.manifest.json', import.meta.url))
        .rows,
    ).toEqual(rows);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

it('keeps the 64 MiB decompression ceiling and 1000 word ceiling for every leaf', () => {
  const huge = Buffer.alloc(LEARNING_SENSE_MAX_BYTES + 1, 32);
  const compressed = gzipSync(huge);
  expect(() =>
    readLearningSensesRows(compressed, {
      ...manifest,
      bytes: compressed.length,
      sha256: sha(compressed),
      jsonlSha256: sha(huge),
    }),
  ).toThrow();
  expect(() => validateLearningSensesRows(rows, { ...manifest, wordCount: 1001 })).toThrow();
  expect(() => readLearningSensesRows(packed, manifest, { remaining: 0 })).toThrow(
    'collection_decoded_limit',
  );
});

it('accepts standard single parts of speech and rejects combined labels that require semantic splitting', () => {
  for (const pos of learningSensePartsOfSpeech) {
    const input = changed();
    input[0]!.senses[0]!.pos = pos;
    input[0]!.senses[0]!.bindingHash = learningSenseBindingHash(input[0]!.senses[0]!);
    expect(() => validateLearningSensesRows(input, manifest)).not.toThrow();
  }
  const input = changed();
  input[0]!.senses[0]!.pos = 'adj./adv.' as (typeof input)[0]['senses'][0]['pos'];
  expect(() => validateLearningSensesRows(input, manifest)).toThrow();
});

it('preserves corpus licenses, exact source text and independent translated-field provenance', () => {
  const input = changed(),
    sense = input[0]!.senses[0]!;
  const notice = 'Pinned synthetic public-source license notice.';
  const reviewed = {
    ...manifest,
    license: 'mixed' as const,
    licenseNotices: [
      { fileName: 'SOURCE-LICENSE.txt', bytes: Buffer.byteLength(notice), sha256: sha(notice) },
    ],
  };
  sense.contentMetadata = {
    ...sense.contentMetadata,
    kind: 'reviewed-public-content',
    license: 'mixed',
    fieldSources: {
      definitionEn: {
        kind: 'corpus',
        license: 'WordNet-3.0',
        author: 'Synthetic source author',
        attribution: 'Synthetic public source attribution.',
        sourceName: 'Synthetic WordNet source',
        sourceUrl: 'https://example.org/wordnet',
        sourceText: sense.definitionEn,
        sourceTextSha256: sha(sense.definitionEn),
        sourceSnapshotSha256: 'a'.repeat(64),
        licenseNoticeSha256: sha(notice),
        textSha256: sha(sense.definitionEn),
      },
      definitionZh: {
        kind: 'original-authoring',
        license: 'MIT',
        author: 'NightStudy contributors',
        textSha256: sha(sense.definitionZh),
      },
    },
  };
  expect(() => validateLearningSensesRows(input, reviewed)).not.toThrow();
  expect(() => validateLearningSensesRows(input, { ...reviewed, licenseNotices: [] })).toThrow(
    'source_or_notice',
  );
  const fields = sense.contentMetadata.fieldSources as Record<string, Record<string, unknown>>;
  fields.definitionEn!.sourceText += ' Changed.';
  expect(() => validateLearningSensesRows(input, reviewed)).toThrow('source_or_notice');
});

it('requires deterministic original source identity, genuine Codex authorship, exact word binding and explicit pins', () => {
  const fixture = withOriginalSource();
  expect(() =>
    validateLearningSourceAdditions(fixture.sourceRows, fixture.rows, fixture.manifest),
  ).not.toThrow();
  expect(() => validateLearningSourceAdditions([], fixture.rows, manifest)).toThrow(
    'missing_original_source',
  );
  expect(() => validateLearningSourceAdditions(fixture.sourceRows, fixture.rows, manifest)).toThrow(
    'count',
  );
  const source = fixture.sourceRows[0]!;
  source.contentMetadata.license = 'CC-BY-4.0' as never;
  expect(() =>
    validateLearningSourceAdditions(fixture.sourceRows, fixture.rows, fixture.manifest),
  ).toThrow();
  source.contentMetadata.license = 'MIT';
  source.definitionZh += '已修改';
  expect(() =>
    validateLearningSourceAdditions(fixture.sourceRows, fixture.rows, fixture.manifest),
  ).toThrow('invalid_original_source');
  const wrong = withOriginalSource();
  wrong.sourceRows[0]!.wordId = 'another-word';
  expect(() =>
    validateLearningSourceAdditions(wrong.sourceRows, wrong.rows, wrong.manifest),
  ).toThrow('invalid_original_source');
  const unbound = withOriginalSource();
  unbound.rows[0]!.senses.shift();
  expect(() =>
    validateLearningSourceAdditions(unbound.sourceRows, unbound.rows, unbound.manifest),
  ).toThrow('unbound_original_source');
});

it('loads the independently pinned bounded original-source payload and rejects byte damage or a missing file', () => {
  const scratch = fs.mkdtempSync(
    path.join(process.env.TMPDIR || os.tmpdir(), 'nightstudy-original-sources-'),
  );
  try {
    const fixture = withOriginalSource();
    const raw = Buffer.from(fixture.rows.map((row) => JSON.stringify(row)).join('\n') + '\n'),
      packed = gzipSync(raw);
    Object.assign(fixture.manifest, {
      bytes: packed.length,
      sha256: sha(packed),
      jsonlSha256: sha(raw),
    });
    const file = path.join(scratch, 'learning-senses-fixture.manifest.json');
    fs.writeFileSync(file, JSON.stringify(fixture.manifest));
    fs.writeFileSync(path.join(scratch, fixture.manifest.fileName), packed);
    const sourceFile = path.join(scratch, fixture.manifest.sourceAdditions.fileName);
    fs.writeFileSync(sourceFile, fixture.sourcePacked);
    expect(loadLearningSensesBundle(file).bundles[0]!.sourceRows).toEqual(fixture.sourceRows);
    const fullBudget = {
      remaining: raw.length + Buffer.byteLength(JSON.stringify(fixture.sourceRows[0]) + '\n'),
    };
    expect(loadLearningSensesFiles(file, fullBudget).sourceRows).toEqual(fixture.sourceRows);
    expect(fullBudget.remaining).toBe(0);
    expect(() => loadLearningSensesFiles(file, { remaining: raw.length + 1 })).toThrow();
    fs.appendFileSync(sourceFile, ' ');
    expect(() => loadLearningSensesBundle(file)).toThrow('source_additions_checksum');
    fs.unlinkSync(sourceFile);
    expect(() => loadLearningSensesBundle(file)).toThrow();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
