import copy
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import unittest
import urllib.parse

spec = importlib.util.spec_from_file_location('direct_source', Path(__file__).with_name('tatoeba-direct-source.py'))
SOURCE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(SOURCE)


def sentence(sentence_id, language='eng', **extra):
    return {'id': sentence_id, 'text': ' The rain stopped by noon. ' if language == 'eng' else '雨在中午前停了。', 'lang': language, 'script': None if language == 'eng' else 'Hans', 'license': 'CC BY 2.0 FR', 'owner': 'synthetic-current-owner', 'is_unapproved': False, **extra}


def body(translations=None):
    return {'data': [{**sentence(123), 'translations': translations if translations is not None else [sentence(456, 'cmn', is_direct=True)]}], 'paging': {'total': 1, 'has_next': False}}


class DirectSourceTests(unittest.TestCase):
    def parse(self, value):
        return SOURCE.parse_page(json.dumps(value, ensure_ascii=False).encode(), SOURCE.FIRST_URL, '2026-10-14T00:00:00+00:00')

    def test_next_requires_fixed_https_origin_path_all_filters_and_one_cursor(self):
        valid = SOURCE.FIRST_URL + '&after=123%2C456'
        self.assertEqual(SOURCE.validate_url(valid), valid)
        bad = [valid.replace('https:', 'http:'), valid.replace('api.tatoeba.org', 'evil.example'), valid.replace('api.tatoeba.org', 'user:pass@api.tatoeba.org'), valid.replace('/v1/sentences', '/v1/sentences/123'), valid.replace('lang=eng', 'lang=fra', 1), valid + '&lang=eng', valid + '#fragment', valid + '&limit=50', SOURCE.FIRST_URL]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(SOURCE.SourceError):
                SOURCE.validate_url(value)

    def test_preserves_both_source_texts_and_licenses_without_claiming_historical_authorship(self):
        value = body([sentence(456, 'cmn', is_direct=True, license='CC0 1.0')])
        original = copy.deepcopy(value)
        raw, pairs, rejected = self.parse(value)
        self.assertEqual(value, original)
        self.assertEqual(len(pairs), 1)
        self.assertEqual(rejected, {})
        self.assertEqual(pairs[0]['english']['text'], ' The rain stopped by noon. ')
        self.assertEqual(pairs[0]['relationship']['isDirect'], True)
        for field, license in [('exampleEn', 'CC BY 2.0 FR'), ('exampleZh', 'CC0 1.0')]:
            meta = pairs[0]['contentMetadata'][field]
            self.assertEqual(meta['license'], license)
            self.assertEqual(meta['review'], 'pending')
            self.assertEqual(meta['ownerRole'], 'current-owner')
            self.assertNotIn('author', meta)
        self.assertEqual(pairs[0]['contentMetadata']['exampleEn']['sourceTextSha256'], SOURCE.sha(' The rain stopped by noon. '.encode()))

    def test_rejects_unknown_license_orphan_unapproved_indirect_and_non_hans(self):
        for extra, reason in [({'license': 'PROBLEM'}, 'chinese_unsupported_license'), ({'owner': None}, 'chinese_missing_owner'), ({'is_unapproved': True}, 'chinese_unapproved_or_unknown'), ({'is_direct': False}, 'not_direct'), ({'script': 'Hant'}, 'chinese_not_hans'), ({'script': None}, 'chinese_not_hans')]:
            with self.subTest(extra=extra):
                _, pairs, rejected = self.parse(body([sentence(456, 'cmn', is_direct=True, **extra)] if 'is_direct' not in extra else [sentence(456, 'cmn', **extra)]))
                self.assertEqual(pairs, [])
                self.assertEqual(rejected[reason], 1)

    def test_schema_and_unsafe_paging_fail_before_any_source_is_selected(self):
        bad = [[], {'data': [], 'paging': {'total': True, 'has_next': False}}, {'data': [], 'paging': {'total': 1, 'has_next': True, 'next': 'https://evil.example/path'}}]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(SOURCE.SourceError):
                self.parse(value)
        _, pairs, rejected = self.parse(body([sentence(True, 'cmn', is_direct=True)]))
        self.assertEqual(pairs, [])
        self.assertEqual(rejected['chinese_invalid_sentence'], 1)

    def test_retry_after_honors_seconds_and_http_dates(self):
        now = datetime(2026, 10, 14, 0, 0, 0, tzinfo=timezone.utc)
        self.assertEqual(SOURCE.retry_after('123', now), 123)
        self.assertEqual(SOURCE.retry_after('Wed, 14 Oct 2026 00:02:00 GMT', now), 120)
        self.assertEqual(SOURCE.retry_after('Wed, 14 Oct 2026 00:00:00 GMT', now), 0)
        self.assertIsNone(SOURCE.retry_after('not-a-date', now))


if __name__ == '__main__':
    unittest.main()
