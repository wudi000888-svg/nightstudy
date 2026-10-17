"""Pinned text/meaning/audio boundaries, without a network or voice model."""
import copy
import argparse
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('atomic_audio', Path(__file__).with_name('learning-senses-audio.py'))
audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audio)


class MeaningSentenceAudioBoundaries(unittest.TestCase):
    def test_sentence_shards_are_disjoint_exhaustive_and_keep_references_together(self):
        rows = [{'textHash': hashlib.sha256(str(i).encode()).hexdigest(),
                 'references': [{'wordId': 'a'}, {'wordId': 'b'}]} for i in range(101)]
        partitions = [audio.sentence_shard(rows, i, 7) for i in range(7)]
        self.assertEqual({row['textHash'] for part in partitions for row in part},
                         {row['textHash'] for row in rows})
        self.assertEqual(sum(map(len, partitions)), len(rows))
        self.assertTrue(all(len(row['references']) == 2 for part in partitions for row in part))
        self.assertEqual(audio.sentence_shard(rows, 0, 1), rows)
        for index, count in [(-1, 2), (2, 2), (0, 0), (0, 1001)]:
            with self.assertRaisesRegex(ValueError, 'invalid_sentence_shard'):
                audio.sentence_shard(rows, index, count)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nightstudy-meaning-audio-test-')
        self.root = Path(self.temporary.name)
        self.row = {'wordId': 'word-bank', 'senses': [{'id': 'bank-finance', 'wordId': 'word-bank', 'status': 'published',
            'contentVersion': 'test-v1', 'examples': [{'id': 'example-bank-account',
                'learningSenseId': 'bank-finance', 'wordId': 'word-bank', 'status': 'published', 'contentVersion': 'test-v1',
                'contextLabel': '办理账户', 'exampleEn': 'I opened an account at the bank.',
                'exampleZh': '我在银行开了账户。', 'contentMetadata': {'source': 'Original test sentence'}}]}]}

    def tearDown(self):
        self.temporary.cleanup()

    def pinned(self, rows=None):
        raw = ('\n'.join(json.dumps(row, ensure_ascii=False) for row in (rows or [self.row]))+'\n').encode()
        packed = gzip.compress(raw, mtime=0)
        content = self.root/'content.jsonl.gz'
        content.write_bytes(packed)
        manifest = self.root/'manifest.json'
        manifest.write_text(json.dumps({'id': 'test-v1', 'bytes': len(packed),
            'sha256': hashlib.sha256(packed).hexdigest(), 'jsonlSha256': hashlib.sha256(raw).hexdigest()}))
        return manifest, content

    def test_public_audio_input_keeps_explicit_meaning_and_example_evidence(self):
        manifest, content = self.pinned()
        _, rows = audio.collect(manifest, content)
        self.assertEqual(rows[0]['references'][0]['learningSenseId'], 'bank-finance')
        self.assertEqual(rows[0]['references'][0]['exampleId'], 'example-bank-account')
        self.assertEqual(rows[0]['text'], self.row['senses'][0]['examples'][0]['exampleEn'])
        self.assertNotIn('definitionZh', rows[0])

    def source_addition_fixture(self):
        spec = importlib.util.spec_from_file_location('audio_source_fixture_compiler', Path(__file__).with_name('learning-senses-compile.py'))
        compiler = importlib.util.module_from_spec(spec); spec.loader.exec_module(compiler)
        source = compiler.original_source_addition({'id': 'word-bank', 'normalizedLemma': 'bank'},
            'finance', 'n.', '银行；提供金融服务的机构', 'An institution providing financial services.',
            'Original test source for exact meaning binding; no external certification claim.')
        row = copy.deepcopy(self.row); row['normalizedLemma'] = 'bank'
        row['senses'][0]['sourceBindings'] = [{'sourceSenseId': source['id'], 'wordId': 'word-bank',
            'sourcePosSha256': compiler.sha(source['pos']),
            'sourceDefinitionZhSha256': compiler.sha(source['definitionZh']),
            'sourceDefinitionEnSha256': compiler.sha(source['definitionEn'])}]
        file, content = self.pinned([row]); manifest = json.loads(file.read_text())
        raw = (json.dumps(source, ensure_ascii=False)+'\n').encode(); packed = gzip.compress(raw, mtime=0)
        side = self.root/'learning-sense-sources-test.jsonl.gz'; side.write_bytes(packed)
        manifest['sourceAdditions'] = {'fileName': side.name, 'bytes': len(packed),
            'sha256': hashlib.sha256(packed).hexdigest(), 'jsonlSha256': hashlib.sha256(raw).hexdigest(), 'rowCount': 1}
        file.write_text(json.dumps(manifest)); return file, content, side, manifest, row, raw

    def test_original_source_sidecar_is_pinned_bound_and_included_in_decoded_budget(self):
        file, content, side, manifest, row, raw = self.source_addition_fixture()
        _, sentences = audio.collect(file, content)
        self.assertEqual(len(sentences), 1)
        budget = [len(gzip.decompress(content.read_bytes()))+len(raw)-1]
        with self.assertRaisesRegex(ValueError, 'meaning_collection_expanded_limit'):
            audio.leaf_words(file, manifest, content, budget)
        side.write_bytes(side.read_bytes()+b'changed')
        with self.assertRaisesRegex(ValueError, 'meaning_source_additions_pin_mismatch'):
            audio.collect(file, content)

    def test_original_source_pin_cannot_be_removed_or_point_to_another_path(self):
        file, content, _, manifest, _, _ = self.source_addition_fixture()
        missing = copy.deepcopy(manifest); del missing['sourceAdditions']; file.write_text(json.dumps(missing))
        with self.assertRaisesRegex(ValueError, 'meaning_source_additions_pin_required'):
            audio.collect(file, content)
        manifest['sourceAdditions']['fileName'] = '../outside.jsonl.gz'; file.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'meaning_source_additions_pin_invalid'):
            audio.collect(file, content)

    def test_original_source_sidecar_count_decoded_digest_and_binding_drift_rejected(self):
        for field, value, error in [('rowCount', 2, 'count_or_identity'), ('jsonlSha256', '0'*64, 'jsonl_mismatch')]:
            file, content, _, manifest, _, _ = self.source_addition_fixture()
            manifest['sourceAdditions'][field] = value; file.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'meaning_source_additions_'+error): audio.collect(file, content)
        file, content, _, manifest, row, _ = self.source_addition_fixture()
        row['senses'][0]['sourceBindings'][0]['sourceDefinitionEnSha256'] = '0'*64
        raw = (json.dumps(row, ensure_ascii=False)+'\n').encode(); packed = gzip.compress(raw, mtime=0)
        content.write_bytes(packed); manifest.update(bytes=len(packed), sha256=hashlib.sha256(packed).hexdigest(), jsonlSha256=hashlib.sha256(raw).hexdigest()); file.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'meaning_source_additions_binding_mismatch'): audio.collect(file, content)

    def test_changed_compressed_bytes_or_decoded_pin_are_rejected(self):
        manifest, content = self.pinned()
        content.write_bytes(content.read_bytes()+b'changed')
        with self.assertRaisesRegex(ValueError, 'meaning_content_pin_mismatch'):
            audio.collect(manifest, content)
        manifest, content = self.pinned()
        pin = json.loads(manifest.read_text()); pin['jsonlSha256'] = '0'*64
        manifest.write_text(json.dumps(pin))
        with self.assertRaisesRegex(ValueError, 'meaning_content_jsonl_mismatch'):
            audio.collect(manifest, content)

    def test_candidate_cross_meaning_version_or_missing_translation_cannot_generate(self):
        for field, value in [('status', 'candidate'), ('wordId', 'other-word'), ('learningSenseId', 'bank-river'),
                             ('contentVersion', 'old-version'), ('exampleZh', ''),
                             ('contextLabel', ' '), ('exampleEn', '')]:
            with self.subTest(field=field):
                row = copy.deepcopy(self.row)
                row['senses'][0]['examples'][0][field] = value
                manifest, content = self.pinned([row])
                with self.assertRaisesRegex(ValueError, 'unpublished_or_unbound_sentence'):
                    audio.collect(manifest, content)

    def test_identical_audio_text_deduplicates_bytes_but_keeps_each_meaning_reference(self):
        second = copy.deepcopy(self.row)
        second['wordId'] = 'word-account'
        second['senses'][0]['wordId'] = 'word-account'
        second['senses'][0]['id'] = 'account-finance'
        second['senses'][0]['examples'][0].update(id='example-account-bank', learningSenseId='account-finance', wordId='word-account')
        manifest, content = self.pinned([self.row, second])
        _, rows = audio.collect(manifest, content)
        self.assertEqual(len(rows), 1)
        self.assertEqual({ref['exampleId'] for ref in rows[0]['references']},
                         {'example-bank-account', 'example-account-bank'})

    def test_missing_external_mount_is_rejected_before_directory_creation(self):
        with patch.object(Path, 'is_mount', return_value=False), patch.object(Path, 'mkdir') as mkdir:
            with self.assertRaisesRegex(ValueError, 'external_disk_not_mounted'):
                audio.external('/Volumes/XXX/Codex/work/audio-boundary-test', True)
            mkdir.assert_not_called()

    def baseline(self, version='sentence-audio-v3', accents=('US', 'UK')):
        directory = self.root/version
        (directory/'files').mkdir(parents=True, exist_ok=True)
        module = audio.pipeline_module()
        text = self.row['senses'][0]['examples'][0]['exampleEn']
        raw = b'ID3' + b'baseline audio bytes'*10
        digest = hashlib.sha256(raw).hexdigest()
        key = f'files/{digest}.mp3'
        (directory/key).write_bytes(raw)
        entries = [{'text': text, 'textHash': module.text_hash(text), 'accent': accent,
                    'fileKey': key, 'fileSha256': digest, 'sizeBytes': len(raw),
                    'mimeType': 'audio/mpeg', 'kind': 'synthesized',
                    'cacheKey': f'{accent}-test-cache'} for accent in accents]
        source = directory/'sources.manifest.json'
        source.write_text(json.dumps({'version': version, 'source': 'Public test originals'}))
        built = {'version': version, 'status': 'ready', 'entries': entries,
                 'sourceManifestSha256': audio.digest(source)}
        manifest = directory/'manifest.json'
        manifest.write_text(json.dumps(built))
        data = self.root/'data'; data.mkdir(exist_ok=True)
        (data/audio.BASELINE_PINS.get(version, version+'.manifest.json')).write_text(json.dumps({
            'id': version, 'version': version, 'manifestSha256': audio.digest(manifest),
            'sourceManifestSha256': audio.digest(source)}))
        return manifest, entries, module

    def collection(self):
        pins, union = [], []
        for name, lemma in [('a', 'bank'), ('b', 'account')]:
            row = copy.deepcopy(self.row)
            row['wordId'] = 'word-'+name; row['normalizedLemma'] = lemma
            row['senses'][0].update(id='sense-'+name, wordId=row['wordId'], sourceBindings=[])
            row['senses'][0]['examples'][0].update(id='example-'+name, wordId=row['wordId'],
                                                  learningSenseId='sense-'+name)
            union.append({'wordId': row['wordId'], 'normalizedLemma': lemma})
            manifest, content = self.pinned([row])
            content_name = f'learning-senses-test-{name}.jsonl.gz'
            content.rename(self.root/content_name)
            shard = json.loads(manifest.read_text())
            shard.update(formatVersion=1, id='learning-senses-test-'+name, fileName=content_name,
                         wordCount=1, senseCount=1, exampleCount=1,
                         sourceExportSha256='a'*64, bilingualOverlaySha256='b'*64)
            shard_file = self.root/f'learning-senses-test-{name}.manifest.json'
            shard_file.write_text(json.dumps(shard))
            pins.append({'manifestFileName': shard_file.name, 'bytes': shard_file.stat().st_size,
                         'sha256': audio.digest(shard_file), 'id': shard['id'],
                         'wordCount': 1, 'senseCount': 1, 'exampleCount': 1})
        manifest = self.root/'learning-senses-collection-test.manifest.json'
        manifest.write_text(json.dumps({'formatVersion': 2, 'kind': 'learning-senses-collection',
            'id': 'learning-senses-collection-test', 'version': 'test', 'shards': pins,
            'wordCount': 2, 'requiredWordCount': 2, 'senseCount': 2, 'exampleCount': 2,
            'sourceExportSha256': 'a'*64, 'bilingualOverlaySha256': 'b'*64,
            'requiredWordsSha256': hashlib.sha256(json.dumps(union, ensure_ascii=False,
                sort_keys=True, separators=(',', ':')).encode()).hexdigest()}))
        return manifest

    def test_collection_recursively_pins_all_leaf_content_and_retains_shared_audio_references(self):
        manifest_file = self.collection()
        manifest, rows = audio.collect(manifest_file)
        self.assertEqual(manifest['sha256'], audio.digest(manifest_file))
        self.assertEqual(manifest['_audioIdentityKind'], 'collection-manifest-sha256')
        self.assertEqual(len(rows), 1)
        self.assertEqual({ref['wordId'] for ref in rows[0]['references']}, {'word-a', 'word-b'})

    def test_collection_has_a_total_decoded_budget_and_rejects_false_pin_totals(self):
        manifest_file = self.collection()
        with patch.object(audio, 'COLLECTION_MAX_DECODED_BYTES', 1):
            with self.assertRaisesRegex(ValueError, 'meaning_collection_expanded_limit'):
                audio.collect(manifest_file)
        manifest = json.loads(manifest_file.read_text())
        manifest['senseCount'] += 1
        manifest_file.write_text(json.dumps(manifest))
        with patch.object(audio, 'leaf_words', side_effect=AssertionError('must reject before decode')):
            with self.assertRaisesRegex(ValueError, 'meaning_collection_pin_totals_mismatch'):
                audio.collect(manifest_file)

    def test_collection_shard_manifest_payload_and_union_tampering_are_rejected(self):
        for target, expected in [('manifest', 'meaning_shard_manifest_pin_mismatch'),
                                 ('payload', 'meaning_content_pin_mismatch'),
                                 ('union', 'meaning_collection_union_mismatch')]:
            with self.subTest(target=target):
                manifest_file = self.collection()
                manifest = json.loads(manifest_file.read_text())
                if target == 'manifest':
                    file = self.root/manifest['shards'][0]['manifestFileName']
                    file.write_bytes(file.read_bytes()+b' ')
                elif target == 'payload':
                    file = self.root/'learning-senses-test-a.jsonl.gz'
                    file.write_bytes(file.read_bytes()+b'changed')
                else:
                    manifest['requiredWordsSha256'] = '0'*64
                    manifest_file.write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, expected):
                    audio.collect(manifest_file)

    def test_pack_ids_are_fixed_bounded_and_never_floating_aliases(self):
        for value in ['sentence-audio-v3', 'sentence-audio-v4', 'sentence-audio-v4-0001', 'sentence-audio-v4-9999']:
            self.assertEqual(audio.pack_id(value), value)
        for value in ['sentence-audio-v4-0000', 'sentence-audio-v4-1', 'latest', '../sentence-audio-v4',
                      'sentence-audio-v4-10000', 'sentence-audio-v5']:
            with self.assertRaises(argparse.ArgumentTypeError):
                audio.pack_id(value)

    def test_a_fixed_v4_shard_can_be_reused_only_via_its_repository_pin(self):
        baseline, _, module = self.baseline(version='sentence-audio-v4-0001')
        with patch.object(audio, 'REPO', self.root):
            pairs, baselines = audio.load_incremental_baselines([baseline], module)
        self.assertEqual(len(pairs), 2)
        self.assertEqual(baselines[0]['id'], 'sentence-audio-v4-0001')

    def test_reviewed_pronunciation_replaces_uncorrected_synthetic_reuse_per_accent(self):
        baseline, _, module = self.baseline()
        with patch.object(audio, 'REPO', self.root):
            pairs, _ = audio.load_incremental_baselines([baseline], module)
        file, content = self.pinned()
        _, rows = audio.collect(file, content)
        rows[0]['pronunciationCorrections'] = {'US': {'sha256': 'f'*64}}
        pending, _, _, coverage = audio.incremental_scope(rows, pairs, module)
        self.assertEqual((len(pending['US']), len(pending['UK'])), (1, 0))
        self.assertEqual(coverage['reusedClipCount'], 1)
        old = pairs[(rows[0]['textHash'], 'US')][0]
        old['pronunciationCorrectionSha256'] = 'f'*64
        pending, _, _, coverage = audio.incremental_scope(rows, pairs, module)
        self.assertEqual(coverage['reusedClipCount'], 2)
        self.assertFalse(pending['US'])
        old['pronunciationCorrectionSha256'] = 'a'*64
        old['kind'] = 'recorded'
        pending, _, _, coverage = audio.incremental_scope(rows, pairs, module)
        self.assertEqual(coverage['reusedClipCount'], 2)
        self.assertFalse(pending['US'])

    def test_immutable_delta_metadata_and_archive_never_replace_different_bytes(self):
        module = audio.pipeline_module()
        metadata = self.root/'immutable.json'
        audio.write_build_json(module, metadata, {'version': 'sentence-audio-v4-0001'}, True)
        before = metadata.read_bytes()
        audio.write_build_json(module, metadata, {'version': 'sentence-audio-v4-0001'}, True)
        with self.assertRaisesRegex(ValueError, 'immutable_audio_json_conflict'):
            audio.write_build_json(module, metadata, {'version': 'sentence-audio-v4-0002'}, True)
        self.assertEqual(metadata.read_bytes(), before)
        output = self.root/'archive'; output.mkdir()
        asset = output/'example.txt'; asset.write_text('original artifact')
        archive = self.root/'fixed.tar.gz'
        audio.build_archive([asset], output, archive, True)
        before = archive.read_bytes()
        audio.build_archive([asset], output, archive, True)
        asset.write_text('changed artifact')
        with self.assertRaisesRegex(ValueError, 'immutable_audio_archive_conflict'):
            audio.build_archive([asset], output, archive, True)
        self.assertEqual(archive.read_bytes(), before)
        self.assertEqual(list(self.root.glob('.audio-shard-*')), [])

    def test_pinned_v3_reuses_both_accents_and_preserves_baseline_proof(self):
        baseline, entries, module = self.baseline()
        manifest, content = self.pinned()
        _, rows = audio.collect(manifest, content)
        with patch.object(audio, 'REPO', self.root):
            pairs, baselines = audio.load_incremental_baselines([baseline], module)
        pending, reused, media, coverage = audio.incremental_scope(rows, pairs, module)
        self.assertEqual(pending, {'US': [], 'UK': []})
        self.assertEqual(len(reused), 1)
        self.assertEqual({entry['accent'] for entry in media}, {'US', 'UK'})
        self.assertTrue(all(entry['baseline'] == baselines[0] for entry in media))
        self.assertEqual({entry['fileSha256'] for entry in media}, {entries[0]['fileSha256']})
        self.assertEqual(coverage, {'requestedSentenceCount': 1, 'requestedClipCount': 2,
            'reusedClipCount': 2, 'generatedClipCount': 0,
            'fullyReusedSentenceCount': 1, 'partiallyReusedSentenceCount': 0})

    def test_a_single_existing_accent_only_generates_the_missing_accent(self):
        baseline, _, module = self.baseline(accents=('US',))
        manifest, content = self.pinned()
        _, rows = audio.collect(manifest, content)
        with patch.object(audio, 'REPO', self.root):
            pairs, _ = audio.load_incremental_baselines([baseline], module)
        pending, _, media, coverage = audio.incremental_scope(rows, pairs, module)
        self.assertEqual(pending, {'US': [], 'UK': rows})
        self.assertEqual([item['accent'] for item in media], ['US'])
        self.assertEqual(coverage['partiallyReusedSentenceCount'], 1)
        self.assertEqual(coverage['generatedClipCount'], 1)

    def publication_hold(self, rows, accent='UK'):
        module = audio.publication_holds_module()
        rows[0]['references'][0].update(learningSenseId='learning-sense-'+'a'*64,
                                         exampleId='sense-example-'+'b'*64)
        text, text_hash = rows[0]['text'], rows[0]['textHash']
        entry = {'id': 'sentence-audio-hold-'+module.sha(text_hash+'\0'+accent),
            'text': text, 'textHash': text_hash, 'accent': accent,
            'learningSenseId': rows[0]['references'][0]['learningSenseId'],
            'exampleId': rows[0]['references'][0]['exampleId'],
            'riskCategory': 'insufficient-regional-evidence',
            'review': {'reviewer': 'Codex', 'decision': 'hold', 'expertCertified': False,
                       'reason': 'Regional POS evidence remains unresolved; not every uncertain clip is proved wrong.'}}
        file = self.root/'publication-holds.json'
        file.write_text(json.dumps({'formatVersion': 1, 'id': module.POLICY_ID,
                                    'entries': [entry]}))
        active, pin = module.load_holds(file, audio.digest(file), rows)
        return active, pin, file

    def test_exact_hold_precedes_even_recorded_baseline_reuse_and_keeps_other_accent(self):
        baseline, _, module = self.baseline()
        file, content = self.pinned()
        _, rows = audio.collect(file, content)
        active, _, _ = self.publication_hold(rows)
        with patch.object(audio, 'REPO', self.root):
            pairs, _ = audio.load_incremental_baselines([baseline], module)
        blocked = pairs[(rows[0]['textHash'], 'UK')][0]
        blocked['kind'] = 'recorded'
        # A held pair must not even consult its corrupt cached/baseline bytes.
        blocked['fileKey'] = 'files/held-should-never-be-read.mp3'
        with patch.object(module.pack, 'validate_entry', return_value=True) as checked:
            pending, reused, media, coverage = audio.incremental_scope(rows, pairs, module, active)
        self.assertEqual(checked.call_count, 1)
        self.assertEqual(pending, {'US': [], 'UK': []})
        self.assertEqual([entry['accent'] for entry in media], ['US'])
        self.assertEqual(len(reused[0]['references']), len(rows[0]['references']))
        self.assertEqual(coverage['heldClipCount'], 1)
        self.assertEqual(coverage['heldSentenceCount'], 1)
        self.assertEqual(coverage['fullyHeldSentenceCount'], 0)
        self.assertEqual(coverage['eligibleClipCount'], 1)
        self.assertEqual(coverage['requestedClipCount'], coverage['heldClipCount']+
                         coverage['reusedClipCount']+coverage['generatedClipCount'])

    def test_held_missing_accent_is_not_sent_to_generation_or_journal_cache(self):
        module = audio.pipeline_module()
        file, content = self.pinned()
        _, rows = audio.collect(file, content)
        active, _, _ = self.publication_hold(rows, 'UK')
        pending, _, media, coverage = audio.incremental_scope(rows, {}, module, active)
        self.assertEqual(pending, {'US': rows, 'UK': []})
        self.assertEqual(media, [])
        self.assertEqual(coverage['generatedClipCount'], 1)
        self.assertEqual(coverage['heldClipCount'], 1)
        active[(rows[0]['textHash'], 'US')] = {'id': 'second-test-hold'}
        pending, _, _, coverage = audio.incremental_scope(rows, {}, module, active)
        self.assertEqual(pending, {'US': [], 'UK': []})
        self.assertEqual(coverage['fullyHeldSentenceCount'], 1)
        self.assertEqual(coverage['eligibleClipCount'], 0)

    def test_other_shards_holds_do_not_inflate_current_coverage(self):
        module = audio.pipeline_module()
        file, content = self.pinned()
        _, rows = audio.collect(file, content)
        pending, _, _, coverage = audio.incremental_scope(rows, {}, module,
            {('0'*64, 'UK'): {'id': 'out-of-shard'}})
        self.assertEqual(pending, {'US': rows, 'UK': rows})
        self.assertEqual(coverage['heldClipCount'], 0)
        self.assertEqual(coverage['eligibleClipCount'], 2)

    def test_existing_fixed_output_rejects_a_changed_hold_scope_before_sidecar_write(self):
        output = self.root/'fixed-output'; output.mkdir()
        (output/'manifest.json').write_text('{}')
        (output/'sources.manifest.json').write_text('{}')
        pin = {'fileName': 'holds.json', 'sha256': 'a'*64, 'bytes': 123,
               'holdCount': 1, 'appliedClipCount': 1}
        before = {file.name: file.read_bytes() for file in output.iterdir()}
        with self.assertRaisesRegex(ValueError, 'existing_audio_output_hold_scope_mismatch'):
            audio.check_existing_hold_scope(output, pin)
        self.assertEqual(before, {file.name: file.read_bytes() for file in output.iterdir()})
        expected = {**pin, 'sourceFileName': pin['fileName'], 'fileName': 'pronunciation-holds.json'}
        (output/'sources.manifest.json').write_text(json.dumps({'pronunciationHolds': expected}))
        audio.check_existing_hold_scope(output, pin)
        with self.assertRaisesRegex(ValueError, 'existing_audio_output_hold_scope_mismatch'):
            audio.check_existing_hold_scope(output, None)

    def test_hold_plan_checks_references_even_when_all_audio_was_already_reused(self):
        baseline, _, module = self.baseline()
        manifest, content = self.pinned()
        _, rows = audio.collect(manifest, content)
        _, pin, file = self.publication_hold(rows)
        output = self.root/'held-plan'; output.mkdir()
        argv = ['learning-senses-audio.py', '--manifest', str(manifest), '--content', str(content),
            '--output', str(output), '--model-dir', str(self.root/'unused-models'),
            '--baseline-manifest', str(baseline), '--pack-id', 'sentence-audio-v4', '--plan-only',
            '--pronunciation-holds', str(file), '--pronunciation-holds-sha256', pin['sha256'],
            '--release-url', 'https://github.com/wudi000888-svg/nightstudy/releases/download/v-test']
        # The policy targets different sense/example IDs from the content. It
        # cannot be ignored just because no worker would have been required.
        with patch.object(audio, 'REPO', self.root), patch.object(sys, 'argv', argv), \
                patch.object(audio, 'pipeline_module', return_value=module), \
                patch.object(audio, 'external', side_effect=lambda directory, create=False: Path(directory).resolve()), \
                patch.object(audio.concurrent.futures, 'ProcessPoolExecutor') as pool:
            with self.assertRaisesRegex(ValueError, 'pronunciation_holds_meaning_mismatch'):
                audio.main()
        pool.assert_not_called()
        self.assertFalse((output/'manifest.json').exists())

    def test_v3_explicit_hold_is_rejected_without_workers_or_output_metadata(self):
        manifest, content = self.pinned()
        output = self.root/'v3-held'; output.mkdir()
        argv = ['learning-senses-audio.py', '--manifest', str(manifest), '--content', str(content),
            '--output', str(output), '--model-dir', str(self.root/'unused-models'),
            '--pronunciation-holds', str(self.root/'unused-policy.json'),
            '--pronunciation-holds-sha256', 'a'*64,
            '--release-url', 'https://github.com/wudi000888-svg/nightstudy/releases/download/v-test']
        with patch.object(sys, 'argv', argv), \
                patch.object(audio, 'external', side_effect=lambda directory, create=False: Path(directory).resolve()), \
                patch.object(audio.concurrent.futures, 'ProcessPoolExecutor') as pool:
            with self.assertRaisesRegex(ValueError, 'incremental_pack_required_for_pronunciation_holds'):
                audio.main()
        pool.assert_not_called()
        self.assertFalse((output/'sources.manifest.json').exists())

    def test_all_held_or_reused_plan_reports_exact_gap_and_nonplan_has_no_empty_archive(self):
        baseline, _, module = self.baseline()
        manifest_file, content = self.pinned()
        manifest, rows = audio.collect(manifest_file, content)
        _, pin, file = self.publication_hold(rows)
        output = self.root/'hold-only'; output.mkdir()
        argv = ['learning-senses-audio.py', '--manifest', str(manifest_file),
            '--output', str(output), '--model-dir', str(self.root/'unused-models'),
            '--baseline-manifest', str(baseline), '--pack-id', 'sentence-audio-v4',
            '--pronunciation-holds', str(file), '--pronunciation-holds-sha256', pin['sha256'],
            '--release-url', 'https://github.com/wudi000888-svg/nightstudy/releases/download/v-test']
        captured = io.StringIO()
        with patch.object(audio, 'REPO', self.root), \
                patch.object(audio, 'collect', return_value=(manifest, rows)), \
                patch.object(audio, 'pipeline_module', return_value=module), \
                patch.object(audio, 'external', side_effect=lambda directory, create=False: Path(directory).resolve()), \
                patch.object(audio.concurrent.futures, 'ProcessPoolExecutor') as pool:
            with patch.object(sys, 'argv', [*argv, '--plan-only']), contextlib.redirect_stdout(captured):
                audio.main()
            with patch.object(sys, 'argv', argv), self.assertRaisesRegex(
                    ValueError, 'no_audio_delta_with_publication_holds'):
                audio.main()
        pool.assert_not_called()
        plan = json.loads(captured.getvalue())
        self.assertEqual(plan['coverage']['heldClipCount'], 1)
        self.assertEqual(plan['coverage']['reusedClipCount'], 1)
        self.assertEqual(plan['coverage']['generatedClipCount'], 0)
        self.assertEqual(plan['pronunciationHolds']['sha256'], pin['sha256'])
        self.assertFalse((output/'manifest.json').exists())
        self.assertFalse((output/'pronunciation-holds.json').exists())
        self.assertFalse((self.root/'nightstudy-sentence-audio-v4.tar.gz').exists())

    def test_generated_delta_archives_exact_hold_pin_and_keeps_all_content_references(self):
        baseline, entries, module = self.baseline(accents=('UK',))
        manifest_file, content = self.pinned()
        manifest, rows = audio.collect(manifest_file, content)
        _, hold_pin, file = self.publication_hold(rows, 'UK')
        raw_hold = file.read_bytes()
        output = self.root/'generated-with-hold'; output.mkdir()
        (self.root/'LICENSE').write_text('Original test content license\n')
        calls = []

        def synthesize(accent, assigned, output_string, model_string, shard):
            calls.append((accent, len(assigned)))
            entry = {**entries[0], 'accent': accent, 'cacheKey': accent+'-new-cache'}
            target = Path(output_string)
            (target/'files').mkdir(exist_ok=True)
            (target/entry['fileKey']).write_bytes((baseline.parent/entry['fileKey']).read_bytes())
            return [entry]

        class InlinePool:
            def __init__(self, **kwargs):
                pass
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def submit(self, fn, *args):
                return SimpleNamespace(result=lambda: synthesize(*args))

        argv = ['learning-senses-audio.py', '--manifest', str(manifest_file),
            '--output', str(output), '--model-dir', str(self.root/'unused-models'),
            '--baseline-manifest', str(baseline), '--pack-id', 'sentence-audio-v4',
            '--pronunciation-holds', str(file), '--pronunciation-holds-sha256', hold_pin['sha256'],
            '--release-url', 'https://github.com/wudi000888-svg/nightstudy/releases/download/v-test']
        with patch.object(audio, 'REPO', self.root), patch.object(sys, 'argv', argv), \
                patch.object(audio, 'collect', return_value=(manifest, rows)), \
                patch.object(audio, 'pipeline_module', return_value=module), \
                patch.object(audio, 'external', side_effect=lambda directory, create=False: Path(directory).resolve()), \
                patch.object(audio.concurrent.futures, 'ProcessPoolExecutor', InlinePool), \
                patch.object(module, 'audit_entries', side_effect=lambda entries, output, workers: entries), \
                patch.object(module.codec, 'build_tool_identity', return_value={'name': 'Test-only encoder'}), \
                patch.object(module.pack, 'make_voice') as make_voice:
            audio.main()
        make_voice.assert_not_called()
        self.assertEqual(calls, [('US', 1)])
        built = json.loads((output/'manifest.json').read_text())
        sources = json.loads((output/'sources.manifest.json').read_text())
        self.assertEqual([entry['accent'] for entry in built['entries']], ['US'])
        self.assertEqual(sources['requestedSentences'], rows)
        self.assertEqual(sources['reusedMediaReferences'], [])
        self.assertEqual(sources['heldMediaReferences'][0]['accent'], 'UK')
        self.assertEqual(sources['pronunciationHolds'], {**hold_pin,
            'sourceFileName': file.name, 'fileName': 'pronunciation-holds.json'})
        self.assertEqual(built['statistics']['requestedClipCount'], 2)
        self.assertEqual(built['statistics']['heldClipCount'], 1)
        self.assertEqual(built['statistics']['generatedClipCount'], 1)
        self.assertEqual((output/'pronunciation-holds.json').read_bytes(), raw_hold)
        import tarfile
        with tarfile.open(self.root/'nightstudy-sentence-audio-v4.tar.gz', 'r:gz') as archive:
            self.assertEqual(archive.extractfile('pronunciation-holds.json').read(), raw_hold)

    def test_v3_manifest_or_source_tampering_is_rejected(self):
        for filename, message in [('manifest.json', 'audio_baseline_pin_mismatch'),
                                  ('sources.manifest.json', 'audio_baseline_source_pin_mismatch')]:
            with self.subTest(filename=filename):
                baseline, _, module = self.baseline()
                target = baseline.parent/filename
                target.write_bytes(target.read_bytes()+b' ')
                with patch.object(audio, 'REPO', self.root):
                    with self.assertRaisesRegex(ValueError, message):
                        audio.load_incremental_baselines([baseline], module)

    def test_selected_reused_media_checksum_or_symlink_is_rejected(self):
        baseline, entries, module = self.baseline()
        manifest, content = self.pinned()
        _, rows = audio.collect(manifest, content)
        with patch.object(audio, 'REPO', self.root):
            pairs, _ = audio.load_incremental_baselines([baseline], module)
        asset = baseline.parent/entries[0]['fileKey']
        original = asset.read_bytes()
        asset.write_bytes(b'ID3' + b'changed')
        with self.assertRaisesRegex(ValueError, 'invalid_reused_audio'):
            audio.incremental_scope(rows, pairs, module)
        asset.unlink()
        target = self.root/'outside.mp3'; target.write_bytes(original)
        asset.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'invalid_reused_audio'):
            audio.incremental_scope(rows, pairs, module)

    def test_duplicate_baseline_is_rejected_before_generation(self):
        baseline, _, module = self.baseline()
        with patch.object(audio, 'REPO', self.root):
            with self.assertRaisesRegex(ValueError, 'duplicate_audio_baseline'):
                audio.load_incremental_baselines([baseline, baseline], module)

    def test_all_reused_delta_never_loads_a_voice_or_starts_workers(self):
        baseline, _, module = self.baseline()
        manifest, content = self.pinned()
        output = self.root/'all-reused'; output.mkdir()
        argv = ['learning-senses-audio.py', '--manifest', str(manifest), '--content', str(content),
                '--output', str(output), '--model-dir', str(self.root/'unused-models'),
                '--baseline-manifest', str(baseline), '--pack-id', 'sentence-audio-v4',
                '--release-url', 'https://github.com/wudi000888-svg/nightstudy/releases/download/v-test']
        with patch.object(audio, 'REPO', self.root), patch.object(sys, 'argv', argv), \
                patch.object(audio, 'pipeline_module', return_value=module), \
                patch.object(audio, 'external', side_effect=lambda directory, create=False: Path(directory).resolve()), \
                patch.object(audio.concurrent.futures, 'ProcessPoolExecutor') as pool, \
                patch.object(module.pack, 'make_voice') as make_voice:
            with self.assertRaisesRegex(ValueError, 'all_audio_already_present_no_delta_needed'):
                audio.main()
        pool.assert_not_called()
        make_voice.assert_not_called()
        self.assertFalse((output/'manifest.json').exists())

    def test_sentence_workers_require_cached_voices_with_download_disabled(self):
        module = audio.pipeline_module()
        output = self.root/'worker'; (output/'progress').mkdir(parents=True)
        text = 'The class reads a short story.'
        row = {'text': text, 'textHash': module.text_hash(text)}
        entry = {'mimeType': 'audio/mpeg'}
        with patch.object(module.pack, 'make_voice', return_value=object()) as make_voice:
            with patch.object(module.pack, 'synthesize_entry', return_value=entry) as synthesize:
                result = module.worker('UK', [row], str(output), str(self.root/'models'), 0)
                self.assertEqual(result[0]['text'], text)
                self.assertEqual(synthesize.call_count, 1)
        self.assertEqual(make_voice.call_args.args[2:], (1, False))

    def test_plan_only_reports_even_fully_reused_scope_without_publishable_outputs(self):
        baseline, _, module = self.baseline()
        manifest, content = self.pinned()
        output = self.root/'plan-only'; output.mkdir()
        argv = ['learning-senses-audio.py', '--manifest', str(manifest), '--content', str(content),
                '--output', str(output), '--model-dir', str(self.root/'unused-models'),
                '--baseline-manifest', str(baseline), '--pack-id', 'sentence-audio-v4', '--plan-only',
                '--release-url', 'https://github.com/wudi000888-svg/nightstudy/releases/download/v-test']
        with patch.object(audio, 'REPO', self.root), patch.object(sys, 'argv', argv), \
                patch.object(audio, 'pipeline_module', return_value=module), \
                patch.object(audio, 'external', side_effect=lambda directory, create=False: Path(directory).resolve()), \
                patch.object(audio.concurrent.futures, 'ProcessPoolExecutor') as pool, \
                patch.object(module.pack, 'make_voice') as make_voice:
            audio.main()
        pool.assert_not_called()
        make_voice.assert_not_called()
        self.assertFalse((output/'manifest.json').exists())
        self.assertFalse((output/'sources.manifest.json').exists())

    def test_single_worker_v4_package_identity_and_partial_accent_coverage_are_auditable(self):
        baseline, entries, module = self.baseline(accents=('US',))
        manifest, content = self.pinned()
        output = self.root/'v4-build'; output.mkdir()
        (self.root/'LICENSE').write_text('Original test content license\n')
        calls = []
        worker_limits = []

        def synthesize(accent, rows, output_string, model_string, shard):
            calls.append((accent, len(rows)))
            target = Path(output_string)
            entry = {**entries[0], 'accent': accent, 'cacheKey': accent+'-new-cache'}
            (target/'files').mkdir(exist_ok=True)
            (target/entry['fileKey']).write_bytes((baseline.parent/entry['fileKey']).read_bytes())
            return [entry]

        class InlinePool:
            def __init__(self, **kwargs):
                worker_limits.append(kwargs['max_workers'])
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def submit(self, fn, *args):
                return SimpleNamespace(result=lambda: synthesize(*args))

        argv = ['learning-senses-audio.py', '--manifest', str(manifest), '--content', str(content),
                '--output', str(output), '--model-dir', str(self.root/'unused-models'),
                '--baseline-manifest', str(baseline), '--pack-id', 'sentence-audio-v4',
                '--release-url', 'https://github.com/wudi000888-svg/nightstudy/releases/download/v-test']
        with patch.object(audio, 'REPO', self.root), patch.object(sys, 'argv', argv), \
                patch.object(audio, 'pipeline_module', return_value=module), \
                patch.object(audio, 'external', side_effect=lambda directory, create=False: Path(directory).resolve()), \
                patch.object(audio.concurrent.futures, 'ProcessPoolExecutor', InlinePool), \
                patch.object(module, 'audit_entries', side_effect=lambda entries, output, workers: entries), \
                patch.object(module.codec, 'build_tool_identity', return_value={'name': 'Test-only encoder'}), \
                patch.object(module.pack, 'make_voice') as make_voice:
            audio.main()
        make_voice.assert_not_called()
        self.assertEqual(worker_limits, [1])
        self.assertEqual(calls, [('UK', 1)])
        built = json.loads((output/'manifest.json').read_text())
        sources = json.loads((output/'sources.manifest.json').read_text())
        pin = json.loads((self.root/'sentence-audio-v4.pin.json').read_text())
        self.assertEqual(built['version'], 'sentence-audio-v4')
        self.assertEqual(pin['id'], 'sentence-audio-v4')
        self.assertEqual(built['statistics']['entryCount'], 1)
        self.assertEqual(built['statistics']['requestedClipCount'], 2)
        self.assertEqual(built['statistics']['reusedClipCount'], 1)
        self.assertEqual(built['statistics']['generatedClipCount'], 1)
        self.assertEqual(sources['reusedMediaReferences'][0]['baseline']['id'], 'sentence-audio-v3')
        self.assertEqual([entry['accent'] for entry in built['entries']], ['UK'])
        self.assertTrue((self.root/'nightstudy-sentence-audio-v4.tar.gz').is_file())
        self.assertFalse((self.root/'nightstudy-sentence-audio-v3.tar.gz').exists())


if __name__ == '__main__':
    unittest.main()
