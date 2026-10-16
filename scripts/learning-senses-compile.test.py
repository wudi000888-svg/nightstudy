import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('learning_senses_compile', Path(__file__).with_name('learning-senses-compile.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class AtomicMeaningBoundaries(unittest.TestCase):
    def setUp(self):
        self.source = [dict(id='word-bank', normalizedLemma='bank', contentVersion='synthetic', sourceRef='pack:synthetic',
            senses=[dict(id='source-bank', wordId='word-bank', pos='n.', definitionZh='银行；河岸', definitionEn='',
                         contentMetadata={}, exampleEn='', exampleZh='')], examples=[])]
        self.draft = dict(lemma='bank', key='finance', pos='n.', definitionZh='银行',
            definitionEn='A financial institution.', ordinal=0,
            sources=[dict(pos='n.', definitionZh='银行；河岸', definitionEn='', relation='narrower',
                          reason='Synthetic split explicitly separates the financial meaning from the river edge.')],
            review=dict(decision='publish', reviewer='Codex', expertCertified=False,
                        semanticRationale='Synthetic review selects the financial meaning only.'),
            examples=[dict(context='存款', en='I opened an account at the bank.', zh='我在银行开了账户。',
                           semanticRationale='The account makes this a financial institution.'),
                      dict(context='贷款', en='The bank approved the loan.', zh='银行批准了贷款。',
                           semanticRationale='Approving a loan clearly concerns a financial institution.')])

    def compile(self, drafts=None):
        return c.compile_rows(self.source, drafts if drafts is not None else [self.draft], 'synthetic-v1')

    def test_explicit_narrower_binding_never_changes_source_or_reuses_word_examples(self):
        before = copy.deepcopy(self.source)
        row = self.compile()[0]
        self.assertEqual(self.source, before)
        self.assertEqual(row['senses'][0]['sourceBindings'][0]['sourceDefinitionEnSha256'], c.sha(''))
        self.assertEqual(len(row['senses'][0]['examples']), 2)
        self.assertEqual(row['senses'][0]['bindingHash'], c.binding_hash(row['senses'][0]))

    def test_missing_drafts_create_gaps_instead_of_fabricated_meanings(self):
        rows = self.compile([])
        gaps, candidates = c.inventory(self.source, rows)
        self.assertEqual(rows, [])
        self.assertEqual(candidates, [])
        self.assertEqual(gaps[0]['status'], 'atomic-review-required')
        self.assertIsNone(gaps[0]['remainingAtomicMeaningCount'])

    def test_a_comma_pos_or_near_match_cannot_align_sources(self):
        self.draft['sources'][0]['definitionZh'] = '银行'
        with self.assertRaisesRegex(ValueError, 'ambiguous_or_changed_source'):
            self.compile()

    def test_empty_source_pos_is_hashed_and_drift_is_rejected(self):
        self.source[0]['senses'][0]['pos'] = ''
        with self.assertRaisesRegex(ValueError, 'ambiguous_or_changed_source'):
            self.compile()

    def test_matching_text_from_another_word_never_counts_as_source_evidence(self):
        self.source[0]['senses'][0]['wordId'] = 'another-word'
        with self.assertRaisesRegex(ValueError, 'cross_word_source_identity'):
            self.compile()

    def test_two_different_labels_do_not_allow_the_same_sentence(self):
        self.draft['examples'][1]['en'] = self.draft['examples'][0]['en']
        with self.assertRaisesRegex(ValueError, 'duplicate_sentence'):
            self.compile()

    def test_single_context_and_missing_surface_never_publish(self):
        self.draft['examples'][1]['context'] = '存款'
        with self.assertRaisesRegex(ValueError, 'two_distinct_contexts'):
            self.compile()
        self.draft['examples'][1]['context'] = '贷款'
        self.draft['examples'][1]['en'] = 'The company approved the loan.'
        with self.assertRaisesRegex(ValueError, 'target_surface_absent'):
            self.compile()

    def test_old_sentence_stays_an_unbound_candidate(self):
        self.source[0]['examples'].append(dict(id='old', exampleEn='I sat on the bank.', exampleZh='我坐在河岸上。'))
        gaps, candidates = c.inventory(self.source, self.compile())
        self.assertEqual(gaps[0]['curatedLearningSenses'], 1)
        self.assertEqual(candidates[0]['status'], 'unbound-candidate')
        self.assertNotIn('learningSenseId', candidates[0])

    def test_editorial_queue_keeps_all_source_bytes_but_does_not_mark_a_word_complete(self):
        rows = self.compile()
        gaps, candidates = c.inventory(self.source, rows)
        queue = list(c.authoring_queue(self.source, rows, candidates))
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0]['sourceSenses'][0]['definitionZh'], '银行；河岸')
        self.assertEqual(queue[0]['sourceSenses'][0]['sourceDefinitionEnSha256'], c.sha(''))
        self.assertFalse(queue[0]['exhaustiveMeaningInventoryReviewed'])
        self.assertEqual(queue[0]['status'], 'partially-curated')

    def test_compressed_pack_has_a_fixed_portable_header_and_no_time(self):
        raw = 'Original bilingual fixture 原创。\n'.encode()
        packed = c.pack_bytes(raw)
        self.assertEqual(packed, c.pack_bytes(raw))
        self.assertEqual(packed[4:8], b'\0\0\0\0')
        self.assertEqual(packed[9], 255)
        self.assertEqual(c.gzip.decompress(packed), raw)

    def test_authored_pack_has_unique_meaning_and_semantic_review_for_every_sentence(self):
        drafts = c.load_drafts(Path(__file__).parents[1] / 'data/learning-senses-authored.json')
        self.assertGreaterEqual(len(drafts), 44)
        self.assertTrue(all(len(d['examples']) >= 2 for d in drafts))
        self.assertTrue(all(d['review']['expertCertified'] is False for d in drafts))

    def test_heteronym_policy_never_claims_unverified_word_audio_is_compatible(self):
        path = Path(__file__).parents[1] / 'data/learning-senses-authored-batch2.json'
        drafts = c.load_drafts(path)
        marked = [d for d in drafts if d['lemma'] in ('record', 'present')]
        self.assertEqual(len(marked), 6)
        self.assertTrue(all(d['pronunciation']['wordAudioCompatible'] is False for d in marked))
        drafts.extend(c.load_drafts(Path(__file__).parents[1] / 'data/learning-senses-authored-batch3.json'))
        all_heteronyms = [d for d in drafts if d['lemma'] in ('record', 'present', 'address', 'subject')]
        self.assertEqual(len(all_heteronyms), 12)
        self.assertTrue(all(d['pronunciation']['wordAudioCompatible'] is False for d in all_heteronyms))
        self.draft['pronunciation'] = dict(wordAudioCompatible=True,
            reason='Synthetic unsupported claim must never enable an unverified recording.')
        with self.assertRaisesRegex(ValueError, 'unsupported_pronunciation_policy'):
            self.compile()


if __name__ == '__main__':
    unittest.main()
