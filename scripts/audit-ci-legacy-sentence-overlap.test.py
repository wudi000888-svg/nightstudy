#!/usr/bin/env python3
"""Small model-free identity inventory regressions; no reuse authorization."""
import copy
import importlib.util
from pathlib import Path
import unittest

FILE = Path(__file__).with_name('audit-ci-legacy-sentence-overlap.py')
SPEC = importlib.util.spec_from_file_location('legacy_overlap_inventory', FILE)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)
_, h, _ = audit.load_pure()


def voices():
    return dict(voices={a: dict(model={'sha256': 'a' * 64}, config={'sha256': 'b' * 64}) for a in h.ACCENTS})


class LegacyIdentityTests(unittest.TestCase):
    def test_same_text_and_accent_do_not_hide_engine_config_or_asset_identity(self):
        expected = audit.expected_identity(h, 'A complete current English example sentence.', 'US', None, voices())
        original = dict(expected, fileSha256='c' * 64, sizeBytes=12345, qualityMetrics={'fixture': 'whole old metrics'})
        self.assertTrue(audit.compare_entry(original, expected)['exactCurrentSynthesisIdentityMatches'])
        for field in ('engineVersion', 'voiceModelSha256', 'voiceConfigSha256', 'cacheKey'):
            changed = dict(original, **{field: 'different'})
            with self.subTest(field=field):
                result = audit.compare_entry(changed, expected)
                self.assertFalse(result['exactCurrentSynthesisIdentityMatches'])
                self.assertFalse(result['currentIdentityFieldMatches'][field])
                self.assertFalse(result['reuseApproved'])

    def test_missing_old_model_digest_is_reported_not_guessed_from_source(self):
        expected = audit.expected_identity(h, 'A complete current English example sentence.', 'UK', None, voices())
        old = dict(expected)
        del old['voiceModelSha256']
        result = audit.compare_entry(old, expected)
        self.assertEqual(result['missingIdentityFields'], ['voiceModelSha256'])
        self.assertFalse(result['exactCurrentSynthesisIdentityMatches'])

    def test_current_correction_never_inherits_a_matching_old_base_cache(self):
        text = 'A complete current English example sentence.'
        base = audit.expected_identity(h, text, 'UK', None, voices())
        correction = dict(sha256='c' * 64, record={'id': 'sentence-pronunciation-' + 'd' * 64},
                          correctedPhonemes=['first.', 'second.'])
        group = dict(accents={'UK': dict(state='reviewed-correction', correction=correction, hold=None)})
        current = audit.expected_identity(h, text, 'UK', group, voices())
        self.assertNotEqual(current['cacheKey'], base['cacheKey'])
        self.assertEqual(current['pronunciationCorrectionSha256'], correction['sha256'])
        result = audit.compare_entry(base, current)
        self.assertFalse(result['exactCurrentSynthesisIdentityMatches'])
        self.assertFalse(result['currentIdentityFieldMatches']['pronunciationCorrectionSha256'])
        self.assertFalse(result['reuseApproved'])

    def test_exact_identity_is_still_only_metadata_inventory_and_does_not_mutate_old_entry(self):
        expected = audit.expected_identity(h, 'A complete current English example sentence.', 'US', None, voices())
        old = dict(expected, fileSha256='e' * 64, originalFileSha256='f' * 64,
                   sourceName='Original published voice', qualityMetrics=dict(rmsDbfs=-20))
        frozen = copy.deepcopy(old)
        result = audit.compare_entry(old, expected)
        self.assertTrue(result['exactCurrentSynthesisIdentityMatches'])
        self.assertFalse(result['mediaDecodedInThisAudit'])
        self.assertFalse(result['reuseApproved'])
        self.assertEqual(old, frozen)


if __name__ == '__main__':
    unittest.main()
