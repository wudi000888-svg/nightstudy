#!/usr/bin/env python3
"""Derive the required word union from an independent pinned complete book catalog.

Authored batches never define their own completion target. This command does not
author, translate, review, publish, download, or access a database.
"""
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha(value):
    return hashlib.sha256(value).hexdigest()


def derive_targets(source, catalog, declared_catalog):
    by_lemma = {word['normalizedLemma']: word for word in source}
    if len(by_lemma) != len(source):
        raise ValueError('duplicate_source_lemma')
    declared = {book['id']: book for book in declared_catalog['books']}
    if len(declared) != len(declared_catalog['books']):
        raise ValueError('duplicate_declared_book')
    seen_books, union, books, withdrawn = set(), {}, [], []
    for book in catalog['books']:
        if book['id'] in seen_books or book['id'] not in declared:
            raise ValueError('duplicate_or_undeclared_book')
        seen_books.add(book['id'])
        items, seen_words, seen_ordinals = [], set(), set()
        for ordinal, lemma in book['items']:
            if not isinstance(ordinal, int) or ordinal in seen_ordinals or lemma in seen_words:
                raise ValueError('duplicate_or_invalid_membership')
            seen_ordinals.add(ordinal); seen_words.add(lemma)
            word = by_lemma.get(lemma)
            if not word:
                raise ValueError('catalog_word_missing_from_source:' + lemma)
            if word.get('withdrawn'):
                withdrawn.append({'bookId': book['id'], 'normalizedLemma': lemma})
                continue
            identity = {'wordId': word['id'], 'normalizedLemma': lemma}
            if identity['wordId'] in union and union[identity['wordId']] != identity:
                raise ValueError('source_word_id_collision')
            union[identity['wordId']] = identity
            items.append({'ordinal': ordinal, **identity})
        if len(items) != declared[book['id']]['wordCount']:
            raise ValueError('declared_book_count_mismatch:' + book['id'])
        books.append({key: book[key] for key in ('id', 'goal', 'kind')} |
                     {'wordCount': len(items), 'items': sorted(items, key=lambda item: item['ordinal'])})
    active = {word['id']: {'wordId': word['id'], 'normalizedLemma': word['normalizedLemma']}
              for word in source if not word.get('withdrawn')}
    if set(declared) != seen_books or union != active:
        raise ValueError('incomplete_independent_catalog_union')
    if len(union) != declared_catalog['activeWords'] or sum(book['wordCount'] for book in books) != declared_catalog['activeBookItems']:
        raise ValueError('declared_catalog_totals_mismatch')
    return sorted(union.values(), key=lambda row: (row['wordId'], row['normalizedLemma'])), books, withdrawn


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('source', 'source-sha256', 'catalog', 'catalog-sha256', 'bilingual-manifest', 'output'):
        parser.add_argument('--' + flag, required=True)
    args = parser.parse_args()
    source_bytes, catalog_bytes = Path(args.source).read_bytes(), Path(args.catalog).read_bytes()
    if sha(source_bytes) != args.source_sha256 or sha(catalog_bytes) != args.catalog_sha256:
        raise ValueError('independent_source_pin_mismatch')
    catalog = json.loads(catalog_bytes)
    if catalog['sourceExportSha256'] != args.source_sha256:
        raise ValueError('catalog_source_mismatch')
    overlay_file = Path(args.bilingual_manifest)
    overlay_bytes = overlay_file.read_bytes(); overlay = json.loads(overlay_bytes)
    if overlay['sourceExportSha256'] != args.source_sha256 or overlay['catalogSourceSha256'] != args.catalog_sha256:
        raise ValueError('bilingual_source_or_catalog_mismatch')
    packed = (overlay_file.parent / overlay['fileName']).read_bytes()
    if len(packed) != overlay['bytes'] or sha(packed) != overlay['sha256']:
        raise ValueError('bilingual_payload_pin_mismatch')
    decoded = gzip.decompress(packed)
    if sha(decoded) != overlay['jsonlSha256']:
        raise ValueError('bilingual_decoded_pin_mismatch')
    spec = importlib.util.spec_from_file_location('learning_senses_target_compiler',
        Path(__file__).with_name('learning-senses-compile.py'))
    compiler = importlib.util.module_from_spec(spec); spec.loader.exec_module(compiler)
    source = compiler.merge_source([json.loads(line) for line in source_bytes.splitlines() if line],
        [json.loads(line) for line in decoded.splitlines() if line])
    required, books, withdrawn = derive_targets(source, catalog, overlay['catalog'])
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
    files = []
    for name, value in [('required-words.json', required), ('book-memberships.json', books), ('withdrawn-memberships.json', withdrawn)]:
        raw = (canonical(value) + '\n').encode('utf8')
        with (output / name).open('xb') as handle:
            handle.write(raw)
        files.append({'fileName': name, 'bytes': len(raw), 'sha256': sha(raw)})
    report = {'formatVersion': 1, 'kind': 'independent-learning-senses-targets',
        'sourceExportSha256': args.source_sha256, 'catalogSourceSha256': args.catalog_sha256,
        'bilingualManifestSha256': sha(overlay_bytes), 'bookCount': len(books),
        'requiredWordCount': len(required), 'activeBookItems': sum(book['wordCount'] for book in books),
        'requiredWordsUnionSha256': sha(canonical(required).encode('utf8')), 'files': files,
        'authoredContentUsedToDefineTarget': False}
    with (output / 'targets.manifest.json').open('x') as handle:
        json.dump(report, handle, ensure_ascii=False, sort_keys=True, indent=2); handle.write('\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
