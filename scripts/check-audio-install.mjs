import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import assert from 'node:assert/strict';

const fields = ['definitionZh', 'definitionEn', 'exampleZh', 'exampleEn'];
const exceptions = new Set([
  'attent',
  'cance',
  'eg',
  'erm',
  'flourishment',
  'handtruck',
  "n't",
  'outskirt',
  'pp',
  'reservior',
  'uptodate',
  'vitamine',
]);
const expected = { words: 8798, senses: 40442, bookItems: 21250, books: 5, exceptions };
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const present = (value) => typeof value === 'string' && Boolean(value.trim());
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const paired = (value, kind) => present(value[kind + 'Zh']) && present(value[kind + 'En']);
const sorted = (rows) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
class VerificationError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}
const requireCheck = (condition, code, details) => {
  if (!condition) throw new VerificationError(code, details);
};

function identity(data) {
  return {
    words: sha(
      JSON.stringify(
        sorted(data.words).map(
          ({ id, lemma, normalizedLemma, sourceRef, contentVersion, status }) => ({
            id,
            lemma,
            normalizedLemma,
            sourceRef,
            contentVersion,
            status,
          }),
        ),
      ),
    ),
    books: sha(
      JSON.stringify(sorted(data.books).map(({ id, goal, version }) => ({ id, goal, version }))),
    ),
    bookItems: sha(JSON.stringify(sorted(data.bookItems))),
    senses: sha(
      JSON.stringify(
        sorted(data.words.flatMap((word) => word.senses)).map(({ id, wordId, pos, ordinal }) => ({
          id,
          wordId,
          pos,
          ordinal,
        })),
      ),
    ),
  };
}
function snapshot(data) {
  return {
    formatVersion: 1,
    siteId: data.siteId,
    instanceId: data.instanceId,
    counts: {
      words: data.words.length,
      senses: data.words.reduce((n, word) => n + word.senses.length, 0),
      bookItems: data.bookItems.length,
      books: data.books.length,
    },
    identity: identity(data),
    sourceSenses: sorted(data.words.flatMap((word) => word.senses)).map((sense) => ({
      id: sense.id,
      wordId: sense.wordId,
      fields: Object.fromEntries(
        fields.filter((field) => sense[field] !== '').map((field) => [field, sha(sense[field])]),
      ),
    })),
  };
}
function verifyBaseline(data, baseline) {
  requireCheck(
    baseline?.formatVersion === 1 && Array.isArray(baseline.sourceSenses),
    'invalid_bilingual_baseline',
  );
  requireCheck(
    baseline.siteId === data.siteId && baseline.instanceId === data.instanceId,
    'bilingual_baseline_realm_mismatch',
  );
  const now = identity(data);
  for (const key of ['words', 'books', 'bookItems', 'senses'])
    requireCheck(now[key] === baseline.identity[key], 'bilingual_original_identity_changed', {
      component: key,
    });
  const sourceMap = new Map(baseline.sourceSenses.map((sense) => [sense.id, sense]));
  let immutableFields = 0,
    filledFields = 0;
  for (const word of data.words)
    for (const sense of word.senses) {
      const original = sourceMap.get(sense.id);
      requireCheck(original?.wordId === word.id, 'bilingual_original_sense_binding_changed');
      for (const field of fields) {
        if (original.fields[field]) {
          requireCheck(
            sha(sense[field]) === original.fields[field],
            'bilingual_original_source_text_changed',
            { wordId: word.id, senseId: sense.id, field },
          );
          immutableFields++;
        } else if (present(sense[field])) {
          const sourceField = field.slice(0, -2) + (field.endsWith('Zh') ? 'En' : 'Zh');
          const metadata = object(object(sense.contentMetadata)[field]);
          requireCheck(
            typeof original.fields[sourceField] === 'string' &&
              metadata.sourceTextSha256 === original.fields[sourceField],
            'bilingual_translation_source_hash_mismatch',
            { wordId: word.id, senseId: sense.id, field },
          );
          filledFields++;
        }
      }
    }
  return {
    originalFieldsPreserved: immutableFields,
    filledFieldsChecked: filledFields,
    sourceEnglishDefinitionWords: new Set(
      baseline.sourceSenses
        .filter((sense) => sense.fields.definitionEn)
        .map((sense) => sense.wordId),
    ).size,
    sourceChineseDefinitionWords: new Set(
      baseline.sourceSenses
        .filter((sense) => sense.fields.definitionZh)
        .map((sense) => sense.wordId),
    ).size,
    identityPreserved: true,
  };
}
function verifyBilingual(data, bundle, limits = expected) {
  requireCheck(
    data.words.length === limits.words &&
      data.books.length === limits.books &&
      data.bookItems.length === limits.bookItems,
    'bilingual_scope_count_mismatch',
    { words: data.words.length, books: data.books.length, bookItems: data.bookItems.length },
  );
  requireCheck(
    data.pack?.status === 'ready' &&
      data.pack.sha256 === bundle.manifest.sha256 &&
      data.pack.entryCount === limits.words,
    'bilingual_pack_identity_not_ready',
  );
  const senses = data.words.flatMap((word) => word.senses);
  const pairedSenses = senses.filter((sense) => paired(sense, 'definition')).length;
  const policy = bundle.manifest.definitionPolicy ?? 'strict-sense-pairs';
  requireCheck(
    ['strict-sense-pairs', 'word-source-languages'].includes(policy),
    'bilingual_definition_policy_invalid',
  );
  requireCheck(
    senses.length === limits.senses &&
      (policy === 'word-source-languages' || pairedSenses === limits.senses),
    'bilingual_definition_senses_incomplete',
    {
      definitionSenses: senses.length,
      pairedDefinitionSenses: pairedSenses,
      expected: limits.senses,
    },
  );
  const englishWords = data.words.filter((word) =>
    word.senses.some((sense) => present(sense.definitionEn)),
  ).length;
  const chineseWords = data.words.filter((word) =>
    word.senses.some((sense) => present(sense.definitionZh)),
  ).length;
  const pairedWords = data.words.filter((word) =>
    word.senses.some((sense) => paired(sense, 'definition')),
  ).length;
  requireCheck(
    data.words.every((word) => word.status === 'published') &&
      englishWords === limits.words &&
      chineseWords === limits.words &&
      (policy === 'word-source-languages' || pairedWords === limits.words),
    'bilingual_word_definitions_incomplete',
  );
  const senseMap = new Map(senses.map((sense) => [sense.id, sense]));
  const validFocus = data.bookItems.filter(
    (item) => senseMap.get(item.focusSenseId)?.wordId === item.wordId,
  ).length;
  requireCheck(validFocus === limits.bookItems, 'bilingual_book_focus_binding_invalid');
  const pairedFocus = data.bookItems.filter((item) => {
    const focus = senseMap.get(item.focusSenseId);
    return focus?.wordId === item.wordId && paired(focus, 'definition');
  }).length;
  requireCheck(
    policy === 'word-source-languages' || pairedFocus === limits.bookItems,
    'bilingual_book_focus_incomplete',
    {
      pairedFocusItems: pairedFocus,
      expected: limits.bookItems,
    },
  );
  const wordsByLemma = new Map(data.words.map((word) => [word.normalizedLemma, word]));
  requireCheck(
    bundle.rows.length === limits.words && wordsByLemma.size === limits.words,
    'bilingual_bundle_scope_mismatch',
  );
  let packageFields = 0,
    packageExamples = 0;
  const bundledLemmas = new Set();
  for (const row of bundle.rows) {
    requireCheck(!bundledLemmas.has(row.normalizedLemma), 'bilingual_duplicate_bundle_word');
    bundledLemmas.add(row.normalizedLemma);
    const word = wordsByLemma.get(row.normalizedLemma);
    requireCheck(Boolean(word), 'bilingual_bundle_word_missing');
    for (const patch of row.senses) {
      const actual = senseMap.get(patch.id);
      requireCheck(actual?.wordId === word.id, 'bilingual_pack_sense_binding_mismatch');
      for (const field of fields)
        if (patch[field] !== undefined) {
          requireCheck(actual[field] === patch[field], 'bilingual_pack_target_mismatch', {
            wordId: word.id,
            senseId: patch.id,
            field,
          });
          const sourceField = field.slice(0, -2) + (field.endsWith('Zh') ? 'En' : 'Zh');
          requireCheck(
            present(actual[sourceField]) &&
              object(object(actual.contentMetadata)[field]).sourceTextSha256 ===
                sha(actual[sourceField]),
            'bilingual_translation_source_hash_mismatch',
            { wordId: word.id, senseId: patch.id, field },
          );
          requireCheck(
            isDeepStrictEqual(
              object(object(actual.contentMetadata)[field]),
              object(object(patch.contentMetadata)[field]),
            ),
            'bilingual_definition_provenance_changed',
            { wordId: word.id, senseId: patch.id, field },
          );
          packageFields++;
        }
    }
    for (const example of row.examples) {
      const actual = word.examples.find(
        (entry) => entry.exampleEn === example.exampleEn && entry.exampleZh === example.exampleZh,
      );
      requireCheck(Boolean(actual), 'bilingual_pack_example_missing', { wordId: word.id });
      for (const field of ['exampleEn', 'exampleZh']) {
        const source = object(object(actual.contentMetadata)[field]);
        requireCheck(
          present(source.license) &&
            (present(source.author) ||
              (present(source.sourceOwner) &&
                ['current-owner', 'export-attributed-owner'].includes(source.sourceOwnerRole))),
          'bilingual_example_attribution_missing',
          { wordId: word.id, field },
        );
        const approved = object(object(example.contentMetadata)[field]);
        requireCheck(isDeepStrictEqual(source, approved), 'bilingual_example_attribution_changed', {
          wordId: word.id,
          field,
        });
        if (source.kind === 'corpus')
          requireCheck(
            source.sourceTextSha256 === sha(actual[field]),
            'bilingual_example_source_hash_mismatch',
            { wordId: word.id, field },
          );
        if (
          source.kind === 'machine-translation' ||
          source.kind === 'original-authoring' ||
          (source.sourceLanguage === 'en' && field === 'exampleZh')
        )
          requireCheck(
            source.sourceTextSha256 ===
              sha(actual[field === 'exampleZh' ? 'exampleEn' : 'exampleZh']),
            'bilingual_example_source_hash_mismatch',
            { wordId: word.id, field },
          );
      }
      packageExamples++;
    }
    for (const warning of row.warnings ?? []) {
      const actual = senseMap.get(warning.senseId);
      requireCheck(
        actual?.wordId === word.id && sha(actual.definitionZh) === warning.sourceTextSha256,
        'bilingual_source_warning_binding_mismatch',
        { wordId: word.id, senseId: warning.senseId },
      );
      const warnings = object(actual.contentMetadata).lexicalWarnings;
      requireCheck(
        Array.isArray(warnings) &&
          warnings.some(
            (entry) =>
              object(entry).code === warning.code && object(entry).message === warning.message,
          ),
        'bilingual_source_warning_missing',
        { wordId: word.id, senseId: warning.senseId },
      );
    }
  }
  const missing = data.words.filter(
    (word) => !word.examples.some((example) => paired(example, 'example')),
  );
  for (const word of missing) {
    requireCheck(limits.exceptions.has(word.normalizedLemma), 'bilingual_unexpected_example_gap', {
      normalizedLemma: word.normalizedLemma,
    });
    const warned = word.senses.some((sense) => {
      const warnings = object(sense.contentMetadata).lexicalWarnings;
      return (
        Array.isArray(warnings) &&
        warnings.some(
          (warning) =>
            object(warning).code === 'source-spelling-unverified' &&
            present(object(warning).message),
        )
      );
    });
    requireCheck(warned, 'bilingual_exception_requires_source_warning', {
      normalizedLemma: word.normalizedLemma,
    });
  }
  const exampleWords = data.words.length - missing.length;
  const bundledExampleWords = bundle.rows.filter((row) =>
    row.examples.some((example) => paired(example, 'example')),
  ).length;
  const declaredExampleWords = bundle.manifest.statistics?.wordUsageExampleWordCount;
  requireCheck(
    Number.isSafeInteger(declaredExampleWords) &&
      declaredExampleWords === bundledExampleWords &&
      exampleWords === declaredExampleWords,
    'bilingual_declared_example_coverage_mismatch',
    { declared: declaredExampleWords, bundled: bundledExampleWords, actual: exampleWords },
  );
  requireCheck(
    exampleWords >= limits.words - limits.exceptions.size,
    'bilingual_example_coverage_incomplete',
  );
  return {
    words: data.words.length,
    definitionPolicy: policy,
    wordSourceEnglishDefinitionWords: englishWords,
    wordSourceChineseDefinitionWords: chineseWords,
    wordSourceLanguagesWords: data.words.filter(
      (word) =>
        word.senses.some((sense) => present(sense.definitionEn)) &&
        word.senses.some((sense) => present(sense.definitionZh)),
    ).length,
    pairedDefinitionWords: pairedWords,
    definitionSenses: senses.length,
    pairedDefinitionSenses: pairedSenses,
    bookItems: data.bookItems.length,
    pairedFocusItems: pairedFocus,
    bilingualWordExampleWords: exampleWords,
    missingWordExamples: missing.map((word) => word.normalizedLemma).sort(),
    allowedSourceExceptionCount: limits.exceptions.size,
    packageFieldsChecked: packageFields,
    packageExamplesChecked: packageExamples,
  };
}
function readPinnedBundle(manifestName, count) {
  const directory = new URL('../data/', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL(manifestName, directory), 'utf8'));
  requireCheck(
    manifest.wordCount === count && /^[\w.-]+\.jsonl\.gz$/.test(manifest.fileName),
    'invalid_bilingual_verification_manifest',
  );
  const bytes = fs.readFileSync(new URL(manifest.fileName, directory));
  requireCheck(
    bytes.length === manifest.bytes && sha(bytes) === manifest.sha256,
    'bilingual_verification_pack_checksum_mismatch',
  );
  const decoded = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
  requireCheck(
    sha(decoded) === manifest.jsonlSha256,
    'bilingual_verification_jsonl_checksum_mismatch',
  );
  return {
    manifest,
    rows: new TextDecoder('utf-8', { fatal: true })
      .decode(decoded)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}
function readBundle() {
  const bundle = readPinnedBundle('bilingual-pack.manifest.json', expected.words);
  requireCheck(
    bundle.manifest.definitionPolicy === 'word-source-languages',
    'bilingual_install_requires_word_source_languages_policy',
  );
  return bundle;
}
async function readSite(db, siteId) {
  const content = JSON.parse(
    fs.readFileSync(new URL('../data/content-ecdict.manifest.json', import.meta.url), 'utf8'),
  );
  const books = await db.book.findMany({
    where: { ownerId: null, status: 'published', version: content.id },
    select: {
      id: true,
      goal: true,
      version: true,
      items: {
        select: { id: true, bookId: true, wordId: true, focusSenseId: true, ordinal: true },
      },
    },
  });
  for (const book of books)
    requireCheck(
      book.items.length === content.statistics.bookCounts[book.goal],
      'built_in_book_item_count_mismatch',
      { goal: book.goal, actual: book.items.length },
    );
  const bookItems = books.flatMap((book) => book.items),
    wordIds = [...new Set(bookItems.map((item) => item.wordId))];
  const words = await db.word.findMany({
    where: { id: { in: wordIds } },
    select: {
      id: true,
      lemma: true,
      normalizedLemma: true,
      sourceRef: true,
      contentVersion: true,
      status: true,
      phoneticUs: true,
      phoneticUk: true,
      audio: { where: { status: 'ready' }, select: { accent: true } },
      senses: {
        select: {
          id: true,
          wordId: true,
          pos: true,
          ordinal: true,
          definitionZh: true,
          definitionEn: true,
          exampleZh: true,
          exampleEn: true,
          contentMetadata: true,
        },
      },
      examples: { select: { id: true, exampleZh: true, exampleEn: true, contentMetadata: true } },
    },
  });
  const state = await db.siteState.findUniqueOrThrow({
    where: { id: 'singleton' },
    select: { siteId: true, instanceId: true },
  });
  requireCheck(state.siteId === siteId, 'verification_database_realm_mismatch');
  const pack = await db.contentPack.findUnique({ where: { id: 'bilingual-v1' } });
  return { siteId, instanceId: state.instanceId, books, bookItems, words, pack };
}
async function verifyAudio(db, data, verifiedAudioBytes) {
  const pack = await db.contentPack.findUnique({ where: { id: 'audio-v1' } });
  const source = JSON.parse(
    fs.readFileSync(new URL('../data/audio-pack.manifest.json', import.meta.url), 'utf8'),
  );
  requireCheck(
    pack?.status === 'ready' &&
      pack.entryCount === 17596 &&
      pack.sha256 === source.source.sha256 &&
      object(pack.tagCounts).kind === 'audio',
    'audio_pack_not_ready',
  );
  requireCheck(
    data.books.length === 5 &&
      data.words.length === 8798 &&
      data.words.every(
        (word) =>
          present(word.phoneticUs) &&
          present(word.phoneticUk) &&
          word.audio.length === 2 &&
          word.audio.some((entry) => entry.accent === 'US') &&
          word.audio.some((entry) => entry.accent === 'UK'),
      ),
    'built_in_book_audio_coverage_incomplete',
  );
  const media = await db.wordAudio.findMany({
    where: {
      word: { normalizedLemma: { in: ['rain', 'abandon', 'water', 'tomato'] } },
      status: 'ready',
    },
  });
  for (const entry of media) await verifiedAudioBytes(entry);
  requireCheck(
    media.some((entry) => entry.kind === 'recorded') &&
      media.some((entry) => entry.kind === 'synthesized'),
    'audio_sample_coverage_incomplete',
  );
  return {
    audio: data.words.reduce((n, word) => n + word.audio.length, 0),
    sampleFiles: media.length,
  };
}
function verifyPhrases(
  data,
  bundle,
  limits = {
    words: 437,
    sourceSenses: 527,
    translated: 501,
    excluded: 26,
    curated: 13,
    books: { 'cet4-phrases': 236, 'cet6-phrases': 201 },
  },
) {
  requireCheck(
    data.pack?.status === 'ready' &&
      data.pack.sha256 === bundle.manifest.sha256 &&
      data.pack.entryCount === limits.words,
    'phrase_pack_identity_not_ready',
  );
  requireCheck(
    data.words.length === limits.words &&
      bundle.rows.length === limits.words &&
      new Set(data.words.map((word) => word.id)).size === limits.words,
    'phrase_word_scope_incomplete',
  );
  const words = new Map(data.words.map((word) => [word.normalizedLemma, word]));
  const items = data.books.flatMap((book) => book.items);
  requireCheck(
    data.books.length === Object.keys(limits.books).length && items.length === limits.words,
    'phrase_book_scope_incomplete',
  );
  for (const [slug, count] of Object.entries(limits.books)) {
    const book = data.books.find((entry) => entry.slug === slug);
    requireCheck(
      book?.kind === 'phrases' &&
        book.ownerId === null &&
        book.status === 'published' &&
        book.items.length === count,
      'phrase_book_item_count_mismatch',
      { slug },
    );
  }
  const originalIds = new Set();
  const excludedIds = new Set();
  let translated = 0,
    excluded = 0,
    curated = 0,
    examples = 0;
  for (const row of bundle.rows) {
    const word = words.get(row.normalizedLemma);
    requireCheck(
      word?.id === row.sourceWordId && word.status === 'published',
      'phrase_canonical_identity_changed',
    );
    const senses = new Map(word.senses.map((sense) => [sense.id, sense]));
    const sourceFocus = senses.get(row.sourceFocusSenseId);
    requireCheck(
      sourceFocus?.wordId === word.id &&
        sha(sourceFocus.definitionZh) === row.sourceFocusTextSha256,
      'phrase_original_focus_source_changed',
    );
    for (const patch of row.senses) {
      const actual = senses.get(patch.id);
      requireCheck(
        actual?.wordId === word.id &&
          actual.definitionZh === patch.sourceText &&
          sha(actual.definitionZh) === patch.sourceTextSha256,
        'phrase_original_source_changed',
      );
      requireCheck(
        actual.definitionEn === patch.definitionEn &&
          isDeepStrictEqual(
            object(actual.contentMetadata).definitionEn,
            object(patch.contentMetadata).definitionEn,
          ),
        'phrase_definition_supplement_mismatch',
      );
      originalIds.add(patch.id);
      translated++;
    }
    for (const warning of row.qualityWarnings) {
      const original = senses.get(warning.senseId);
      const quality = object(object(original?.contentMetadata).lexicalQuality);
      const expectedExcluded = row.qualityWarnings.some(
        (entry) => entry.senseId === warning.senseId && entry.excludeFromLearning,
      );
      requireCheck(
        original?.wordId === word.id &&
          sha(original.definitionZh) === warning.sourceTextSha256 &&
          quality.excludeFromLearning === expectedExcluded &&
          quality.field === 'definitionZh' &&
          quality.sourceTextSha256 === warning.sourceTextSha256 &&
          (!expectedExcluded || !present(original.definitionEn)),
        'phrase_quality_exclusion_not_applied',
      );
      originalIds.add(warning.senseId);
      if (expectedExcluded) excludedIds.add(warning.senseId);
    }
    if (row.curatedFocus) {
      const actual = senses.get(row.curatedFocus.id);
      requireCheck(
        actual?.wordId === word.id &&
          actual.pos === row.curatedFocus.pos &&
          actual.definitionEn === row.curatedFocus.definitionEn &&
          actual.definitionZh === row.curatedFocus.definitionZh &&
          isDeepStrictEqual(actual.contentMetadata, row.curatedFocus.contentMetadata),
        'phrase_curated_focus_mismatch',
      );
      curated++;
    }
    const focus = senses.get(row.focusSenseId);
    const item = items.find((entry) => entry.wordId === word.id);
    requireCheck(
      item?.focusSenseId === row.focusSenseId &&
        focus?.wordId === word.id &&
        paired(focus, 'definition') &&
        !object(object(focus.contentMetadata).lexicalQuality).excludeFromLearning,
      'phrase_learning_focus_incomplete',
    );
    requireCheck(
      present(word.phoneticUs) &&
        present(word.phoneticUk) &&
        word.audio.length === 2 &&
        ['US', 'UK'].every((accent) => word.audio.some((entry) => entry.accent === accent)),
      'phrase_audio_phonetic_coverage_incomplete',
    );
    for (const example of row.examples) {
      const actual = word.examples.find(
        (entry) => entry.exampleEn === example.exampleEn && entry.exampleZh === example.exampleZh,
      );
      requireCheck(
        actual && isDeepStrictEqual(actual.contentMetadata, example.contentMetadata),
        'phrase_example_source_mismatch',
      );
      examples++;
    }
  }
  excluded = excludedIds.size;
  requireCheck(
    originalIds.size === limits.sourceSenses &&
      translated === limits.translated &&
      excluded === limits.excluded &&
      curated === limits.curated &&
      examples === limits.words,
    'phrase_source_coverage_mismatch',
    { original: originalIds.size, translated, excluded, curated, examples },
  );
  const phrases = new Map(bundle.rows.map((row) => [row.sourceWordId, row]));
  for (const link of data.collocations) {
    const row = phrases.get(link.phraseId);
    requireCheck(
      row &&
        row.collocationTokens.includes(link.word.normalizedLemma) &&
        link.word.id !== link.phraseId &&
        link.word.status === 'published',
      'phrase_collocation_exact_identity_invalid',
    );
  }
  requireCheck(data.collocations.length > 0, 'phrase_collocations_missing');
  return {
    words: limits.words,
    sourceSensesPreserved: originalIds.size,
    sourceSensesWithEnglish: translated,
    qualityExcludedSourceSenses: excluded,
    curatedFocusSenses: curated,
    bilingualFocusItems: items.length,
    bilingualExampleWords: examples,
    dualAccentAudioEntries: limits.words * 2,
    exactCollocationLinks: data.collocations.length,
  };
}
async function readPhrases(db, bundle) {
  const books = await db.book.findMany({
    where: {
      ownerId: null,
      kind: 'phrases',
      status: 'published',
      id: {
        in: ['cet4-phrases', 'cet6-phrases'].map(
          (goal) => 'content-' + bundle.manifest.id + '-' + goal,
        ),
      },
    },
    select: {
      id: true,
      slug: true,
      kind: true,
      ownerId: true,
      status: true,
      items: { select: { wordId: true, focusSenseId: true } },
    },
  });
  const ids = bundle.rows.map((row) => row.sourceWordId);
  const words = await db.word.findMany({
    where: { id: { in: ids } },
    include: { senses: true, examples: true, audio: { where: { status: 'ready' } } },
  });
  const collocations = await db.wordCollocation.findMany({
    where: { phraseId: { in: ids } },
    include: { word: { select: { id: true, normalizedLemma: true, status: true } } },
  });
  const pack = await db.contentPack.findUnique({ where: { id: bundle.manifest.id } });
  return { books, words, collocations, pack };
}
async function verifyPhraseAudio(db, data, verifiedAudioBytes) {
  const pack = await db.contentPack.findUnique({ where: { id: 'phrase-audio-v1' } });
  const source = JSON.parse(
    fs.readFileSync(new URL('../data/phrase-audio.manifest.json', import.meta.url), 'utf8'),
  );
  requireCheck(
    pack?.status === 'ready' &&
      pack.entryCount === 874 &&
      pack.sha256 === source.source.sha256 &&
      object(pack.tagCounts).kind === 'audio',
    'phrase_audio_pack_not_ready',
  );
  const entries = data.words.flatMap((word) => word.audio);
  for (let offset = 0; offset < entries.length; offset += 8)
    await Promise.all(entries.slice(offset, offset + 8).map((entry) => verifiedAudioBytes(entry)));
  return { phraseMediaFilesVerified: entries.length };
}
function selfTest() {
  const fixture = () => {
    const sense = {
      id: 'sense',
      wordId: 'word',
      pos: 'n.',
      ordinal: 0,
      definitionZh: '甲',
      definitionEn: '',
      exampleZh: '',
      exampleEn: '',
      contentMetadata: {},
    };
    const data = {
      siteId: 'fixture',
      instanceId: 'fixture-instance',
      books: [{ id: 'book', goal: 'daily', version: 'fixture' }],
      bookItems: [
        { id: 'item', bookId: 'book', wordId: 'word', focusSenseId: 'sense', ordinal: 0 },
      ],
      words: [
        {
          id: 'word',
          lemma: 'alpha',
          normalizedLemma: 'alpha',
          sourceRef: 'fixture',
          contentVersion: 'fixture',
          status: 'published',
          senses: [sense],
          examples: [],
        },
      ],
      pack: { status: 'ready', sha256: sha('fixture'), entryCount: 1 },
    };
    const baseline = snapshot(data);
    sense.definitionEn = 'first';
    sense.contentMetadata = { definitionEn: { sourceTextSha256: sha('甲') } };
    const metadata = {
      exampleEn: { kind: 'generated', license: 'MIT', author: 'Synthetic test fixture' },
      exampleZh: { kind: 'generated', license: 'MIT', author: 'Synthetic test fixture' },
    };
    data.words[0].examples = [
      {
        id: 'usage',
        exampleEn: 'An alpha appears.',
        exampleZh: '出现一个甲。',
        contentMetadata: metadata,
      },
    ];
    const bundle = {
      manifest: { sha256: sha('fixture'), statistics: { wordUsageExampleWordCount: 1 } },
      rows: [
        {
          normalizedLemma: 'alpha',
          senses: [
            {
              id: 'sense',
              definitionEn: 'first',
              contentMetadata: structuredClone(sense.contentMetadata),
            },
          ],
          examples: structuredClone(data.words[0].examples).map(({ id, ...value }) => value),
        },
      ],
    };
    return {
      data,
      baseline,
      bundle,
      limits: { words: 1, senses: 1, bookItems: 1, books: 1, exceptions: new Set(['oddword']) },
    };
  };
  const fail = (mutate, code, baselineCheck = false) => {
    const fixtureData = fixture();
    mutate(fixtureData);
    assert.throws(
      () =>
        baselineCheck
          ? verifyBaseline(fixtureData.data, fixtureData.baseline)
          : verifyBilingual(fixtureData.data, fixtureData.bundle, fixtureData.limits),
      (error) => error.code === code,
    );
  };
  const good = fixture();
  assert.equal(verifyBilingual(good.data, good.bundle, good.limits).pairedDefinitionSenses, 1);
  assert.equal(verifyBaseline(good.data, good.baseline).originalFieldsPreserved, 1);
  fail(({ data }) => {
    data.words[0].senses[0].definitionEn = '';
  }, 'bilingual_definition_senses_incomplete');
  fail(
    ({ data }) => {
      data.words[0].id = 'replacement';
    },
    'bilingual_original_identity_changed',
    true,
  );
  fail(
    ({ data }) => {
      data.words[0].senses[0].definitionZh = '乙';
    },
    'bilingual_original_source_text_changed',
    true,
  );
  fail(
    ({ data }) => {
      data.bookItems[0].focusSenseId = 'different';
    },
    'bilingual_original_identity_changed',
    true,
  );
  fail(({ data }) => {
    data.words[0].examples = [];
  }, 'bilingual_pack_example_missing');
  fail(({ data, bundle }) => {
    data.words[0].examples = [];
    bundle.rows[0].examples = [];
  }, 'bilingual_unexpected_example_gap');
  fail(
    ({ data }) => {
      data.words[0].senses[0].contentMetadata.definitionEn.sourceTextSha256 = sha('wrong');
    },
    'bilingual_translation_source_hash_mismatch',
    true,
  );
  fail(({ data }) => {
    data.words[0].senses[0].definitionEn = 'another translation';
  }, 'bilingual_pack_target_mismatch');
  fail(({ data }) => {
    data.words[0].senses[0].contentMetadata.definitionEn.modelLicense = 'Incorrect license';
  }, 'bilingual_definition_provenance_changed');
  fail(({ data }) => {
    data.words[0].examples[0].contentMetadata.exampleZh.author = 'Wrong author';
  }, 'bilingual_example_attribution_changed');
  fail(
    ({ data }) => {
      data.words[0].senses[0].exampleEn = 'Unattributed extra example';
    },
    'bilingual_translation_source_hash_mismatch',
    true,
  );
  const exception = fixture();
  exception.data.words[0].normalizedLemma = 'oddword';
  exception.bundle.rows[0].normalizedLemma = 'oddword';
  exception.data.words[0].examples = [];
  exception.bundle.rows[0].examples = [];
  exception.bundle.manifest.statistics.wordUsageExampleWordCount = 0;
  assert.throws(
    () => verifyBilingual(exception.data, exception.bundle, exception.limits),
    (error) => error.code === 'bilingual_exception_requires_source_warning',
  );
  exception.data.words[0].senses[0].contentMetadata.lexicalWarnings = [
    { code: 'source-spelling-unverified', message: 'Synthetic unverified source fixture.' },
  ];
  assert.deepEqual(
    verifyBilingual(exception.data, exception.bundle, exception.limits).missingWordExamples,
    ['oddword'],
  );
  const warning = {
    code: 'source-spelling-unverified',
    message: 'Synthetic unverified source fixture.',
    senseId: 'sense',
    sourceTextSha256: sha('甲'),
  };
  exception.bundle.rows[0].warnings = [warning];
  assert.equal(verifyBilingual(exception.data, exception.bundle, exception.limits).words, 1);
  warning.sourceTextSha256 = sha('different source');
  assert.throws(
    () => verifyBilingual(exception.data, exception.bundle, exception.limits),
    (error) => error.code === 'bilingual_source_warning_binding_mismatch',
  );
  const independent = fixture();
  independent.bundle.manifest.definitionPolicy = 'word-source-languages';
  const sourceEnglish = {
    ...structuredClone(independent.data.words[0].senses[0]),
    id: 'english-source',
    definitionZh: '',
    definitionEn: 'An independent original definition.',
    contentMetadata: {},
  };
  independent.data.words[0].senses[0].definitionEn = '';
  independent.bundle.rows[0].senses = [];
  independent.data.words[0].senses.push(sourceEnglish);
  independent.limits.senses = 2;
  const independentResult = verifyBilingual(
    independent.data,
    independent.bundle,
    independent.limits,
  );
  assert.equal(independentResult.wordSourceLanguagesWords, 1);
  assert.equal(independentResult.pairedDefinitionWords, 0);
  assert.equal(independentResult.pairedFocusItems, 0);
  sourceEnglish.definitionEn = '';
  assert.throws(
    () => verifyBilingual(independent.data, independent.bundle, independent.limits),
    (error) => error.code === 'bilingual_word_definitions_incomplete',
  );
  fail(({ bundle }) => {
    bundle.manifest.statistics.wordUsageExampleWordCount = 0;
  }, 'bilingual_declared_example_coverage_mismatch');
  const owner = fixture();
  for (const field of ['exampleEn', 'exampleZh']) {
    const metadata = owner.data.words[0].examples[0].contentMetadata[field];
    delete metadata.author;
    metadata.kind = 'corpus';
    metadata.sourceOwner = 'Synthetic export owner';
    metadata.sourceOwnerRole = 'export-attributed-owner';
    metadata.sourceTextSha256 = sha(owner.data.words[0].examples[0][field]);
  }
  owner.bundle.rows[0].examples = structuredClone(owner.data.words[0].examples).map(
    ({ id, ...value }) => value,
  );
  assert.equal(verifyBilingual(owner.data, owner.bundle, owner.limits).packageExamplesChecked, 1);
  owner.data.words[0].examples[0].contentMetadata.exampleZh.sourceTextSha256 =
    sha('different source');
  owner.bundle.rows[0].examples[0].contentMetadata = structuredClone(
    owner.data.words[0].examples[0].contentMetadata,
  );
  assert.throws(
    () => verifyBilingual(owner.data, owner.bundle, owner.limits),
    (error) => error.code === 'bilingual_example_source_hash_mismatch',
  );
  const phrase = fixture();
  phrase.data.words[0].phoneticUs = '/fɪkstʃər/';
  phrase.data.words[0].phoneticUk = '/fɪkstʃə/';
  phrase.data.words[0].audio = [{ accent: 'US' }, { accent: 'UK' }];
  const phraseRow = {
    normalizedLemma: 'alpha',
    sourceWordId: 'word',
    sourceFocusSenseId: 'sense',
    sourceFocusTextSha256: sha('甲'),
    focusSenseId: 'sense',
    senses: [
      {
        id: 'sense',
        sourceText: '甲',
        sourceTextSha256: sha('甲'),
        definitionEn: 'first',
        contentMetadata: structuredClone(phrase.data.words[0].senses[0].contentMetadata),
      },
    ],
    qualityWarnings: [],
    examples: structuredClone(phrase.bundle.rows[0].examples),
    collocationTokens: ['alpha'],
  };
  phrase.data.books = [
    {
      id: 'book',
      slug: 'fixture-phrases',
      kind: 'phrases',
      ownerId: null,
      status: 'published',
      items: phrase.data.bookItems,
    },
  ];
  phrase.data.collocations = [
    { phraseId: 'word', word: { id: 'head', normalizedLemma: 'alpha', status: 'published' } },
  ];
  phrase.bundle.rows = [phraseRow];
  const phraseLimits = {
    words: 1,
    sourceSenses: 1,
    translated: 1,
    excluded: 0,
    curated: 0,
    books: { 'fixture-phrases': 1 },
  };
  assert.equal(verifyPhrases(phrase.data, phrase.bundle, phraseLimits).bilingualFocusItems, 1);
  const phraseFail = (mutate, code) => {
    const copied = structuredClone({ data: phrase.data, bundle: phrase.bundle });
    mutate(copied);
    assert.throws(
      () => verifyPhrases(copied.data, copied.bundle, phraseLimits),
      (error) => error.code === code,
    );
  };
  phraseFail(({ data }) => {
    data.words[0].id = 'replacement';
  }, 'phrase_canonical_identity_changed');
  phraseFail(({ data }) => {
    data.words[0].senses[0].definitionZh = '改写';
  }, 'phrase_original_focus_source_changed');
  phraseFail(({ data }) => {
    data.words[0].audio.pop();
  }, 'phrase_audio_phonetic_coverage_incomplete');
  phraseFail(({ data }) => {
    data.collocations[0].word.normalizedLemma = 'unrelated';
  }, 'phrase_collocation_exact_identity_invalid');
  phraseFail(({ data }) => {
    data.books[0].items[0].focusSenseId = 'other';
  }, 'phrase_learning_focus_incomplete');
  const groupedWarnings = structuredClone({ data: phrase.data, bundle: phrase.bundle });
  const quality = {
    excludeFromLearning: true,
    field: 'definitionZh',
    sourceTextSha256: sha('旧源'),
  };
  groupedWarnings.data.words[0].senses.push({
    id: 'excluded',
    wordId: 'word',
    definitionZh: '旧源',
    definitionEn: '',
    contentMetadata: { lexicalQuality: quality },
  });
  groupedWarnings.bundle.rows[0].qualityWarnings = ['first', 'second'].map((code) => ({
    senseId: 'excluded',
    sourceTextSha256: sha('旧源'),
    excludeFromLearning: code === 'first',
    code,
  }));
  const groupedLimits = { ...phraseLimits, sourceSenses: 2, excluded: 1 };
  assert.equal(
    verifyPhrases(groupedWarnings.data, groupedWarnings.bundle, groupedLimits)
      .qualityExcludedSourceSenses,
    1,
  );
  quality.excludeFromLearning = false;
  assert.throws(
    () => verifyPhrases(groupedWarnings.data, groupedWarnings.bundle, groupedLimits),
    (error) => error.code === 'phrase_quality_exclusion_not_applied',
  );
  const scopeWarning = structuredClone({ data: phrase.data, bundle: phrase.bundle });
  scopeWarning.data.words[0].senses[0].contentMetadata.lexicalQuality = {
    excludeFromLearning: false,
    field: 'definitionZh',
    sourceTextSha256: sha('甲'),
  };
  scopeWarning.bundle.rows[0].qualityWarnings = [
    {
      senseId: 'sense',
      sourceTextSha256: sha('甲'),
      excludeFromLearning: false,
    },
  ];
  assert.equal(
    verifyPhrases(scopeWarning.data, scopeWarning.bundle, phraseLimits).qualityExcludedSourceSenses,
    0,
  );
  scopeWarning.data.words[0].senses[0].contentMetadata.lexicalQuality.excludeFromLearning = true;
  assert.throws(
    () => verifyPhrases(scopeWarning.data, scopeWarning.bundle, phraseLimits),
    (error) => error.code === 'phrase_quality_exclusion_not_applied',
  );
  console.log(
    JSON.stringify({ action: 'install.verify.self-test', passed: 31, databaseUsed: false }),
  );
}
async function main() {
  const { values } = parseArgs({
    options: {
      snapshot: { type: 'string' },
      'bilingual-baseline': { type: 'string' },
      'self-test': { type: 'boolean' },
    },
    strict: true,
  });
  requireCheck(!(values.snapshot && values['bilingual-baseline']), 'choose_one_verification_mode');
  if (values['self-test']) {
    selfTest();
    return;
  }
  if (fs.existsSync('.env')) process.loadEnvFile('.env');
  const [{ readConfig }, { createDatabase }, { verifiedAudioBytes }] = await Promise.all([
    import('../apps/api/dist/config.js'),
    import('../apps/api/dist/db.js'),
    import('../apps/api/dist/audio.js'),
  ]);
  const sites = readConfig().sites,
    snapshots = { formatVersion: 1, sites: {} };
  let baseline;
  if (values['bilingual-baseline']) {
    const file = path.resolve(values['bilingual-baseline']);
    requireCheck(fs.statSync(file).size <= 32 * 1024 * 1024, 'bilingual_baseline_too_large');
    baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
    requireCheck(baseline.formatVersion === 1, 'invalid_bilingual_baseline');
  }
  const bundle = baseline ? readBundle() : null;
  const phraseBundle = values.snapshot ? null : readPinnedBundle('phrase-books.manifest.json', 437);
  for (const site of sites) {
    const db = createDatabase(site.databaseUrl);
    try {
      const data = await readSite(db, site.id),
        audio = await verifyAudio(db, data, verifiedAudioBytes);
      if (values.snapshot) {
        requireCheck(!data.pack, 'bilingual_baseline_requires_uninstalled_pack');
        requireCheck(
          data.words.length === expected.words &&
            data.bookItems.length === expected.bookItems &&
            data.words.reduce((n, word) => n + word.senses.length, 0) === expected.senses,
          'bilingual_baseline_scope_incomplete',
        );
        snapshots.sites[site.id] = snapshot(data);
      }
      const original = baseline ? verifyBaseline(data, baseline.sites?.[site.id]) : null;
      const bilingual = bundle ? verifyBilingual(data, bundle) : null;
      const phraseData = phraseBundle ? await readPhrases(db, phraseBundle) : null;
      const phrases = phraseData ? verifyPhrases(phraseData, phraseBundle) : null;
      const phraseAudio = phraseData
        ? await verifyPhraseAudio(db, phraseData, verifiedAudioBytes)
        : null;
      console.log(
        JSON.stringify({
          action: 'install.verify',
          verified: true,
          siteId: site.id,
          mode: values.snapshot ? 'source-baseline' : baseline ? 'audio-and-bilingual' : 'audio',
          books: data.books.length,
          words: data.words.length,
          ...audio,
          original,
          bilingual,
          phrases,
          ...phraseAudio,
          scope:
            'Pristine built-in installation acceptance; source or catalog edits fail explicitly rather than being rewritten.',
        }),
      );
    } finally {
      await db.$disconnect();
    }
  }
  if (values.snapshot) {
    const destination = path.resolve(values.snapshot),
      temporary = destination + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(snapshots) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, destination);
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      action: 'install.verify.failed',
      code: error instanceof VerificationError ? error.code : 'verification_runtime_failed',
      ...(error instanceof VerificationError
        ? { details: error.details }
        : { errorType: error.name }),
    }),
  );
  process.exitCode = 1;
});
