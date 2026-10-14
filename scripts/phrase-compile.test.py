import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('phrase_compile', Path(__file__).with_name('phrase-compile.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture():
    lexical = [{'normalizedLemma': 'take care of', 'wordId': 'existing-word', 'senses': [
        {'id': 'existing-sense', 'definitionZh': '照顾', 'definitionEn': '', 'pos': '', 'ordinal': -20000}]}]
    selection = [{'normalizedLemma': 'take care of', 'wordId': 'existing-word', 'senseId': 'existing-sense',
                  'sourceText': '照顾', 'sourceTextSha256': module.sha('照顾'), 'book': 'basic'}]
    authored = [{'normalizedLemma': 'take care of', 'definitionEn': 'To look after someone or something.',
                 'exampleEn': 'I will take care of your plants tomorrow.', 'exampleZh': '我明天会照顾你的植物。'}]
    return authored, lexical, selection


class CompileTest(unittest.TestCase):
    def compile(self, values):
        return module.compile_rows(*values, expected_counts={'cet4-phrases': 1})

    def test_preserves_existing_identity_and_metadata_classification(self):
        rows, queue = self.compile(fixture())
        self.assertEqual(rows[0]['focusSenseId'], 'existing-sense')
        self.assertEqual(rows[0]['sourceWordId'], 'existing-word')
        self.assertEqual(rows[0]['senses'][0]['contentMetadata']['definitionEn']['kind'], 'original-authoring')
        self.assertNotIn('model', rows[0]['senses'][0]['contentMetadata']['definitionEn'])
        self.assertEqual(queue[0]['review'], 'pending')

    def test_exact_original_bytes_not_trimmed(self):
        values = fixture(); values[1][0]['senses'][0]['definitionZh'] = '照顾 '
        with self.assertRaisesRegex(ValueError, 'source_identity'):
            self.compile(values)

    def test_duplicate_lemma_fails(self):
        values = fixture(); values[0].append(copy.deepcopy(values[0][0]))
        with self.assertRaises(ValueError): self.compile(values)

    def test_cross_word_sense_fails(self):
        values = fixture(); values[0][0]['additionalSenses'] = [{'id': 'other-word-sense', 'definitionEn': 'A false gloss.'}]
        with self.assertRaisesRegex(ValueError, 'cross_word'):
            self.compile(values)

    def test_nonempty_existing_language_cannot_be_overwritten(self):
        values = fixture(); values[1][0]['senses'][0]['definitionEn'] = 'Administrator text'
        with self.assertRaisesRegex(ValueError, 'not_empty'):
            self.compile(values)

    def test_missing_additional_chinese_sense_fails(self):
        values = fixture(); values[1][0]['senses'].append({'id': 'extra', 'definitionZh': '赡养', 'definitionEn': ''})
        with self.assertRaisesRegex(ValueError, 'unaccounted'):
            self.compile(values)

    def test_bad_source_requires_independent_bilingual_focus(self):
        values = fixture(); row = values[0][0]
        row['definitionEn'] = ''; row['warnings'] = [{'code': 'source-definition-unreliable', 'message': 'Wrong source meaning.'}]
        with self.assertRaisesRegex(ValueError, 'requires_curated_focus'):
            self.compile(values)
        row['curatedFocus'] = {'definitionZh': '照料某人或某物', 'definitionEn': 'To look after someone or something.', 'reason': 'Source meaning reviewed and corrected separately.'}
        rows, _ = self.compile(values)
        self.assertTrue(rows[0]['focusSenseId'].startswith('phrase-focus-'))
        self.assertEqual(rows[0]['senses'], [])
        self.assertEqual(rows[0]['qualityWarnings'][0]['sourceTextSha256'], module.sha('照顾'))

    def test_whole_phrase_and_unicode_boundaries(self):
        self.assertTrue(module.exact_phrase('take care of', 'Please TAKE CARE OF this plant.'))
        self.assertFalse(module.exact_phrase('take care of', 'retake care ofness'))
        self.assertFalse(module.exact_phrase('take care of', '字take care of字'))
        self.assertFalse(module.exact_phrase('take care of', 'take care of́'))
        self.assertFalse(module.exact_phrase('take care of', 'xtake care oftake care of'))

    def test_variant_phrase_does_not_count_as_exact(self):
        values = fixture(); values[0][0]['exampleEn'] = 'She takes care of the garden.'
        with self.assertRaisesRegex(ValueError, 'missing_exact_phrase'):
            self.compile(values)

    def test_gzip_is_deterministic(self):
        self.assertEqual(module.deterministic_gzip(b'abc\n'), module.deterministic_gzip(b'abc\n'))
        self.assertEqual(module.gzip.decompress(module.deterministic_gzip(b'abc\n')), b'abc\n')

    def test_stopwords_are_excluded_without_lemma_guessing(self):
        rows, _ = self.compile(fixture())
        self.assertEqual(rows[0]['collocationTokens'], ['take', 'care'])

    def test_duplicate_sense_patch_fails(self):
        values = fixture(); values[0][0]['additionalSenses'] = [{'id': 'existing-sense', 'definitionEn': 'Duplicate.'}]
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            self.compile(values)


if __name__ == '__main__': unittest.main()
