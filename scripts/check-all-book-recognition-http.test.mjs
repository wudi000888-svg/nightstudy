import test from 'node:test';
import assert from 'node:assert/strict';
import { isolatedUrl, signupWaitMs, mutationAllowed, inspectIssued, scoringSnapshot } from './check-all-book-recognition-http.mjs';

function fixture() {
  const focus = { id: 'meaning', pos: 'n.', definitionZh: '用于跨越河流的桥梁', definitionEn: 'A structure carrying people across a river.',
    examples: [{ contextLabel: '河流' }, { contextLabel: '铁路' }] };
  const fixed = { wordId: 'new-word', senses: [focus, { ...focus, id: 'other', definitionZh: '连接不同群体的纽带' }] };
  const item = { id: 'item', wordId: fixed.wordId, word: { id: fixed.wordId, lemma: 'bridge' }, focusSenseId: focus.id,
    bucket: 'new', revealed: false, rated: false, exerciseDone: false, progressRevision: 0,
    recognition: { options: [{ id: 'correct', text: focus.definitionZh, pos: 'n.' },
      { id: 'wrong-one', text: '山脉', pos: 'n.' }, { id: 'wrong-two', text: '票券', pos: 'n.' }] } };
  return { item, fixed };
}

test('production domains, HTTPS and credentials cannot be recognition targets', () => {
  for (const value of ['https://english.minminlove.top', 'http://example.test', 'https://127.0.0.1',
    'http://user:secret@127.0.0.1:3000', 'http://127.0.0.1:3000/?redirect=prod']) {
    assert.throws(() => isolatedUrl(value), /disposable_loopback_only/);
  }
  assert.equal(isolatedUrl('http://127.0.0.1:5198').href, 'http://127.0.0.1:5198/');
});

test('real signup admission uses monotonic spacing instead of retrying or disabling limits', () => {
  assert.equal(signupWaitMs(0, 100, 100), 10100);
  assert.equal(signupWaitMs(1, 100, 100), 0);
  assert.equal(signupWaitMs(2, 100, 100), 0);
  assert.equal(signupWaitMs(3, 100, 3000), 7200);
  assert.equal(signupWaitMs(3, 100, 10200), 0);
  assert.throws(() => signupWaitMs(3, 100, 99), /monotonic_signup_clock/);
});

test('a fast 18-account run respects the actual renewing-lastRequest BetterAuth counter', () => {
  const starts = []; let now = 0, quietStarted = 0, completed = 0, lastRequest = null, count = 0;
  for (let i = 0; i < 18; i++) {
    now += signupWaitMs(completed, quietStarted, now);
    count = lastRequest === null || now - lastRequest >= 10000 ? 1 : count + 1;
    assert.ok(count <= 3);
    lastRequest = now; starts.push(now); now += 10; completed++;
    if (completed % 3 === 0) quietStarted = now;
    now += 10; // Model all other HTTP work being very fast.
  }
  assert.equal(starts[0], 10100);
  for (let i = 3; i < starts.length; i += 3) assert.ok(starts[i] - starts[i - 1] >= 10100);
});

test('only reveal may reach study commands; scores, AI, admin and account deletion are forbidden', () => {
  mutationAllowed('api/v2/study/sessions/s/commands', 'POST', { action: 'reveal', recognitionOptionId: 'issued' });
  for (const [route, method, body] of [
    ['api/v2/study/sessions/s/commands', 'POST', { action: 'rate', rating: 'good' }],
    ['api/v2/study/sessions/s/commands', 'POST', { action: 'answer', answer: 'bridge' }],
    ['api/v2/study/sessions/s/commands', 'POST', { action: 'reveal', rating: 'good' }],
    ['api/v2/admin/users', 'POST', {}], ['api/v2/deepseek', 'POST', {}], ['api/auth/delete-user', 'POST', {}],
    ['api/v2/me', 'DELETE', {}],
  ]) assert.throws(() => mutationAllowed(route, method, body), /unrelated_mutation/);
});

test('a new-content issued question has one current meaning without hidden answer leakage', () => {
  const { item, fixed } = fixture();
  const result = inspectIssued(item, fixed, new Set(['original-word']));
  assert.equal(result.mode, 'recognition');
  assert.equal(result.outsideOriginal35, true);
  assert.equal(result.expectedCorrectOptionId, 'correct');
  assert.throws(() => inspectIssued({ ...item, recognition: { ...item.recognition, correctOptionId: 'correct' } }, fixed, new Set()), /hidden_answer/);
  assert.throws(() => inspectIssued({ ...item, word: { ...item.word, senses: [] } }, fixed, new Set()), /hides_meanings/);
});

test('wrong grammar, a second correct sense and a missing target meaning fail independent inspection', () => {
  for (const change of [
    row => { row.recognition.options[1].pos = 'v.'; },
    row => { row.recognition.options[1].text = '连接不同群体的纽带'; },
    row => { row.recognition.options[0].text = '无关含义'; },
  ]) {
    const { item, fixed } = fixture(); change(item);
    assert.throws(() => inspectIssued(item, fixed, new Set()));
  }
});

test('actual recall fallback remains recall and does not invent options or matrix approval', () => {
  const { item, fixed } = fixture(); delete item.recognition;
  fixed.senses[0].pos = '';
  fixed.senses[0].contentMetadata = { authoredDisplayPos: 'prep. phr.', authoredDisplayPosSource: { kind: 'original-authoring' } };
  const result = inspectIssued(item, fixed, new Set());
  assert.equal(result.mode, 'recall');
  assert.equal(result.pos, 'prep. phr.');
  assert.equal(result.expectedCorrectOptionId, null);
  assert.equal(result.options, undefined);
  assert.match(result.fallback, /not recomputed/);
});

test('zero completion and absent FSRS are asserted independently of legal session revisions', () => {
  const stats = { totalLearned: 0, totalReviews: 0, totalRatings: 0, today: { uniqueWords: 0, newWords: 0, reviews: 0 } };
  const plan = { revision: 9, completedUnique: 0, completedNew: 0, completedReview: 0 };
  const library = { items: [{ word: { id: 'new-word' }, progress: null, reviewCount: 0, learnedAt: null, reviewedAt: null, dueAt: null }] };
  const before = scoringSnapshot(stats, plan, library, 'new-word');
  assert.deepEqual(scoringSnapshot(stats, { ...plan, revision: 10 }, library, 'new-word'), before);
  assert.throws(() => scoringSnapshot({ ...stats, totalRatings: 1 }, plan, library, 'new-word'), /memory_or_completion/);
  assert.throws(() => scoringSnapshot(stats, { ...plan, completedUnique: 1 }, library, 'new-word'), /memory_or_completion/);
  assert.throws(() => scoringSnapshot(stats, plan, { items: [{ ...library.items[0], progress: { revision: 0, reps: 0 } }] }, 'new-word'), /memory_or_completion/);
});
