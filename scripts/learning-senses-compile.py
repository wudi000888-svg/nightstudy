#!/usr/bin/env python3
"""Compile reviewed atomic learning meanings; never infer alignment or generate text.

The public word projection is merged with a checksum-pinned bilingual overlay.
Draft source selectors are *exact text identities*, not a POS/ordinal join. All
old sentences remain unbound candidates until an editor explicitly selects them.
"""
import argparse
import copy
import gzip
import hashlib
import io
import json
import re
import unicodedata
from pathlib import Path


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha(value):
    return hashlib.sha256(value.encode('utf-8') if isinstance(value, str) else value).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def lines(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def load_drafts(path):
    if Path(path).suffix == '.jsonl':
        return lines(path)
    authored = json.loads(Path(path).read_text())
    drafts = []
    for meaning in authored['meanings']:
        draft = copy.deepcopy(meaning)
        draft['sources'] = [copy.deepcopy(authored['sourceSelectors'][key])
                            for key in draft.pop('sourceKeys')]
        draft['review'] = dict(authored['editorialPolicy'],
                               semanticRationale=draft.pop('semanticRationale'))
        if draft['lemma'] in authored.get('pronunciationPolicies', {}):
            draft['pronunciation'] = copy.deepcopy(authored['pronunciationPolicies'][draft['lemma']])
        drafts.append(draft)
    return drafts


def audio_text(value):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', value).translate(
        str.maketrans({'\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"'}))).strip()


def exact_target(form, text):
    return re.search(r'(?<![^\W\d_])' + re.escape(form) + r'(?![^\W\d_])', text, re.I) is not None


def eligible(sense):
    quality = sense.get('contentMetadata', {}).get('lexicalQuality', {})
    field = quality.get('field')
    return not (quality.get('excludeFromLearning') is True and field in ('definitionZh', 'definitionEn')
                and quality.get('sourceTextSha256') == sha(sense.get(field, '')))


def merge_source(source, overlay):
    """Reproduce the pinned v2 text values without accessing users or a database."""
    source = copy.deepcopy(source)
    by_lemma = {w['normalizedLemma']: w for w in source}
    require(len(by_lemma) == len(source), 'duplicate_source_word')
    for patch in overlay:
        word = by_lemma[patch['normalizedLemma']]
        if patch.get('defaultBookWithdrawal'):
            word['withdrawn'] = True
            continue
        senses = {s['id']: s for s in word['senses']}
        for item in patch['senses']:
            target = senses[item['id']]
            for field in ('definitionZh', 'definitionEn', 'exampleZh', 'exampleEn', 'pos'):
                if field in item:
                    require(not target.get(field), 'nonempty_overlay_target:' + item['id'])
                    target[field] = item[field]
            target['contentMetadata'].update(item['contentMetadata'])
        for item in patch.get('corrections', []):
            target = senses[item['replacesSenseId']]
            require(sha(target['definitionZh']) == item['sourceDefinitionZhSha256'] and
                    sha(target['definitionEn']) == item['sourceDefinitionEnSha256'] and
                    target['pos'] == item['sourcePos'], 'correction_source_drift')
            target['contentMetadata']['lexicalQuality'] = dict(excludeFromLearning=True,
                field='definitionZh', sourceTextSha256=sha(target['definitionZh']))
            word['senses'].append(dict(id=item['id'], wordId=word['id'], pos=item['pos'],
                definitionZh=item['definitionZh'], definitionEn=item['definitionEn'],
                ordinal=target['ordinal'] - 100000, exampleEn='', exampleZh='',
                contentMetadata=item['contentMetadata']))
        for index, item in enumerate(patch['examples']):
            word['examples'].append(dict(id='bilingual-example-' + sha(word['normalizedLemma'] + '\0' + item['exampleEn']),
                wordId=word['id'], **item, ordinal=index))
        for item in patch.get('exampleCorrections', []):
            target = next(e for e in word['examples'] if e['id'] == item['id'])
            require(sha(target['exampleEn']) == item['sourceExampleEnSha256'] and
                    sha(target['exampleZh']) == item['sourceExampleZhSha256'], 'candidate_translation_source_drift')
            target['exampleZh'] = item['exampleZh']
            target['contentMetadata'].update(item['contentMetadata'])
    return source


def binding_hash(sense):
    fields = ('id', 'wordId', 'pos', 'definitionZh', 'definitionEn', 'contentVersion')
    binding_fields = ('sourceSenseId', 'relation', 'sourcePosSha256',
                      'sourceDefinitionZhSha256', 'sourceDefinitionEnSha256')
    value = {key: sense[key] for key in fields}
    value['sourceBindings'] = [{key: binding[key] for key in binding_fields}
        for binding in sorted(sense['sourceBindings'], key=lambda b: b['sourceSenseId'])]
    return sha(canonical(value))


def compile_rows(source, drafts, version):
    words = {w['normalizedLemma']: w for w in source if not w.get('withdrawn')}
    require(len({(d['lemma'], d['key']) for d in drafts}) == len(drafts), 'duplicate_draft_key')
    output = {}
    sentence_usage = {}
    for draft in drafts:
        word = words[draft['lemma']]
        require(re.fullmatch(r'[a-z0-9-]+', draft['key']), 'invalid_draft_key')
        require(draft['definitionZh'].strip() and re.search('[\u4e00-\u9fff]', draft['definitionZh']), 'missing_chinese_definition')
        require(re.search('[A-Za-z]', draft['definitionEn']) and not re.search('[\u4e00-\u9fff]', draft['definitionEn']), 'invalid_english_definition')
        require(draft['pos'] in ('n.', 'v.', 'vt.', 'vi.', 'adj.', 'adv.', 'phr. v.', 'prep. phr.', 'adv. phr.', 'idiom'), 'invalid_pos')
        review = draft['review']
        require(review['decision'] == 'publish' and review['reviewer'] == 'Codex' and
                len(review['semanticRationale']) >= 15 and review['expertCertified'] is False,
                'missing_editorial_review')
        sense_id = 'learning-sense-' + sha(word['id'] + '\0' + draft['key'])
        bindings = []
        for selected in draft['sources']:
            # Equality is intentional. Substring selection, commas and shared POS
            # are never treated as evidence that two meanings correspond.
            matches = [s for s in word['senses'] if eligible(s) and
                s['definitionZh'] == selected.get('definitionZh', '') and
                s['definitionEn'] == selected.get('definitionEn', '') and
                s['pos'] == selected['pos']]
            require(len(matches) == 1, 'ambiguous_or_changed_source:' + draft['lemma'] + ':' + draft['key'])
            source_sense = matches[0]
            require(source_sense['wordId'] == word['id'], 'cross_word_source_identity')
            require(selected['relation'] in ('exact', 'narrower', 'corrected-from'), 'invalid_source_relation')
            require(len(selected['reason']) >= 10, 'missing_source_relation_reason')
            bindings.append(dict(id='sense-binding-' + sha(sense_id + '\0' + source_sense['id']),
                wordId=word['id'], learningSenseId=sense_id, sourceSenseId=source_sense['id'],
                relation=selected['relation'], sourcePosSha256=sha(source_sense['pos']),
                sourceDefinitionZhSha256=sha(source_sense['definitionZh']),
                sourceDefinitionEnSha256=sha(source_sense['definitionEn']),
                contentMetadata=dict(reason=selected['reason'], sourceVersion=word['contentVersion'],
                                     review=review)))
        require(bindings and len({b['sourceSenseId'] for b in bindings}) == len(bindings), 'missing_or_duplicate_binding')
        examples = []
        for index, example in enumerate(draft['examples']):
            en, zh, context = example['en'], example['zh'], example['context']
            require(en.strip() == en and len(en) >= 15 and re.search('[\u4e00-\u9fff]', zh), 'invalid_bilingual_example')
            require(context.strip() and len(example['semanticRationale']) >= 15, 'missing_example_semantic_review')
            surface = example.get('surface', draft['lemma'])
            require(exact_target(surface, en), 'target_surface_absent:' + draft['lemma'])
            require(surface == draft['lemma'] or example.get('surfaceKind') in
                    ('inflected-form', 'pronoun-slot', 'object-insertion'), 'unreviewed_target_surface')
            text_hash = sha(audio_text(en))
            previous = sentence_usage.get((word['id'], text_hash))
            require(previous is None, 'duplicate_sentence_across_meanings:' + draft['lemma'])
            sentence_usage[(word['id'], text_hash)] = sense_id
            examples.append(dict(id='sense-example-' + sha(sense_id + '\0' + en),
                wordId=word['id'], learningSenseId=sense_id, contextLabel=context,
                exampleEn=en, exampleZh=zh, ordinal=index, status='published', contentVersion=version,
                contentMetadata=dict(kind='original-authoring', author='NightStudy contributors',
                    authoringMethod='Direct Codex bilingual writing', license='MIT', review='codex-reviewed',
                    expertCertified=False, semanticRationale=example['semanticRationale'],
                    exampleEnSha256=sha(en), exampleZhSha256=sha(zh), textHash=text_hash,
                    targetSurface=dict(lemma=draft['lemma'], form=surface,
                        kind=example.get('surfaceKind', 'exact'), review='codex-reviewed'))))
        require(len(examples) >= 2 and len({e['contextLabel'] for e in examples}) >= 2,
                'two_distinct_contexts_required:' + draft['lemma'])
        sense = dict(id=sense_id, wordId=word['id'], pos=draft['pos'],
            definitionZh=draft['definitionZh'], definitionEn=draft['definitionEn'],
            ordinal=draft['ordinal'], status='published', contentVersion=version,
            contentMetadata=dict(kind='original-authoring', author='NightStudy contributors',
                authoringMethod='Direct Codex bilingual writing', license='MIT',
                review='codex-reviewed', expertCertified=False, editorialReview=review,
                semanticKey=draft['key']), sourceBindings=bindings, examples=examples)
        if draft.get('pronunciation'):
            require(draft['pronunciation']['wordAudioCompatible'] is False and
                    len(draft['pronunciation']['reason']) >= 15, 'unsupported_pronunciation_policy')
            sense['contentMetadata']['pronunciation'] = draft['pronunciation']
        sense['bindingHash'] = binding_hash(sense)
        output.setdefault(word['normalizedLemma'], dict(wordId=word['id'],
            normalizedLemma=word['normalizedLemma'], senses=[]))['senses'].append(sense)
    return sorted(output.values(), key=lambda row: row['normalizedLemma'])


def inventory(source, rows):
    completed = {row['wordId']: row for row in rows}
    gaps, candidates = [], []
    for word in source:
        if word.get('withdrawn'):
            continue
        current = completed.get(word['id'], {}).get('senses', [])
        bound = {b['sourceSenseId'] for s in current for b in s['sourceBindings']}
        senses = [s for s in word['senses'] if eligible(s)]
        gaps.append(dict(wordId=word['id'], lemma=word['normalizedLemma'],
            sourceSenseRows=len(senses), curatedLearningSenses=len(current),
            pairedContextExamples=sum(len(s['examples']) for s in current),
            status='partially-curated' if current else 'atomic-review-required',
            remainingAtomicMeaningCount=None,
            unboundSourceSenseIds=[s['id'] for s in senses if s['id'] not in bound],
            note='Source rows are not atomic meaning counts; no exhaustive coverage claim.'))
        for example in [*word['examples'], *[s for s in senses if s.get('exampleEn')]]:
            candidates.append(dict(wordId=word['id'], lemma=word['normalizedLemma'],
                candidateId=example['id'], exampleEn=example['exampleEn'],
                exampleZh=example.get('exampleZh', ''), status='unbound-candidate',
                sourceTextSha256=sha(example['exampleEn']),
                contentMetadata=example.get('contentMetadata', {})))
    return gaps, candidates


def authoring_queue(source, rows, candidates):
    """Export every active word for continued editorial work, with no auto joins."""
    meanings = {row['wordId']: row['senses'] for row in rows}
    candidate_ids = {}
    for candidate in candidates:
        candidate_ids.setdefault(candidate['wordId'], []).append(candidate['candidateId'])
    for word in source:
        if word.get('withdrawn'):
            continue
        yield dict(wordId=word['id'], normalizedLemma=word['normalizedLemma'],
            sourceRef=word['sourceRef'], sourceContentVersion=word['contentVersion'],
            status='partially-curated' if word['id'] in meanings else 'atomic-review-required',
            exhaustiveMeaningInventoryReviewed=False,
            sourceSenses=[dict(id=sense['id'], pos=sense['pos'],
                definitionZh=sense['definitionZh'], definitionEn=sense['definitionEn'],
                sourcePosSha256=sha(sense['pos']),
                sourceDefinitionZhSha256=sha(sense['definitionZh']),
                sourceDefinitionEnSha256=sha(sense['definitionEn']),
                contentMetadata=sense.get('contentMetadata', {}))
                for sense in word['senses'] if eligible(sense)],
            curatedLearningSenses=[dict(id=sense['id'], pos=sense['pos'],
                semanticKey=sense['contentMetadata']['semanticKey'],
                definitionZh=sense['definitionZh'], definitionEn=sense['definitionEn'],
                sourceSenseIds=[b['sourceSenseId'] for b in sense['sourceBindings']],
                contexts=[e['contextLabel'] for e in sense['examples']])
                for sense in meanings.get(word['id'], [])],
            unboundCandidateIds=candidate_ids.get(word['id'], []))


def write_lines(path, rows):
    data = ''.join(canonical(row) + '\n' for row in rows).encode('utf-8')
    Path(path).write_bytes(data)
    return data


def pack_bytes(raw):
    # gzip.compress(mtime=0) delegates headers to zlib in some Python releases,
    # yielding platform-dependent OS bytes. GzipFile pins the portable header.
    stream = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0, compresslevel=9) as packed:
        packed.write(raw)
    return stream.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--source-sha256', required=True)
    parser.add_argument('--bilingual-manifest', required=True)
    parser.add_argument('--drafts', action='append', required=True,
                        help='Explicit authored JSON/JSONL; repeat for independently reviewed batches.')
    parser.add_argument('--output', required=True)
    parser.add_argument('--pack-id', default='learning-senses-v1')
    parser.add_argument('--version')
    args = parser.parse_args()
    require(re.fullmatch(r'learning-senses-[a-z0-9-]+', args.pack_id), 'invalid_learning_sense_pack_id')
    version = args.version or args.pack_id
    source_bytes = Path(args.source).read_bytes()
    require(sha(source_bytes) == args.source_sha256, 'source_checksum_mismatch')
    manifest_path = Path(args.bilingual_manifest)
    overlay_manifest = json.loads(manifest_path.read_text())
    require(overlay_manifest['sourceExportSha256'] == sha(source_bytes), 'overlay_source_export_mismatch')
    overlay_bytes = (manifest_path.parent / overlay_manifest['fileName']).read_bytes()
    require(sha(overlay_bytes) == overlay_manifest['sha256'], 'overlay_checksum_mismatch')
    decoded = gzip.decompress(overlay_bytes)
    require(sha(decoded) == overlay_manifest['jsonlSha256'], 'overlay_decoded_checksum_mismatch')
    source = merge_source([json.loads(line) for line in source_bytes.splitlines() if line],
                          [json.loads(line) for line in decoded.splitlines() if line])
    rows = compile_rows(source, [draft for path in args.drafts for draft in load_drafts(path)], version)
    require(rows, 'empty_learning_sense_pack')
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    raw = write_lines(output / (args.pack_id + '.jsonl'), rows)
    packed = pack_bytes(raw)
    (output / (args.pack_id + '.jsonl.gz')).write_bytes(packed)
    gaps, candidates = inventory(source, rows)
    write_lines(output / 'learning-senses-progress.jsonl', gaps)
    write_lines(output / 'learning-senses-candidates.jsonl', candidates)
    write_lines(output / 'learning-senses-authoring-queue.jsonl', authoring_queue(source, rows, candidates))
    audio = [dict(exampleEn=e['exampleEn'], text=audio_text(e['exampleEn']), textHash=e['contentMetadata']['textHash'],
                  source=dict(author='NightStudy contributors', license='MIT', kind='original-authoring'),
                  bundle=args.pack_id)
        for row in rows for sense in row['senses'] for e in sense['examples']]
    write_lines(output / 'learning-senses-sentences.jsonl', audio)
    report = dict(formatVersion=1, id=args.pack_id, version=version,
        fileName=args.pack_id + '.jsonl.gz', bytes=len(packed), sha256=sha(packed),
        jsonlSha256=sha(raw), sourceExportSha256=sha(source_bytes),
        bilingualOverlaySha256=sha(overlay_bytes),
        draftsSha256=sha(canonical([dict(fileName=Path(path).name, sha256=sha(Path(path).read_bytes()))
                                   for path in args.drafts])),
        sourceUrl='https://github.com/wudi000888-svg/nightstudy', license='MIT',
        wordCount=len(rows), senseCount=sum(len(r['senses']) for r in rows),
        exampleCount=len(audio), scope='Explicitly curated atomic senses; all remaining meanings stay incomplete.',
        editorialReview='codex-reviewed', semanticQualityCertified=False,
        activeBookWords=len(gaps), wordsWithCuratedMeanings=len(rows),
        wordsAwaitingAtomicReview=len(gaps)-len(rows), totalRemainingAtomicMeaningCount=None,
        wordLevelCandidateCount=len(candidates), exhaustiveBookCoverage=False)
    (output / (args.pack_id + '.manifest.json')).write_text(json.dumps(report, ensure_ascii=False,
        sort_keys=True, indent=2) + '\n')
    progress = dict(activeBookCount=len(overlay_manifest.get('catalog', {}).get('books', [])),
        activeBookWords=len(gaps), sourceSenseRows=sum(gap['sourceSenseRows'] for gap in gaps),
        wordsWithSomeCuratedMeanings=len(rows), curatedLearningSenses=report['senseCount'],
        bilingualContextExamples=len(audio), partiallyCuratedWords=len(rows),
        wordsAwaitingAtomicReview=len(gaps)-len(rows), exhaustivelyReviewedWords=0,
        totalRemainingAtomicMeaningCount=None, totalRemainingContextExampleCount=None,
        unboundWordLevelAndEmbeddedCandidates=len(candidates),
        scope='Every source word has a queue row; source rows are not independent meaning counts.',
        sourceExportSha256=sha(source_bytes), bilingualOverlaySha256=sha(overlay_bytes),
        currentPackSha256=sha(packed))
    (output / 'learning-senses-progress.summary.json').write_text(json.dumps(progress,
        ensure_ascii=False, sort_keys=True, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
