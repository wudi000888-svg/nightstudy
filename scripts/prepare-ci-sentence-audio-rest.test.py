#!/usr/bin/env python3
"""Model-free remaining-job approval and matrix boundary regressions."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

FILE = Path(__file__).with_name('prepare-ci-sentence-audio-rest.py')
SPEC = importlib.util.spec_from_file_location('remaining_ci_audio_plan', FILE)
rest = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rest)
r, _ = rest.load_helper()


def first_fixture():
    request = dict(batchApproval=dict(sliceNumber=1, workers=4),
                   targets=[dict(textHash='%064x' % number, accents=['US', 'UK']) for number in range(256)])
    receipt = dict(kind='nightstudy-ci-sentence-audio-batch-independent-check-v1', state='VERIFIED_SELECTED_BATCH_ONLY',
        requestSha256=rest.FIRST_REQUEST_SHA, publicRootSha256=r.PUBLIC_SHA, finalPolicySha256=r.FINAL_SHA,
        batchApproval=copy.deepcopy(request['batchApproval']), selectedLeafGroups=256, generatedPairs=512,
        completeMp3EofDecodes=512, originalWavsFullyRead=512, heldDenials=1, allCurrentReferencesBound=True,
        selectionPairUnionVerified=True, oldUnapprovedCandidateSelection='NOT_SELECTED', oldUnapprovedCandidates=89880,
        workers=4, threadsPerVoice=1, decoderThreads=1, decoderInputProtocol='fd', seekablePinnedInput=True,
        reviewedFrozenRawCallsVerified=True, publicationAuthorized=False, batchWorkerSha256=r.WORKER_SHA,
        checkerSourceSha256=rest.CHECKER_SHA, purePilotHelperSha256='8d4c07d943331228790aa6d0376b664677180705c0b590d42c6c73b32dcc9057',
        journalReusePolicy='disabled-fresh-generation-no-progress-inputs-v1', media=[
            dict(textHash=t['textHash'], accent=a, cacheKey='a' * 64, fileSha256='b' * 64,
                 originalWavSha256='c' * 64, metrics={'fixture': True}, originalWavMetrics={'fixture': True})
            for t in request['targets'] for a in t['accents']])
    return request, receipt


def jobs_fixture():
    return dict(requests=[dict(sliceNumber=n, packId='sentence-audio-v4-%04d' % (100 + n),
        fileName='.ci-audio-plan/request-%04d.json' % n, sha256='%064x' % n,
        groups=256 if n == 1 else 470 if n == 101 else 1000,
        pairs=512 if n == 1 else 940 if n == 101 else 2000) for n in range(1, 102)])


class RemainingPlanTests(unittest.TestCase):
    def test_actual_acceptance_shape_needs_all512_pair_keys(self):
        request, receipt = first_fixture()
        rest.first_check(r, receipt, request)
        receipt['media'][-1] = copy.deepcopy(receipt['media'][0])
        with self.assertRaisesRegex(ValueError, 'first_all512_media_keys_and_original_wavs'):
            rest.first_check(r, receipt, request)

    def test_incomplete_eof_or_weaker_worker_settings_never_authorize_rest(self):
        request, receipt = first_fixture()
        for key, value in (('completeMp3EofDecodes', 511), ('originalWavsFullyRead', 511), ('workers', 2),
                           ('decoderThreads', 2), ('threadsPerVoice', 2), ('heldDenials', 0), ('decoderInputProtocol', 'pipe'),
                           ('oldUnapprovedCandidateSelection', 'SELECTED'), ('publicationAuthorized', True)):
            changed = dict(receipt, **{key: value})
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'whole_actual_first_independent_acceptance'):
                rest.first_check(r, changed, request)

    def test_other_request_or_checker_source_cannot_stand_in_for_actual_first(self):
        request, receipt = first_fixture()
        for key, value in (('requestSha256', '0' * 64), ('checkerSourceSha256', '1' * 64), ('batchWorkerSha256', '2' * 64)):
            changed = dict(receipt, **{key: value})
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'whole_actual_first_independent_acceptance'):
                rest.first_check(r, changed, request)

    def test_first_evidence_success_conclusion_is_explicit_not_inferred(self):
        job = dict(jobs_fixture()['requests'][0], bytes=248810, sha256=rest.FIRST_REQUEST_SHA)
        selection = dict(fileName='.ci-audio-plan/selection.manifest.json', bytes=36984, sha256='a' * 64)
        approval = dict(kind='nightstudy-ci-audio-first-accepted-v1', packId=job['packId'], selectionManifest=selection,
            request={key: job[key] for key in r.PIN_FIELDS}, check=dict(fileName='.ci-audio-inputs/check.json',
            bytes=368196, sha256=rest.FIRST_CHECK_SHA), assembly=dict(fileName='.ci-audio-inputs/assembly.json', bytes=986, sha256='b' * 64),
            unpack=dict(fileName='.ci-audio-inputs/unpack.json', bytes=70, sha256='c' * 64),
            archive=dict(fileName='nightstudy-sentence-audio-v4-0101.tar.gz', bytes=10316537, sha256='d' * 64),
            source=dict(release='audio-build-batches-014-20261019', runId=39229287197, attempt=1,
                        commit='3b8da3fc09ca89883f96a539c8dad73f0980559d', conclusion='success'))
        rest.accepted_source(r, approval, {'selection': selection}, job)
        approval['source']['conclusion'] = 'failure'
        with self.assertRaisesRegex(ValueError, 'explicit_actual_first_job_conclusion'):
            rest.accepted_source(r, approval, {'selection': selection}, job)

    def test_remaining_matrix_is_exact2_through101_and_never_first(self):
        matrix = rest.remaining_matrix(r, jobs_fixture())
        self.assertEqual(len(matrix['include']), 100)
        self.assertEqual([row['sliceNumber'] for row in matrix['include']], list(range(2, 102)))
        self.assertEqual(matrix['include'][0]['packId'], 'sentence-audio-v4-0102')
        self.assertEqual(matrix['include'][-1]['packId'], 'sentence-audio-v4-0201')
        jobs = jobs_fixture()
        jobs['requests'][1]['sliceNumber'] = 1
        with self.assertRaisesRegex(ValueError, 'remaining_ordered_unique_identity'):
            rest.remaining_matrix(r, jobs)

    def test_missing_remaining_job_is_not_silently_ignored(self):
        jobs = jobs_fixture()
        jobs['requests'].pop()
        with self.assertRaisesRegex(ValueError, 'exact101_actual_plan_jobs'):
            rest.remaining_matrix(r, jobs)

    def test_full100_matrix_exceeds_pilot4096_but_fits_explicit64k_cap(self):
        matrix = rest.remaining_matrix(r, jobs_fixture())
        self.assertGreater(len(r.canonical(matrix)), 4096)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary).resolve() / 'github-output'
            path.write_bytes(b'prior=value\n')
            rest.write_matrix(r, path, matrix)
            raw = path.read_bytes()
            self.assertLess(len(raw), 65536)
            self.assertEqual(r.decode(raw.splitlines()[1].removeprefix(b'matrix=')), matrix)
            with self.assertRaisesRegex(ValueError, 'fresh_remaining_matrix_key'):
                rest.write_matrix(r, path, matrix)
            self.assertEqual(path.read_bytes(), raw)

    def test_first_scope_remains_a_separate_entry(self):
        with patch.object(rest.sys, 'argv', ['rest', '--archive', 'unused', '--scope', 'first', '--github-output', 'unused']):
            with self.assertRaises(SystemExit) as stopped:
                rest.main()
            self.assertEqual(stopped.exception.code, 2)


if __name__ == '__main__':
    unittest.main()
