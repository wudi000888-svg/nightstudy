#!/usr/bin/env python3
"""Model-free rejection regressions; real full EOF is checked in cloud batches."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest

FILE = Path(__file__).with_name('check-ci-sentence-audio-batch.py')
SPEC = importlib.util.spec_from_file_location('independent_batch_checker', FILE)
batch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(batch)
h, _ = batch.load_helpers()


def reference(reviewed=False, number=0):
    value = dict(wordId='demo-word-022', learningSenseId='learning-sense-' + '%064x' % (number + 1),
                 exampleId='sense-example-' + '%064x' % (number + 2), contentVersion='fixture-v1',
                 bindingHash='c' * 64, leafIndex=1, leafManifestSha256='d' * 64,
                 payloadSha256='e' * 64, publicContextSha256='f' * 64, sourceBindingsSha256='1' * 64)
    if reviewed:
        del value['publicContextSha256']
        value.update(semanticSha256='2' * 64, proofSourceBindingsSha256='3' * 64, packetReferenceSha256=None)
    return value


def fixture():
    text = 'This currently held sentence must never produce any media.'
    key = h.sha(text)
    held = dict(textHash=key, text=text, references=[reference(True)], rawTokenSegments=[['tʃ', 'aɪ', '.']],
                originalPhonemes=['tʃaɪ.'], accents=dict(
                    US=dict(state='reviewed-retain', correction=None, hold=None),
                    UK=dict(state='hold', correction=None, hold={'fixture': 'whole current hold'})))
    target = dict(textHash=key, text=text, references=held['references'], accents=['US'])
    request = dict(kind='nightstudy-ci-sentence-audio-request-v1', mode='batch', packId='sentence-audio-v4-9002',
                   portableControls={}, voicesManifest={}, publicRootSha256=h.PUBLIC_SHA, finalPolicySha256=h.FINAL_SHA,
                   targets=[target], holdChecks=[dict(textHash=key, accent='UK')], batchApproval={})
    voices = dict(voices={a: dict(model={'sha256': '4' * 64}, config={'sha256': '5' * 64}) for a in h.ACCENTS})
    return request, {key: held}, voices


def task_expected(count):
    return {('%064x' % number, accent): dict(identity=dict(referencesSha256='a' * 64, route='linux-original-text'),
            target=dict(text='A complete current sentence for this independent task.'), group=None, correction=None)
            for accent in h.ACCENTS for number in range(1, count + 1)}


def events_for(expected, task):
    return [dict(textHash=key[0], accent=key[1], displayedTextUnchanged=row['target']['text'],
                 taskId=task['id'], workerPid=42, workerPgid=100, referencesSha256='a' * 64,
                 route='linux-original-text', frontendPrecheckOnly=True, rawRouteObserved=False,
                 completedPublicCall=True, actualFrontendTokenSegments=[['tʃ', 'aɪ', '.']],
                 actualFrontendPhonemes=['tʃaɪ.']) for key, row in sorted(expected.items())]


class IndependentBatchTests(unittest.TestCase):
    def test_pilot_entry_still_rejects_nine_sentences(self):
        request, controls, voices = fixture()
        request.pop('batchApproval')
        request['mode'] = 'pilot'
        request['targets'] *= 9
        with self.assertRaisesRegex(ValueError, 'exact_bounded_pilot_request'):
            h.expected_targets(request, controls, voices)

    def test_full_batch_chunks_cover_each_accent_once_at_128(self):
        expected = task_expected(1000)
        execution, subsets = batch.execution_metadata(h, expected, 4)
        self.assertEqual(execution['taskCount'], 16)
        self.assertEqual(execution['maxWorkers'], 4)
        self.assertEqual([task['sentenceCount'] for task in execution['tasks'][:8]], [128] * 7 + [104])
        self.assertEqual(set().union(*(set(v) for v in subsets.values())), set(expected))
        self.assertEqual(sum(map(len, subsets.values())), 2000)
        altered = task_expected(999)
        other, _ = batch.execution_metadata(h, altered, 4)
        self.assertNotEqual(execution['tasks'][-1]['id'], other['tasks'][-1]['id'])

    def test_route_requires_one_exact_task_not_all_same_accent(self):
        expected = task_expected(129)
        execution, subsets = batch.execution_metadata(h, expected, 4)
        task = execution['tasks'][0]
        selected = subsets[task['id']]
        events = events_for(selected, task)
        self.assertEqual(h.validate_routes(events, selected, task, 100), 42)
        with self.assertRaisesRegex(ValueError, 'all_task_pairs_one_fresh_worker'):
            h.validate_routes(events[:-1], selected, task, 100)
        extra = events_for(subsets[execution['tasks'][1]['id']], task)
        with self.assertRaisesRegex(ValueError, 'actual_completed_public_call_task_and_process'):
            h.validate_routes(events + extra, selected, task, 100)

    def test_active_hold_is_denied_before_identity_or_media(self):
        request, controls, voices = fixture()
        expected, _, denied = batch.expected_targets(h, request, controls, controls, voices, {})
        self.assertEqual(len(expected), 1)
        self.assertEqual(denied[0]['modelLoaded'], False)
        self.assertEqual(denied[0]['mediaGenerated'], False)
        request['targets'][0]['accents'] = ['UK']
        with self.assertRaisesRegex(ValueError, 'active_hold_before_identity'):
            batch.expected_targets(h, request, controls, controls, voices, {})

    def test_pending_and_published_baseline_are_never_fresh_targets(self):
        request, controls, voices = fixture()
        key = request['targets'][0]['textHash'], 'US'
        for reason in ('pending-explicit', 'published-baseline-exact-current-refs', 'hold'):
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError, 'no_held_blocked_or_published_baseline_generation'):
                batch.expected_targets(h, request, controls, controls, voices, {key: reason})

    def test_all_current_refs_are_required_even_for_an_unselected_leaf(self):
        key = h.sha('An unselected current leaf also needs complete reference identity.')
        refs = [reference(False, 1), reference(False, 3)]
        public = {key: [batch.reference_fingerprint(h, r, False) for r in refs]}
        target = dict(textHash=key, references=refs)
        batch.current_selection_references(h, target, public, False)
        changed = copy.deepcopy(target)
        changed['references'].pop()
        with self.assertRaisesRegex(ValueError, 'all_selection_complete_current_public_references'):
            batch.current_selection_references(h, changed, public, False)
        changed = copy.deepcopy(target)
        changed['references'][0]['sourceBindingsSha256'] = '9' * 64
        with self.assertRaisesRegex(ValueError, 'all_selection_complete_current_public_references'):
            batch.current_selection_references(h, changed, public, False)

    def test_overlay_public_context_cannot_be_treated_as_old_private_proof(self):
        key = h.sha(batch.SUPPLEMENT_TEXT)
        original = reference()
        target = dict(textHash=key, references=[original])
        public = {key: [batch.reference_fingerprint(h, original, False)]}
        batch.current_selection_references(h, target, public, False)
        changed = copy.deepcopy(target)
        changed['references'][0]['publicContextSha256'] = '9' * 64
        with self.assertRaisesRegex(ValueError, 'all_selection_complete_current_public_references'):
            batch.current_selection_references(h, changed, public, False)
        with self.assertRaisesRegex(ValueError, 'complete_current_reference_identity'):
            batch.current_selection_references(h, target, public, True)

    def test_four_workers_require_actual_cpu_and_eight_gib(self):
        value = dict(cpuCount=4, memAvailableBytes=8 * 1024 ** 3, workers=4, threadsPerVoice=1,
                     fourWorkersRequireAvailableBytes=8 * 1024 ** 3)
        batch.cloud_admission(h, value, 4)
        for field, replacement in (('cpuCount', 2), ('memAvailableBytes', 8 * 1024 ** 3 - 1), ('threadsPerVoice', 2)):
            changed = dict(value, **{field: replacement})
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'actual_explicit_cloud_resource_admission'):
                batch.cloud_admission(h, changed, 4)

    def test_frozen_unicode_token_boundaries_are_not_reconstructed_from_joined(self):
        request, controls, voices = fixture()
        expected, _, _ = batch.expected_targets(h, request, controls, controls, voices, {})
        execution, _ = batch.execution_metadata(h, expected, 1)
        task = execution['tasks'][0]
        key, selected = next(iter(expected.items()))
        group = selected['group']
        event = dict(textHash=key[0], accent='US', displayedTextUnchanged=group['text'], taskId=task['id'],
                     workerPid=42, workerPgid=100, referencesSha256=selected['identity']['referencesSha256'],
                     route='frozen-reviewed-raw-per-sentence', frontendPrecheckOnly=False, rawRouteObserved=True,
                     completedPublicCall=True, sentenceIndex=0, rawPayload='[[tʃaɪ.]]',
                     originalTokenSegments=copy.deepcopy(group['rawTokenSegments']), originalPhonemes=['tʃaɪ.'],
                     renderedPhonemes=['tʃaɪ.'], correctionSha256=None, correctionId=None,
                     linuxDisplayedTextPhonemizeCalled=False)
        self.assertEqual(h.validate_routes([event], expected, task, 100), 42)
        event['originalTokenSegments'] = [list('tʃaɪ.')]
        with self.assertRaisesRegex(ValueError, 'actual_entire_frozen_unicode_raw_route'):
            h.validate_routes([event], expected, task, 100)

    def test_imports_are_independent_of_workers_and_models(self):
        self.assertFalse(any(name in sys.modules for name in ('piper', 'onnxruntime', 'numpy', 'torch')))
        self.assertFalse(any('accepted_pilot_contract' in name or 'ci_fresh_batch_contract' in name for name in sys.modules))


if __name__ == '__main__':
    unittest.main()
