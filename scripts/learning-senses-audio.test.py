"""Pinned text/meaning/audio boundaries, without a network or voice model."""
import copy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('atomic_audio', Path(__file__).with_name('learning-senses-audio.py'))
audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audio)


class MeaningSentenceAudioBoundaries(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nightstudy-meaning-audio-test-')
        self.root = Path(self.temporary.name)
        self.row = {'wordId': 'word-bank', 'senses': [{'id': 'bank-finance', 'wordId': 'word-bank', 'status': 'published',
            'contentVersion': 'test-v1', 'examples': [{'id': 'example-bank-account',
                'learningSenseId': 'bank-finance', 'wordId': 'word-bank', 'status': 'published', 'contentVersion': 'test-v1',
                'contextLabel': '办理账户', 'exampleEn': 'I opened an account at the bank.',
                'exampleZh': '我在银行开了账户。', 'contentMetadata': {'source': 'Original test sentence'}}]}]}

    def tearDown(self):
        self.temporary.cleanup()

    def pinned(self, rows=None):
        raw = ('\n'.join(json.dumps(row, ensure_ascii=False) for row in (rows or [self.row]))+'\n').encode()
        packed = gzip.compress(raw, mtime=0)
        content = self.root/'content.jsonl.gz'
        content.write_bytes(packed)
        manifest = self.root/'manifest.json'
        manifest.write_text(json.dumps({'id': 'test-v1', 'bytes': len(packed),
            'sha256': hashlib.sha256(packed).hexdigest(), 'jsonlSha256': hashlib.sha256(raw).hexdigest()}))
        return manifest, content

    def test_public_audio_input_keeps_explicit_meaning_and_example_evidence(self):
        manifest, content = self.pinned()
        _, rows = audio.collect(manifest, content)
        self.assertEqual(rows[0]['references'][0]['learningSenseId'], 'bank-finance')
        self.assertEqual(rows[0]['references'][0]['exampleId'], 'example-bank-account')
        self.assertEqual(rows[0]['text'], self.row['senses'][0]['examples'][0]['exampleEn'])
        self.assertNotIn('definitionZh', rows[0])

    def test_changed_compressed_bytes_or_decoded_pin_are_rejected(self):
        manifest, content = self.pinned()
        content.write_bytes(content.read_bytes()+b'changed')
        with self.assertRaisesRegex(ValueError, 'meaning_content_pin_mismatch'):
            audio.collect(manifest, content)
        manifest, content = self.pinned()
        pin = json.loads(manifest.read_text()); pin['jsonlSha256'] = '0'*64
        manifest.write_text(json.dumps(pin))
        with self.assertRaisesRegex(ValueError, 'meaning_content_jsonl_mismatch'):
            audio.collect(manifest, content)

    def test_candidate_cross_meaning_version_or_missing_translation_cannot_generate(self):
        for field, value in [('status', 'candidate'), ('wordId', 'other-word'), ('learningSenseId', 'bank-river'),
                             ('contentVersion', 'old-version'), ('exampleZh', ''),
                             ('contextLabel', ' '), ('exampleEn', '')]:
            with self.subTest(field=field):
                row = copy.deepcopy(self.row)
                row['senses'][0]['examples'][0][field] = value
                manifest, content = self.pinned([row])
                with self.assertRaisesRegex(ValueError, 'unpublished_or_unbound_sentence'):
                    audio.collect(manifest, content)

    def test_identical_audio_text_deduplicates_bytes_but_keeps_each_meaning_reference(self):
        second = copy.deepcopy(self.row)
        second['wordId'] = 'word-account'
        second['senses'][0]['wordId'] = 'word-account'
        second['senses'][0]['id'] = 'account-finance'
        second['senses'][0]['examples'][0].update(id='example-account-bank', learningSenseId='account-finance', wordId='word-account')
        manifest, content = self.pinned([self.row, second])
        _, rows = audio.collect(manifest, content)
        self.assertEqual(len(rows), 1)
        self.assertEqual({ref['exampleId'] for ref in rows[0]['references']},
                         {'example-bank-account', 'example-account-bank'})

    def test_missing_external_mount_is_rejected_before_directory_creation(self):
        with patch.object(Path, 'is_mount', return_value=False), patch.object(Path, 'mkdir') as mkdir:
            with self.assertRaisesRegex(ValueError, 'external_disk_not_mounted'):
                audio.external('/Volumes/XXX/Codex/work/audio-boundary-test', True)
            mkdir.assert_not_called()


if __name__ == '__main__':
    unittest.main()
