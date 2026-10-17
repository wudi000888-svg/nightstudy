"""Exact publication holds: pure text/JSON tests, with no audio/model imports."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sentence_audio_holds',
    Path(__file__).with_name('sentence-audio-holds.py'))
holds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(holds)


class SentencePublicationHolds(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nightstudy-audio-holds-')
        self.root = Path(self.temporary.name)
        self.text = 'The drawing shows a bifurcate stem.'
        self.entry = self.record(self.text, 'UK')
        self.rows = [{'text': self.text, 'textHash': holds.sha(self.text),
                      'references': [{'learningSenseId': self.entry['learningSenseId'],
                                      'exampleId': self.entry['exampleId']}]}]

    def tearDown(self):
        self.temporary.cleanup()

    def record(self, text, accent):
        digest = holds.sha(text)
        return {'id': 'sentence-audio-hold-' + holds.sha(digest+'\0'+accent),
                'text': text, 'textHash': digest, 'accent': accent,
                'learningSenseId': 'learning-sense-'+'a'*64,
                'exampleId': 'sense-example-'+'b'*64,
                'riskCategory': 'insufficient-regional-evidence',
                'review': {'reviewer': 'Codex', 'decision': 'hold',
                           'expertCertified': False,
                           'reason': 'Current regional/POS combination needs a direct source; uncertainty is not a declaration of wrong audio.'}}

    def write(self, entries=None, **updates):
        value = {'formatVersion': 1, 'id': holds.POLICY_ID,
                 'entries': [self.entry] if entries is None else entries}
        value.update(updates)
        file = self.root/'sentence-audio-holds-v1.json'
        raw = (json.dumps(value, ensure_ascii=False, separators=(',', ':'))+'\n').encode()
        file.write_bytes(raw)
        return file, holds.sha(raw)

    def test_absence_requires_no_file_and_no_pin(self):
        self.assertEqual(holds.load_holds(None, None, self.rows), ({}, None))
        for file, pin in [(None, 'a'*64), (self.root/'absent', None), ('', None)]:
            with self.subTest(file=file, pin=pin):
                with self.assertRaisesRegex(ValueError, 'pin_required'):
                    holds.load_holds(file, pin, self.rows)

    def test_exact_accent_hold_keeps_the_complete_policy_pin(self):
        file, pin = self.write()
        active, identity = holds.load_holds(file, pin, self.rows)
        self.assertEqual(set(active), {(holds.sha(self.text), 'UK')})
        self.assertNotIn((holds.sha(self.text), 'US'), active)
        self.assertEqual(identity, {'fileName': file.name, 'bytes': file.stat().st_size,
                                   'sha256': pin, 'holdCount': 1, 'appliedClipCount': 1})

    def test_pinned_explicit_empty_policy_is_distinct_from_absent_policy(self):
        file, pin = self.write([])
        active, identity = holds.load_holds(file, pin, self.rows)
        self.assertEqual(active, {})
        self.assertEqual(identity['holdCount'], 0)
        self.assertEqual(identity['appliedClipCount'], 0)
        self.assertEqual(identity['sha256'], pin)

    def test_full_policy_validated_but_only_current_shard_counts(self):
        outside = self.record('The laboratory has a second entrance.', 'US')
        file, pin = self.write([self.entry, outside])
        active, identity = holds.load_holds(file, pin, self.rows)
        self.assertEqual(len(active), 1)
        self.assertEqual(identity['holdCount'], 2)
        self.assertEqual(identity['appliedClipCount'], 1)
        active, identity = holds.load_holds(file, pin, [])
        self.assertEqual(active, {})
        self.assertEqual(identity['appliedClipCount'], 0)
        outside['review']['decision'] = 'publish'
        file, pin = self.write([self.entry, outside])
        with self.assertRaisesRegex(ValueError, 'pronunciation_hold_review'):
            holds.load_holds(file, pin, self.rows)

    def test_same_text_cannot_evade_a_wrong_meaning_reference(self):
        for field in ['learningSenseId', 'exampleId']:
            changed = copy.deepcopy(self.entry)
            changed[field] = ('learning-sense-' if field == 'learningSenseId' else
                              'sense-example-')+'c'*64
            file, pin = self.write([changed])
            with self.subTest(field=field), self.assertRaisesRegex(
                    ValueError, 'pronunciation_holds_meaning_mismatch'):
                holds.load_holds(file, pin, self.rows)

    def test_shared_sentence_can_bind_any_actual_reference_without_losing_others(self):
        rows = copy.deepcopy(self.rows)
        rows[0]['references'].insert(0, {'learningSenseId': 'another-sense',
                                         'exampleId': 'another-example'})
        before = copy.deepcopy(rows)
        file, pin = self.write()
        active, _ = holds.load_holds(file, pin, rows)
        self.assertEqual(len(active), 1)
        self.assertEqual(rows, before)

    def test_raw_checksum_symlink_oversize_and_duplicate_json_key_are_rejected(self):
        file, pin = self.write()
        file.write_bytes(file.read_bytes()+b' ')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            holds.load_holds(file, pin, self.rows)
        link = self.root/'linked.json'; link.symlink_to(file)
        with self.assertRaisesRegex(ValueError, 'pronunciation_holds_file'):
            holds.load_holds(link, holds.sha(file.read_bytes()), self.rows)
        with patch.object(holds, 'MAX_BYTES', 1), self.assertRaisesRegex(
                ValueError, 'pronunciation_holds_file'):
            holds.load_holds(file, holds.sha(file.read_bytes()), self.rows)
        raw = b'{"formatVersion":1,"formatVersion":1,"id":"sentence-audio-holds-v1","entries":[]}'
        file.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, 'duplicate_json_key'):
            holds.load_holds(file, holds.sha(raw), self.rows)

    def test_exact_duplicate_and_text_or_accent_identity_drift_fail(self):
        file, pin = self.write([self.entry, copy.deepcopy(self.entry)])
        with self.assertRaisesRegex(ValueError, 'pronunciation_holds_duplicate'):
            holds.load_holds(file, pin, self.rows)
        cases = [('textHash', '0'*64, 'pronunciation_hold_text'),
                 ('text', '  '+self.text, 'pronunciation_hold_text'),
                 ('accent', 'US', 'pronunciation_hold_identity'),
                 ('accent', 'AU', 'pronunciation_hold_identity'),
                 ('id', 'sentence-audio-hold-'+'0'*64, 'pronunciation_hold_identity'),
                 ('learningSenseId', '../sense', 'pronunciation_hold_reference'),
                 ('riskCategory', 'all-audio-wrong', 'pronunciation_hold_risk_category')]
        for field, value, error in cases:
            changed = copy.deepcopy(self.entry); changed[field] = value
            file, pin = self.write([changed])
            with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, error):
                holds.load_holds(file, pin, self.rows)

    def test_only_three_risk_categories_without_expert_or_publication_claims(self):
        for category in holds.RISK_CATEGORIES:
            entry = copy.deepcopy(self.entry); entry['riskCategory'] = category
            self.assertEqual(holds.validate_hold(entry), entry)
        for field, value in [('expertCertified', True), ('decision', 'publish'),
                             ('reviewer', 'Expert'), ('reason', 'uncertain'),
                             ('reason', ' '*3990+'A specific reading still needs review')]:
            changed = copy.deepcopy(self.entry); changed['review'][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'review'):
                holds.validate_hold(changed)

    def test_unknown_fields_boolean_version_and_overlarge_policy_fail(self):
        for updates in [{'extra': True}, {'formatVersion': True}, {'id': 'latest'}]:
            file, pin = self.write(**updates)
            with self.subTest(updates=updates), self.assertRaisesRegex(ValueError, 'manifest'):
                holds.load_holds(file, pin, self.rows)
        file, pin = self.write([self.entry, self.record('Another precise sentence is here.', 'US')])
        with patch.object(holds, 'MAX_HOLDS', 1), self.assertRaisesRegex(ValueError, 'manifest'):
            holds.load_holds(file, pin, self.rows)
        changed = copy.deepcopy(self.entry); changed['globalLemmaBan'] = 'bifurcate'
        with self.assertRaisesRegex(ValueError, 'fields'):
            holds.validate_hold(changed)

    def test_requested_text_identity_and_duplicate_rows_fail(self):
        file, pin = self.write()
        for changed in [{**self.rows[0], 'text': self.text.lower()},
                        {**self.rows[0], 'references': None}]:
            with self.assertRaisesRegex(ValueError, 'requested_text'):
                holds.load_holds(file, pin, [changed])
        with self.assertRaisesRegex(ValueError, 'requested_duplicate'):
            holds.load_holds(file, pin, self.rows*2)


if __name__ == '__main__':
    unittest.main()
