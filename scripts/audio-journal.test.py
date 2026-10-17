"""Regression for the accumulated-log memory failure; no voice model needed."""
import importlib.util
import json
from pathlib import Path
import tempfile
import tracemalloc
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bounded_journal', Path(__file__).with_name('audio-journal.py'))
journal = importlib.util.module_from_spec(spec); spec.loader.exec_module(journal)


class BoundedJournals(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.row = {'accent': 'US', 'textHash': 'a'*64, 'cacheKey': 'b'*64,
                    'fileSha256': 'c'*64, 'mimeType': 'audio/mpeg'}

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, rows):
        file = self.root/name
        with file.open('w') as handle:
            for row in rows:
                handle.write(json.dumps(row)+'\n')
        return file

    def test_streaming_skips_corruption_oversized_lines_and_recovers_next_record(self):
        file = self.root/'US-0.jsonl'
        with file.open('wb') as h:
            h.write(b'x'*(journal.MAX_LINE_BYTES*3)+b'\ninvalid\n[]\n\xff\n')
            h.write(json.dumps(self.row).encode()+b'\n{"incomplete":')
        with patch.object(Path, 'read_text', side_effect=AssertionError('whole-file read')):
            self.assertEqual(list(journal.records(file)), [self.row])

    def test_only_current_exact_cache_identities_are_kept_last_record_wins(self):
        irrelevant = {**self.row, 'cacheKey': 'd'*64}
        first = self.write('US-0.jsonl', [self.row, irrelevant,
            {**self.row, 'accent': 'UK'}, {**self.row, 'cacheKey': []}])
        last = self.write('US-1.jsonl', [{**self.row, 'revision': 2}])
        selected = journal.select_entries([last, first], {('a'*64, 'b'*64)}, 'US')
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[('a'*64, 'b'*64)]['revision'], 2)

    def test_many_irrelevant_records_do_not_grow_the_in_memory_cache(self):
        file = self.root/'US-0.jsonl'
        with file.open('w') as handle:
            for i in range(20000):
                handle.write(json.dumps({**self.row, 'textHash': f'{i:064x}', 'padding': 'x'*1000})+'\n')
        tracemalloc.start()
        try:
            selected = journal.select_entries([file], {(f'{0:064x}', 'b'*64)}, 'US')
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(len(selected), 1)
        self.assertLess(peak, 4*1024*1024)

    def test_quality_cache_filters_digest_policy_and_invalid_shape(self):
        good = {'fileSha256': 'c'*64, 'qualityMetrics': {'policyVersion': 1, 'peakAmplitude': 50}}
        file = self.write('quality-v1.jsonl', [good, {'fileSha256': [], 'qualityMetrics': {}},
            {**good, 'fileSha256': 'd'*64}, {**good, 'qualityMetrics': {'policyVersion': 2}}])
        self.assertEqual(journal.select_quality(file, {'c'*64}, 1), {'c'*64: good['qualityMetrics']})

    def test_compaction_is_disk_indexed_deduplicated_and_preserves_source_bytes(self):
        inputs = self.root/'input'; inputs.mkdir()
        a = inputs/'US-0.jsonl'; a.write_text((json.dumps(self.row)+'\n')*100)
        b = inputs/'US-1.jsonl'; b.write_text(json.dumps({**self.row, 'new': True})+'\n')
        q = inputs/'quality-v1.jsonl'; q.write_text(json.dumps({'fileSha256': 'c'*64,
            'qualityMetrics': {'policyVersion': 1}})+'\n')
        before = [journal.digest(p) for p in [a,b,q]]
        out = self.root/'out'; receipt = journal.compact([inputs], out)
        self.assertEqual(receipt['kept']['US']['records'], 1)
        self.assertEqual(receipt['kept']['quality-v1']['records'], 1)
        self.assertTrue(list(journal.records(out/'US-compact.jsonl'))[0]['new'])
        self.assertEqual([journal.digest(p) for p in [a,b,q]], before)
        self.assertFalse((out/'index.sqlite3').exists())
        twice = self.root/'twice'
        journal.compact([out, out], twice)
        for name in ['US-compact.jsonl', 'UK-compact.jsonl', 'quality-v1.jsonl']:
            self.assertEqual((out/name).read_bytes(), (twice/name).read_bytes())
        with self.assertRaisesRegex(ValueError, 'must_be_new'):
            journal.compact([inputs], out)

    def test_compaction_rejects_symlink_sources(self):
        inputs = self.root/'input'; inputs.mkdir()
        target = self.write('target', [self.row]); (inputs/'US-0.jsonl').symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'unsafe_journal'):
            journal.compact([inputs], self.root/'out')

    def test_pinned_completed_manifest_primes_unique_audio_and_quality_without_history(self):
        file = self.root/'manifest.json'
        row = {**self.row, 'qualityMetrics': {'policyVersion': 1}}
        file.write_text(json.dumps({'status': 'ready', 'entries': [row, row]}))
        out = self.root/'out'
        receipt = journal.compact([], out, [(file, journal.digest(file))])
        self.assertEqual(receipt['kept']['US']['records'], 1)
        self.assertEqual(receipt['kept']['quality-v1']['records'], 1)
        self.assertEqual(receipt['inputs'][0]['kind'], 'completed-manifest')
        with self.assertRaisesRegex(ValueError, 'unsafe_or_unpinned'):
            list(journal.manifest_records(file, '0'*64))
        file.write_text(json.dumps({'status': 'partial', 'entries': []}))
        with self.assertRaisesRegex(ValueError, 'not_completed'):
            list(journal.manifest_records(file, journal.digest(file)))

    def test_oversized_manifest_is_rejected_before_parsing(self):
        file = self.root/'manifest.json'; file.write_text('{}')
        with patch.object(journal, 'MAX_MANIFEST_BYTES', 1), \
                patch.object(json, 'load', side_effect=AssertionError('parsed oversized manifest')):
            with self.assertRaisesRegex(ValueError, 'unsafe_or_unpinned'):
                list(journal.manifest_records(file, journal.digest(file)))

    def test_cached_worker_does_not_load_a_voice_model(self):
        spec = importlib.util.spec_from_file_location('cached_pipeline', Path(__file__).with_name('sentence-audio-pack.py'))
        pipeline = importlib.util.module_from_spec(spec); spec.loader.exec_module(pipeline)
        output = self.root/'output'; (output/'progress').mkdir(parents=True)
        text = 'We read the short passage together.'
        sources = pipeline.pack.load_sources(pipeline.pack.DEFAULT_VOICES_MANIFEST)
        source = sources['voices']['US']
        row = {'text': text, 'textHash': pipeline.text_hash(text)}
        entry = {**self.row, **row, 'cacheKey': pipeline.pack.synthesis_identity(text, 'US', source),
                 **{k:source[k] for k in ['sourceName', 'sourceUrl', 'license', 'attribution']}}
        (output/'progress/US-0.jsonl').write_text(json.dumps(entry)+'\n')
        with patch.object(pipeline.pack, 'make_voice', side_effect=AssertionError('model loaded on cache hit')), \
                patch.object(pipeline.pack, 'validate_entry', return_value=True):
            self.assertEqual(pipeline.worker('US', [row], str(output), str(self.root), 0), [entry])


if __name__ == '__main__':
    unittest.main()
