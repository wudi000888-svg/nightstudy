/** Read-only HTTP acceptance against an isolated, fully installed application. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  prepareLearningSensesVerification,
  readLearningSensesBundle,
} from './check-learning-senses-install.mjs';
import { readSentenceAudioPolicy } from './check-sentence-audio-policy.mjs';
import { readSentenceAudioCollectionPins } from './check-audio-install.mjs';
import { hasExactPublicWordIdentity } from './all-book-http-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const mib = 1024 ** 2;
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const normalize = (value) =>
  value.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/gu, ' ').trim();
const displayedPos = (sense) =>
  sense.pos.trim()
    ? sense.pos
    : sense.contentMetadata?.authoredDisplayPosSource?.kind === 'original-authoring' &&
        [
          'phr. v.',
          'prep. phr.',
          'adv. phr.',
          'adj. phr.',
          'conj. phr.',
          'det. phr.',
          'pron. phr.',
          'modal phr.',
        ].includes(sense.contentMetadata?.authoredDisplayPos)
      ? sense.contentMetadata.authoredDisplayPos
      : '';
const need = (condition, code) => {
  if (!condition) throw new Error(code);
};
const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    'audio-root': { type: 'string' },
    receipt: { type: 'string' },
  },
  strict: true,
});
need(
  Object.values(values).every((v) => typeof v === 'string') &&
    values['base-url'] &&
    values['audio-root'] &&
    values.receipt,
  'explicit_acceptance_inputs',
);
const base = new URL(values['base-url']);
need(
  base.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) &&
    !base.username &&
    !base.password &&
    !base.search &&
    !base.hash,
  'isolated_loopback_application_required',
);
base.pathname = base.pathname.replace(/\/+$/, '') + '/';
const output = path.resolve(values.receipt);
need(
  !fs.existsSync(output) && fs.realpathSync(path.dirname(output)) === path.dirname(output),
  'fresh_acceptance_receipt',
);
function bytes(file, cap, expected) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    need(st.isFile() && st.size > 0 && st.size <= cap, 'bounded_acceptance_file');
    const raw = fs.readFileSync(fd);
    need(raw.length === st.size && (!expected || sha(raw) === expected), 'acceptance_file_pin');
    return raw;
  } finally {
    fs.closeSync(fd);
  }
}
const json = (name) => JSON.parse(bytes(path.join(root, 'data', name), mib));
const policy = readSentenceAudioPolicy(path.join(root, 'data'));
const plan = prepareLearningSensesVerification(
  path.join(root, 'data/learning-senses-collection-v2.manifest.json'),
  policy,
);
need(
  plan.manifest.wordCount === 18767 &&
    plan.manifest.senseCount === 49992 &&
    plan.manifest.exampleCount === 99984 &&
    policy.entries.length === 79,
  'complete_fixed_learning_scope',
);
const baseline = new Set(
  readLearningSensesBundle(path.join(root, 'data/learning-senses-v1.manifest.json')).rows.map(
    (w) => w.wordId,
  ),
);
const dictionary = json('content-ecdict.manifest.json'),
  exam = json('exam-books.manifest.json'),
  phrases = json('phrase-books.manifest.json');
const bookIds = [
  ...Object.keys(dictionary.statistics.bookCounts).map(
    (goal) => `content-${dictionary.id}-${goal}`,
  ),
  ...exam.books.map((book) => `content-${exam.id}-${book.id}`),
  ...Object.keys(phrases.bookCounts).map((goal) => `content-${phrases.id}-${goal}`),
];
need(new Set(bookIds).size === 18, 'fixed_eighteen_books');
const receipt = {
  kind: 'nightstudy-all-book-content-http-v1',
  startedAt: new Date().toISOString(),
  baseUrl: base.href,
  anonymous: true,
  methods: ['GET', 'HEAD'],
  businessMutations: 0,
  publicRootSha256: plan.manifestSha256,
  globalHoldCount: 79,
  checks: [],
  requests: [],
  samples: [],
  failures: [],
};
function check(code, condition) {
  receipt.checks.push({ code, passed: !!condition });
  need(condition, code);
}
async function request(
  relative,
  { method = 'GET', headers = {}, status = 200, cap = 8 * mib } = {},
) {
  const url = new URL(relative.replace(/^\//, ''), base);
  need(
    url.origin === base.origin && ['GET', 'HEAD'].includes(method),
    'same_origin_read_only_http',
  );
  const response = await fetch(url, {
    method,
    headers: { 'Accept-Encoding': 'identity', ...headers },
    redirect: 'manual',
    credentials: 'omit',
    signal: AbortSignal.timeout(30000),
  });
  const blocks = [];
  let length = 0;
  if (response.body)
    for await (const block of response.body) {
      length += block.length;
      need(length <= cap, 'bounded_http_body');
      blocks.push(Buffer.from(block));
    }
  const raw = Buffer.concat(blocks, length);
  receipt.requests.push({
    method,
    pathname: url.pathname,
    status: response.status,
    bytes: raw.length,
  });
  check(`${method} ${url.pathname} ${status}`, response.status === status);
  if (method === 'HEAD' || status === 304) check('empty_http_body', raw.length === 0);
  return { raw, headers: response.headers };
}
async function api(relative, options) {
  const result = await request('api/v2/' + relative, options);
  need(result.headers.get('content-type')?.includes('json'), 'api_json_response');
  return JSON.parse(result.raw);
}
try {
  const health = JSON.parse((await request('health/ready')).raw);
  check(
    'running_frozen_application_version',
    health.status === 'ready' &&
      health.version === JSON.parse(bytes(path.join(root, 'package.json'), 65536)).version,
  );
  check('anonymous_identity', (await api('me')).user === null);
  const books = (await api('books')).items;
  check(
    'all_eighteen_builtin_books',
    books.length === 18 &&
      bookIds.every((id) =>
        books.some((b) => b.id === id && b.visibility === 'public' && !b.isDemo && b.wordCount > 0),
      ),
  );
  const selected = new Set();
  for (const bookId of bookIds) {
    const page = await api('books/' + encodeURIComponent(bookId) + '?limit=50');
    check('book_identity_and_nonempty_members', page.book.id === bookId && page.items.length > 0);
    const member =
      page.items.find(
        (word) => !baseline.has(word.id) && !selected.has(word.id) && word.senseCount > 1,
      ) ??
      page.items.find((word) => !baseline.has(word.id) && word.senseCount > 1) ??
      page.items.find((word) => !baseline.has(word.id) && !selected.has(word.id)) ??
      page.items.find((word) => !baseline.has(word.id));
    need(member, 'new_content_representative_in_every_book');
    selected.add(member.id);
    const index = plan.leafForWordId(member.id);
    need(Number.isInteger(index), 'representative_has_pinned_public_leaf');
    const fixed = plan
      .readLeaf(index, { remaining: 16 * mib })
      .rows.find((word) => word.wordId === member.id);
    need(fixed, 'representative_in_exact_pinned_leaf');
    const word = (await api('words/' + encodeURIComponent(member.id))).word;
    check('new_word_has_all_atomic_senses', hasExactPublicWordIdentity(word, fixed));
    for (const sense of fixed.senses) {
      const actual = word.senses.find((item) => item.id === sense.id);
      check(
        'sense_pos_bilingual_and_binding',
        actual?.kind === 'learning' &&
          actual.pos === displayedPos(sense) &&
          actual.definitionEn === sense.definitionEn &&
          actual.definitionZh === sense.definitionZh &&
          actual.bindingHash === sense.bindingHash &&
          actual.contentVersion === sense.contentVersion,
      );
      check(
        'each_meaning_has_different_bilingual_contexts',
        actual.examples.length === sense.examples.length &&
          actual.examples.length >= 2 &&
          new Set(actual.examples.map((e) => e.contextLabel)).size >= 2,
      );
      for (const example of sense.examples)
        check(
          'exact_meaning_bound_example',
          actual.examples.some(
            (e) =>
              e.id === example.id &&
              e.learningSenseId === sense.id &&
              e.contentVersion === sense.contentVersion &&
              e.contextLabel === example.contextLabel &&
              e.exampleEn === example.exampleEn &&
              e.exampleZh === example.exampleZh,
          ),
        );
    }
    const orderedSenses = word.senses.map((actual) => {
      const sense = fixed.senses.find((item) => item.id === actual.id);
      if (!sense) return null;
      const examples = actual.examples.map((example) =>
        sense.examples.find((item) => item.id === example.id),
      );
      need(examples.every(Boolean), 'every_public_example_has_exact_pinned_identity');
      return { ...sense, examples };
    });
    need(orderedSenses.every(Boolean), 'every_public_sense_has_exact_pinned_identity');
    const sense = orderedSenses.find((s) =>
      s.examples.some(
        (e) =>
          !['US', 'UK'].some((a) => policy.byIdentity.has(sha(normalize(e.exampleEn)) + '\0' + a)),
      ),
    );
    need(sense, 'playable_example_representative');
    const example = sense.examples.find(
      (e) =>
        !['US', 'UK'].some((a) => policy.byIdentity.has(sha(normalize(e.exampleEn)) + '\0' + a)),
    );
    receipt.samples.push({
      bookId,
      wordId: word.id,
      lemma: word.lemma,
      normalizedLemma: fixed.normalizedLemma,
      senseId: sense.id,
      definitionEn: sense.definitionEn,
      definitionZh: sense.definitionZh,
      pos: displayedPos(sense),
      examples: sense.examples.map((e) => ({
        id: e.id,
        english: e.exampleEn,
        chinese: e.exampleZh,
        contextLabel: e.contextLabel,
      })),
      senses: orderedSenses.map((s) => ({
        id: s.id,
        pos: displayedPos(s),
        definitionEn: s.definitionEn,
        definitionZh: s.definitionZh,
        examples: s.examples.map((e) => ({
          id: e.id,
          english: e.exampleEn,
          chinese: e.exampleZh,
          contextLabel: e.contextLabel,
        })),
      })),
      audioText: example.exampleEn,
      textHash: sha(normalize(example.exampleEn)),
      newOutsideOriginal35: true,
    });
  }
  const collectionPins = readSentenceAudioCollectionPins(
    path.join(root, 'data/sentence-audio-v4.collection.json'),
  );
  const stats = await api('dictionary/stats');
  check(
    'all_new_audio_packs_installed',
    collectionPins.length === 101 &&
      collectionPins.every((pin) =>
        stats.packs.some((p) => p.id === pin.id && p.entryCount === pin.entryCount),
      ),
  );
  const wanted = new Set(receipt.samples.slice(0, 6).map((sample) => sample.textHash)),
    audio = new Map();
  for (const pin of [
    json('sentence-audio.manifest.json'),
    json('sentence-audio-v2.manifest.json'),
    json('sentence-audio-v3.manifest.json'),
    ...collectionPins,
  ]) {
    const built = JSON.parse(
      bytes(
        path.join(values['audio-root'], pin.id + '.manifest.json'),
        128 * mib,
        pin.manifestSha256,
      ),
    );
    for (const entry of built.entries)
      if (wanted.has(entry.textHash)) {
        const key = entry.textHash + '\0' + entry.accent;
        check('published_sample_has_one_immutable_asset', !audio.has(key));
        audio.set(key, entry);
      }
  }
  for (const sample of receipt.samples.slice(0, 6)) {
    const sentence = (await api('sentence-audio/' + sample.textHash)).sentence;
    check(
      'current_sentence_has_both_ready_accents',
      sentence.textHash === sample.textHash &&
        normalize(sentence.text) === normalize(sample.audioText) &&
        ['US', 'UK'].every((a) =>
          sentence.audio.some((e) => e.accent === a && e.status === 'ready'),
        ),
    );
    for (const accent of ['US', 'UK']) {
      const expected = audio.get(sample.textHash + '\0' + accent);
      need(expected, 'independent_published_audio_sample');
      const uri = `api/v2/sentence-audio/${sample.textHash}/audio/${accent}`,
        response = await request(uri, { cap: 2 * mib });
      check(
        'served_new_sentence_bytes_match_published_sha',
        sha(response.raw) === expected.fileSha256 && response.raw.length === expected.sizeBytes,
      );
      const head = await request(uri, { method: 'HEAD' });
      check(
        'head_matches_exact_media_size',
        Number(head.headers.get('content-length')) === expected.sizeBytes,
      );
      const range = await request(uri, { headers: { Range: 'bytes=0-31' }, status: 206 });
      check('range_matches_exact_published_bytes', range.raw.equals(response.raw.subarray(0, 32)));
    }
  }
  const holdSamples = [
    ...new Map(policy.entries.map((e) => [e.riskCategory + ':' + e.accent, e])).values(),
  ];
  for (const hold of holdSamples) {
    const sentence = (await api('sentence-audio/' + hold.textHash)).sentence;
    check('held_accent_not_advertised', !sentence.audio.some((e) => e.accent === hold.accent));
    await request(`api/v2/sentence-audio/${hold.textHash}/audio/${hold.accent}`, { status: 404 });
    await request(`api/v2/sentence-audio/${hold.textHash}/audio/${hold.accent}`, {
      method: 'HEAD',
      status: 404,
    });
  }
  check(
    'private_wordbook_still_denied',
    (await api('wordbook', { status: 401 })).code === 'authentication_required',
  );
  plan.unchanged();
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.failures.push(String(error.message));
  process.exitCode = 1;
}
receipt.completedAt = new Date().toISOString();
receipt.limitations = [
  'HTTP checks sample every book; the independent database checker verifies the entire installed collection.',
  'No browser, Safari, native-device or expert acoustic certification is claimed.',
  'Normal anonymous request maintenance may update rate counters.',
];
fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(
  JSON.stringify({
    passed: receipt.passed,
    books: receipt.samples.length,
    checks: receipt.checks.length,
    requests: receipt.requests.length,
    failures: receipt.failures,
  }),
);
