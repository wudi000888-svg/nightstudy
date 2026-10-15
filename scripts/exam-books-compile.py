#!/usr/bin/env python3
"""Compile pinned headword lists against the separately licensed ECDICT source.

Only English headword membership is extracted. Definitions, phonetics and recordings
from the downloaded book files are never copied. See docs/OPEN_CONTENT_REUSE.md.
"""
import argparse
import csv
import gzip
import hashlib
import json
from pathlib import Path
import re
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
BOOKS = [
    ('cet4-open', 'cet4', '四级 · 核心词汇', 'cet4', 'vocabulary'),
    ('cet6-open', 'cet6', '六级 · 进阶词汇', 'cet6', 'vocabulary'),
    ('tem4-open', 'tem4', '专四 · 核心词汇', 'tem4', 'vocabulary'),
    ('tem8-open', 'tem8', '专八 · 进阶词汇', 'tem8', 'vocabulary'),
    ('toefl-open', 'toefl', '托福 · 核心词汇', 'toefl', 'vocabulary'),
    ('gre-open', 'gre', 'GRE · 进阶词汇', 'gre', 'vocabulary'),
    ('tem4-phrases', 'tem4', '专四 · 词组与搭配', 'phrases-tem4', 'phrases'),
    ('tem8-phrases', 'tem8', '专八 · 词组与搭配', 'phrases-tem8', 'phrases'),
    ('toefl-extended', 'toefl', '托福 · 扩展词汇', 'ecdict:toefl', 'vocabulary'),
    ('gre-extended', 'gre', 'GRE · 扩展词汇', 'ecdict:gre', 'vocabulary'),
    ('postgraduate', 'postgraduate', '考研 · 核心词汇', 'ecdict:ky', 'vocabulary'),
]


def normalize(value):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', value).strip().lower().replace('’', "'").replace('‘', "'"))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked_bytes(path, expected):
    data = path.read_bytes()
    if len(data) != expected['bytes'] or digest(data) != expected['sha256']:
        raise ValueError('source_checksum_mismatch:' + str(path))
    return data


def check_large_file(path, expected):
    checksum = hashlib.sha256()
    size = 0
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(2 * 1024 * 1024), b''):
            size += len(chunk)
            checksum.update(chunk)
    if size != expected['bytes'] or checksum.hexdigest() != expected['sha256']:
        raise ValueError('source_checksum_mismatch:' + str(path))


def compile_books(source_dir, ecdict_path, output_dir):
    sources = json.loads((ROOT / 'data/exam-books.sources.json').read_text())['sources']
    by_id = {row['id']: row for row in sources}
    dictionary = json.loads((ROOT / 'data/content-ecdict.manifest.json').read_text())
    check_large_file(ecdict_path, dictionary)
    candidates = {}
    for _, _, _, source_id, _ in BOOKS:
        if source_id in candidates:
            continue
        if source_id.startswith('ecdict:'):
            candidates[source_id] = []
            continue
        source = by_id[source_id]
        suffix = Path(source['path']).suffix
        data = checked_bytes(source_dir / (source_id + suffix), source).decode('utf-8-sig')
        values = [row['name'] for row in json.loads(data)] if source_id == 'tem4' else data.splitlines()
        candidates[source_id] = [value.strip() for value in values if value.strip()]
    requested = {normalize(value) for values in candidates.values() for value in values}
    matched = set()
    english_definitions = set()
    dictionary_rows = 0
    with ecdict_path.open(newline='', encoding='utf-8-sig') as handle:
        for row in csv.DictReader(handle):
            dictionary_rows += 1
            lemma = normalize(row['word'])
            tags = set(row['tag'].split())
            for tag in ('toefl', 'gre', 'ky'):
                if tag in tags:
                    candidates['ecdict:' + tag].append(row['word'])
            if lemma in requested or tags.intersection(('toefl', 'gre', 'ky')):
                if row['translation'].strip():
                    matched.add(lemma)
                if row['definition'].strip():
                    english_definitions.add(lemma)
    if dictionary_rows != dictionary['statistics']['entryCount']:
        raise ValueError('dictionary_row_count_mismatch')
    rows, books, review = [], [], []
    valid = re.compile(r"^[a-z]+(?:['-][a-z]+)*(?: [a-z]+(?:['-][a-z]+)*){0,9}$")
    for book_id, goal, title, source_id, kind in BOOKS:
        seen = set()
        accepted = []
        rejects = []
        duplicates = 0
        for raw in candidates[source_id]:
            lemma = normalize(raw)
            if lemma in seen:
                duplicates += 1
                continue
            seen.add(lemma)
            reason = 'unsupported_headword' if not valid.fullmatch(lemma) else 'not_in_pinned_dictionary' if lemma not in matched else None
            if reason:
                rejects.append({'book': book_id, 'lemma': raw, 'normalizedLemma': lemma, 'reason': reason})
            else:
                accepted.append(lemma)
                rows.append({'book': book_id, 'normalizedLemma': lemma})
        review.extend(rejects)
        books.append({
            'id': book_id, 'goal': goal, 'title': title, 'kind': kind, 'sourceId': source_id,
            'description': '按词表顺序学习常见词组与搭配。' if kind == 'phrases' else '按词表顺序系统学习、复习与拼写。',
            'sourceCount': len(candidates[source_id]), 'uniqueSourceCount': len(seen),
            'duplicateCount': duplicates, 'wordCount': len(accepted), 'unmatchedCount': len(rejects),
            'withEnglishDefinition': len(set(accepted) & english_definitions),
        })
    decoded = ''.join(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n' for row in rows).encode()
    packed = gzip.compress(decoded, compresslevel=9, mtime=0)
    manifest = {
        'formatVersion': 1, 'id': 'exam-books-v1', 'version': '2026-10-16', 'kind': 'exam-books',
        'fileName': 'exam-books-v1.jsonl.gz', 'bytes': len(packed), 'sha256': digest(packed),
        'jsonlSha256': digest(decoded), 'membershipCount': len(rows), 'wordCount': len({row['normalizedLemma'] for row in rows}),
        'requiredDictionary': {'id': dictionary['id'], 'sha256': dictionary['sha256']},
        'sourceUrl': 'https://github.com/openetymology/OpenEtymology/tree/7d89f3697abf26e305fe2627f181b692c2c10b28',
        'license': 'CC-BY-SA-4.0 AND LicenseRef-Headword-Facts', 'books': books,
        'limitations': [
            'These community-curated lists are not certified complete official examination syllabuses.',
            'Only headwords matching a Chinese definition in the pinned ECDICT are admitted; all exclusions are listed in the review queue.',
            'Existing words are reused. The pack contains no new definitions, examples, phonetics or audio, and English/Chinese meanings are not assumed to align.',
            'The TEM4 source repository code is MIT, but its underlying third-party dictionary data has no established data licence. Only factual English headword membership is extracted; expressive dictionary content is excluded.',
            'OpenEtymology and 2ndLA list adaptations remain separately distributed under CC-BY-SA-4.0; the application code remains MIT.',
        ],
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / manifest['fileName']).write_bytes(packed)
    (output_dir / 'exam-books.manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    (output_dir / 'exam-books.review-queue.json').write_text(json.dumps({'formatVersion': 1, 'packId': manifest['id'], 'entries': review}, ensure_ascii=False, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path, required=True)
    parser.add_argument('--ecdict', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'data')
    args = parser.parse_args()
    result = compile_books(args.source_dir, args.ecdict, args.output_dir)
    print(json.dumps({'packId': result['id'], 'sha256': result['sha256'], 'wordCount': result['wordCount'], 'membershipCount': result['membershipCount'], 'books': result['books']}, ensure_ascii=False))
