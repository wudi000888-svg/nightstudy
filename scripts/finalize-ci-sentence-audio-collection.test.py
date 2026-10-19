"""Model-free publication closure regressions; run only in the cloud workflow."""
from pathlib import Path
import copy
import hashlib
import importlib.util
import json
import math
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('global_collection', Path(__file__).with_name('finalize-ci-sentence-audio-collection.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Pure:
    ACCENTS = ('US', 'UK')
    PUBLIC_SHA = 'a' * 64
    FINAL_SHA = 'b' * 64

    @staticmethod
    def need(ok, code):
        if not ok:
            raise ValueError(code)

    @staticmethod
    def sha(value):
        return hashlib.sha256(value.encode('utf-8') if isinstance(value, str) else value).hexdigest()

    @staticmethod
    def canonical(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)

    @staticmethod
    def digest(value):
        return isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)

    @staticmethod
    def relative(root, name):
        path = Path(name)
        Pure.need(not path.is_absolute() and '..' not in path.parts, 'test_relative_pin')
        return root / path


H = Pure()


def pin(name='source.json'):
    return dict(fileName=name, bytes=10, sha256='e' * 64)


class ClosureTests(unittest.TestCase):
    def test_cross_language_fixed_vectors_include_astral_key_sort(self):
        vectors = [
            (dict(count=1, label='例句', qualityMetrics=dict(clippedSampleFraction=0.0, rmsDbfs=-20.0)),
             '60035ee702c725f90e7ca517a119f3d08f73dd9403296cc20c7c35ef5a5c1815'),
            (0, 'af61886518b0ec1da50e0b7e877a7e02cc7173f0becd9a994e1e5e661a16e3ee'),
            (0.0, 'af61886518b0ec1da50e0b7e877a7e02cc7173f0becd9a994e1e5e661a16e3ee'),
            (-0.0, 'a0f0e77097840a798730ef59e0a808403d9af8c8e52af53e42eb5de98f301701'),
            ({'😀': 1, '\ue000': 2}, 'c13787df458c8c1cd4afa4224befbb30329708bd4d3e34ac84693f0e2d854547'),
        ]
        for value, expected in vectors:
            with self.subTest(value=value):
                self.assertEqual(MODULE.full_entry_sha(H, value), expected)

    def test_whole_record_hash_preserves_tags_boolean_and_nested_provenance(self):
        original = dict(qualityMetrics=dict(peak=0), source=dict(note=['number', '0000000000000000']))
        changed = copy.deepcopy(original)
        changed['source']['note'].append('unapproved')
        self.assertNotEqual(MODULE.full_entry_sha(H, original), MODULE.full_entry_sha(H, changed))
        self.assertNotEqual(MODULE.full_entry_sha(H, True), MODULE.full_entry_sha(H, 1))
        self.assertNotEqual(MODULE.full_entry_sha(H, 0), MODULE.full_entry_sha(H, ['number', '0000000000000000']))

    def test_nonfinite_unsafe_and_invalid_unicode_cannot_enter_choice(self):
        for value in (math.inf, -math.inf, math.nan, 2 ** 53, '\ud800', {'\ud800': 1}):
            with self.subTest(value=repr(value)), self.assertRaises((ValueError, UnicodeEncodeError)):
                MODULE.full_entry_sha(H, value)

    def test_deep_untrusted_entry_is_bounded(self):
        value = None
        for _ in range(130):
            value = [value]
        with self.assertRaisesRegex(ValueError, 'entry_hash_json_depth'):
            MODULE.full_entry_sha(H, value)

    def test_global_holds_are_not_multiplied_into_each_pack(self):
        a, b, outside = 'a' * 64, 'b' * 64, 'c' * 64
        request = dict(targets=[dict(textHash=a), dict(textHash=b)])
        holds = {(a, 'US'): {}, (outside, 'US'): {}, (outside, 'UK'): {}}
        stats = MODULE.coverage(request, {(a, 'UK'): {}, (b, 'US'): {}}, {(b, 'UK'): {}}, holds)
        self.assertEqual(stats, dict(requestedSentenceCount=2, requestedClipCount=4, generatedClipCount=2,
            reusedClipCount=1, fullyReusedSentenceCount=0, partiallyReusedSentenceCount=1,
            heldClipCount=1, heldSentenceCount=1, fullyHeldSentenceCount=0, eligibleClipCount=3))

    def test_duplicate_pair_is_not_silently_overwritten(self):
        row = dict(textHash='a' * 64, accent='US', fileSha256='b' * 64)
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            MODULE.unique_rows(H, [row, {**row, 'fileSha256': 'c' * 64}], 'duplicate')

    def test_mature_reuse_reference_retains_all_nine_fields(self):
        entry = dict(textHash='a' * 64, accent='UK', fileKey='files/test.mp3', fileSha256='b' * 64,
            mimeType='audio/mpeg', sizeBytes=100, kind='synthesized', cacheKey='c' * 64, qualityMetrics=dict(peak=40))
        baseline = dict(id='sentence-audio-v2', manifestSha256='d' * 64, sourceManifestSha256='e' * 64)
        result = MODULE.expected_reuse(dict(entry=entry, baseline=baseline))
        self.assertEqual(len(result), 9)
        self.assertEqual(result['baseline'], baseline)
        self.assertEqual(result['cacheKey'], entry['cacheKey'])
        self.assertNotIn('qualityMetrics', result)

    def choice_fixture(self):
        keys = [('a' * 64, 'US'), ('b' * 64, 'UK')]
        original = {key: dict(textHash=key[0], accent=key[1], qualityMetrics=dict(peak=30.0), fileSha256=str(i) * 64)
                    for i, key in enumerate(keys)}
        official = {keys[0]: dict(entry={**original[keys[0]], 'fileSha256': '9' * 64})}
        choice = dict(kind='nightstudy-ci-sentence-audio-publication-choice-v1', state='EXPLICIT_CURRENT_PUBLICATION_PARTITION',
            entryHashRecipe=MODULE.ENTRY_HASH_RECIPE, packId='sentence-audio-v4-0101', publicRootSha256=H.PUBLIC_SHA, finalPolicySha256=H.FINAL_SHA,
            request=pin(), independentCheck=pin(), candidate={name: pin() for name in ('descriptor', 'archive', 'manifest', 'sources', 'freshInstallerCheck')},
            legacyQualification=pin(), legacySelection=pin(),
            selectedFreshPairs=[dict(textHash=keys[1][0], accent=keys[1][1], originalGeneratedEntrySha256=MODULE.full_entry_sha(H, original[keys[1]]))],
            reusedOfficialPairs=[dict(textHash=keys[0][0], accent=keys[0][1], officialEntrySha256=MODULE.full_entry_sha(H, official[keys[0]]['entry']))],
            generatedNotSelectedPairs=[dict(textHash=keys[0][0], accent=keys[0][1], originalGeneratedEntrySha256=MODULE.full_entry_sha(H, original[keys[0]]))],
            generationProofUnchanged=True, publicationAuthorized=False)
        frame = dict(selectionProof=pin(), candidate={name: pin() for name in ('descriptor', 'archive', 'manifest', 'sources', 'installerCheck')})
        inv = dict(legacyQualification=dict(receipt=pin(), selection=pin()))
        return original, official, choice, frame, inv

    def validate(self, fixture):
        original, official, choice, frame, inv = fixture
        with patch.object(MODULE, 'entity', return_value=(choice, b'{}')):
            return MODULE.validate_choice(H, None, frame, inv, dict(packId=choice['packId']), pin(), pin(), {}, official, original)

    def test_publication_choice_uses_distinct_official_and_generated_whole_records(self):
        fixture = self.choice_fixture()
        self.assertEqual(self.validate(fixture), {('a' * 64, 'US')})
        fixture[2]['reusedOfficialPairs'][0]['officialEntrySha256'] = fixture[2]['generatedNotSelectedPairs'][0]['originalGeneratedEntrySha256']
        with self.assertRaisesRegex(ValueError, 'official_entry_digest'):
            self.validate(fixture)

    def test_missing_and_duplicate_partition_cannot_discard_generation(self):
        fixture = self.choice_fixture()
        fixture[2]['generatedNotSelectedPairs'] = []
        with self.assertRaisesRegex(ValueError, 'partition'):
            self.validate(fixture)
        fixture = self.choice_fixture()
        fixture[2]['selectedFreshPairs'] *= 2
        with self.assertRaisesRegex(ValueError, 'unique'):
            self.validate(fixture)

    def test_old_untyped_entry_hash_recipe_is_rejected(self):
        fixture = self.choice_fixture()
        fixture[2]['entryHashRecipe'] = 'canonical-json'
        with self.assertRaisesRegex(ValueError, 'explicit_publication_choice'):
            self.validate(fixture)

    def test_generation_identity_and_existing_quality_tolerance_are_preserved(self):
        key = ('a' * 64, 'US')
        voice = dict(model=dict(sha256='b' * 64), config=dict(sha256='c' * 64),
            sourceName='voice', sourceUrl='https://example.test/voice', license='MIT', attribution='Author')
        identity = dict(cacheKey='d' * 64, correctionSha256=None)
        expected = dict(identity=identity, target=dict(text='A complete current example.'), correction=None)
        media = dict(cacheKey=identity['cacheKey'], fileSha256='e' * 64, originalWavSha256='f' * 64,
            metrics=dict(rmsDbfs=-20.0, peak=40.0))
        entry = dict(textHash=key[0], accent=key[1], text=expected['target']['text'], lemma=expected['target']['text'],
            cacheKey=identity['cacheKey'], fileSha256=media['fileSha256'], originalFileSha256=media['originalWavSha256'],
            mimeType='audio/mpeg', fileKey='files/' + media['fileSha256'] + '.mp3', kind='synthesized', engineVersion='1.8.0',
            voiceModelSha256=voice['model']['sha256'], voiceConfigSha256=voice['config']['sha256'],
            qualityMetrics=dict(rmsDbfs=-19.999, peak=40.0), **{name: voice[name] for name in ('sourceName', 'sourceUrl', 'license', 'attribution')})
        MODULE.generated_entry(H, entry, expected, {'_media': {key: media}}, {'voices': {'US': voice}})
        changed = copy.deepcopy(entry)
        changed['qualityMetrics']['rmsDbfs'] = -19.997
        with self.assertRaisesRegex(ValueError, 'original_independent_tolerances'):
            MODULE.generated_entry(H, changed, expected, {'_media': {key: media}}, {'voices': {'US': voice}})
        changed = dict(entry, originalFileSha256='1' * 64)
        with self.assertRaisesRegex(ValueError, 'actual_checked_media'):
            MODULE.generated_entry(H, changed, expected, {'_media': {key: media}}, {'voices': {'US': voice}})

    def test_entry_count_and_unique_physical_asset_count_are_distinct(self):
        frame = {name: pin(name + '.json') for name in ('descriptor', 'archive', 'manifest', 'sources')}
        descriptor = dict(id='sentence-audio-v4-0101')
        receipt = dict(kind='nightstudy-ci-sentence-audio-installer-check-v1', state='VERIFIED_EXTRACTED_PACK_ONLY',
            checkerSourceSha256=MODULE.FRESH_INSTALLER_SHA, packId=descriptor['id'], requestSha256=pin()['sha256'],
            independentCheckSha256=pin()['sha256'], descriptorSha256=frame['descriptor']['sha256'],
            archiveSha256=frame['archive']['sha256'], archiveBytes=frame['archive']['bytes'],
            manifestSha256=frame['manifest']['sha256'], sourceManifestSha256=frame['sources']['sha256'],
            globalHoldCount=79, globalHoldsSha256=MODULE.HOLD_SHA, uniqueMp3Files=1, comparedEntries=2,
            maturePinnedEntryCheckPassed=True, matureHoldPackCheckPassed=True, exactMp3OnlyFileClosure=True,
            publicationAuthorized=False, databaseUsed=False, modelsUsed=False, audioDecodedHere=False,
            helperSourceSha256=MODULE.INSTALLER_HELPERS)
        MODULE.proof_receipt(H, receipt, MODULE.FRESH_INSTALLER_SHA, descriptor, frame, pin(), pin(), 2, 0, 1)
        with self.assertRaisesRegex(ValueError, 'independent_installer_receipt'):
            MODULE.proof_receipt(H, dict(receipt, uniqueMp3Files=2), MODULE.FRESH_INSTALLER_SHA,
                descriptor, frame, pin(), pin(), 2, 0, 1)

    def test_fresh_output_never_replaces_an_existing_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'receipt.json'
            result = MODULE.write_bytes(H, file, b'{}\n')
            self.assertEqual(result['sha256'], H.sha(b'{}\n'))
            with self.assertRaisesRegex(ValueError, 'fresh_bounded_global_output'):
                MODULE.write_bytes(H, file, b'{"changed":true}\n')
            self.assertEqual(file.read_bytes(), b'{}\n')


if __name__ == '__main__':
    unittest.main()
