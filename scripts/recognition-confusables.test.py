import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('confusables', Path(__file__).with_name('recognition-confusables.py'))
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)


class PublicLexicalExclusions(unittest.TestCase):
    def test_synonyms_direct_subsumption_and_similar_adjectives_are_symmetric(self):
        graph = {'1-n': ({'dog', 'hound'}, {'2-n'}), '2-n': ({'canine'}, set()),
                 '3-n': ({'cat'}, {'2-n'}), '4-a': ({'pliable'}, {'5-a'}),
                 '5-a': ({'pliant'}, set())}
        result = mod.exclusions(graph, {'dog', 'hound', 'canine', 'cat', 'pliable', 'pliant'}, [])
        self.assertIn('hound', result['dog']); self.assertIn('canine', result['dog'])
        self.assertIn('dog', result['canine']); self.assertNotIn('cat', result['dog'])
        self.assertIn('pliant', result['pliable']); self.assertIn('pliable', result['pliant'])

    def test_parser_preserves_pointer_semantics_and_filters_non_active_words(self):
        lines = ['  WordNet copyright header',
                 '00000001 00 n 02 dog 0 hound 0 001 @ 00000002 n 0000 | not copied',
                 '00000002 00 n 01 canine 0 000 | not copied',
                 '00000003 00 s 01 able(p) 0 000 | adjective marker']
        graph = mod.parse_synsets(lines)
        self.assertEqual(graph['00000003-a'][0], {'able'})
        result = mod.exclusions(graph, {'dog', 'canine'}, [])
        self.assertEqual(result, {'canine': ['dog'], 'dog': ['canine']})

    def test_missing_pointer_is_not_silently_dropped_and_manual_guard_is_explicit(self):
        with self.assertRaisesRegex(ValueError, 'missing_wordnet_pointer_target'):
            mod.exclusions({'1-n': ({'a'}, {'missing'})}, {'a'})
        self.assertEqual(mod.exclusions({}, {'poison', 'pollutant'}),
                         {'poison': ['pollutant'], 'pollutant': ['poison']})


if __name__ == '__main__':
    unittest.main()
