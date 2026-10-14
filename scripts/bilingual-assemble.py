#!/usr/bin/env python3
"""Assemble reviewed lexical drafts and real attributed pairs, without inference or network."""
import argparse
import copy
import gzip
import importlib.util
import json
import io
import re
from pathlib import Path


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


C = module('nightstudy_content_compiler', 'bilingual-compile.py')
CORRECTIONS = module('nightstudy_content_corrections', 'bilingual-apply-corrections.py')


def assemble(lexical_rows, corpus_rows, authored_rows, corrections, phrase_rows,
             source_manifest, warning_rows, expected_count=8798):
    lexical = C.index_words(lexical_rows, 'lexical')
    C.require(len(lexical) == expected_count, 'assembly_lexical_scope_mismatch')
    corpus = C.index_words(corpus_rows, 'corpus')
    authored = C.index_words(authored_rows, 'authored')
    C.require(set(corpus) <= set(lexical) and set(authored) <= set(lexical), 'assembly_foreign_word')
    C.require(not set(corpus) & set(authored), 'assembly_duplicate_example_source')
    held = {row['normalizedLemma'] for row in warning_rows
            if any(w['code'] == 'source-spelling-unverified' for w in row.get('warnings', []))}
    C.require(held <= set(lexical) and len(held) <= 12, 'assembly_source_warning_scope')
    C.require(not (set(corpus) | set(authored)) & held, 'assembly_held_word_has_usage')
    missing = set(lexical) - set(corpus) - set(authored) - held
    C.require(not missing, 'assembly_usage_drafts_incomplete:' + ','.join(sorted(missing)[:20]))
    rows = [{'normalizedLemma': lemma, 'senses': [], 'examples': []} for lemma in sorted(lexical)]
    by_lemma = {row['normalizedLemma']: row for row in rows}
    for lemma, entry in corpus.items():
        candidates = entry.get('candidates')
        C.require(isinstance(candidates, list) and 0 < len(candidates) <= 3, 'assembly_corpus_candidates_required')
        # The source exporter already ranks context and keeps each original credit line.
        selected = candidates[0]
        example = {key: copy.deepcopy(selected[key]) for key in ('exampleEn', 'exampleZh', 'contentMetadata')}
        for field in ('exampleEn', 'exampleZh'):
            metadata = example['contentMetadata'].get(field, {})
            C.require(metadata.get('kind') == 'corpus' and
                      metadata.get('sourceDataset') == 'manyThingsEnglishChinese',
                      'assembly_corpus_source_kind')
            C.require(not any(key.lower().startswith(('model', 'runtime', 'prompt')) for key in metadata),
                      'assembly_corpus_inference_metadata')
        C.validate_example(example, lemma, None, source_manifest['datasets'], 'word-source-languages')
        by_lemma[lemma]['examples'] = [example]
    for lemma, entry in authored.items():
        C.require(set(entry) == {'normalizedLemma', 'exampleEn', 'exampleZh'}, 'assembly_authored_draft_shape')
        en, zh = entry['exampleEn'], entry['exampleZh']
        C.text_field(en, 'assembly_authored_english_required')
        C.text_field(zh, 'assembly_authored_chinese_required')
        C.require(re.search(r'[A-Za-z]', en) and not re.search(r'[\u3400-\u9fff]', en),
                  'assembly_authored_english_language')
        C.require(re.search(r'[\u3400-\u9fff]', zh), 'assembly_authored_chinese_language')
        C.require(6 <= len(re.findall(r"[A-Za-z]+(?:['-][A-Za-z]+)*", en)) <= 16,
                  'assembly_authored_context_length')
        base = {'kind': 'generated', 'review': 'pending', 'license': 'MIT',
                'author': 'NightStudy contributors', 'authoringMethod': 'Codex-assisted original writing'}
        example = {'exampleEn': en, 'exampleZh': zh, 'contentMetadata': {
            'exampleEn': {**base, 'language': 'en', 'sourceTextSha256': C.digest(en)},
            'exampleZh': {**base, 'language': 'zh', 'sourceLanguage': 'en', 'sourceTextSha256': C.digest(en)}}}
        C.validate_example(example, lemma, None, source_manifest['datasets'], 'word-source-languages')
        by_lemma[lemma]['examples'] = [example]
    rows, _, counts = CORRECTIONS.apply_corrections(rows, lexical_rows, corrections, source_manifest)
    by_lemma = {row['normalizedLemma']: row for row in rows}
    phase_field_count = 0
    for phrase in phrase_rows:
        lemma = phrase['normalizedLemma']
        if lemma not in by_lemma:
            continue
        C.require(phrase.get('sourceWordId') == C.digest(lemma), 'assembly_phrase_word_identity')
        original_senses = {sense['id']: sense for sense in lexical[lemma]['senses']}
        for patch in phrase['senses']:
            original = original_senses.get(patch['id'])
            C.require(original is not None and original['definitionZh'] == patch['sourceText'], 'assembly_phrase_source_identity')
            metadata = patch.get('contentMetadata', {}).get('definitionEn', {})
            C.require(metadata.get('sourceTextSha256') == C.digest(original['definitionZh']) and
                      patch.get('sourceTextSha256') == C.digest(original['definitionZh']) and
                      metadata.get('sourceSenseId') == patch['id'] and
                      metadata.get('sourceLanguage') == 'zh', 'assembly_phrase_source_hash')
            if original.get('definitionEn', '') != '':
                continue
            C.require(not any(s['id'] == patch['id'] for s in by_lemma[lemma]['senses']), 'assembly_duplicate_phrase_patch')
            by_lemma[lemma]['senses'].append({'id': patch['id'], 'definitionEn': patch['definitionEn'],
                'contentMetadata': {'definitionEn': copy.deepcopy(patch['contentMetadata']['definitionEn'])}})
            phase_field_count += 1
    return rows, {'corpusWordCount': len(corpus), 'authoredExampleWordCount': len(authored),
                  'sourceHeldExampleWordCount': len(held), 'nativeEnglishAuthoredFields': counts['senseFieldsCorrected'],
                  'sharedPhraseEnglishFields': phase_field_count}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('lexical', 'corpus-candidates', 'authored-directory', 'corrections', 'phrase-pack',
                 'source-manifest', 'warnings', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    manifest_path = Path(__file__).resolve().parents[1] / 'data/phrase-books.manifest.json'
    inputs = [args.lexical, args.corpus_candidates, args.corrections, args.phrase_pack,
              args.source_manifest, args.warnings, manifest_path]
    authored_files = sorted(args.authored_directory.glob('authored-*.jsonl'))
    C.require(authored_files, 'assembly_authored_drafts_required')
    inputs += authored_files
    C.require(args.output.resolve() not in {p.resolve() for p in inputs}, 'assembly_output_must_not_replace_source')
    authored = [row for file in authored_files for row in C.read_jsonl(file)]
    phrase_manifest = C.parse_json(manifest_path.read_text())
    compressed = args.phrase_pack.read_bytes()
    C.require(len(compressed) == phrase_manifest['bytes'] and C.digest(compressed) == phrase_manifest['sha256'], 'assembly_phrase_pack_checksum')
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
        decoded = stream.read(C.MAX_JSONL_BYTES + 1)
    C.require(len(decoded) <= C.MAX_JSONL_BYTES and C.digest(decoded) == phrase_manifest['jsonlSha256'], 'assembly_phrase_jsonl_checksum')
    phrase = [C.parse_json(line) for line in decoded.decode('utf-8').splitlines() if line]
    source = C.parse_json(args.source_manifest.read_text())
    result, counts = assemble(C.read_jsonl(args.lexical), C.read_jsonl(args.corpus_candidates), authored,
                             C.parse_json(args.corrections.read_text()), phrase, source,
                             C.parse_json(args.warnings.read_text()))
    C.atomic_write(args.output, ''.join(C.canonical(row) + '\n' for row in result).encode('utf-8'))
    print(C.canonical({'action': 'bilingual.assemble', 'wordCount': len(result), **counts,
                       'review': 'pending; structure and provenance only'}))


if __name__ == '__main__':
    try:
        main()
    except (C.CompileError, CORRECTIONS.COMPILER.CompileError, OSError, ValueError, KeyError) as error:
        raise SystemExit(str(error))
