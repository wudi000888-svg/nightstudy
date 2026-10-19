#!/usr/bin/env python3
"""Model-free regressions for the cloud boundary and frozen public raw route."""
import importlib.util
import io
from pathlib import Path
import tempfile
import types
import unittest
import wave

FILE = Path(__file__).with_name('ci-sentence-audio-worker.py')
SPEC = importlib.util.spec_from_file_location('nightstudy_ci_worker_test_subject', FILE)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class RawVoice:
    def __init__(self, rate=22050):
        self.config = types.SimpleNamespace(phoneme_id_map={p: [1] for p in 'tʃaɪ b.'})
        self.calls = []
        self.rate = rate

    def phonemize(self, text):
        raise AssertionError('reviewed displayed text must never enter Linux G2P')

    def synthesize_wav(self, payload, wav_file):
        self.calls.append(payload)
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(self.rate)
        wav_file.writeframes(b'\x01\x00' * 2205)


class CloudBoundaryTests(unittest.TestCase):
    def group(self):
        # Multi-codepoint tokens must survive untouched in frozen evidence.
        return dict(rawTokenSegments=[['tʃ', 'aɪ', '.'], ['b', '.']],
                    originalPhonemes=['tʃaɪ.', 'b.'])

    def test_reviewed_raw_uses_whole_segments_and_never_g2p(self):
        voice, events, buffer = RawVoice(), [], io.BytesIO()
        group = self.group()
        with wave.open(buffer, 'wb') as output:
            worker.raw_render(voice, 'Displayed English sentence.', group, None, output,
                              lambda index, payload: events.append((index, payload)))
        self.assertEqual(voice.calls, ['[[tʃaɪ.]]', '[[b.]]'])
        self.assertEqual(events, [(0, '[[tʃaɪ.]]'), (1, '[[b.]]')])
        self.assertEqual(group['rawTokenSegments'][0], ['tʃ', 'aɪ', '.'])
        buffer.seek(0)
        with wave.open(buffer, 'rb') as output:
            self.assertEqual(output.getnframes(), 4410)
            self.assertEqual(output.getframerate(), 22050)

    def test_correction_only_changes_the_explicit_rendered_literal(self):
        voice, buffer = RawVoice(), io.BytesIO()
        correction = {'correctedPhonemes': ['baɪ.', 'tʃ.']}
        with wave.open(buffer, 'wb') as output:
            worker.raw_render(voice, 'Displayed English sentence.', self.group(),
                              correction, output, lambda *_: None)
        self.assertEqual(voice.calls, ['[[baɪ.]]', '[[tʃ.]]'])

    def test_incompatible_raw_wav_is_rejected_before_pcm_join(self):
        with self.assertRaisesRegex(ValueError, 'raw_sentence_wav_format'):
            with wave.open(io.BytesIO(), 'wb') as output:
                try:
                    worker.raw_render(RawVoice(16000), 'Displayed English sentence.',
                                      self.group(), None, output, lambda *_: None)
                finally:
                    # Permit closing the intentionally not-yet-initialized sink.
                    output.setnchannels(1)
                    output.setsampwidth(2)
                    output.setframerate(22050)

    def test_empty_frozen_segment_can_be_preserved_only_for_holds(self):
        worker.validate_raw([['aɪ'], []], ['aɪ', ''], True)
        with self.assertRaisesRegex(ValueError, 'frozen_raw_segment'):
            worker.validate_raw([['aɪ'], []], ['aɪ', ''], False)

    def test_token_join_drift_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'frozen_raw_segment'):
            worker.validate_raw([['tʃ', 'aɪ']], ['taɪ'], False)

    def test_held_generation_is_denied_before_source_or_model_access(self):
        text = 'This sentence remains unavailable.'
        digest = worker.sha(text)
        refs = [dict(wordId='demo-word-022', learningSenseId='learning-sense-'+'a'*64,
                     exampleId='sense-example-'+'b'*64)]
        group = dict(text=text, references=refs,
                     accents={'US': dict(state='hold', correction=None, hold={})})
        pipeline = types.SimpleNamespace(normalize=lambda value: value)
        request = dict(kind='nightstudy-ci-sentence-audio-request-v1', mode='pilot',
            packId='sentence-audio-v4-9001', portableControls={}, voicesManifest={},
            publicRootSha256=worker.PUBLIC_ROOT_SHA, finalPolicySha256=worker.FINAL_POLICY_SHA,
            targets=[dict(textHash=digest, text=text, references=refs, accents=['US'])],
            holdChecks=[dict(textHash=digest, accent='US')])
        # Deliberately no pack/model attribute exists: policy must reject first.
        with self.assertRaisesRegex(ValueError, 'held_target_generation_forbidden'):
            worker.prepare_request(request, {digest: group}, pipeline)

    def test_changed_current_reference_is_rejected_before_policy_or_model(self):
        text = 'This sentence remains unavailable.'
        digest = worker.sha(text)
        ref = dict(wordId='demo-word-022', learningSenseId='learning-sense-'+'a'*64,
                   exampleId='sense-example-'+'b'*64, semanticSha256='c'*64)
        changed = dict(ref, semanticSha256='d'*64)
        request = dict(kind='nightstudy-ci-sentence-audio-request-v1', mode='pilot',
            packId='sentence-audio-v4-9001', portableControls={}, voicesManifest={},
            publicRootSha256=worker.PUBLIC_ROOT_SHA, finalPolicySha256=worker.FINAL_POLICY_SHA,
            targets=[dict(textHash=digest, text=text, references=[changed], accents=['US'])],
            holdChecks=[dict(textHash=digest, accent='US')])
        group = dict(text=text, references=[ref])
        with self.assertRaisesRegex(ValueError, 'pilot_target_current_context_changed'):
            worker.prepare_request(request, {digest: group}, types.SimpleNamespace(normalize=lambda x: x))

    def test_traversal_and_absolute_control_paths_are_rejected(self):
        for name in ('../private.json', '/tmp/private.json', 'data/../../private.json'):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, 'input_relative_filename'):
                    worker.relative_file(name)

    def test_oversized_or_symlink_input_is_rejected_before_read(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'input.json'
            path.write_bytes(b'123456789')
            with self.assertRaisesRegex(ValueError, 'input_file_bounds'):
                worker.read_bounded(path, 8)
            link = Path(temporary) / 'link.json'
            link.symlink_to(path)
            with self.assertRaises(OSError):
                worker.read_bounded(link, 16)


if __name__ == '__main__':
    unittest.main()
