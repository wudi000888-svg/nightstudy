import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parseArgs, isDeepStrictEqual } from 'node:util';

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) =>
  Array.isArray(value)
    ? '[' + value.map(canonical).join(',') + ']'
    : value !== null && typeof value === 'object'
      ? '{' +
        Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
          .join(',') +
        '}'
      : JSON.stringify(value);
const normalizeAudioText = (value) =>
  value.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/gu, ' ').trim();
class VerificationError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}
const check = (condition, code, details = {}) => {
  if (!condition) throw new VerificationError(code, details);
};
const bindingFields = [
  'sourceSenseId',
  'relation',
  'sourcePosSha256',
  'sourceDefinitionZhSha256',
  'sourceDefinitionEnSha256',
];
function meaningHash(sense) {
  const value = Object.fromEntries(
    ['id', 'wordId', 'pos', 'definitionZh', 'definitionEn', 'contentVersion'].map((key) => [
      key,
      sense[key],
    ]),
  );
  value.sourceBindings = [...sense.sourceBindings]
    .sort((a, b) =>
      a.sourceSenseId < b.sourceSenseId ? -1 : a.sourceSenseId > b.sourceSenseId ? 1 : 0,
    )
    .map((binding) => Object.fromEntries(bindingFields.map((key) => [key, binding[key]])));
  return sha(canonical(value));
}

export function readLearningSensesBundle(
  manifestPath = new URL('../data/learning-senses-v1.manifest.json', import.meta.url),
) {
  const filename =
    manifestPath instanceof URL ? fileURLToPath(manifestPath) : path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  check(
    manifest.formatVersion === 1 &&
      /^learning-senses-[a-z0-9-]+$/.test(manifest.id) &&
      /^[a-z0-9.-]+\.jsonl\.gz$/.test(manifest.fileName),
    'invalid_learning_senses_manifest',
  );
  const bytes = fs.readFileSync(path.join(path.dirname(filename), manifest.fileName));
  check(
    bytes.length === manifest.bytes && sha(bytes) === manifest.sha256,
    'learning_senses_pack_checksum',
  );
  const decoded = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
  check(sha(decoded) === manifest.jsonlSha256, 'learning_senses_decoded_checksum');
  const rows = new TextDecoder('utf-8', { fatal: true })
    .decode(decoded)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  check(
    rows.length === manifest.wordCount &&
      rows.flatMap((row) => row.senses).length === manifest.senseCount &&
      rows.flatMap((row) => row.senses.flatMap((sense) => sense.examples)).length ===
        manifest.exampleCount,
    'learning_senses_pack_counts',
  );
  return { manifest, rows };
}

function exactRecord(actual, expected, code) {
  check(
    actual && Object.keys(expected).every((key) => isDeepStrictEqual(actual[key], expected[key])),
    code,
    { id: expected.id },
  );
}

/** Independent read-side verification of actual database rows, not an install dry run. */
export function verifyLearningSenses(data, bundle, baseline = null) {
  const { manifest, rows } = bundle;
  check(data.siteId && data.siteId === data.expectedSiteId, 'learning_senses_realm_mismatch');
  check(
    data.pack?.status === 'ready' &&
      data.pack.sha256 === manifest.sha256 &&
      data.pack.version === manifest.version &&
      data.pack.entryCount === manifest.wordCount &&
      data.pack.definitionZhCount === manifest.senseCount &&
      data.pack.definitionEnCount === manifest.senseCount,
    'learning_senses_installed_pin',
  );
  check(
    data.pack.tagCounts?.kind === 'learning-senses' &&
      data.pack.tagCounts.learningSenses === manifest.senseCount &&
      data.pack.tagCounts.contextExamples === manifest.exampleCount &&
      data.pack.tagCounts.exhaustiveBookCoverage === false,
    'learning_senses_installed_scope',
  );
  const words = new Map(data.words.map((word) => [word.id, word]));
  const raw = new Map(data.rawSenses.map((sense) => [sense.id, sense]));
  const meanings = new Map(data.learningSenses.map((sense) => [sense.id, sense]));
  const bindings = new Map(data.bindings.map((binding) => [binding.id, binding]));
  const examples = new Map(data.examples.map((example) => [example.id, example]));
  check(
    words.size === rows.length &&
      meanings.size === manifest.senseCount &&
      examples.size === manifest.exampleCount &&
      bindings.size ===
        rows.reduce(
          (count, row) =>
            count + row.senses.reduce((n, sense) => n + sense.sourceBindings.length, 0),
          0,
        ),
    'learning_senses_installed_counts',
  );
  let sourceBindings = 0;
  for (const row of rows) {
    check(
      words.get(row.wordId)?.normalizedLemma === row.normalizedLemma,
      'learning_senses_word_identity',
      { wordId: row.wordId },
    );
    const sentenceHashes = new Set();
    for (const expected of row.senses) {
      const {
        sourceBindings: expectedBindings,
        examples: expectedExamples,
        ...expectedRecord
      } = expected;
      const meaning = meanings.get(expected.id);
      exactRecord(meaning, expectedRecord, 'learning_senses_meaning_changed');
      check(
        meaning.wordId === row.wordId && meaning.status === 'published',
        'learning_senses_meaning_cross_word',
      );
      const actualBindings = data.bindings.filter(
        (binding) => binding.learningSenseId === meaning.id,
      );
      check(
        actualBindings.length === expectedBindings.length &&
          meaning.bindingHash === meaningHash({ ...meaning, sourceBindings: actualBindings }),
        'learning_senses_binding_hash',
      );
      for (const expectedBinding of expectedBindings) {
        const binding = bindings.get(expectedBinding.id);
        exactRecord(binding, expectedBinding, 'learning_senses_binding_changed');
        const source = raw.get(binding.sourceSenseId);
        check(
          binding.learningSenseId === meaning.id &&
            binding.wordId === row.wordId &&
            source?.wordId === row.wordId,
          'learning_senses_cross_word_source',
        );
        check(
          sha(source.pos) === binding.sourcePosSha256 &&
            sha(source.definitionZh) === binding.sourceDefinitionZhSha256 &&
            sha(source.definitionEn) === binding.sourceDefinitionEnSha256,
          'learning_senses_source_byte_drift',
          { sourceSenseId: binding.sourceSenseId },
        );
        sourceBindings++;
      }
      const contexts = new Set();
      for (const expectedExample of expectedExamples) {
        const example = examples.get(expectedExample.id);
        exactRecord(example, expectedExample, 'learning_senses_example_changed');
        check(
          example.wordId === row.wordId &&
            example.learningSenseId === meaning.id &&
            example.status === 'published',
          'learning_senses_cross_word_example',
        );
        const meta = example.contentMetadata;
        const surface = meta?.targetSurface;
        check(
          meta?.exampleEnSha256 === sha(example.exampleEn) &&
            meta?.exampleZhSha256 === sha(example.exampleZh) &&
            meta?.textHash === sha(normalizeAudioText(example.exampleEn)),
          'learning_senses_example_text_hash',
        );
        check(
          surface?.lemma === row.normalizedLemma &&
            surface?.review === 'codex-reviewed' &&
            typeof surface?.form === 'string',
          'learning_senses_target_surface_identity',
        );
        const escaped = surface.form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        check(
          new RegExp(`(?<![\\p{L}\\p{M}])${escaped}(?![\\p{L}\\p{M}])`, 'iu').test(
            example.exampleEn,
          ),
          'learning_senses_target_surface_absent',
        );
        check(!sentenceHashes.has(meta.textHash), 'learning_senses_sentence_reused_for_word');
        sentenceHashes.add(meta.textHash);
        contexts.add(example.contextLabel);
      }
      check(contexts.size >= 2, 'learning_senses_two_contexts');
    }
  }
  if (baseline) {
    check(
      baseline.formatVersion === 1 &&
        baseline.siteId === data.siteId &&
        baseline.instanceId === data.instanceId,
      'learning_senses_baseline_realm',
    );
    const current = sourceSnapshot(data);
    check(
      isDeepStrictEqual(current.words, baseline.words) &&
        isDeepStrictEqual(current.rawSenses, baseline.rawSenses),
      'learning_senses_original_source_identity_changed',
    );
  }
  return {
    words: rows.length,
    learningSenses: manifest.senseCount,
    sourceBindings,
    bilingualContextExamples: manifest.exampleCount,
    contextsPerSenseMinimum: 2,
    exhaustiveBookCoverage: false,
    expertCertified: false,
    originalSourceBaselineChecked: Boolean(baseline),
  };
}

export function sourceSnapshot(data) {
  return {
    formatVersion: 1,
    siteId: data.siteId,
    instanceId: data.instanceId,
    words: data.words
      .map((word) =>
        Object.fromEntries(
          ['id', 'lemma', 'normalizedLemma', 'sourceRef', 'contentVersion', 'status'].map((key) => [
            key,
            word[key],
          ]),
        ),
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    rawSenses: data.rawSenses
      .map((sense) => ({
        id: sense.id,
        wordId: sense.wordId,
        pos: sense.pos,
        ordinal: sense.ordinal,
        fieldHashes: Object.fromEntries(
          ['definitionZh', 'definitionEn', 'exampleZh', 'exampleEn'].map((field) => [
            field,
            sha(sense[field]),
          ]),
        ),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

export async function verifyLearningSentenceAudio(rows, audioRows, audioRoot) {
  const targets = new Map(
    rows
      .flatMap((row) => row.senses.flatMap((sense) => sense.examples))
      .map((example) => [example.contentMetadata.textHash, normalizeAudioText(example.exampleEn)]),
  );
  const installed = new Map(
    audioRows.map((entry) => [entry.textHash + '\0' + entry.accent, entry]),
  );
  const missing = [];
  const verifiedFiles = new Set();
  const problems = [];
  let readyTargets = 0;
  for (const [textHash, text] of targets)
    for (const accent of ['US', 'UK']) {
      const entry = installed.get(textHash + '\0' + accent);
      if (!entry || entry.status !== 'ready') {
        missing.push({ textHash, accent });
        continue;
      }
      if (
        normalizeAudioText(entry.text) !== text ||
        sha(normalizeAudioText(entry.text)) !== textHash ||
        !['recorded', 'synthesized'].includes(entry.kind)
      ) {
        problems.push({ textHash, accent, error: 'sentence_audio_identity' });
        continue;
      }
      if (
        !['sourceName', 'sourceUrl', 'license', 'attribution'].every(
          (field) => typeof entry[field] === 'string' && entry[field].trim(),
        ) ||
        !['audio/mpeg', 'audio/wav', 'audio/ogg'].includes(entry.mimeType)
      ) {
        problems.push({ textHash, accent, error: 'sentence_audio_attribution_or_type' });
        continue;
      }
      if (
        !/^[a-z0-9][a-z0-9/_\-.]*\.(?:mp3|wav|ogg)$/i.test(entry.fileKey) ||
        entry.fileKey.split('/').includes('..') ||
        !/^[a-f0-9]{64}$/.test(entry.fileSha256)
      ) {
        problems.push({ textHash, accent, error: 'sentence_audio_path_or_digest' });
        continue;
      }
      try {
        const root = fs.realpathSync(audioRoot);
        const filename = fs.realpathSync(path.join(root, entry.fileKey));
        const relative = path.relative(root, filename);
        if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
          throw new Error('unsafe_path');
        const stat = fs.statSync(filename);
        if (!stat.isFile() || stat.size < 44 || stat.size > 16 * 1024 * 1024)
          throw new Error('invalid_size');
        const fileIdentity = filename + '\0' + entry.fileSha256;
        if (!verifiedFiles.has(fileIdentity)) {
          const digest = crypto.createHash('sha256');
          for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
          if (digest.digest('hex') !== entry.fileSha256) throw new Error('invalid_digest');
          verifiedFiles.add(fileIdentity);
        }
        readyTargets++;
      } catch {
        problems.push({ textHash, accent, error: 'sentence_audio_file_integrity' });
      }
    }
  return {
    checked: true,
    sentences: targets.size,
    targets: targets.size * 2,
    readyTargets,
    missingCount: missing.length,
    integrityProblemCount: problems.length,
    verifiedFiles: verifiedFiles.size,
    missing: missing.slice(0, 30),
    problems: problems.slice(0, 30),
  };
}

async function selfTest() {
  const bundle = readLearningSensesBundle();
  const { rows, manifest } = bundle;
  const data = {
    expectedSiteId: 'fixture',
    siteId: 'fixture',
    instanceId: 'original-fixture',
    pack: {
      status: 'ready',
      sha256: manifest.sha256,
      version: manifest.version,
      entryCount: manifest.wordCount,
      definitionZhCount: manifest.senseCount,
      definitionEnCount: manifest.senseCount,
      tagCounts: {
        kind: 'learning-senses',
        learningSenses: manifest.senseCount,
        contextExamples: manifest.exampleCount,
        exhaustiveBookCoverage: false,
      },
    },
    words: rows.map((row) => ({
      id: row.wordId,
      lemma: row.normalizedLemma,
      normalizedLemma: row.normalizedLemma,
      sourceRef: 'synthetic',
      contentVersion: 'synthetic',
      status: 'published',
    })),
    rawSenses: [],
    learningSenses: rows.flatMap((row) =>
      row.senses.map(({ sourceBindings, examples, ...sense }) => sense),
    ),
    bindings: rows.flatMap((row) => row.senses.flatMap((sense) => sense.sourceBindings)),
    examples: rows.flatMap((row) => row.senses.flatMap((sense) => sense.examples)),
  };
  // Source identities need their real source bytes. For this independent checker
  // self-test, explicit source fixtures replace only those hash fields and the
  // derived meaning digest in both the expected bundle and the synthetic DB.
  const sourceIds = new Set();
  for (const binding of data.bindings) {
    if (!sourceIds.has(binding.sourceSenseId)) {
      data.rawSenses.push({
        id: binding.sourceSenseId,
        wordId: binding.wordId,
        pos: 'n.',
        definitionZh: '合成源',
        definitionEn: 'Synthetic source.',
        exampleZh: '',
        exampleEn: '',
        ordinal: 0,
      });
      sourceIds.add(binding.sourceSenseId);
    }
    binding.sourcePosSha256 = sha('n.');
    binding.sourceDefinitionZhSha256 = sha('合成源');
    binding.sourceDefinitionEnSha256 = sha('Synthetic source.');
  }
  for (const row of rows) for (const sense of row.senses) sense.bindingHash = meaningHash(sense);
  for (const sense of data.learningSenses)
    sense.bindingHash = rows
      .flatMap((row) => row.senses)
      .find((item) => item.id === sense.id).bindingHash;
  const baseline = sourceSnapshot(data);
  assert.equal(verifyLearningSenses(data, bundle, baseline).learningSenses, manifest.senseCount);
  let changed = structuredClone(data);
  changed.rawSenses[0].pos = 'v.';
  assert.throws(() => verifyLearningSenses(changed, bundle), /source_byte_drift/);
  changed = structuredClone(data);
  changed.bindings[0].wordId = 'another-word';
  assert.throws(() => verifyLearningSenses(changed, bundle), /binding_changed|cross_word/);
  changed = structuredClone(data);
  changed.examples[0].exampleZh += '改';
  assert.throws(() => verifyLearningSenses(changed, bundle), /example_changed/);
  changed = structuredClone(data);
  changed.words[0].lemma += '-changed';
  assert.throws(() => verifyLearningSenses(changed, bundle, baseline), /source_identity_changed/);
  changed = structuredClone(data);
  changed.siteId = 'wrong-realm';
  assert.throws(() => verifyLearningSenses(changed, bundle), /realm_mismatch/);
  const scratch = fs.mkdtempSync(
    path.join(process.env.TMPDIR || os.tmpdir(), 'nightstudy-meaning-check-'),
  );
  try {
    const selected = [{ ...rows[0], senses: [rows[0].senses[0]] }];
    let audio = await verifyLearningSentenceAudio(selected, [], scratch);
    assert.equal(audio.missingCount, 4);
    assert.equal(audio.readyTargets, 0);
    const payload = Buffer.alloc(128, 7);
    fs.writeFileSync(path.join(scratch, 'valid.mp3'), payload);
    const audioRows = selected[0].senses[0].examples.flatMap((example) =>
      ['US', 'UK'].map((accent) => ({
        textHash: example.contentMetadata.textHash,
        text: example.exampleEn,
        accent,
        status: 'ready',
        kind: 'synthesized',
        fileKey: 'valid.mp3',
        fileSha256: sha(payload),
        mimeType: 'audio/mpeg',
        sourceName: 'Synthetic verification fixture',
        sourceUrl: 'https://example.invalid/synthetic-fixture',
        license: 'MIT',
        attribution: 'Original synthetic fixture; no real speech recording.',
      })),
    );
    audio = await verifyLearningSentenceAudio(selected, audioRows, scratch);
    assert.equal(audio.readyTargets, 4);
    assert.equal(audio.verifiedFiles, 1);
    fs.writeFileSync(path.join(scratch, 'corrupt.mp3'), Buffer.alloc(128, 8));
    audioRows[1].fileKey = 'corrupt.mp3';
    audio = await verifyLearningSentenceAudio(selected, audioRows, scratch);
    assert.equal(audio.integrityProblemCount, 1);
    audioRows[1].fileKey = 'valid.mp3';
    audioRows[1].license = '';
    audio = await verifyLearningSentenceAudio(selected, audioRows, scratch);
    assert.equal(audio.integrityProblemCount, 1);
    assert.equal(audio.readyTargets, 3);
    audioRows[1].fileKey = '../outside.mp3';
    audio = await verifyLearningSentenceAudio(selected, audioRows, scratch);
    assert.equal(audio.integrityProblemCount, 1);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  assert.throws(() => verificationSites({}, {}), /explicit_database_selection_required/);
  assert.deepEqual(
    verificationSites(
      { 'single-site': 'default' },
      { DATABASE_URL: 'postgresql://fixture.invalid/explicit' },
    ),
    [{ id: 'default', databaseUrl: 'postgresql://fixture.invalid/explicit', test: false }],
  );
  assert.throws(
    () => verificationSites({ 'single-site': 'default', 'test-database-env': 'FIXTURE_DB' }, {}),
    /choose_one_database_selection_mode/,
  );
  assert.throws(
    () => verificationSites({ 'single-site': 'default', 'sites-file': 'fixture.json' }, {}),
    /choose_one_database_selection_mode/,
  );
  assert.throws(
    () => verificationSites({ 'single-site': 'another' }, {}),
    /single_site_must_be_default/,
  );
  assert.throws(
    () => verificationSites({ 'single-site': 'default' }, {}),
    /single_site_database_url_missing/,
  );
  return {
    checks: 17,
    realPackWords: manifest.wordCount,
    realPackMeanings: manifest.senseCount,
    realPackExamples: manifest.exampleCount,
  };
}

export function verificationSites(values, environment = process.env) {
  const explicitMode = values['single-site'] || values['test-database-env'] || values['sites-file'];
  const filename = values['sites-file'] || (!explicitMode ? environment.SITES_FILE : undefined);
  const modes = [
    Boolean(values['single-site']),
    Boolean(values['test-database-env']),
    Boolean(filename),
  ].filter(Boolean).length;
  check(modes > 0, 'explicit_database_selection_required');
  check(modes === 1, 'choose_one_database_selection_mode');
  if (values['single-site']) {
    check(
      values['single-site'] === 'default' && (!values.site || values.site === 'default'),
      'single_site_must_be_default',
    );
    check(environment.DATABASE_URL, 'single_site_database_url_missing');
    return [{ id: 'default', databaseUrl: environment.DATABASE_URL, test: false }];
  }
  if (values['test-database-env']) {
    check(/^[A-Z][A-Z0-9_]*$/.test(values['test-database-env']), 'invalid_test_database_env_name');
    const databaseUrl = environment[values['test-database-env']];
    check(
      databaseUrl && new URL(databaseUrl).pathname.endsWith('_test'),
      'test_database_name_required',
    );
    return [{ id: values.site || null, databaseUrl, test: true }];
  }
  const configured = JSON.parse(fs.readFileSync(filename, 'utf8'));
  check(
    Array.isArray(configured) && configured.length > 0 && configured.length <= 100,
    'invalid_sites_file',
  );
  const sites = configured
    .filter((site) => !values.site || site.id === values.site)
    .map((site) => {
      check(
        typeof site.id === 'string' &&
          /^[a-z0-9][a-z0-9-]{0,47}$/.test(site.id) &&
          /^[A-Z][A-Z0-9_]*$/.test(site.databaseUrlEnv),
        'invalid_site_database_binding',
      );
      const databaseUrl = environment[site.databaseUrlEnv];
      check(databaseUrl, 'site_database_env_missing');
      return { id: site.id, databaseUrl, test: false };
    });
  check(sites.length > 0, 'no_matching_sites');
  return sites;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'self-test': { type: 'boolean' },
      'single-site': { type: 'string' },
      'test-database-env': { type: 'string' },
      'sites-file': { type: 'string' },
      site: { type: 'string' },
      manifest: { type: 'string' },
      snapshot: { type: 'string' },
      baseline: { type: 'string' },
      audio: { type: 'boolean' },
      'audio-root': { type: 'string' },
    },
    strict: true,
  });
  if (values['self-test']) {
    console.log(JSON.stringify({ ok: true, mode: 'self-test', ...(await selfTest()) }));
    return;
  }
  check(
    !(values.snapshot && (values.baseline || values.audio)),
    'snapshot_verification_flags_are_exclusive',
  );
  const bundle = readLearningSensesBundle(values.manifest);
  const sites = verificationSites(values);
  const { Client } = await import('pg');
  const baseline = values.baseline ? JSON.parse(fs.readFileSync(values.baseline, 'utf8')) : null;
  if (baseline)
    check(
      baseline.formatVersion === 1 && baseline.sites && typeof baseline.sites === 'object',
      'learning_senses_invalid_baseline',
    );
  const snapshots = { formatVersion: 1, sites: {} };
  const summaries = [];
  for (const site of sites) {
    const client = new Client({
      connectionString: site.databaseUrl,
      connectionTimeoutMillis: 10000,
    });
    await client.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='30s'");
      const state = (
        await client.query(`SELECT "siteId","instanceId" FROM "SiteState" WHERE id='singleton'`)
      ).rows[0];
      check(
        state && ((site.test && !site.id) || state.siteId === site.id),
        'learning_senses_realm_mismatch',
      );
      const wordIds = bundle.rows.map((row) => row.wordId);
      const meaningIds = bundle.rows.flatMap((row) => row.senses.map((sense) => sense.id));
      const data = {
        siteId: state.siteId,
        expectedSiteId: site.id || state.siteId,
        instanceId: state.instanceId,
        pack: (await client.query(`SELECT * FROM "ContentPack" WHERE id=$1`, [bundle.manifest.id]))
          .rows[0],
        words: (
          await client.query(
            `SELECT id,lemma,"normalizedLemma","sourceRef","contentVersion",status FROM "Word" WHERE id=ANY($1::text[])`,
            [wordIds],
          )
        ).rows,
        rawSenses: (
          await client.query(
            `SELECT id,"wordId",pos,"definitionZh","definitionEn","exampleZh","exampleEn",ordinal FROM "Sense" WHERE "wordId"=ANY($1::text[])`,
            [wordIds],
          )
        ).rows,
        learningSenses: (
          await client.query(`SELECT * FROM "LearningSense" WHERE id=ANY($1::text[])`, [meaningIds])
        ).rows,
        bindings: (
          await client.query(
            `SELECT * FROM "SenseSourceBinding" WHERE "learningSenseId"=ANY($1::text[])`,
            [meaningIds],
          )
        ).rows,
        examples: (
          await client.query(
            `SELECT * FROM "WordExample" WHERE "learningSenseId"=ANY($1::text[])`,
            [meaningIds],
          )
        ).rows,
      };
      if (values.snapshot) {
        check(
          data.words.length === bundle.manifest.wordCount,
          'learning_senses_snapshot_scope_incomplete',
        );
        const sourceById = new Map(data.rawSenses.map((sense) => [sense.id, sense]));
        for (const row of bundle.rows)
          for (const sense of row.senses)
            for (const binding of sense.sourceBindings) {
              const raw = sourceById.get(binding.sourceSenseId);
              check(
                raw?.wordId === row.wordId &&
                  sha(raw.pos) === binding.sourcePosSha256 &&
                  sha(raw.definitionZh) === binding.sourceDefinitionZhSha256 &&
                  sha(raw.definitionEn) === binding.sourceDefinitionEnSha256,
                'learning_senses_snapshot_source_drift',
              );
            }
        snapshots.sites[state.siteId] = sourceSnapshot(data);
        summaries.push({
          siteId: state.siteId,
          snapshotWords: data.words.length,
          snapshotSourceSenses: data.rawSenses.length,
        });
      } else {
        if (baseline) check(baseline.sites[state.siteId], 'learning_senses_baseline_site_missing');
        const summary = verifyLearningSenses(data, bundle, baseline?.sites?.[state.siteId]);
        let audio = { checked: false, missingCount: null };
        if (values.audio) {
          const hashes = bundle.rows.flatMap((row) =>
            row.senses.flatMap((sense) => sense.examples.map((e) => e.contentMetadata.textHash)),
          );
          const audioRows = (
            await client.query(`SELECT * FROM "SentenceAudio" WHERE "textHash"=ANY($1::text[])`, [
              hashes,
            ])
          ).rows;
          audio = await verifyLearningSentenceAudio(
            bundle.rows,
            audioRows,
            values['audio-root'] || process.env.AUDIO_CACHE_DIR || '.local/audio',
          );
          if (audio.missingCount || audio.integrityProblemCount) process.exitCode = 1;
        }
        summaries.push({ siteId: state.siteId, ...summary, audio });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
  }
  if (values.snapshot)
    fs.writeFileSync(values.snapshot, JSON.stringify(snapshots, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  console.log(
    JSON.stringify({
      ok: !process.exitCode,
      mode: values.snapshot ? 'source-snapshot' : 'verify',
      sites: summaries,
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        ok: false,
        error: error instanceof VerificationError ? error.code : 'verification_runtime_failure',
        details: error instanceof VerificationError ? error.details : {},
      }),
    );
    process.exitCode = 1;
  });
}
