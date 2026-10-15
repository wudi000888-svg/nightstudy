#!/usr/bin/env python3
"""Source binding and resumable offline audio QA, with no model or network."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import sys
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


swac = load('swac_test', 'shtooka-recorded-pack.py')
sentence = load('sentence_test', 'sentence-audio-pack.py')
consolidate = load('consolidate_test', 'consolidate-audio-pack.py')


class OfflineSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nightstudy-audio-test-')
        self.root = Path(self.temporary.name)
        self.output = self.root / 'output'
        for directory in (self.output / 'files', self.output / 'licenses',
                          self.output / 'progress', self.output / 'converted'):
            directory.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        self.temporary.cleanup()

    def make_archive(self, text, accent='UK', region='London', author='Judith Franck'):
        filename = self.root / 'source.tar.xz'
        country = accent
        data = {
            'flac/index.tags.txt': (
                '# SWAC index\n[GLOBAL]\nSWAC_LANG=eng\n'
                f'SWAC_SPEAK_LANG_COUNTRY={country}\nSWAC_SPEAK_LANG_REGION={region}\n'
                f'SWAC_SPEAK_NAME={author}\nSWAC_COLL_AUTHORS={author}\n'
                f'[En-{accent.lower()}-plate.flac]\nSWAC_TEXT={text}\n'
            ).encode(),
            'flac/readme.txt': b'Original recording license notice',
            f'flac/En-{accent.lower()}-plate.flac': b'fLaC' + bytes(28),
        }
        with tarfile.open(filename, 'w:xz') as archive:
            for name, raw in data.items():
                info = tarfile.TarInfo(name)
                info.size = len(raw)
                archive.addfile(info, io.BytesIO(raw))
        return filename

    def test_spoken_article_is_never_removed_to_force_a_match(self):
        archive = self.make_archive('a plate')
        entries, _, _ = swac.archive_entries(archive, 'test', 'UK', {'plate'}, self.output, {})
        self.assertEqual(entries, [])
        entries, _, _ = swac.archive_entries(archive, 'test', 'UK', {'a plate'}, self.output, {})
        self.assertEqual(entries[0]['lemma'], 'a plate')
        self.assertEqual(entries[0]['canonicalWordEvidence']['SWAC_TEXT'], 'a plate')

    def test_unknown_british_region_cannot_be_labeled_uk(self):
        archive = self.make_archive('plate', region='unknown')
        with self.assertRaisesRegex(ValueError, 'british_region_unconfirmed'):
            swac.archive_entries(archive, 'test', 'UK', {'plate'}, self.output, {})

    def test_native_country_must_match_requested_accent(self):
        archive = self.make_archive('plate', accent='US', region='California')
        with self.assertRaisesRegex(ValueError, 'accent_binding_mismatch'):
            swac.archive_entries(archive, 'test', 'UK', {'plate'}, self.output, {})

    def test_release_source_archive_cannot_silently_change(self):
        archive = self.make_archive('plate')
        with self.assertRaisesRegex(ValueError, 'pinned_swac_archive_checksum_mismatch'):
            swac.validate_archive(archive, 'eng-balm-judith')

    def test_us_readme_alone_does_not_grant_a_per_file_license(self):
        archive = self.make_archive('plate', accent='US', region='California', author='Dvortygirl')
        entries, _, rejected = swac.archive_entries(archive, 'test', 'US', {'plate'}, self.output, {})
        self.assertEqual(entries, [])
        self.assertEqual(rejected, {'missing_matching_commons_license': 1})

    def test_mismatched_commons_author_or_word_is_rejected(self):
        archive = self.make_archive('plate', accent='US', region='California', author='Dvortygirl')
        for reference in ({'lemma': 'plate', 'sourceName': 'Other speaker'},
                          {'lemma': 'to plate', 'sourceName': 'Dvortygirl'}):
            with patch.object(swac.recorded, 'entry_from_page', return_value=reference):
                entries, _, _ = swac.archive_entries(
                    archive, 'test', 'US', {'plate'}, self.output,
                    {'File:En-us-plate.ogg': {'title': 'File:En-us-plate.ogg'}})
            self.assertEqual(entries, [])

    def test_filename_prefix_alone_does_not_prove_accent(self):
        page = {'title': 'File:En-us-plate.ogg', 'imageinfo': [{
            'url': 'https://upload.wikimedia.org/wikipedia/commons/0/00/test.ogg',
            'extmetadata': {'License': {'value': 'cc-by-sa-3.0'},
                            'Artist': {'value': 'Dvortygirl'}}}]}
        self.assertIsNone(swac.recorded.entry_from_page(page, 'US'))

    def test_synthetic_recording_cannot_be_labeled_human(self):
        page = {'title': 'File:En-us-plate.ogg', 'imageinfo': [{
            'extmetadata': {'License': {'value': 'cc-by-sa-3.0'},
                            'ImageDescription': {'value': 'US English pronunciation; synthesized'}}}]}
        self.assertIsNone(swac.recorded.entry_from_page(page, 'US'))

    def test_sentence_hash_normalizes_quotes_but_preserves_case(self):
        self.assertEqual(sentence.text_hash('  It’s　fine. '), sentence.text_hash("It's fine."))
        self.assertNotEqual(sentence.text_hash('US'), sentence.text_hash('us'))

    def test_public_sentence_collection_includes_original_seed_and_full_lessons(self):
        rows = sentence.collect(Path(__file__).resolve().parent.parent)
        self.assertEqual(len([row for row in rows if row.get('unit') == 'original-seed-example']), 40)
        self.assertEqual(len([row for row in rows if row.get('unit') == 'complete-lesson']), 6)
        self.assertEqual(len(rows), 8404)
        self.assertTrue(all(row['textHash'] == sentence.text_hash(row['text']) for row in rows))

    def test_sentence_audit_resumes_by_digest_without_trusting_identity(self):
        metrics = {'policyVersion': sentence.codec.QUALITY_POLICY['version']}
        entries = [{'fileSha256': 'a' * 64, 'textHash': 'one'},
                   {'fileSha256': 'a' * 64, 'textHash': 'two'}]
        with patch.object(sentence.codec, 'inspect_media', return_value=metrics) as inspect:
            self.assertEqual(len(sentence.audit_entries(entries, self.output, 2)), 2)
            self.assertEqual(inspect.call_count, 1)
            sentence.audit_entries(entries, self.output, 2)
            self.assertEqual(inspect.call_count, 1)
            sentence.audit_entries([{**entries[0], 'fileSha256': 'b' * 64}], self.output, 2)
            self.assertEqual(inspect.call_count, 2)

    def test_cached_sentence_media_keeps_bytes_but_refreshes_corrected_credits(self):
        source = sentence.pack.load_sources(sentence.pack.DEFAULT_VOICES_MANIFEST)['voices']['US']
        text = 'Rain falls softly.'
        row = {'textHash': sentence.text_hash(text), 'text': text}
        previous = {**row, 'accent': 'US', 'kind': 'synthesized', 'mimeType': 'audio/mpeg',
                    'fileSha256': 'c' * 64, 'fileKey': 'files/' + 'c' * 64 + '.mp3',
                    'cacheKey': sentence.pack.synthesis_identity(text, 'US', source),
                    'sourceName': 'Old credits', 'sourceUrl': 'https://example.invalid/old',
                    'license': 'Old statement', 'attribution': 'Old author statement'}
        (self.output / 'progress/US-0.jsonl').write_text(json.dumps(previous) + '\n')
        with patch.object(sentence.pack, 'make_voice', return_value=object()), \
                patch.object(sentence.pack, 'validate_entry', return_value=True), \
                patch.object(sentence.pack, 'synthesize_entry') as synthesize, \
                patch.object(sentence.codec, 'encode_mp3') as encode:
            entry = sentence.worker('US', [row], str(self.output), str(self.root / 'models'), 0)[0]
        synthesize.assert_not_called()
        encode.assert_not_called()
        self.assertEqual(entry['fileSha256'], previous['fileSha256'])
        self.assertEqual(entry['cacheKey'], previous['cacheKey'])
        for key in ('sourceName', 'sourceUrl', 'license', 'attribution'):
            self.assertEqual(entry[key], source[key])
        saved = json.loads((self.output / 'progress/US-0.jsonl').read_text().splitlines()[-1])
        self.assertEqual(saved['attribution'], source['attribution'])

    def test_cached_mp3_is_repaired_if_output_bytes_changed(self):
        source_root = self.root / 'source'
        (source_root / 'files').mkdir(parents=True)
        raw = b'ID3' + bytes(150)
        digest = hashlib.sha256(raw).hexdigest()
        key = f'files/{digest}.mp3'
        (source_root / key).write_bytes(raw)
        (self.output / key).write_bytes(b'corrupted existing output')
        entry = {'fileKey': key, 'fileSha256': digest, 'mimeType': 'audio/mpeg',
                 'kind': 'recorded', 'attribution': 'Original author'}
        with patch.object(consolidate.codec, 'inspect_media', return_value={'policyVersion': 1}):
            consolidate.materialize((entry, source_root), self.output)
        self.assertEqual((self.output / key).read_bytes(), raw)
        corrected = {**entry, 'attribution': 'Corrected author and license URL'}
        self.assertEqual(consolidate.materialize((corrected, source_root), self.output)['attribution'],
                         corrected['attribution'])

    def test_quality_failure_falls_back_without_hiding_rejected_source(self):
        preferred = {'lemma': 'plate', 'accent': 'US', 'fileSha256': 'a' * 64}
        fallback = {'lemma': 'plate', 'accent': 'US', 'fileSha256': 'b' * 64}
        with patch.object(consolidate, 'materialize', side_effect=[ValueError('silent'), fallback]):
            entry = consolidate.materialize_with_fallback(
                [(preferred, self.root), (fallback, self.root)], self.output)
        self.assertEqual(entry['fileSha256'], fallback['fileSha256'])
        self.assertEqual(entry['qualityFallbacks'], [{'sourceFileSha256': 'a' * 64, 'reason': 'silent'}])

    def test_recorded_choice_can_inherit_independent_ipa_without_changing_audio(self):
        entry = {'lemma': 'plate', 'accent': 'US', 'kind': 'recorded', 'fileSha256': 'a' * 64}
        previous = {'lemma': 'plate', 'accent': 'US', 'kind': 'synthesized',
                    'fileSha256': 'b' * 64, 'phonetic': '/pleɪt/',
                    'phoneticSource': 'Test algorithmic transcription',
                    'phoneticMethod': 'algorithmic', 'phoneticExpertValidated': False}
        merged = consolidate.inherit_phonetic_metadata(entry, [(previous, self.root)])
        self.assertEqual(merged['phonetic'], previous['phonetic'])
        self.assertEqual(merged['kind'], 'recorded')
        self.assertEqual(merged['fileSha256'], entry['fileSha256'])
        self.assertEqual(merged['phoneticMetadataReference']['fileSha256'], previous['fileSha256'])
        for changed in ({**previous, 'lemma': 'a plate'}, {**previous, 'accent': 'UK'}):
            with self.assertRaisesRegex(ValueError, 'phonetic_word_accent_binding_mismatch'):
                consolidate.inherit_phonetic_metadata(entry, [(changed, self.root)])

    def test_cache_only_never_writes_publishable_pack_or_loads_a_model(self):
        source_root = self.root / 'cache-input'
        source_root.mkdir()
        source_bytes = b'{"schemaVersion":2,"version":"word-audio-v2"}\n'
        (source_root / 'sources.manifest.json').write_bytes(source_bytes)
        manifest = source_root / 'manifest.json'
        manifest.write_text(json.dumps({'version': 'word-audio-v2', 'status': 'ready',
            'sourceManifestSha256': hashlib.sha256(source_bytes).hexdigest(),
            'entries': [{'lemma': 'plate', 'accent': 'US', 'kind': 'recorded', 'fileSha256': 'a' * 64}]}))
        output = self.root / 'cache-only-output'
        with patch.object(sys, 'argv', ['consolidate-audio-pack.py', '--input-manifest', str(manifest),
                                       '--output', str(output), '--workers', '2', '--cache-only']), \
                patch.object(consolidate, 'materialize_with_fallback', return_value={'lemma': 'plate'}), \
                patch.object(consolidate.codec, 'build_tool_identity', return_value={}), \
                patch.object(consolidate.pack, 'make_phonemizer') as phonemizer, \
                patch.object(consolidate.pack, 'make_voice') as make_voice:
            consolidate.main()
        phonemizer.assert_not_called()
        make_voice.assert_not_called()
        for filename in ('manifest.json', 'sources.manifest.json', 'quality-exclusions.json', 'licenses'):
            self.assertFalse((output / filename).exists(), filename)
        self.assertFalse((self.root / 'nightstudy-word-audio-v2.tar.gz').exists())
        self.assertFalse((self.root / 'word-audio-v2.pin.json').exists())


if __name__ == '__main__':
    unittest.main()
