import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('sense_targets', Path(__file__).with_name('learning-senses-targets.py'))
targets = importlib.util.module_from_spec(spec); spec.loader.exec_module(targets)


class IndependentTargets(unittest.TestCase):
    def setUp(self):
        self.source = [{'id': 'a', 'normalizedLemma': 'rain'}, {'id': 'b', 'normalizedLemma': 'water'},
                       {'id': 'withdrawn', 'normalizedLemma': 'badentry', 'withdrawn': True}]
        self.catalog = {'books': [{'id': 'book-a', 'goal': 'daily', 'kind': 'vocabulary', 'items': [[0, 'rain'], [1, 'water'], [2, 'badentry']]},
                                 {'id': 'book-b', 'goal': 'cet4', 'kind': 'vocabulary', 'items': [[0, 'water']]}]}
        self.declared = {'books': [{'id': 'book-a', 'wordCount': 2}, {'id': 'book-b', 'wordCount': 1}],
                         'activeWords': 2, 'activeBookItems': 3}

    def test_cross_book_overlap_deduplicates_union_and_withdrawal_is_explicit(self):
        required, books, withdrawn = targets.derive_targets(self.source, self.catalog, self.declared)
        self.assertEqual(required, [{'wordId': 'a', 'normalizedLemma': 'rain'}, {'wordId': 'b', 'normalizedLemma': 'water'}])
        self.assertEqual(sum(book['wordCount'] for book in books), 3)
        self.assertEqual(withdrawn, [{'bookId': 'book-a', 'normalizedLemma': 'badentry'}])

    def test_omitted_word_cannot_shrink_its_own_completion_target(self):
        source = self.source + [{'id': 'extra', 'normalizedLemma': 'snow'}]
        with self.assertRaisesRegex(ValueError, 'incomplete_independent_catalog_union'):
            targets.derive_targets(source, self.catalog, self.declared)

    def test_wrong_membership_or_book_count_is_rejected(self):
        catalog = copy.deepcopy(self.catalog); catalog['books'][0]['items'].append([3, 'missing'])
        with self.assertRaisesRegex(ValueError, 'catalog_word_missing'):
            targets.derive_targets(self.source, catalog, self.declared)
        catalog = copy.deepcopy(self.catalog); catalog['books'][0]['items'].append([3, 'rain'])
        with self.assertRaisesRegex(ValueError, 'duplicate_or_invalid_membership'):
            targets.derive_targets(self.source, catalog, self.declared)
        declared = copy.deepcopy(self.declared); declared['books'][1]['wordCount'] = 2
        with self.assertRaisesRegex(ValueError, 'declared_book_count_mismatch'):
            targets.derive_targets(self.source, self.catalog, declared)

    def test_duplicate_or_unlisted_book_is_rejected(self):
        catalog = copy.deepcopy(self.catalog); catalog['books'].append(copy.deepcopy(catalog['books'][0]))
        with self.assertRaisesRegex(ValueError, 'duplicate_or_undeclared_book'):
            targets.derive_targets(self.source, catalog, self.declared)


if __name__ == '__main__':
    unittest.main()
