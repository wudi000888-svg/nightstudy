"""Model-free explicit inventory mapping and pinned-file boundary checks."""
from pathlib import Path
import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('global_map', Path(__file__).with_name('prepare-ci-sentence-audio-global.py'))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


def pin(name):
    return dict(fileName=name, bytes=3, sha256=hashlib.sha256(b'{}\n').hexdigest())


def frame(number, converted=False):
    stage = '.ci-publication/slice-%04d/' % number
    candidate = {name: pin(stage + 'candidate/' + name + '.json') for name in m.CANDIDATE_FIELDS}
    publication = dict(mode='original-generation', selectionProof=None, **candidate)
    if converted:
        publication = dict(mode='legacy-reuse-conversion', selectionProof=pin(stage + 'selected/publication-choice.json'),
            **{name: pin(stage + 'selected/' + name + '.json') for name in m.CANDIDATE_FIELDS}, candidate=candidate)
    return dict(sliceNumber=number, packId='sentence-audio-v4-%04d' % (100 + number),
        request=pin('.ci-audio-plan/request-%04d.json' % number), check=pin(stage + 'check.json'),
        generation=dict(build=pin(stage + 'build.json'), manifest=pin('manifest.json'), sources=pin('sources.manifest.json')),
        publication=publication)


class FakeReader:
    def __init__(self):
        self.calls = []
        self.frames = {'.ci-publication/slice-%04d/batch-frame.json' % n: frame(n, n == 3) for n in range(1, 102)}
        self.values = {
            'data/ci-audio-batch-plan.manifest.json': dict(kind='nightstudy-ci-audio-prepared-plan-pin-v1',
                jobs=pin('.ci-audio-plan/job-manifest.json'), selection=pin('.ci-audio-plan/selection.manifest.json')),
            'data/ci-audio-batch-inputs.manifest.json': dict(portableControls=pin('.ci-audio-inputs/base.json'),
                supplementalControls=pin('.ci-audio-inputs/supplement.json')),
            '.ci-audio-inputs/supplement.json': dict(observation=pin('.ci-audio-inputs/observation.json')),
        }
        self.checked = False

    def take(self, name, cap, capture=False, expected=None):
        self.calls.append((name, capture, expected))
        if name.endswith('/batch-frame.json'):
            return pin(name), copy.deepcopy(self.frames[name])
        return pin(name), copy.deepcopy(self.values.get(name))

    def unchanged(self):
        self.checked = True


class InventoryTests(unittest.TestCase):
    def test_all101_exact_order_both_publication_branches_and_no_declaration_reopen(self):
        reader = FakeReader()
        value = m.assemble(reader)
        self.assertEqual(set(value), {'kind', 'mediaReleaseUrl', 'planManifest', 'publicRoot', 'controls', 'globalHolds',
            'legacyOverlap', 'legacyQualification', 'legacyManifests', 'batches'})
        self.assertEqual([row['sliceNumber'] for row in value['batches']], list(range(1, 102)))
        self.assertEqual(value['batches'][0]['packId'], 'sentence-audio-v4-0101')
        self.assertEqual(value['batches'][-1]['packId'], 'sentence-audio-v4-0201')
        self.assertIsNone(value['batches'][0]['publication']['selectionProof'])
        self.assertEqual(value['batches'][2]['publication']['candidate'], reader.frames['.ci-publication/slice-0003/batch-frame.json']['publication']['candidate'])
        self.assertEqual([old['packId'] for old in value['legacyManifests']], ['sentence-audio-v1', 'sentence-audio-v2', 'sentence-audio-v3'])
        self.assertTrue(reader.checked)
        opened = [name for name, _, _ in reader.calls]
        self.assertNotIn('manifest.json', opened)
        self.assertNotIn('sources.manifest.json', opened)
        self.assertFalse(any(name.endswith(('.tar.gz', '.mp3', '.wav', '.onnx')) for name in opened))

    def test_missing_or_wrong_slice_never_emits_partial_inventory(self):
        reader = FakeReader()
        del reader.frames['.ci-publication/slice-0100/batch-frame.json']
        with self.assertRaises(KeyError):
            m.assemble(reader)
        reader = FakeReader()
        reader.frames['.ci-publication/slice-0100/batch-frame.json']['sliceNumber'] = 99
        with self.assertRaisesRegex(ValueError, 'all101_explicit_frames'):
            m.assemble(reader)

    def test_changed_archive_or_installer_is_not_hidden_by_mapping(self):
        value = frame(3, True)
        value['publication']['archive']['sha256'] = 'f' * 64
        value['publication']['installerCheck']['sha256'] = 'e' * 64
        result = m.checked_frame(value, 3)
        self.assertEqual(result['publication']['archive']['sha256'], 'f' * 64)
        self.assertEqual(result['publication']['installerCheck']['sha256'], 'e' * 64)
        self.assertNotEqual(result['publication']['archive'], result['publication']['candidate']['archive'])
        # The mapper preserves evidence; the independent finalizer decides it.
        self.assertNotIn('publicationAuthorized', result)

    def test_ambiguous_choice_missing_original_candidate_and_path_escape_rejected(self):
        for mutate in (
            lambda row: row['publication']['candidate'].pop('assembly'),
            lambda row: row['publication'].__setitem__('extra', {}),
            lambda row: row['generation']['sources'].__setitem__('fileName', '../outside.json'),
        ):
            value = frame(3, True)
            mutate(value)
            with self.assertRaises(ValueError):
                m.checked_frame(value, 3)
        value = frame(1)
        value['publication']['selectionProof'] = pin('implicit.json')
        with self.assertRaisesRegex(ValueError, 'implicit_choice'):
            m.checked_frame(value, 1)

    def test_actual_pin_hash_and_late_same_bytes_replacement(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            file = root / 'small.json'
            file.write_bytes(b'{}\n')
            reader = m.Reader(root)
            actual, value = reader.take('small.json', 1024, True)
            self.assertEqual(value, {})
            self.assertEqual(actual, pin('small.json'))
            with self.assertRaisesRegex(ValueError, 'pinned_metadata_mismatch'):
                reader.take('small.json', 1024, expected={**actual, 'sha256': 'f' * 64})
            replacement = root / 'replacement.json'
            replacement.write_bytes(b'{}\n')
            replacement.replace(file)
            with self.assertRaisesRegex(ValueError, 'final_input_identity_changed'):
                reader.unchanged()

    def test_duplicate_json_symlink_and_aggregate_input_bound(self):
        with self.assertRaisesRegex(ValueError, 'duplicate_json_key'):
            m.decode(b'{"same":1,"same":2}')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'small.json').write_bytes(b'{}\n')
            (root / 'alias.json').symlink_to(root / 'small.json')
            with self.assertRaisesRegex(ValueError, 'no_symlinks'):
                m.Reader(root).take('alias.json', 1024)
            reader = m.Reader(root)
            reader.total = 128 * m.MIB
            with self.assertRaisesRegex(ValueError, 'total_metadata_bounds'):
                reader.take('small.json', 1024)


if __name__ == '__main__':
    unittest.main()
