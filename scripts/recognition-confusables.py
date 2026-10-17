#!/usr/bin/env python3
"""Build a conservative exclusion index from pinned public WordNet data.

Shared senses, direct hypernyms/hyponyms and adjective similarity are exclusions,
not a claim that words are interchangeable in every sense. No content generation.
"""
import argparse
import gzip
import hashlib
import io
import json
import re
import unicodedata
import zipfile
from collections import defaultdict
from pathlib import Path

RELATIONS = {'@', '@i', '~', '~i', '&'}
MANUAL = [('poison', 'pollutant')]


def normalize(value):
    value = unicodedata.normalize('NFKC', value).lower().replace('\u2019', "'").replace('\u2018', "'")
    return re.sub(r'\s+', ' ', value).strip()


def parse_synsets(lines):
    output = {}
    for line in lines:
        if not line or not line[0].isdigit():
            continue
        fields = line.partition('|')[0].split()
        offset, pos, count = fields[0], fields[2].replace('s', 'a'), int(fields[3], 16)
        words = [normalize(re.sub(r'\((?:a|p|ip)\)$', '', fields[4 + i * 2]).replace('_', ' ')) for i in range(count)]
        cursor = 4 + count * 2
        pointers = int(fields[cursor]); cursor += 1
        related = []
        for _ in range(pointers):
            symbol, target, target_pos, _indices = fields[cursor:cursor + 4]; cursor += 4
            if symbol in RELATIONS:
                related.append(target + '-' + target_pos.replace('s', 'a'))
        identity = offset + '-' + pos
        if identity in output:
            raise ValueError('duplicate_wordnet_synset')
        output[identity] = (set(words), set(related))
    return output


def exclusions(synsets, active, manual=MANUAL):
    members = {key: words & active for key, (words, _) in synsets.items()}
    result = defaultdict(set)
    for identity, (words, links) in synsets.items():
        local = words & active
        other = set(local)
        for linked in links:
            if linked not in synsets:
                raise ValueError('missing_wordnet_pointer_target')
            other.update(members[linked])
        for word in local:
            for target in other - {word}:
                result[word].add(target); result[target].add(word)
    for a, b in manual:
        if a in active and b in active:
            result[a].add(b); result[b].add(a)
    return {word: sorted(values) for word, values in sorted(result.items()) if values}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('wordnet', 'wordnet-sha256', 'required-words', 'required-words-sha256', 'output'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    digest = lambda raw: hashlib.sha256(raw).hexdigest()
    raw, targets_raw = Path(args.wordnet).read_bytes(), Path(args.required_words).read_bytes()
    if digest(raw) != args.wordnet_sha256 or digest(targets_raw) != args.required_words_sha256:
        raise ValueError('public_index_source_pin_mismatch')
    required = json.loads(targets_raw)
    active = {row['normalizedLemma'] for row in required}
    if len(active) != len(required) or any(normalize(word) != word for word in active):
        raise ValueError('invalid_independent_word_union')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        lines = [line for name in ('noun', 'verb', 'adj', 'adv')
                 for line in archive.read('wordnet/data.' + name).decode('utf8').splitlines()]
        notice = archive.read('wordnet/LICENSE')
    index = exclusions(parse_synsets(lines), active)
    payload = {'formatVersion': 1, 'id': 'recognition-confusables-v1',
        'normalization': 'NFKC; lower case; curly apostrophe to ASCII; collapse whitespace',
        'policy': 'Conservative word-level exclusions; not exhaustive semantic certification.',
        'relations': sorted(RELATIONS), 'manualConservativePairs': [list(pair) for pair in MANUAL],
        'words': index}
    decoded = (json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode('utf8')
    stream = io.BytesIO()
    with gzip.GzipFile(fileobj=stream, mode='wb', filename='', mtime=0, compresslevel=9) as packed:
        packed.write(decoded)
    packed = stream.getvalue()
    if len(decoded) > 16 * 1024 * 1024 or len(packed) > 8 * 1024 * 1024:
        raise ValueError('confusable_index_limit')
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
    name = 'recognition-confusables-v1.json.gz'; notice_name = 'recognition-wordnet.LICENSE.txt'
    for filename, content in ((name, packed), (notice_name, notice)):
        with (output / filename).open('xb') as handle:
            handle.write(content)
    manifest = {'formatVersion': 1, 'id': payload['id'], 'fileName': name,
        'bytes': len(packed), 'sha256': digest(packed), 'jsonSha256': digest(decoded),
        'wordnetSha256': digest(raw), 'requiredWordsSha256': digest(targets_raw),
        'sourceUrl': 'https://wordnet.princeton.edu/download/current-version',
        'license': 'WordNet-3.0', 'licenseNoticeFileName': notice_name, 'licenseNoticeSha256': digest(notice),
        'requiredWordCount': len(active), 'indexedWordCount': len(index),
        'directedExclusionCount': sum(map(len, index.values())), 'semanticQualityCertified': False}
    with (output / 'recognition-confusables-v1.manifest.json').open('x') as handle:
        handle.write(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
    print(json.dumps(manifest))


if __name__ == '__main__':
    main()
