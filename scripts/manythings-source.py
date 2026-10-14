#!/usr/bin/env python3
"""Parse a pinned public bilingual export locally; no network, model or database.

Selection is literal, word-level usage, never a claim of sense alignment or review.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid
import zipfile

ZIP_SHA = 'd606361aa7312dcdfb15ef4fc51cb1e7ed8bc2dc608a7b192626cd36e8403106'
ZIP_BYTES = 1386340
SNAPSHOT = '2026-02-13'
EXPORT_URL = 'https://www.manythings.org/anki/cmn-eng.zip'
DATASET = 'manyThingsEnglishChinese'
ROOT = Path('/Volumes/XXX/Codex/work/nightstudy')
CREDIT = re.compile(r'^CC-BY 2\.0 \(France\) Attribution: tatoeba\.org #([1-9]\d*) \(([^()\n]+)\) & #([1-9]\d*) \(([^()\n]+)\)$')
TOKENS = re.compile(r'[A-Za-z]+(?:[\x27\u2019][A-Za-z]+)?')


def sha(value):
    return hashlib.sha256(value).hexdigest()


def parse_line(line, number):
    columns = line.split('\t')
    if len(columns) != 3 or not columns[0].strip() or not columns[1].strip():
        raise ValueError('invalid_export_columns')
    english, chinese, attribution = columns
    match = CREDIT.fullmatch(attribution)
    if not match or match[1] == match[3] or any(len(match[i]) > 200 for i in [2, 4]):
        raise ValueError('invalid_export_attribution')
    ids, owners = [match[1], match[3]], [match[2], match[4]]
    metadata = {}
    for index, (field, text, language) in enumerate([
        ('exampleEn', english, 'en'), ('exampleZh', chinese, 'zh'),
    ]):
        metadata[field] = {
            'kind': 'corpus', 'review': 'pending', 'license': 'CC-BY-2.0-FR',
            'licenseUrl': 'https://creativecommons.org/licenses/by/2.0/fr/',
            'sourceName': 'Tatoeba / ManyThings selection', 'sourceDataset': DATASET,
            'sourceLanguage': language, 'sourceSentenceId': ids[index],
            'sourceUrl': 'https://tatoeba.org/en/sentences/show/' + ids[index],
            'sourceExportUrl': EXPORT_URL, 'sourceSha256': ZIP_SHA, 'snapshot': SNAPSHOT,
            'sourceTextSha256': sha(text.encode('utf-8')),
            'sourceOwner': owners[index], 'sourceOwnerRole': 'export-attributed-owner',
            'attribution': attribution,
            'publisherAttribution': 'www.manythings.org/anki and tatoeba.org',
            'relationship': {'kind': 'source-export-pair'},
        }
        metadata[field]['translationSentenceId' if index == 0 else 'translationOfSentenceId'] = ids[1 - index]
    return {
        'exampleEn': english, 'exampleZh': chinese, 'contentMetadata': metadata,
        'sourceLine': number, 'chineseScript': 'not-verified',
    }


def read_export(archive):
    source = archive.read_bytes()
    if len(source) != ZIP_BYTES or sha(source) != ZIP_SHA:
        raise ValueError('source_export_pin_mismatch')
    with zipfile.ZipFile(archive) as bundle:
        infos = bundle.infolist()
        if {entry.filename for entry in infos} != {'cmn.txt', '_about.txt'} or len(infos) != 2:
            raise ValueError('unexpected_export_members')
        if any(entry.file_size > 8 * 1024 * 1024 or stat.S_ISLNK(entry.external_attr >> 16) for entry in infos):
            raise ValueError('invalid_export_member')
        text_bytes = bundle.read('cmn.txt')
        about_bytes = bundle.read('_about.txt')
    lines = text_bytes.decode('utf-8-sig').splitlines()
    if len(lines) != 32028:
        raise ValueError('source_export_row_count_mismatch')
    rows = [parse_line(line, number) for number, line in enumerate(lines, 1)]
    return rows, about_bytes, text_bytes


def literal_matches(lemmas, rows):
    ordinary = {lemma for lemma in lemmas if re.fullmatch('[a-z]+', lemma)}
    special = {lemma: re.compile(r'(?<![A-Za-z])' + re.escape(lemma) + r'(?![A-Za-z])', re.I)
               for lemma in lemmas - ordinary}
    matches = {lemma: [] for lemma in lemmas}
    for row in rows:
        text = row['exampleEn']
        found = {token.lower() for token in re.findall('[A-Za-z]+', text)} & ordinary
        found.update(lemma for lemma, regex in special.items() if regex.search(text))
        for lemma in found:
            matches[lemma].append(row)
    return matches


def candidate_rank(row, lemmas):
    tokens = TOKENS.findall(row['exampleEn'])
    count = len(tokens)
    # These are reproducible selection heuristics, not linguistic correctness scores.
    unfamiliar = sum(token.lower() not in lemmas for token in tokens)
    unusual = int(any(mark in row['exampleEn'] for mark in ['"', '(', ')', ':', ';', '\n']))
    return (int(not 5 <= count <= 18), unusual, unfamiliar, abs(count - 9), len(row['exampleEn']), row['sourceLine'])


def select_candidates(matches, lemmas):
    selected = []
    for lemma in sorted(lemmas):
        candidates, seen = [], set()
        for row in sorted(matches[lemma], key=lambda entry: candidate_rank(entry, lemmas)):
            source_id = row['contentMetadata']['exampleEn']['sourceSentenceId']
            if source_id in seen:
                continue
            seen.add(source_id)
            candidates.append({**row, 'selection': {
                'method': 'exact-literal-boundary', 'senseAligned': False,
                'englishTokenCount': len(TOKENS.findall(row['exampleEn'])),
                'preferredLength': 5 <= len(TOKENS.findall(row['exampleEn'])) <= 18,
                'review': 'pending',
            }})
            if len(candidates) == 3:
                break
        if candidates:
            selected.append({'normalizedLemma': lemma, 'candidates': candidates})
    return selected


def output_root(directory):
    if not os.path.ismount('/Volumes/XXX'):
        raise ValueError('external_volume_not_mounted')
    directory.mkdir(parents=True, exist_ok=True)
    real = directory.resolve(strict=True)
    if not real.is_relative_to(ROOT.resolve(strict=True)):
        raise ValueError('output_outside_external_work_root')
    probe = real / ('.write-probe-' + uuid.uuid4().hex)
    with probe.open('xb') as stream:
        stream.write(b'write-probe')
    probe.unlink()
    return real


def atomic(directory, name, data):
    root = output_root(directory)
    target = root / name
    if target.is_symlink():
        raise ValueError('output_leaf_symlink')
    temp = root / ('.' + name + '.' + uuid.uuid4().hex + '.partial')
    with temp.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, target)
    return {'file': name, 'bytes': len(data), 'sha256': sha(data)}


def jsonl(rows):
    return ''.join(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n' for row in rows).encode('utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--lexical', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    lexical_bytes = args.lexical.read_bytes()
    words = [json.loads(line) for line in lexical_bytes.decode('utf-8').splitlines() if line]
    lemmas = {row['normalizedLemma'] for row in words}
    if len(words) != len(lemmas) or any(not isinstance(lemma, str) or not lemma for lemma in lemmas):
        raise ValueError('invalid_lexical_scope')
    rows, about_bytes, text_bytes = read_export(args.archive)
    matches = literal_matches(lemmas, rows)
    candidates = select_candidates(matches, lemmas)
    missing = [{
        'normalizedLemma': row['normalizedLemma'], 'lemma': row['lemma'],
        'sourceRef': row.get('sourceRef'), 'senses': row['senses'],
        'reason': 'no-exact-source-export-match',
    } for row in words if not matches[row['normalizedLemma']]]
    outputs = [atomic(args.output, name, content) for name, content in [
        ('manythings-pairs.jsonl', jsonl(rows)),
        ('word-candidates.jsonl', jsonl(candidates)),
        ('missing-words.jsonl', jsonl(missing)),
        ('_about.txt', about_bytes),
    ]]
    preferred = sum(any(candidate['selection']['preferredLength'] for candidate in row['candidates']) for row in candidates)
    report = {
        'formatVersion': 1, 'dataset': DATASET, 'sourceUrl': EXPORT_URL,
        'sourcePage': 'https://www.manythings.org/anki/',
        'snapshot': SNAPSHOT, 'processedAt': datetime.now(timezone.utc).isoformat(),
        'sourceBytes': ZIP_BYTES, 'sourceSha256': ZIP_SHA,
        'sourceTextBytes': len(text_bytes), 'sourceTextSha256': sha(text_bytes),
        'sourceAboutSha256': sha(about_bytes), 'lexicalSha256': sha(lexical_bytes),
        'pairs': len(rows), 'lexicalWords': len(words), 'coveredWords': len(candidates),
        'missingWords': len(missing), 'coveredWordsWithPreferredLength': preferred,
        'candidateCount': sum(len(row['candidates']) for row in candidates),
        'candidateCountDistribution': dict(Counter(len(row['candidates']) for row in candidates)),
        'license': 'CC-BY-2.0-FR', 'outputs': outputs,
        'notes': [
            'Original English and Chinese text and each export-attributed owner are preserved exactly.',
            'Export pairing is not current API direct-link/approval verification, and owners are not proven historical authors.',
            'Chinese script is not verified; the original export includes simplified and traditional forms. No conversion is applied.',
            'Literal English boundary matching is word-level usage, not matching the meaning of a particular Sense.',
            '5–18 English tokens are a ranking preference, never a hard coverage filter; all candidates await semantic review.',
            'Canonical word IDs are not present in this public lexical input; no IDs are fabricated or changed.',
        ],
    }
    atomic(args.output, 'source-report.json', (json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    print(json.dumps({key: report[key] for key in ['pairs', 'lexicalWords', 'coveredWords', 'missingWords', 'coveredWordsWithPreferredLength', 'candidateCount']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
