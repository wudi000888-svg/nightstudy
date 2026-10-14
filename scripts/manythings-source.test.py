import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('source', Path(__file__).with_name('manythings-source.py'))
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)


class ExportSourceTests(unittest.TestCase):
    def row(self, english='She opened the window before breakfast.', chinese='她早餐前打开了窗户。', en='12', zh='34'):
        return source.parse_line(english + '\t' + chinese + '\tCC-BY 2.0 (France) Attribution: tatoeba.org #' + en + ' (OwnerOne) & #' + zh + ' (OwnerTwo)', 1)

    def test_each_endpoint_owns_its_exact_text_and_attributed_owner(self):
        row = self.row()
        en, zh = row['contentMetadata']['exampleEn'], row['contentMetadata']['exampleZh']
        self.assertEqual(en['sourceOwner'], 'OwnerOne')
        self.assertEqual(zh['sourceOwner'], 'OwnerTwo')
        self.assertTrue(zh['sourceUrl'].endswith('/34'))
        self.assertEqual(zh['translationOfSentenceId'], '12')
        self.assertEqual(zh['sourceTextSha256'], hashlib.sha256(row['exampleZh'].encode()).hexdigest())
        self.assertEqual(zh['relationship']['kind'], 'source-export-pair')
        self.assertNotIn('author', zh)
        self.assertNotIn('is_direct', zh)
        self.assertEqual(row['chineseScript'], 'not-verified')

    def test_malformed_credit_duplicate_ids_and_extra_columns_fail(self):
        for line in ['Rain.\t下雨。\tUnknown author', 'Rain.\t下雨。\tCC-BY 2.0 (France) Attribution: tatoeba.org #12 (A) & #12 (B)', 'a\tb\tc\td']:
            with self.assertRaises(ValueError):
                source.parse_line(line, 1)

    def test_literal_boundaries_do_not_stem_or_invent_matches(self):
        words = {'rain', 'window', 'wind', 'by-product', 'mr.'}
        rows = [self.row(), self.row('Rain falls on every by-product that Mr. Green leaves outside.')]
        result = source.literal_matches(words, rows)
        self.assertEqual(len(result['wind']), 0)
        self.assertEqual(len(result['rain']), 1)
        self.assertEqual(len(result['by-product']), 1)
        self.assertEqual(len(result['mr.']), 1)

    def test_preferred_length_is_not_a_coverage_filter(self):
        row = self.row('Rain.', en='56', zh='78')
        matches = source.literal_matches({'rain'}, [row])
        chosen = source.select_candidates(matches, {'rain'})
        self.assertEqual(len(chosen), 1)
        self.assertFalse(chosen[0]['candidates'][0]['selection']['preferredLength'])

    def test_candidates_are_capped_and_deduplicate_english_sentence_ids(self):
        rows = [self.row('The rain kept us inside all morning.', en=str(i), zh=str(i+100)) for i in range(1, 5)]
        rows.append(self.row('The rain kept us inside all morning.', en='1', zh='200'))
        candidates = source.select_candidates({'rain': rows}, {'rain'})[0]['candidates']
        self.assertEqual(len(candidates), 3)
        self.assertEqual(len({row['contentMetadata']['exampleEn']['sourceSentenceId'] for row in candidates}), 3)


if __name__ == '__main__':
    unittest.main()
