/** Real ordinary-user recognition calls, exclusively against disposable cloud Compose. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import {
  prepareLearningSensesVerification,
  readLearningSensesBundle,
} from './check-learning-senses-install.mjs';
import { readSentenceAudioPolicy } from './check-sentence-audio-policy.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url)),
  MIB = 1024 ** 2;
const need = (ok, code) => {
  if (!ok) throw new Error(code);
};
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const clean = (value) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
const pos = (value) => value.replace(/[.\s]/g, '').replace(/^v[ti]$/, 'v');
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
const historicalMatrix = {
  reportId: 'recognition-stage25-audit-0002/matrix-report.private.json',
  bytes: 28941,
  sha256: 'c71f53d99673e68bb37f00533aaf603290940c57d56305f0f9732cae2072b8eb',
  status: 'PASS',
  books: 18,
  validatedShards: 1139,
  bookFocuses: 226112,
  measuredAttempts: 678336,
  noQuestionRecallFallbackMemberships: 739,
  independentlyCoveredSenses: 49992,
  openedByThisCloudScript: false,
  randomTrialsDoNotGuaranteeEveryFutureShuffle: true,
};

export function isolatedUrl(value) {
  const url = new URL(value);
  need(
    url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'disposable_loopback_only',
  );
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url;
}

export function signupWaitMs(completed, quietStarted, now) {
  need(
    Number.isInteger(completed) &&
      completed >= 0 &&
      completed <= 18 &&
      Number.isFinite(now) &&
      Number.isFinite(quietStarted) &&
      quietStarted >= 0 &&
      quietStarted <= now,
    'monotonic_signup_clock',
  );
  return completed % 3 === 0 ? Math.max(0, 10100 - (now - quietStarted)) : 0;
}

export function mutationAllowed(relative, method, body) {
  if (method === 'GET') return;
  need(
    body && typeof body === 'object' && !Array.isArray(body),
    'explicit_disposable_json_mutation',
  );
  const api = relative.replace(/^\//, '');
  const allowed =
    (method === 'POST' &&
      (api === 'api/auth/sign-up/email' ||
        /^api\/v2\/books\/[^/]+\/select$/.test(api) ||
        api === 'api/v2/study/plan/confirm' ||
        api === 'api/v2/study/sessions' ||
        (/^api\/v2\/study\/sessions\/[^/]+\/commands$/.test(api) &&
          body.action === 'reveal' &&
          !('rating' in body) &&
          !('answer' in body)))) ||
    (method === 'PUT' && api === 'api/v2/learning-preferences');
  need(allowed, 'no_rating_ai_admin_or_unrelated_mutation');
}

export function inspectIssued(item, fixed, baseline) {
  need(
    item.wordId === fixed.wordId &&
      item.word.id === fixed.wordId &&
      item.bucket === 'new' &&
      !item.revealed &&
      !item.rated &&
      !item.exerciseDone &&
      item.progressRevision === 0,
    'actual_unrated_new_item',
  );
  const permitted = new Set([
    'id',
    'lemma',
    'displayLemma',
    'phonetic',
    'phoneticUs',
    'phoneticUk',
    'phoneticSource',
    'pronunciationCompatible',
  ]);
  need(
    Object.keys(item.word).every((key) => permitted.has(key)),
    'issued_question_hides_meanings_and_answers',
  );
  const focus = fixed.senses.find((sense) => sense.id === item.focusSenseId);
  need(
    focus &&
      displayedPos(focus) &&
      focus.definitionEn.trim() &&
      /[\u3400-\u9fff]/u.test(focus.definitionZh) &&
      focus.examples.length >= 2 &&
      new Set(focus.examples.map((example) => example.contextLabel)).size >= 2,
    'issued_focus_is_current_bilingual_atomic_contextual_meaning',
  );
  const common = {
    wordId: fixed.wordId,
    lemma: item.word.lemma,
    focusSenseId: focus.id,
    pos: displayedPos(focus),
    definitionEn: focus.definitionEn,
    definitionZh: focus.definitionZh,
    outsideOriginal35: !baseline.has(fixed.wordId),
  };
  if (!item.recognition)
    return {
      ...common,
      mode: 'recall',
      expectedCorrectOptionId: null,
      fallback:
        'Actual API issued safe recall instead of inventing choices; bounded-pool eligibility is not recomputed by this HTTP sample.',
    };
  const question = item.recognition;
  need(
    !('correctOptionId' in question) &&
      !('selectedOptionId' in question) &&
      Array.isArray(question.options) &&
      question.options.length >= 3 &&
      question.options.length <= 4,
    'hidden_answer_and_bounded_actual_options',
  );
  need(
    new Set(question.options.map((option) => option.id)).size === question.options.length &&
      new Set(question.options.map((option) => clean(option.text))).size ===
        question.options.length &&
      question.options.every(
        (option) =>
          typeof option.id === 'string' &&
          option.id.length > 0 &&
          /[\u3400-\u9fff]/u.test(option.text) &&
          pos(option.pos) === pos(focus.pos),
      ),
    'unique_same_grammar_actual_options',
  );
  const matches = question.options.filter(
    (option) => clean(option.text) === clean(focus.definitionZh),
  );
  need(matches.length === 1, 'one_option_is_exact_current_focus');
  const allMeanings = new Set(fixed.senses.map((sense) => clean(sense.definitionZh)));
  need(
    question.options.every(
      (option) => option.id === matches[0].id || !allMeanings.has(clean(option.text)),
    ),
    'other_meanings_of_target_are_not_false_distractors',
  );
  return {
    ...common,
    mode: 'recognition',
    expectedCorrectOptionId: matches[0].id,
    options: question.options,
    issuedCorrectOptionIdAbsent: true,
  };
}

export function scoringSnapshot(stats, plan, library, currentId) {
  need(
    library.items.length === 1 && library.items[0].word.id === currentId,
    'actual_current_word_library_anchor',
  );
  const word = library.items[0];
  const value = {
    totalLearned: stats.totalLearned,
    totalReviews: stats.totalReviews,
    totalRatings: stats.totalRatings,
    todayUnique: stats.today.uniqueWords,
    todayNew: stats.today.newWords,
    todayReviews: stats.today.reviews,
    completedUnique: plan.completedUnique,
    completedNew: plan.completedNew,
    completedReview: plan.completedReview,
    progress: word.progress,
    reviewCount: word.reviewCount,
    learnedAt: word.learnedAt,
    reviewedAt: word.reviewedAt,
    dueAt: word.dueAt,
  };
  need(
    Object.entries(value).every(([key, item]) =>
      ['progress', 'learnedAt', 'reviewedAt', 'dueAt'].includes(key) ? item === null : item === 0,
    ),
    'selection_and_reveal_do_not_create_memory_or_completion_evidence',
  );
  return value;
}

function bytes(file, cap) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const identity = (s) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
  try {
    const before = fs.fstatSync(fd);
    need(
      before.isFile() && before.size > 0 && before.size <= cap && fs.realpathSync(file) === file,
      'bounded_recognition_input',
    );
    const raw = fs.readFileSync(fd);
    need(
      raw.length === before.size &&
        identity(before) === identity(fs.fstatSync(fd)) &&
        identity(before) === identity(fs.lstatSync(file)),
      'recognition_input_identity',
    );
    return raw;
  } finally {
    fs.closeSync(fd);
  }
}

export async function main() {
  const { values } = parseArgs({
    options: { 'base-url': { type: 'string' }, receipt: { type: 'string' } },
    strict: true,
  });
  need(
    process.platform === 'linux' &&
      process.env.GITHUB_ACTIONS === 'true' &&
      process.env.GITHUB_REPOSITORY === 'wudi000888-svg/nightstudy' &&
      /^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') &&
      process.env.NIGHTSTUDY_DISPOSABLE_COMPOSE_ACCEPTANCE === '1',
    'explicit_github_disposable_compose_only',
  );
  need(values['base-url'] && values.receipt, 'explicit_recognition_inputs');
  const base = isolatedUrl(values['base-url']),
    output = path.resolve(values.receipt);
  need(
    !fs.existsSync(output) && fs.realpathSync(path.dirname(output)) === path.dirname(output),
    'fresh_recognition_receipt',
  );
  const receipt = {
    kind: 'nightstudy-all-book-recognition-http-v1',
    startedAt: new Date().toISOString(),
    baseUrl: base.href,
    githubRunId: process.env.GITHUB_RUN_ID,
    isolation: 'Explicit disposable GitHub Compose target; no production execution',
    credentialPersistence: false,
    temporaryOrdinaryAccounts: 0,
    requests: [],
    books: [],
    failures: [],
    authAdmission: {
      signupBatchSize: 3,
      quietIntervalMs: 10100,
      initialQuietWindow: true,
      monotonicClock: true,
      retries: 0,
      fakeClientIps: false,
    },
    ratingCommands: 0,
    answerCommands: 0,
    aiCalls: 0,
    historicalMatrixEvidence: historicalMatrix,
  };
  let origin = base.origin,
    completedSignups = 0,
    signupQuietStarted = performance.now();
  async function call(relative, { method = 'GET', body, jar, status = 200 } = {}) {
    mutationAllowed(relative, method, body);
    const url = new URL(relative.replace(/^\//, ''), base);
    need(
      url.origin === base.origin && url.pathname.startsWith(base.pathname),
      'same_isolated_application_only',
    );
    const headers = { Accept: 'application/json', 'Accept-Encoding': 'identity', Origin: origin };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (jar?.size) headers.Cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(30000),
    });
    const chunks = [];
    let length = 0;
    if (response.body)
      for await (const chunk of response.body) {
        length += chunk.length;
        need(length <= 8 * MIB, 'bounded_recognition_response');
        chunks.push(Buffer.from(chunk));
      }
    if (jar)
      for (const cookie of response.headers.getSetCookie()) {
        const token = cookie.split(';', 1)[0],
          split = token.indexOf('=');
        need(split > 0 && token.length <= 16384, 'bounded_ephemeral_auth_cookie');
        if (token.slice(split + 1)) jar.set(token.slice(0, split), token.slice(split + 1));
        else jar.delete(token.slice(0, split));
      }
    receipt.requests.push({
      method,
      pathname: url.pathname,
      status: response.status,
      bytes: length,
    });
    need(
      response.status === status,
      'recognition_http_status_' + response.status + '_expected_' + status + '_' + url.pathname,
    );
    need(response.headers.get('content-type')?.includes('json'), 'recognition_json_response');
    try {
      return JSON.parse(Buffer.concat(chunks, length));
    } catch {
      throw new Error('recognition_invalid_json_response');
    }
  }
  const get = (relative, jar) => call('api/v2/' + relative, { jar });
  try {
    const health = await call('health/ready'),
      site = await get('site');
    const pkg = JSON.parse(bytes(path.join(ROOT, 'package.json'), 65536));
    need(
      health.status === 'ready' &&
        health.version === pkg.version &&
        site.version === pkg.version &&
        site.initialized === true &&
        site.registrationOpen === true,
      'ready_registered_disposable_application',
    );
    origin = isolatedUrl(site.publicUrl).origin;
    need((await get('me')).user === null, 'initially_anonymous_acceptance_client');
    const policy = readSentenceAudioPolicy(path.join(ROOT, 'data'));
    const plan = prepareLearningSensesVerification(
      path.join(ROOT, 'data/learning-senses-collection-v2.manifest.json'),
      policy,
    );
    need(
      plan.manifest.wordCount === 18767 &&
        plan.manifest.senseCount === 49992 &&
        plan.manifest.exampleCount === 99984,
      'fixed_complete_public_meanings',
    );
    receipt.publicRootSha256 = plan.manifestSha256;
    const baseline = new Set(
      readLearningSensesBundle(path.join(ROOT, 'data/learning-senses-v1.manifest.json')).rows.map(
        (word) => word.wordId,
      ),
    );
    const data = (name) => JSON.parse(bytes(path.join(ROOT, 'data', name), MIB));
    const dictionary = data('content-ecdict.manifest.json'),
      exams = data('exam-books.manifest.json'),
      phrases = data('phrase-books.manifest.json');
    const bookIds = [
      ...Object.keys(dictionary.statistics.bookCounts).map(
        (goal) => `content-${dictionary.id}-${goal}`,
      ),
      ...exams.books.map((book) => `content-${exams.id}-${book.id}`),
      ...Object.keys(phrases.bookCounts).map((goal) => `content-${phrases.id}-${goal}`),
    ];
    const available = (await get('books')).items;
    need(
      bookIds.length === 18 &&
        new Set(bookIds).size === 18 &&
        available.length === 18 &&
        bookIds.every((id) =>
          available.some((book) => book.id === id && book.visibility === 'public' && !book.isDemo),
        ),
      'all18_real_builtin_books',
    );
    const cache = new Map();
    function currentWord(wordId) {
      const index = plan.leafForWordId(wordId);
      need(Number.isInteger(index), 'issued_word_has_current_public_leaf');
      if (!cache.has(index)) {
        if (cache.size >= 2) cache.delete(cache.keys().next().value);
        cache.set(index, plan.readLeaf(index, { remaining: 16 * MIB }).rows);
      }
      const fixed = cache.get(index).find((word) => word.wordId === wordId);
      need(fixed, 'issued_word_found_in_pinned_leaf');
      return fixed;
    }
    for (const [index, bookId] of bookIds.entries()) {
      const jar = new Map(),
        email = `ci-recognition-${process.env.GITHUB_RUN_ID}-${crypto.randomUUID()}@example.test`;
      const password = crypto.randomBytes(32).toString('base64url');
      // BetterAuth 1.7.7 renews lastRequest for each success. Three successful
      // signups therefore require a full quiet window, not mere even spacing.
      for (
        let wait = signupWaitMs(completedSignups, signupQuietStarted, performance.now());
        wait > 0;
        wait = signupWaitMs(completedSignups, signupQuietStarted, performance.now())
      ) {
        await new Promise((resolve) => setTimeout(resolve, Math.ceil(wait)));
      }
      await call('api/auth/sign-up/email', {
        method: 'POST',
        jar,
        body: { name: 'CI recognition ' + index, email, password },
      });
      completedSignups++;
      if (completedSignups % 3 === 0) signupQuietStarted = performance.now();
      need(jar.size > 0, 'real_betterauth_session_cookie_received');
      const me = (await get('me', jar)).user;
      need(me?.role === 'user' && me.email === email, 'independent_ordinary_account_per_book');
      receipt.temporaryOrdinaryAccounts++;
      await call(`api/v2/books/${encodeURIComponent(bookId)}/select`, {
        method: 'POST',
        jar,
        body: {},
      });
      const settings = (await get('me/settings', jar)).settings;
      const confirmed = await call('api/v2/study/plan/confirm', {
        method: 'POST',
        jar,
        body: {
          bookId,
          dailyTotalGoal: 5,
          groupSize: 5,
          timeZone: 'UTC',
          expectedRevision: settings.revision,
          commandId: crypto.randomUUID(),
        },
      });
      need(
        confirmed.plan.bookId === bookId &&
          confirmed.plan.dailyTotalGoal === 5 &&
          confirmed.settings.currentBookId === bookId,
        'real_book_selection_and_daily_total_goal',
      );
      const preferences = (await get('learning-preferences', jar)).preferences;
      const changed = await call('api/v2/learning-preferences', {
        method: 'PUT',
        jar,
        body: {
          expectedRevision: preferences.revision,
          meaningChoiceEnabled: true,
          spellingEnabled: false,
        },
      });
      need(
        changed.preferences.meaningChoiceEnabled === true &&
          changed.preferences.spellingEnabled === false,
        'real_meaning_choice_preference',
      );
      const issued = await call('api/v2/study/sessions', {
        method: 'POST',
        jar,
        body: {
          mode: 'learn',
          bookId,
          size: 5,
          commandId: crypto.randomUUID(),
          expectedPlanRevision: confirmed.plan.revision,
        },
      });
      const session = issued.session;
      need(
        session &&
          session.bookId === bookId &&
          session.cursor === 0 &&
          session.items.length >= 1 &&
          session.items.length <= 5 &&
          session.currentItemId === session.items[0].id,
        'real_initial_new_learning_session',
      );
      const questions = session.items.map((item) =>
        inspectIssued(item, currentWord(item.wordId), baseline),
      );
      const restored = (await get('study/sessions/' + session.id, jar)).session;
      need(
        isDeepStrictEqual(restored.items, session.items) && restored.cursor === session.cursor,
        'issued_options_and_focus_survive_real_get',
      );
      const first = session.items[0],
        expected = questions[0];
      const libraryPath =
        'library/words?' +
        new URLSearchParams({ bookId, locate: first.wordId, sort: 'book', limit: '1' });
      async function snapshot() {
        const stats = await get('stats', jar),
          task = (await get('study/plan', jar)).plan,
          library = await get(libraryPath, jar);
        return scoringSnapshot(stats, task, library, first.wordId);
      }
      const before = await snapshot();
      if (first.recognition) {
        await call(`api/v2/study/sessions/${session.id}/commands`, {
          method: 'POST',
          jar,
          status: 400,
          body: {
            action: 'reveal',
            commandId: crypto.randomUUID(),
            itemId: first.id,
            expectedSessionRevision: restored.revision,
            recognitionOptionId: 'not-an-issued-option',
          },
        });
        const unchanged = (await get('study/sessions/' + session.id, jar)).session;
        need(
          unchanged.revision === restored.revision &&
            isDeepStrictEqual(unchanged.items, restored.items),
          'invalid_choice_cannot_reveal_or_advance',
        );
      }
      const chosen = first.recognition?.options[0].id;
      const command = {
        action: 'reveal',
        commandId: crypto.randomUUID(),
        itemId: first.id,
        expectedSessionRevision: restored.revision,
        ...(chosen ? { recognitionOptionId: chosen } : {}),
      };
      const revealed = await call(`api/v2/study/sessions/${session.id}/commands`, {
        method: 'POST',
        jar,
        body: command,
      });
      const current = revealed.session.items[revealed.session.cursor];
      need(
        revealed.session.cursor === session.cursor &&
          revealed.session.currentItemId === first.id &&
          current.id === first.id &&
          current.revealed === true &&
          !current.rated &&
          !current.exerciseDone &&
          current.progressRevision === 0 &&
          revealed.session.items.every((item) => !item.rated && item.progressRevision === 0),
        'reveal_changes_visibility_without_rating_or_cursor_advance',
      );
      if (chosen)
        need(
          current.recognition.selectedOptionId === chosen &&
            current.recognition.correctOptionId === expected.expectedCorrectOptionId &&
            isDeepStrictEqual(current.recognition.options, first.recognition.options),
          'actual_selected_and_correct_focus_are_durably_bound',
        );
      const shown = current.word.senses.find((sense) => sense.id === first.focusSenseId);
      need(
        shown?.kind === 'learning' &&
          shown.pos === expected.pos &&
          shown.definitionZh === expected.definitionZh &&
          shown.definitionEn === expected.definitionEn &&
          shown.examples.length >= 2,
        'reveal_supplies_current_bilingual_focus_and_contexts',
      );
      const replay = await call(`api/v2/study/sessions/${session.id}/commands`, {
        method: 'POST',
        jar,
        body: command,
      });
      need(
        replay.duplicate === true &&
          replay.session.revision === revealed.session.revision &&
          isDeepStrictEqual(replay.session.items, revealed.session.items),
        'real_reveal_retry_is_idempotent',
      );
      const reloaded = (await get('study/sessions/' + session.id, jar)).session;
      need(
        isDeepStrictEqual(reloaded.items, revealed.session.items) &&
          reloaded.cursor === session.cursor,
        'choice_reveal_persist_after_reload',
      );
      const after = await snapshot();
      need(
        isDeepStrictEqual(before, after),
        'actual_get_proves_no_scoring_or_fsrs_or_completed_count_change',
      );
      const safeQuestions = questions.map(
        ({ expectedCorrectOptionId: _privateExpected, ...question }) => question,
      );
      const outside = safeQuestions.filter((question) => question.outsideOriginal35);
      receipt.books.push({
        bookId,
        sessionId: session.id,
        issuedQuestions: safeQuestions,
        newOutsideOriginal35: outside.length,
        recognitionOutsideOriginal35: outside.filter((question) => question.mode === 'recognition')
          .length,
        fallbackCount: safeQuestions.filter((question) => question.mode === 'recall').length,
        sampledOutcome: outside.some((question) => question.mode === 'recognition')
          ? 'REAL_NEW_CONTENT_RECOGNITION'
          : 'ACTUAL_SAMPLE_WITHOUT_NEW_RECOGNITION',
        selectedOptionPersisted: !!chosen,
        revealedBilingualMeaning: true,
        invalidOptionRejected: !!chosen,
        revealIdempotent: true,
        before,
        after,
        cursorUnchanged: true,
        sessionRevisionMayChangeForReveal: true,
      });
      jar.clear();
    }
    plan.unchanged();
    need(
      receipt.books.length === 18 &&
        receipt.temporaryOrdinaryAccounts === 18 &&
        receipt.books.some((book) => book.recognitionOutsideOriginal35 > 0),
      'all18_books_sampled_with_real_new_content_recognition',
    );
    receipt.passed = true;
  } catch (error) {
    receipt.passed = false;
    receipt.failures.push(String(error.message));
    process.exitCode = 1;
  }
  receipt.completedAt = new Date().toISOString();
  receipt.limitations = [
    'Five natural issued questions per book; unavailable choices remain actual recall fallback and are never forced.',
    'Historical full-matrix pins are an explicit reference, not a matrix rerun or a guarantee for every random shuffle.',
    'Only disposable ordinary test accounts, settings, plans and reveal state are written; their Compose volume must be destroyed by CI teardown.',
    'No production, rating, answer, AI, payment, real-device, browser or expert language/acoustic acceptance is claimed.',
  ];
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      passed: receipt.passed,
      books: receipt.books.length,
      recognitionBooks: receipt.books.filter((book) => book.recognitionOutsideOriginal35 > 0)
        .length,
      requests: receipt.requests.length,
      failures: receipt.failures,
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
