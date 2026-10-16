import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const present = (value) => typeof value === 'string' && Boolean(value.trim());
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
// A Tatoeba current owner is an explicit corpus attribution role. Preserve that
// role rather than relabelling the owner as the sentence's original author.
const attributedCorpusOwner = (metadata) =>
  metadata.kind === 'corpus' &&
  present(metadata.owner) &&
  metadata.ownerRole === 'current-owner' &&
  present(metadata.attribution) &&
  typeof metadata.sourceSentenceId === 'string' &&
  /^[1-9]\d{0,18}$/.test(metadata.sourceSentenceId) &&
  metadata.sourceUrl === `https://tatoeba.org/en/sentences/show/${metadata.sourceSentenceId}`;
export class PolishVerificationError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}
const check = (condition, code, details = {}) => {
  if (!condition) throw new PolishVerificationError(code, details);
};
export function learningSense(sense) {
  const quality = object(object(sense.contentMetadata).lexicalQuality);
  return !(
    quality.excludeFromLearning === true &&
    ['definitionZh', 'definitionEn'].includes(quality.field) &&
    quality.sourceTextSha256 === sha(sense[quality.field])
  );
}
const paired = (row, prefix) => present(row[prefix + 'Zh']) && present(row[prefix + 'En']);
export function catalogItemsDigest(items, words) {
  const rows = items.map((item) => [item.ordinal, words.get(item.wordId)?.normalizedLemma]);
  check(
    rows.every((item) => present(item[1])),
    'polish_catalog_word_binding',
  );
  rows.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return sha(JSON.stringify(rows));
}

function historicalExampleIdentity(word, row, bundle, example) {
  if (bundle.manifest.id === 'bilingual-v1')
    return {
      id: 'bilingual-example-' + sha(row.normalizedLemma + '\0' + example.exampleEn),
      metadata: {
        ...example.contentMetadata,
        packId: bundle.manifest.id,
        ...(example.targetSurface ? { targetSurface: example.targetSurface } : {}),
      },
    };
  check(bundle.manifest.id === 'phrase-books-v1', 'polish_historical_example_pack_unknown');
  return {
    id: 'phrase-example-' + sha(word.id + '\0' + example.exampleEn + '\0' + example.exampleZh),
    metadata: example.contentMetadata,
  };
}

function verifyExampleCorrectionProvenance(patch, english, originalMetadata) {
  const metadata = object(patch.contentMetadata);
  const replacesEnglish = patch.exampleEn !== undefined;
  check(
    ['exampleEn', 'exampleZh'].every(
      (field) =>
        present(object(object(originalMetadata)[field]).kind) &&
        object(originalMetadata)[field].kind !== 'site-authored',
    ) &&
      metadata.exampleZh?.translatedFrom !== undefined &&
      metadata.exampleZh.translatedFrom === object(metadata.exampleZh.translatedFrom),
    'polish_example_correction_provenance_changed',
  );
  check(
    Object.hasOwn(metadata, 'exampleZh') &&
      Object.hasOwn(metadata, 'exampleEn') === replacesEnglish &&
      Object.keys(metadata).every((key) => ['exampleEn', 'exampleZh'].includes(key)),
    'polish_example_correction_provenance_changed',
  );
  for (const field of ['exampleZh', ...(replacesEnglish ? ['exampleEn'] : [])]) {
    const value = object(metadata[field]);
    check(
      value.kind === 'original-authoring' &&
        value.author === 'NightStudy contributors' &&
        value.license === 'MIT' &&
        value.review === 'pending' &&
        (field !== 'exampleEn' || value.language === 'en') &&
        value.sourceTextSha256 === sha(english),
      'polish_example_correction_provenance_changed',
    );
  }
  check(
    metadata.exampleZh.sourceLanguage === 'en' &&
      isDeepStrictEqual(
        metadata.exampleZh.translatedFrom,
        replacesEnglish ? metadata.exampleEn : object(originalMetadata).exampleEn,
      ),
    'polish_example_correction_provenance_changed',
  );
}

/** Verify every pinned target and attribution, without demanding that old source
 * packages contain definitions authored by a later package. */
export function verifyHistoricalTargets(words, bundle, successor) {
  const byLemma = new Map(words.map((word) => [word.normalizedLemma, word]));
  let fields = 0,
    examples = 0;
  for (const row of bundle.rows) {
    const word = byLemma.get(row.normalizedLemma);
    check(word, 'polish_historical_word_missing');
    const senses = new Map(word.senses.map((sense) => [sense.id, sense]));
    for (const patch of row.senses) {
      const actual = senses.get(patch.id);
      check(actual?.wordId === word.id, 'polish_historical_sense_binding');
      if (patch.sourceText !== undefined)
        check(
          actual.definitionZh === patch.sourceText &&
            sha(actual.definitionZh) === patch.sourceTextSha256,
          'polish_historical_source_changed',
        );
      for (const field of ['definitionZh', 'definitionEn', 'exampleZh', 'exampleEn']) {
        if (patch[field] === undefined) continue;
        check(
          actual[field] === patch[field] &&
            isDeepStrictEqual(
              object(actual.contentMetadata)[field],
              object(patch.contentMetadata)[field],
            ),
          'polish_historical_target_changed',
          { lemma: row.normalizedLemma, field },
        );
        fields++;
      }
    }
    if (row.curatedFocus) {
      const actual = senses.get(row.curatedFocus.id);
      for (const field of ['definitionZh', 'definitionEn', 'pos'])
        check(actual?.[field] === row.curatedFocus[field], 'polish_historical_curated_changed');
    }
    for (const example of row.examples) {
      const expected = historicalExampleIdentity(word, row, bundle, example);
      let actual = word.examples.find((entry) => entry.id === expected.id);
      check(actual?.wordId === word.id, 'polish_historical_example_binding');
      const hasOriginalText =
        actual.exampleEn === example.exampleEn && actual.exampleZh === example.exampleZh;
      const declared = successor?.rows
        .find((entry) => entry.normalizedLemma === row.normalizedLemma)
        ?.exampleCorrections?.find((entry) => entry.id === expected.id);
      if (!hasOriginalText || declared) {
        const patch = successor?.rows
          .find((entry) => entry.normalizedLemma === row.normalizedLemma)
          ?.exampleCorrections?.find(
            (entry) =>
              entry.id === expected.id &&
              entry.sourceExampleEnSha256 === sha(example.exampleEn) &&
              entry.sourceExampleZhSha256 === sha(example.exampleZh),
          );
        const archive = object(object(actual.contentMetadata).translationCorrection);
        const expectedArchive = {
          originalExampleEn: example.exampleEn,
          originalText: example.exampleZh,
          originalMetadata: expected.metadata,
          originalPackId: expected.metadata.packId ?? null,
          sourceExampleEnSha256: patch?.sourceExampleEnSha256,
          sourceExampleZhSha256: patch?.sourceExampleZhSha256,
          reason: patch?.reason,
          packId: successor?.manifest.id,
        };
        check(
          patch &&
            successor.manifest.id === 'bilingual-v2' &&
            successor.manifest.publishable === true &&
            actual.exampleEn === (patch.exampleEn ?? example.exampleEn) &&
            actual.exampleZh === patch.exampleZh &&
            isDeepStrictEqual(archive, expectedArchive),
          'polish_historical_example_correction_missing',
        );
        verifyExampleCorrectionProvenance(patch, actual.exampleEn, archive.originalMetadata);
        check(
          isDeepStrictEqual(actual.contentMetadata, {
            ...expected.metadata,
            ...patch.contentMetadata,
            packId: successor.manifest.id,
            translationCorrection: expectedArchive,
          }),
          'polish_historical_example_attribution_changed',
        );
        actual = { ...actual, contentMetadata: archive.originalMetadata };
      }
      check(
        isDeepStrictEqual(actual.contentMetadata, expected.metadata),
        'polish_historical_example_attribution_changed',
      );
      examples++;
    }
    for (const warning of row.warnings ?? []) {
      const sense = senses.get(warning.senseId);
      check(
        sense &&
          sha(sense.definitionZh) === warning.sourceTextSha256 &&
          object(sense.contentMetadata).lexicalWarnings?.some(
            (entry) => entry.code === warning.code && entry.message === warning.message,
          ),
        'polish_historical_warning_missing',
      );
    }
  }
  return { fields, examples };
}

export function verifyPolishedContent(data, bundle) {
  const { manifest, rows } = bundle,
    catalog = manifest.catalog;
  check(
    manifest.id === 'bilingual-v2' && manifest.publishable === true && catalog?.books?.length > 0,
    'polish_manifest_not_publishable',
  );
  check(
    data.pack?.status === 'ready' &&
      data.pack.sha256 === manifest.sha256 &&
      data.pack.entryCount === manifest.wordCount,
    'polish_pack_identity',
  );
  const words = new Map(data.words.map((word) => [word.id, word])),
    lemmas = new Map(data.words.map((word) => [word.normalizedLemma, word]));
  check(
    rows.length === manifest.wordCount && words.size === rows.length && lemmas.size === rows.length,
    'polish_scope_count',
  );
  const withdrawn = new Set(
    rows.filter((row) => row.defaultBookWithdrawal).map((row) => row.normalizedLemma),
  );
  check(withdrawn.size === manifest.statistics.withdrawals, 'polish_withdrawal_count');
  const active = data.words.filter((word) => !withdrawn.has(word.normalizedLemma));
  check(active.length === catalog.activeWords, 'polish_active_word_count');
  const senses = new Map(
    data.words.flatMap((word) => word.senses).map((sense) => [sense.id, sense]),
  );
  check(data.books.length === catalog.books.length, 'polish_catalog_book_count');
  let bookItems = 0,
    definitions = 0,
    exampleFields = 0,
    exampleTranslations = 0,
    positions = 0,
    corrections = 0,
    examples = 0;
  for (const expected of catalog.books) {
    const book = data.books.find((entry) => entry.id === expected.id);
    check(
      book &&
        book.ownerId === null &&
        book.status === 'published' &&
        ['slug', 'goal', 'kind', 'version'].every((field) => book[field] === expected[field]),
      'polish_catalog_book_identity',
      { id: expected.id },
    );
    check(
      book.items.length === expected.wordCount &&
        catalogItemsDigest(book.items, words) === expected.itemsSha256,
      'polish_catalog_membership_changed',
      { id: book.id },
    );
    for (const item of book.items) {
      const word = words.get(item.wordId),
        focus = senses.get(item.focusSenseId);
      check(
        word &&
          !withdrawn.has(word.normalizedLemma) &&
          focus?.wordId === word.id &&
          learningSense(focus) &&
          paired(focus, 'definition') &&
          present(focus.pos),
        'polish_learning_focus_incomplete',
        { book: book.id, lemma: word?.normalizedLemma },
      );
    }
    bookItems += book.items.length;
  }
  check(bookItems === catalog.activeBookItems, 'polish_catalog_item_total');
  for (const word of active) {
    check(word.status === 'published', 'polish_active_word_unpublished');
    const valid = word.senses
      .filter(learningSense)
      .sort((a, b) => a.ordinal - b.ordinal || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const primary = valid.find((sense) => present(sense.definitionZh));
    check(
      primary && paired(primary, 'definition') && present(primary.pos),
      'polish_primary_definition_incomplete',
      { lemma: word.normalizedLemma },
    );
    check(
      [...valid, ...word.examples].some((entry) => paired(entry, 'example')),
      'polish_bilingual_example_incomplete',
      { lemma: word.normalizedLemma },
    );
    check(
      present(word.phoneticUs) &&
        present(word.phoneticUk) &&
        word.audio.length === 2 &&
        ['US', 'UK'].every((accent) => word.audio.some((entry) => entry.accent === accent)),
      'polish_word_audio_incomplete',
      { lemma: word.normalizedLemma },
    );
  }
  for (const row of rows) {
    const word = lemmas.get(row.normalizedLemma);
    check(word, 'polish_target_word_missing');
    for (const patch of row.senses) {
      const actual = senses.get(patch.id);
      check(actual?.wordId === word.id, 'polish_target_sense_binding');
      for (const field of ['definitionZh', 'definitionEn', 'exampleZh', 'exampleEn', 'pos']) {
        if (patch[field] === undefined) continue;
        check(
          actual[field] === patch[field] &&
            isDeepStrictEqual(object(actual.contentMetadata)[field], patch.contentMetadata[field]),
          'polish_target_value_or_attribution_changed',
          { lemma: row.normalizedLemma, field },
        );
        if (field === 'pos') {
          check(
            sha(actual.definitionZh) === patch.sourceDefinitionZhSha256,
            'polish_pos_source_hash',
          );
          positions++;
        } else {
          const other = field.slice(0, -2) + (field.endsWith('En') ? 'Zh' : 'En');
          check(
            patch.contentMetadata[field].sourceTextSha256 === sha(actual[other]),
            'polish_definition_source_hash',
          );
          if (field.startsWith('definition')) definitions++;
          else exampleFields++;
        }
      }
    }
    for (const patch of row.corrections ?? []) {
      const original = senses.get(patch.replacesSenseId),
        actual = senses.get(patch.id);
      check(
        original?.wordId === word.id &&
          sha(original.definitionZh) === patch.sourceDefinitionZhSha256 &&
          sha(original.definitionEn) === patch.sourceDefinitionEnSha256 &&
          original.pos === patch.sourcePos,
        'polish_correction_original_changed',
      );
      const expectedMetadata = {
        ...patch.contentMetadata,
        packId: manifest.id,
        lexicalCorrection: {
          replacesSenseId: patch.replacesSenseId,
          sourceDefinitionZhSha256: patch.sourceDefinitionZhSha256,
          sourceDefinitionEnSha256: patch.sourceDefinitionEnSha256,
          sourcePos: patch.sourcePos,
          reason: patch.reason,
        },
      };
      check(
        actual?.wordId === word.id &&
          ['definitionZh', 'definitionEn', 'pos'].every(
            (field) => actual[field] === patch[field],
          ) &&
          isDeepStrictEqual(actual.contentMetadata, expectedMetadata),
        'polish_correction_target_changed',
      );
      check(
        !learningSense(original) &&
          object(object(original.contentMetadata).lexicalQuality).replacementSenseId === actual.id,
        'polish_correction_source_not_held',
      );
      corrections++;
    }
    for (const patch of row.exampleCorrections ?? []) {
      const actual = word.examples.find((entry) => entry.id === patch.id);
      const archive = object(object(actual?.contentMetadata).translationCorrection);
      const expectedArchive = {
        originalExampleEn: archive.originalExampleEn,
        originalText: archive.originalText,
        originalMetadata: archive.originalMetadata,
        originalPackId: object(archive.originalMetadata).packId ?? null,
        sourceExampleEnSha256: patch.sourceExampleEnSha256,
        sourceExampleZhSha256: patch.sourceExampleZhSha256,
        reason: patch.reason,
        packId: manifest.id,
      };
      check(
        actual?.wordId === word.id &&
          present(archive.originalExampleEn) &&
          present(archive.originalText) &&
          archive.originalMetadata !== null &&
          typeof archive.originalMetadata === 'object' &&
          !Array.isArray(archive.originalMetadata) &&
          sha(archive.originalExampleEn ?? '') === patch.sourceExampleEnSha256 &&
          sha(archive.originalText ?? '') === patch.sourceExampleZhSha256 &&
          isDeepStrictEqual(archive, expectedArchive),
        'polish_example_correction_archive_changed',
      );
      const expectedMetadata = {
        ...archive.originalMetadata,
        ...patch.contentMetadata,
        packId: manifest.id,
        translationCorrection: archive,
      };
      check(
        actual.exampleEn === (patch.exampleEn ?? archive.originalExampleEn) &&
          actual.exampleZh === patch.exampleZh &&
          isDeepStrictEqual(actual.contentMetadata, expectedMetadata),
        'polish_example_correction_target_changed',
      );
      verifyExampleCorrectionProvenance(patch, actual.exampleEn, archive.originalMetadata);
      exampleTranslations++;
    }
    for (const example of row.examples) {
      const actual = word.examples.find(
        (entry) => entry.exampleEn === example.exampleEn && entry.exampleZh === example.exampleZh,
      );
      const expectedMetadata = {
        ...example.contentMetadata,
        packId: manifest.id,
        ...(example.targetSurface ? { targetSurface: example.targetSurface } : {}),
      };
      check(
        actual && isDeepStrictEqual(actual.contentMetadata, expectedMetadata),
        'polish_example_attribution_changed',
      );
      for (const field of ['exampleEn', 'exampleZh']) {
        const metadata = example.contentMetadata[field];
        if (field === 'exampleEn' && metadata.kind === 'original-authoring')
          check(metadata.language === 'en', 'polish_example_language_changed');
        check(
          present(metadata.license) &&
            (present(metadata.author) ||
              present(metadata.sourceOwner) ||
              attributedCorpusOwner(metadata)),
          'polish_example_attribution_missing',
        );
        const sourceField =
          metadata.sourceLanguage === 'en'
            ? 'exampleEn'
            : metadata.sourceLanguage === 'zh'
              ? 'exampleZh'
              : field;
        check(metadata.sourceTextSha256 === sha(actual[sourceField]), 'polish_example_source_hash');
      }
      examples++;
    }
  }
  check(
    definitions === manifest.statistics.definitionFields &&
      exampleFields === manifest.statistics.exampleFields &&
      exampleTranslations === (manifest.statistics.exampleTranslations ?? 0) &&
      positions === manifest.statistics.posFields &&
      corrections === manifest.statistics.correctedSenses &&
      examples === manifest.statistics.exampleWords,
    'polish_manifest_statistics_mismatch',
  );
  return {
    words: active.length,
    sourceWords: rows.length,
    books: data.books.length,
    bookItems,
    pairedPrimaryWords: active.length,
    bilingualExampleWords: active.length,
    definitionFields: definitions,
    exampleFields,
    exampleTranslations,
    posFields: positions,
    correctedSenses: corrections,
    addedExampleWords: examples,
    withdrawnSourceTokens: withdrawn.size,
  };
}

export async function readPolishedContent(db, bundle) {
  const words = await db.word.findMany({
    where: { normalizedLemma: { in: bundle.rows.map((row) => row.normalizedLemma) } },
    include: { senses: true, examples: true, audio: { where: { status: 'ready' } } },
  });
  const books = await db.book.findMany({
    where: {
      ownerId: null,
      OR: [
        { version: { startsWith: 'ecdict-' } },
        { version: 'exam-books-v1', id: { startsWith: 'content-exam-books-v1-' } },
        { version: '2026-10-14-v1', id: { startsWith: 'content-phrase-books-v1-' } },
      ],
    },
    include: { items: true },
  });
  const pack = await db.contentPack.findUnique({ where: { id: bundle.manifest.id } });
  return { words, books, pack };
}

export function polishSelfTest() {
  const sense = {
    id: 's',
    wordId: 'w',
    pos: 'n.',
    definitionZh: '窗户',
    definitionEn: 'An opening in a wall.',
    ordinal: 0,
    contentMetadata: {},
  };
  assert.equal(learningSense(sense), true);
  sense.contentMetadata.lexicalQuality = {
    excludeFromLearning: true,
    field: 'definitionZh',
    sourceTextSha256: sha('窗户'),
  };
  assert.equal(learningSense(sense), false);
  sense.definitionZh = '管理员修改';
  assert.equal(learningSense(sense), true);
  const words = new Map([['w', { normalizedLemma: 'window' }]]);
  assert.equal(catalogItemsDigest([{ ordinal: 2, wordId: 'w' }], words), sha('[[2,"window"]]'));
  assert.throws(
    () => catalogItemsDigest([{ ordinal: 2, wordId: 'missing' }], words),
    (error) => error.code === 'polish_catalog_word_binding',
  );
  const english = 'The window faces north.',
    chinese = '窗户朝北。';
  const definitionMetadata = {
    kind: 'original-authoring',
    license: 'MIT',
    author: 'NightStudy contributors',
    sourceTextSha256: sha('窗户'),
  };
  const exampleMetadata = {
    exampleEn: {
      kind: 'original-authoring',
      language: 'en',
      license: 'MIT',
      author: 'NightStudy contributors',
      sourceTextSha256: sha(english),
    },
    exampleZh: {
      kind: 'original-authoring',
      license: 'MIT',
      author: 'NightStudy contributors',
      sourceLanguage: 'en',
      sourceTextSha256: sha(english),
    },
  };
  const row = {
    normalizedLemma: 'window',
    senses: [
      {
        id: 's',
        definitionEn: 'An opening in a wall.',
        contentMetadata: { definitionEn: definitionMetadata },
      },
    ],
    examples: [{ exampleEn: english, exampleZh: chinese, contentMetadata: exampleMetadata }],
  };
  const bundle = {
    manifest: {
      id: 'bilingual-v2',
      publishable: true,
      sha256: sha('fixture'),
      wordCount: 1,
      statistics: {
        withdrawals: 0,
        definitionFields: 1,
        exampleFields: 0,
        posFields: 0,
        correctedSenses: 0,
        exampleWords: 1,
      },
      catalog: {
        activeWords: 1,
        activeBookItems: 1,
        books: [
          {
            id: 'book',
            slug: 'fixture',
            goal: 'daily',
            kind: 'vocabulary',
            version: 'fixture',
            wordCount: 1,
            itemsSha256: sha('[[2,"window"]]'),
          },
        ],
      },
    },
    rows: [row],
  };
  const data = {
    pack: { status: 'ready', sha256: bundle.manifest.sha256, entryCount: 1 },
    books: [
      {
        ...bundle.manifest.catalog.books[0],
        ownerId: null,
        status: 'published',
        items: [{ id: 'item', wordId: 'w', focusSenseId: 's', ordinal: 2 }],
      },
    ],
    words: [
      {
        id: 'w',
        normalizedLemma: 'window',
        status: 'published',
        phoneticUs: '/ˈwɪndoʊ/',
        phoneticUk: '/ˈwɪndəʊ/',
        audio: [{ accent: 'US' }, { accent: 'UK' }],
        senses: [
          { ...sense, definitionZh: '窗户', contentMetadata: { definitionEn: definitionMetadata } },
        ],
        examples: [
          {
            exampleEn: english,
            exampleZh: chinese,
            contentMetadata: { ...exampleMetadata, packId: 'bilingual-v2' },
          },
        ],
      },
    ],
  };
  assert.equal(verifyPolishedContent(data, bundle).pairedPrimaryWords, 1);
  for (const [mutate, code] of [
    [
      (value) => {
        value.books[0].items[0].ordinal = 3;
      },
      'polish_catalog_membership_changed',
    ],
    [
      (value) => {
        value.books[0].items[0].focusSenseId = 'foreign';
      },
      'polish_learning_focus_incomplete',
    ],
    [
      (value) => {
        value.words[0].senses[0].definitionEn = '';
      },
      'polish_learning_focus_incomplete',
    ],
    [
      (value) => {
        value.words[0].examples = [];
      },
      'polish_bilingual_example_incomplete',
    ],
    [
      (value) => {
        value.words[0].audio.pop();
      },
      'polish_word_audio_incomplete',
    ],
  ]) {
    const copied = structuredClone(data);
    mutate(copied);
    assert.throws(
      () => verifyPolishedContent(copied, bundle),
      (error) => error.code === code,
    );
  }
  // The database row, frozen successor and historical package must be separate
  // JSON values: mutating a simulated row must never also change its authority.
  function correctionFixture(replaceEnglish = false, oldPack = 'bilingual-v1') {
    const oldEnglish = 'The window faces north.\r\n',
      oldChinese = '  窗户朝南。\r\n',
      newEnglish = replaceEnglish ? 'Please close the window.' : oldEnglish,
      newChinese = replaceEnglish ? '请关上窗户。' : '窗户朝北。';
    const historicalExample = {
      exampleEn: oldEnglish,
      exampleZh: oldChinese,
      contentMetadata: {
        exampleEn: { kind: 'corpus', sourceOwner: 'Original English author', license: 'Synthetic' },
        exampleZh: { kind: 'corpus', sourceOwner: 'Original Chinese author', license: 'Synthetic' },
        selection: { retain: ['source context', { ordinal: 7 }] },
      },
    };
    const historical = {
      manifest: { id: oldPack },
      rows: [{ normalizedLemma: 'window', senses: [], examples: [historicalExample] }],
    };
    const original = historicalExampleIdentity(data.words[0], row, historical, historicalExample);
    const originalMetadata = original.metadata;
    const newAuthorship = {
      kind: 'original-authoring',
      author: 'NightStudy contributors',
      license: 'MIT',
      review: 'pending',
      sourceTextSha256: sha(newEnglish),
    };
    const patch = {
      id: original.id,
      sourceExampleEnSha256: sha(oldEnglish),
      sourceExampleZhSha256: sha(oldChinese),
      ...(replaceEnglish ? { exampleEn: newEnglish } : {}),
      exampleZh: newChinese,
      reason: 'The original Chinese reverses the intended direction.',
      contentMetadata: {
        ...(replaceEnglish ? { exampleEn: { ...newAuthorship, language: 'en' } } : {}),
        exampleZh: {
          ...newAuthorship,
          language: 'zh-CN',
          sourceLanguage: 'en',
          translatedFrom: replaceEnglish
            ? { ...newAuthorship, language: 'en' }
            : originalMetadata.exampleEn,
        },
      },
    };
    const archive = {
      originalExampleEn: oldEnglish,
      originalText: oldChinese,
      originalMetadata,
      originalPackId: originalMetadata.packId ?? null,
      sourceExampleEnSha256: patch.sourceExampleEnSha256,
      sourceExampleZhSha256: patch.sourceExampleZhSha256,
      reason: patch.reason,
      packId: 'bilingual-v2',
    };
    const copiedData = structuredClone(data),
      copiedBundle = structuredClone(bundle);
    copiedData.words[0].examples = [
      {
        id: patch.id,
        wordId: 'w',
        ordinal: 19,
        exampleEn: newEnglish,
        exampleZh: newChinese,
        contentMetadata: {
          ...originalMetadata,
          ...patch.contentMetadata,
          packId: 'bilingual-v2',
          translationCorrection: archive,
        },
      },
    ];
    copiedBundle.rows[0].examples = [];
    copiedBundle.rows[0].exampleCorrections = [patch];
    copiedBundle.manifest.statistics.exampleWords = 0;
    copiedBundle.manifest.statistics.exampleTranslations = 1;
    return JSON.parse(JSON.stringify({ data: copiedData, bundle: copiedBundle, historical }));
  }
  let correctionChecks = 0;
  function corpusOwnerFixture() {
    const fixture = structuredClone({ data, bundle });
    for (const field of ['exampleEn', 'exampleZh']) {
      const sourceSentenceId = field === 'exampleEn' ? '14061594' : '14061592';
      const metadata = {
        kind: 'corpus',
        owner: 'Fixture current owner',
        ownerRole: 'current-owner',
        attribution: `Tatoeba sentence #${sourceSentenceId}; current owner: Fixture current owner`,
        license: 'CC BY 2.0 FR',
        sourceSentenceId,
        sourceUrl: `https://tatoeba.org/en/sentences/show/${sourceSentenceId}`,
        sourceTextSha256: sha(field === 'exampleEn' ? english : chinese),
      };
      fixture.data.words[0].examples[0].contentMetadata[field] = structuredClone(metadata);
      fixture.bundle.rows[0].examples[0].contentMetadata[field] = structuredClone(metadata);
    }
    return fixture;
  }
  const ownedCorpus = corpusOwnerFixture();
  assert.equal(verifyPolishedContent(ownedCorpus.data, ownedCorpus.bundle).pairedPrimaryWords, 1);
  correctionChecks++;
  for (const field of ['exampleEn', 'exampleZh'])
    for (const mutate of [
      (metadata) => {
        delete metadata.owner;
      },
      (metadata) => {
        delete metadata.ownerRole;
      },
      (metadata) => {
        metadata.ownerRole = 'original-author';
      },
      (metadata) => {
        delete metadata.attribution;
      },
      (metadata) => {
        metadata.kind = 'site-authored';
      },
      (metadata) => {
        delete metadata.sourceSentenceId;
      },
      (metadata) => {
        metadata.sourceSentenceId = '0';
      },
      (metadata) => {
        metadata.sourceUrl = 'https://tatoeba.org/en/sentences/show/999';
      },
      (metadata) => {
        metadata.sourceUrl = 'https://example.test/en/sentences/show/' + metadata.sourceSentenceId;
      },
      (metadata) => {
        delete metadata.license;
      },
    ]) {
      const fixture = corpusOwnerFixture();
      mutate(fixture.bundle.rows[0].examples[0].contentMetadata[field]);
      fixture.data.words[0].examples[0].contentMetadata[field] = structuredClone(
        fixture.bundle.rows[0].examples[0].contentMetadata[field],
      );
      assert.throws(
        () => verifyPolishedContent(fixture.data, fixture.bundle),
        (error) => error.code === 'polish_example_attribution_missing',
      );
      correctionChecks++;
    }
  for (const language of [undefined, 'zh-CN']) {
    const fixture = JSON.parse(JSON.stringify({ data, bundle }));
    fixture.data.words[0].examples[0].contentMetadata.exampleEn.language = language;
    fixture.bundle.rows[0].examples[0].contentMetadata.exampleEn.language = language;
    assert.throws(
      () => verifyPolishedContent(fixture.data, fixture.bundle),
      (error) => error.code === 'polish_example_language_changed',
    );
    correctionChecks++;
  }
  function verifyBoth(fixture) {
    assert.equal(verifyPolishedContent(fixture.data, fixture.bundle).exampleTranslations, 1);
    correctionChecks++;
    assert.equal(
      verifyHistoricalTargets(fixture.data.words, fixture.historical, fixture.bundle).examples,
      1,
    );
    correctionChecks++;
  }
  function rejected(fixture, verifier, code) {
    assert.throws(
      () =>
        verifier === 'historical'
          ? verifyHistoricalTargets(fixture.data.words, fixture.historical, fixture.bundle)
          : verifyPolishedContent(fixture.data, fixture.bundle),
      (error) => error instanceof PolishVerificationError && error.code === code,
    );
    correctionChecks++;
  }
  function resealCurrentMetadata(fixture) {
    const actual = fixture.data.words[0].examples[0],
      patch = fixture.bundle.rows[0].exampleCorrections[0],
      archive = actual.contentMetadata.translationCorrection;
    actual.contentMetadata = JSON.parse(
      JSON.stringify({
        ...archive.originalMetadata,
        ...patch.contentMetadata,
        packId: fixture.bundle.manifest.id,
        translationCorrection: archive,
      }),
    );
  }
  for (const oldPack of ['bilingual-v1', 'phrase-books-v1'])
    for (const replaceEnglish of [false, true])
      verifyBoth(correctionFixture(replaceEnglish, oldPack));

  const untouched = correctionFixture();
  const untouchedRow = untouched.data.words[0].examples[0],
    untouchedArchive = untouchedRow.contentMetadata.translationCorrection;
  untouchedRow.exampleEn = untouchedArchive.originalExampleEn;
  untouchedRow.exampleZh = untouchedArchive.originalText;
  untouchedRow.contentMetadata = untouchedArchive.originalMetadata;
  assert.equal(verifyHistoricalTargets(untouched.data.words, untouched.historical).examples, 1);
  correctionChecks++;
  rejected(untouched, 'historical', 'polish_historical_example_correction_missing');
  const noSuccessor = correctionFixture();
  assert.throws(
    () => verifyHistoricalTargets(noSuccessor.data.words, noSuccessor.historical),
    (error) => error.code === 'polish_historical_example_correction_missing',
  );
  correctionChecks++;
  for (const mutate of [
    (fixture) => {
      fixture.bundle.rows = [];
    },
    (fixture) => {
      fixture.bundle.rows[0].normalizedLemma = 'another-word';
    },
    (fixture) => {
      fixture.bundle.rows[0].exampleCorrections[0].id = 'foreign-example';
    },
    (fixture) => {
      fixture.bundle.manifest.id = 'foreign-pack';
    },
    (fixture) => {
      fixture.bundle.manifest.publishable = false;
    },
    (fixture) => {
      fixture.bundle.rows[0].exampleCorrections[0].sourceExampleZhSha256 = sha('wrong');
    },
  ]) {
    const fixture = correctionFixture();
    mutate(fixture);
    rejected(fixture, 'historical', 'polish_historical_example_correction_missing');
  }
  for (const [field, replacement] of [
    ['originalExampleEn', 'The window faces south.'],
    ['originalText', '窗户朝南。'], // Trimming the archived bytes is still corruption.
    ['sourceExampleEnSha256', sha('wrong')],
    ['sourceExampleZhSha256', sha('wrong')],
    ['reason', 'An unreviewed reason'],
    ['packId', 'foreign-pack'],
    ['originalPackId', 'foreign-original-pack'],
    ['originalMetadata', []],
    ['unexpectedArchiveField', 'not produced by the installer'],
  ]) {
    const fixture = correctionFixture();
    fixture.data.words[0].examples[0].contentMetadata.translationCorrection[field] = replacement;
    rejected(fixture, 'polished', 'polish_example_correction_archive_changed');
    rejected(fixture, 'historical', 'polish_historical_example_correction_missing');
  }
  for (const mutate of [
    (archive) => {
      archive.originalMetadata.exampleEn.sourceOwner = 'Different author';
    },
    (archive) => {
      archive.originalMetadata.exampleZh.license = 'Different license';
    },
    (archive) => {
      archive.originalMetadata.selection.retain[1].ordinal = 8;
    },
    (archive) => {
      archive.originalMetadata.packId = 'foreign-original-pack';
      archive.originalPackId = 'foreign-original-pack';
    },
  ]) {
    const fixture = correctionFixture();
    mutate(fixture.data.words[0].examples[0].contentMetadata.translationCorrection);
    resealCurrentMetadata(fixture); // A self-consistent forged archive is not its historical authority.
    rejected(fixture, 'historical', 'polish_historical_example_correction_missing');
  }
  for (const field of ['exampleEn', 'exampleZh']) {
    const fixture = correctionFixture();
    fixture.data.words[0].examples[0][field] = 'Unplanned replacement';
    rejected(fixture, 'polished', 'polish_example_correction_target_changed');
    rejected(fixture, 'historical', 'polish_historical_example_correction_missing');
  }
  for (const field of ['exampleEn', 'exampleZh'])
    for (const replacement of [undefined, [], {}, { kind: '' }, { kind: 'site-authored' }]) {
      const fixture = correctionFixture(true);
      const archive = fixture.data.words[0].examples[0].contentMetadata.translationCorrection;
      archive.originalMetadata[field] = replacement;
      resealCurrentMetadata(fixture);
      rejected(fixture, 'polished', 'polish_example_correction_provenance_changed');
      rejected(fixture, 'historical', 'polish_historical_example_correction_missing');
    }
  for (const field of ['id', 'wordId']) {
    const fixture = correctionFixture();
    fixture.data.words[0].examples[0][field] = 'foreign-identity';
    rejected(fixture, 'polished', 'polish_example_correction_archive_changed');
    rejected(fixture, 'historical', 'polish_historical_example_binding');
  }
  const wrongOldId = correctionFixture();
  wrongOldId.data.words[0].examples[0] = { ...untouchedRow, id: 'same-text-wrong-id' };
  rejected(wrongOldId, 'historical', 'polish_historical_example_binding');

  const changedCurrentMetadata = correctionFixture();
  changedCurrentMetadata.data.words[0].examples[0].contentMetadata.exampleZh.author =
    'Another author';
  rejected(changedCurrentMetadata, 'polished', 'polish_example_correction_target_changed');
  rejected(changedCurrentMetadata, 'historical', 'polish_historical_example_attribution_changed');
  for (const [replaceEnglish, mutate] of [
    [
      false,
      (metadata) => {
        metadata.exampleZh.review = 'certified';
      },
    ],
    [
      false,
      (metadata) => {
        delete metadata.exampleZh.sourceTextSha256;
      },
    ],
    [
      false,
      (metadata) => {
        metadata.exampleZh.sourceTextSha256 = sha('wrong');
      },
    ],
    [
      false,
      (metadata) => {
        metadata.exampleZh.sourceLanguage = 'zh';
      },
    ],
    [
      false,
      (metadata) => {
        metadata.exampleZh.translatedFrom = { sourceOwner: 'Invented author' };
      },
    ],
    [
      false,
      (metadata) => {
        metadata.exampleEn = { ...metadata.exampleZh };
      },
    ],
    [
      true,
      (metadata) => {
        delete metadata.exampleEn;
      },
    ],
    [
      true,
      (metadata) => {
        metadata.exampleEn.license = 'Unreviewed license';
      },
    ],
    [
      true,
      (metadata) => {
        metadata.exampleEn.sourceTextSha256 = sha('The old English.');
      },
    ],
    [
      true,
      (metadata) => {
        metadata.exampleEn.review = 'expert-certified';
      },
    ],
    [
      true,
      (metadata) => {
        delete metadata.exampleEn.language;
        metadata.exampleZh.translatedFrom = { ...metadata.exampleEn };
      },
    ],
    [
      true,
      (metadata) => {
        metadata.exampleEn.language = 'zh-CN';
        metadata.exampleZh.translatedFrom = { ...metadata.exampleEn };
      },
    ],
    [
      true,
      (metadata) => {
        metadata.unplannedField = {};
      },
    ],
  ]) {
    const fixture = correctionFixture(replaceEnglish);
    mutate(fixture.bundle.rows[0].exampleCorrections[0].contentMetadata);
    resealCurrentMetadata(fixture);
    rejected(fixture, 'polished', 'polish_example_correction_provenance_changed');
    rejected(fixture, 'historical', 'polish_example_correction_provenance_changed');
  }
  return 11 + correctionChecks;
}
