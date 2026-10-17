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
import shutil
import unicodedata
from pathlib import Path
from urllib.parse import urlparse

MAX_BYTES = 64 * 1024 * 1024
MAX_WORDS = 1000
MAX_COLLECTION_BYTES = 512 * 1024 * 1024
PARTS_OF_SPEECH = ('n.', 'v.', 'vt.', 'vi.', 'adj.', 'adv.', 'prep.', 'pron.',
    'det.', 'art.', 'conj.', 'interj.', 'num.', 'aux.', 'modal v.', 'part.', 'abbr.',
    'phr. v.', 'n. phr.', 'prep. phr.', 'adv. phr.', 'adj. phr.', 'conj. phr.',
    'pron. phr.', 'det. phr.', 'modal phr.', 'idiom')
PUBLIC_LICENSES = ('MIT', 'WordNet-3.0', 'LicenseRef-Chinese-Open-WordNet',
    'CC-BY-2.0-FR', 'CC-BY-3.0', 'CC-BY-4.0', 'CC0-1.0')


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


def reviewed_orthography(draft, normalized_lemma, review):
    """Only an explicit author decision may select a sense's case-sensitive spelling."""
    if 'displayLemma' not in draft:
        require('displayLemmaReason' not in draft, 'orphan_display_lemma_reason')
        return None
    display = draft['displayLemma']
    reason = draft.get('displayLemmaReason', review['semanticRationale'])
    require(isinstance(display, str) and 1 <= len(display) <= 500 and
        display == re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', display)).strip() and
        display.lower() == normalized_lemma,
        'display_lemma_must_differ_only_in_case')
    require(isinstance(reason, str) and 15 <= len(reason) <= 4000,
        'missing_display_lemma_review')
    return dict(displayLemma=display, normalizedLemma=normalized_lemma,
        displayLemmaSha256=sha(display), reviewer='Codex', decision='publish',
        expertCertified=False, reason=reason)


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


def provenance_metadata(fields, field_sources):
    """Keep public source text, attribution and its actual license on every reused field."""
    if field_sources is None:
        return {}
    require(set(field_sources) == set(fields), 'missing_field_provenance')
    output = {}
    public_fields = 0
    for field, original in field_sources.items():
        origin = copy.deepcopy(original)
        require(origin.get('textSha256', sha(fields[field])) == sha(fields[field]), 'public_text_changed')
        origin['textSha256'] = sha(fields[field])
        require(isinstance(origin.get('author'), str) and origin['author'].strip(), 'missing_public_author')
        if origin.get('kind') == 'original-authoring':
            require(set(origin) == {'kind', 'license', 'author', 'textSha256'} and
                    origin['license'] == 'MIT', 'invalid_original_provenance')
        else:
            public_fields += 1
            require(set(origin) == {'kind', 'license', 'author', 'attribution', 'sourceName',
                'sourceUrl', 'sourceText', 'sourceTextSha256', 'sourceSnapshotSha256',
                'licenseNoticeSha256', 'textSha256'}, 'invalid_public_provenance_fields')
            require(origin['kind'] in ('corpus', 'translation') and origin['license'] in PUBLIC_LICENSES,
                    'invalid_public_license_or_kind')
            require(isinstance(origin['attribution'], str) and len(origin['attribution'].strip()) >= 10 and
                    isinstance(origin['sourceName'], str) and origin['sourceName'].strip(), 'missing_public_attribution')
            url = urlparse(origin['sourceUrl'])
            require(url.scheme == 'https' and url.hostname and not url.username and not url.password,
                    'invalid_public_source_url')
            require(isinstance(origin['sourceText'], str) and 0 < len(origin['sourceText']) <= 4000 and
                    sha(origin['sourceText']) == origin['sourceTextSha256'], 'public_source_text_mismatch')
            require(all(isinstance(origin[key], str) and re.fullmatch('[a-f0-9]{64}', origin[key])
                for key in ('sourceSnapshotSha256', 'licenseNoticeSha256')), 'invalid_public_provenance_hash')
            require(origin['kind'] != 'corpus' or origin['sourceText'] == fields[field], 'changed_corpus_text')
        output[field] = origin
    require(public_fields, 'public_provenance_without_public_field')
    return dict(kind='reviewed-public-content', license='mixed', fieldSources=output,
        author='See per-field source attribution',
        authoringMethod='Reviewed public corpus selection and direct Codex bilingual translation or authorship')


def original_source_addition(word, key, pos, definition_zh, definition_en, rationale):
    """Encode explicitly authored text; this helper never invents a definition or semantic review."""
    return dict(id='learning-source-'+sha(word['id']+'\0'+key), wordId=word['id'],
        normalizedLemma=word['normalizedLemma'],pos=pos,definitionZh=definition_zh,definitionEn=definition_en,
        exampleEn='',exampleZh='',ordinal=1000000+int(sha(key)[:7],16),contentMetadata=dict(
            kind='original-authoring',evidenceKind='codex-original-source-addition',author='NightStudy contributors',
            license='MIT',authoringMethod='Direct Codex bilingual writing',review='codex-reviewed',
            expertCertified=False,sourceAdditionVersion='codex-original-source-v1',semanticKey=key,
            definitionZhSha256=sha(definition_zh),definitionEnSha256=sha(definition_en),
            editorialReview=dict(decision='publish',reviewer='Codex',expertCertified=False,semanticRationale=rationale)))


def validate_source_addition(row, active):
    require(isinstance(row,dict) and set(row)=={'id','wordId','normalizedLemma','pos','definitionZh','definitionEn',
        'exampleEn','exampleZh','ordinal','contentMetadata'},'invalid_source_addition_fields')
    word=active.get(row['normalizedLemma']); meta=row['contentMetadata']
    require(word and word['id']==row['wordId'] and not word.get('withdrawn'),'source_addition_word_not_active')
    require(row['pos'] in PARTS_OF_SPEECH and isinstance(row['definitionZh'],str) and
        0<len(row['definitionZh'])<=4000 and re.search('[\u4e00-\u9fff]',row['definitionZh']) and
        isinstance(row['definitionEn'],str) and 0<len(row['definitionEn'])<=4000 and
        re.search('[A-Za-z]',row['definitionEn']) and not re.search('[\u4e00-\u9fff]',row['definitionEn']),
        'source_addition_invalid_bilingual_definition')
    require(isinstance(meta,dict) and isinstance(meta.get('semanticKey'),str) and
            re.fullmatch('[a-z0-9-]+',meta['semanticKey']),'source_addition_invalid_key')
    review=meta.get('editorialReview',{})
    require(isinstance(review,dict) and set(review)=={'decision','reviewer','expertCertified','semanticRationale'} and
        review['decision']=='publish' and review['reviewer']=='Codex' and review['expertCertified'] is False and
        isinstance(review['semanticRationale'],str) and 15<=len(review['semanticRationale'])<=4000,
        'source_addition_missing_review')
    expected=original_source_addition(word,meta['semanticKey'],row['pos'],row['definitionZh'],row['definitionEn'],review['semanticRationale'])
    require(row==expected,'source_addition_identity_or_metadata_drift')
    return row


def append_source_additions(source, path, expected_sha):
    require(bool(path)==bool(expected_sha),'source_additions_pin_required')
    if not path:return source,[]
    file=Path(path)
    require(not file.is_symlink() and file.stat().st_size<=MAX_COLLECTION_BYTES,'unsafe_source_additions_input')
    raw=file.read_bytes();require(sha(raw)==expected_sha,'source_additions_input_checksum')
    additions=[json.loads(line) for line in raw.splitlines() if line]
    require(0<len(additions)<=100000,'source_additions_input_count')
    source=copy.deepcopy(source)
    active={w['normalizedLemma']:w for w in source if not w.get('withdrawn')}
    existing={s['id'] for word in source for s in word['senses']}
    for row in additions:
        validate_source_addition(row,active)
        require(row['id'] not in existing,'duplicate_source_addition_identity');existing.add(row['id'])
        active[row['normalizedLemma']]['senses'].append({k:v for k,v in row.items() if k!='normalizedLemma'})
    return source,additions


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
        require(draft['pos'] in PARTS_OF_SPEECH, 'invalid_pos')
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
                contentMetadata=dict(reason=selected['reason'], sourceVersion=source_sense.get('contentMetadata',{}).get('sourceAdditionVersion',word['contentVersion']),
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
                    ('inflected-form', 'pronoun-slot', 'object-insertion', 'punctuation-variant'), 'unreviewed_target_surface')
            if example.get('surfaceKind') == 'punctuation-variant':
                require(all(re.fullmatch(r'[A-Za-z]+(?:\.[A-Za-z]+)*\.?', value)
                            for value in (surface, draft['lemma'])) and
                        surface.casefold() != draft['lemma'].casefold() and
                        surface.replace('.', '').casefold() == draft['lemma'].replace('.', '').casefold(),
                        'invalid_punctuation_variant')
            text_hash = sha(audio_text(en))
            previous = sentence_usage.get((word['id'], text_hash))
            require(previous is None, 'duplicate_sentence_across_meanings:' + draft['lemma'])
            sentence_usage[(word['id'], text_hash)] = sense_id
            example_record = dict(id='sense-example-' + sha(sense_id + '\0' + en),
                wordId=word['id'], learningSenseId=sense_id, contextLabel=context,
                exampleEn=en, exampleZh=zh, ordinal=index, status='published', contentVersion=version,
                contentMetadata=dict(kind='original-authoring', author='NightStudy contributors',
                    authoringMethod='Direct Codex bilingual writing', license='MIT', review='codex-reviewed',
                    expertCertified=False, semanticRationale=example['semanticRationale'],
                    exampleEnSha256=sha(en), exampleZhSha256=sha(zh), textHash=text_hash,
                    targetSurface=dict(lemma=draft['lemma'], form=surface,
                        kind=example.get('surfaceKind', 'exact'), review='codex-reviewed')))
            example_record['contentMetadata'].update(provenance_metadata(
                dict(exampleEn=en, exampleZh=zh), example.get('fieldSources')))
            examples.append(example_record)
        require(len(examples) >= 2 and len({e['contextLabel'] for e in examples}) >= 2,
                'two_distinct_contexts_required:' + draft['lemma'])
        sense = dict(id=sense_id, wordId=word['id'], pos=draft['pos'],
            definitionZh=draft['definitionZh'], definitionEn=draft['definitionEn'],
            ordinal=draft['ordinal'], status='published', contentVersion=version,
            contentMetadata=dict(kind='original-authoring', author='NightStudy contributors',
                authoringMethod='Direct Codex bilingual writing', license='MIT',
                review='codex-reviewed', expertCertified=False, editorialReview=review,
                semanticKey=draft['key']), sourceBindings=bindings, examples=examples)
        sense['contentMetadata'].update(provenance_metadata(dict(definitionZh=draft['definitionZh'],
            definitionEn=draft['definitionEn']), draft.get('fieldSources')))
        orthography = reviewed_orthography(draft, word['normalizedLemma'], review)
        if orthography is not None:
            sense['contentMetadata']['orthography'] = orthography
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
            focus=copy.deepcopy(word.get('focus', [])), primarySenseId=word.get('primarySenseId'),
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


def word_union_hash(rows):
    return sha(canonical(sorted([dict(wordId=row['wordId'], normalizedLemma=row['normalizedLemma'])
        for row in rows], key=lambda row: (row['wordId'], row['normalizedLemma']))))


def validate_collection_union(required_words, leaves):
    """Required identities come from a separately pinned target, never compiled successes."""
    require(isinstance(required_words, list) and 0 < len(required_words) <= 100000,
            'missing_independent_required_words')
    expected = []
    for word in required_words:
        require(isinstance(word, dict) and set(word) == {'wordId', 'normalizedLemma'} and
                all(isinstance(word[key], str) and word[key] for key in word), 'invalid_required_word')
        expected.append((word['wordId'], word['normalizedLemma']))
    require(len({w[0] for w in expected}) == len(expected) and
            len({w[1] for w in expected}) == len(expected), 'duplicate_required_word')
    words, lemmas, identities, pack_ids = set(), set(), set(), set()
    actual = []
    decoded_bytes = 0
    for manifest, rows in leaves:
        require(manifest['id'] not in pack_ids, 'duplicate_shard_id')
        pack_ids.add(manifest['id'])
        require(0 < len(rows) <= MAX_WORDS, 'too_many_words_in_shard')
        for row in rows:
            decoded_bytes += len(canonical(row).encode('utf-8')) + 1
            require(decoded_bytes <= MAX_COLLECTION_BYTES, 'collection_decoded_limit')
            require(row['wordId'] not in words and row['normalizedLemma'] not in lemmas, 'word_crosses_shards')
            words.add(row['wordId']); lemmas.add(row['normalizedLemma']); actual.append((row['wordId'], row['normalizedLemma']))
            for sense in row['senses']:
                for record in [sense, *sense['sourceBindings'], *sense['examples']]:
                    require(record['id'] not in identities, 'global_duplicate_identity')
                    identities.add(record['id'])
    require(set(actual) == set(expected), 'collection_required_union_mismatch')
    return word_union_hash(required_words)


def load_baseline(manifest_path):
    require(not manifest_path.is_symlink() and manifest_path.stat().st_size <= 1024 * 1024,
            'unsafe_baseline_manifest')
    manifest = json.loads(manifest_path.read_text())
    require(manifest['formatVersion'] == 1 and re.fullmatch(r'learning-senses-[a-z0-9-]+', manifest['id']) and
            re.fullmatch(r'[a-z0-9.-]+\.jsonl\.gz', manifest['fileName']), 'invalid_baseline_manifest')
    payload = manifest_path.parent / manifest['fileName']
    require(not payload.is_symlink() and payload.stat().st_size == manifest['bytes'] and
            payload.stat().st_size <= MAX_BYTES, 'unsafe_baseline_payload')
    packed = payload.read_bytes()
    require(sha(packed) == manifest['sha256'], 'baseline_checksum_mismatch')
    with gzip.GzipFile(fileobj=io.BytesIO(packed)) as handle:
        raw = handle.read(MAX_BYTES + 1)
    require(len(raw) <= MAX_BYTES and sha(raw) == manifest['jsonlSha256'], 'baseline_decoded_checksum_or_limit')
    rows = [json.loads(line) for line in raw.splitlines() if line]
    require(len(rows) == manifest['wordCount'] and len(rows) <= MAX_WORDS and
            sum(len(row['senses']) for row in rows) == manifest['senseCount'] and
            sum(len(s['examples']) for row in rows for s in row['senses']) == manifest['exampleCount'],
            'baseline_count_mismatch')
    notice_names = set()
    for notice in manifest.get('licenseNotices', []):
        require(set(notice) == {'fileName', 'bytes', 'sha256'} and
                re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', notice['fileName']) and
                notice['fileName'] not in notice_names, 'unsafe_baseline_license_notice')
        notice_names.add(notice['fileName'])
        file = manifest_path.parent / notice['fileName']
        require(not file.is_symlink() and 0 < file.stat().st_size <= 128 * 1024 and
                file.stat().st_size == notice['bytes'] and sha(file.read_bytes()) == notice['sha256'],
                'baseline_license_notice_checksum_mismatch')
    return manifest, rows


def collect_notices(paths):
    result, names, hashes = [], set(), set()
    for path in paths:
        path = Path(path)
        require(not path.is_symlink() and path.is_file() and path.stat().st_size <= 128 * 1024 and
                re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', path.name), 'unsafe_license_notice')
        raw = path.read_bytes()
        require(raw and path.name not in names and sha(raw) not in hashes, 'duplicate_or_empty_license_notice')
        names.add(path.name); hashes.add(sha(raw))
        result.append(dict(fileName=path.name, bytes=len(raw), sha256=sha(raw)))
    return sorted(result, key=lambda item: item['fileName'])


def leaf_report(source, rows, source_bytes, overlay_bytes, draft_paths, pack_id, version, output, notices, source_additions=None):
    require(0 < len(rows) <= MAX_WORDS, 'too_many_words_in_shard')
    raw = ''.join(canonical(row) + '\n' for row in rows).encode('utf-8')
    require(len(raw) <= MAX_BYTES, 'shard_exceeds_decoded_limit')
    packed = pack_bytes(raw)
    require(len(packed) <= MAX_BYTES, 'shard_exceeds_compressed_limit')
    pinned = {notice['sha256'] for notice in notices}
    public_content = False
    for row in rows:
        for sense in row['senses']:
            for record in [sense, *sense['examples']]:
                for origin in record['contentMetadata'].get('fieldSources', {}).values():
                    if origin['kind'] != 'original-authoring':
                        public_content = True
                        require(origin['licenseNoticeSha256'] in pinned, 'missing_public_license_notice')
    (output / (pack_id + '.jsonl')).write_bytes(raw)
    (output / (pack_id + '.jsonl.gz')).write_bytes(packed)
    gaps, candidates = inventory(source, rows)
    report = dict(formatVersion=1, id=pack_id, version=version,
        fileName=pack_id + '.jsonl.gz', bytes=len(packed), sha256=sha(packed),
        jsonlSha256=sha(raw), sourceExportSha256=sha(source_bytes), bilingualOverlaySha256=sha(overlay_bytes),
        draftsSha256=sha(canonical([dict(fileName=Path(path).name, sha256=sha(Path(path).read_bytes())) for path in draft_paths])),
        sourceUrl='https://github.com/wudi000888-svg/nightstudy', license='mixed' if public_content else 'MIT',
        wordCount=len(rows), senseCount=sum(len(r['senses']) for r in rows),
        exampleCount=sum(len(s['examples']) for row in rows for s in row['senses']),
        scope='Explicitly curated atomic senses; all remaining meanings stay incomplete.',
        editorialReview='codex-reviewed', semanticQualityCertified=False,
        activeBookWords=len(gaps), wordsWithCuratedMeanings=len(rows), wordsAwaitingAtomicReview=len(gaps)-len(rows),
        totalRemainingAtomicMeaningCount=None, wordLevelCandidateCount=len(candidates), exhaustiveBookCoverage=False)
    if public_content:
        report['licenseNotices'] = notices
    bound={binding['sourceSenseId'] for row in rows for sense in row['senses'] for binding in sense['sourceBindings']}
    additions=sorted([row for row in source_additions or [] if row['id'] in bound],key=lambda row:row['id'])
    require(len(additions)<=1000,'too_many_source_additions_in_shard')
    if additions:
        source_raw=''.join(canonical(row)+'\n' for row in additions).encode('utf-8')
        require(len(source_raw)+len(raw)<=MAX_BYTES,'source_additions_decoded_limit')
        source_packed=pack_bytes(source_raw)
        require(len(source_packed)<=MAX_BYTES,'source_additions_compressed_limit')
        name='learning-sense-sources-'+pack_id.removeprefix('learning-senses-')+'.jsonl.gz'
        (output/name).write_bytes(source_packed)
        report['sourceAdditions']=dict(fileName=name,bytes=len(source_packed),sha256=sha(source_packed),
            jsonlSha256=sha(source_raw),rowCount=len(additions))
    (output / (pack_id + '.manifest.json')).write_text(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + '\n')
    return report


def emit_collection(source, new_rows, source_bytes, overlay_bytes, args, output, notices, source_additions=None):
    require(args.required_words and args.required_words_sha256, 'independent_required_words_pin_required')
    required_raw = Path(args.required_words).read_bytes()
    require(sha(required_raw) == args.required_words_sha256, 'required_words_checksum_mismatch')
    required = json.loads(required_raw)
    active = [dict(wordId=w['id'], normalizedLemma=w['normalizedLemma']) for w in source if not w.get('withdrawn')]
    require(word_union_hash(required) == word_union_hash(active) and len(required) == len(active),
            'required_words_differ_from_pinned_active_catalog')
    require(re.fullmatch(r'learning-senses-collection-[a-z0-9-]+', args.collection_id), 'invalid_collection_id')
    leaves, manifest_files = [], []
    for baseline_path in args.baseline_manifest:
        baseline_path = Path(baseline_path)
        manifest, rows = load_baseline(baseline_path)
        require(manifest['sourceExportSha256'] == sha(source_bytes) and
                manifest['bilingualOverlaySha256'] == sha(overlay_bytes), 'baseline_source_mismatch')
        require(re.fullmatch(r'learning-senses-[a-z0-9.-]+\.manifest\.json', baseline_path.name), 'invalid_baseline_manifest_name')
        require(not manifest.get('sourceAdditions'),'source_additions_baseline_requires_original_source_projection')
        for file_name in [baseline_path.name, manifest['fileName'], *[n['fileName'] for n in manifest.get('licenseNotices', [])]]:
            source_file, target = baseline_path.parent / file_name, output / file_name
            require(not target.exists() and not source_file.is_symlink(), 'collection_output_conflict')
            shutil.copyfile(source_file, target)
        leaves.append((manifest, rows)); manifest_files.append(output / baseline_path.name)
    addition_ids={row['id'] for row in source_additions or []}
    chunks=[];current=[];source_count=0
    for row in new_rows:
        count=len({b['sourceSenseId'] for s in row['senses'] for b in s['sourceBindings']} & addition_ids)
        require(count<=1000,'too_many_source_additions_for_word')
        if current and (len(current)>=args.shard_words or source_count+count>1000):
            chunks.append(current);current=[];source_count=0
        current.append(row);source_count+=count
    if current:chunks.append(current)
    for index,chunk in enumerate(chunks):
        shard_id = args.collection_id.replace('learning-senses-collection-', 'learning-senses-') + '-shard-' + str(index+1).zfill(4)
        rows = copy.deepcopy(chunk)
        for row in rows:
            for sense in row['senses']:
                sense['contentVersion'] = shard_id
                for example in sense['examples']:
                    example['contentVersion'] = shard_id
                sense['bindingHash'] = binding_hash(sense)
        manifest = leaf_report(source, rows, source_bytes, overlay_bytes, args.drafts, shard_id, shard_id, output, notices,source_additions)
        leaves.append((manifest, rows)); manifest_files.append(output / (shard_id + '.manifest.json'))
    union_hash = validate_collection_union(required, leaves)
    total_source_bytes=sum(len(canonical(row).encode('utf-8'))+1 for row in source_additions or [])
    total_meaning_bytes=sum(len(canonical(row).encode('utf-8'))+1 for _,part in leaves for row in part)
    require(total_source_bytes+total_meaning_bytes<=MAX_COLLECTION_BYTES,'collection_decoded_limit')
    rows = [row for _, part in leaves for row in part]
    collection = dict(formatVersion=2, kind='learning-senses-collection', id=args.collection_id,
        version=args.version or args.collection_id, sourceExportSha256=sha(source_bytes), bilingualOverlaySha256=sha(overlay_bytes),
        requiredWordCount=len(required), requiredWordsSha256=union_hash, wordCount=len(rows),
        senseCount=sum(len(row['senses']) for row in rows), exampleCount=sum(len(s['examples']) for row in rows for s in row['senses']),
        editorialReview='codex-reviewed', semanticQualityCertified=False, exhaustiveBookCoverage=False,
        shards=[dict(manifestFileName=file.name, bytes=file.stat().st_size, sha256=sha(file.read_bytes()),
            id=manifest['id'], wordCount=manifest['wordCount'], senseCount=manifest['senseCount'],
            exampleCount=manifest['exampleCount']) for (manifest,_),file in zip(leaves, manifest_files)])
    (output / (args.collection_id + '.manifest.json')).write_text(json.dumps(collection, ensure_ascii=False, sort_keys=True, indent=2) + '\n')
    return collection, rows


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
    parser.add_argument('--collection-id')
    parser.add_argument('--required-words', help='Independent JSON array of exact wordId/normalizedLemma targets.')
    parser.add_argument('--required-words-sha256')
    parser.add_argument('--baseline-manifest', action='append', default=[])
    parser.add_argument('--shard-words', type=int, default=1000)
    parser.add_argument('--license-notice', action='append', default=[])
    parser.add_argument('--source-additions')
    parser.add_argument('--source-additions-sha256')
    args = parser.parse_args()
    require(1 <= args.shard_words <= MAX_WORDS, 'invalid_shard_word_limit')
    require(bool(args.collection_id) or not (args.required_words or args.required_words_sha256 or args.baseline_manifest),
            'collection_options_require_collection_id')
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
    source,source_additions=append_source_additions(source,args.source_additions,args.source_additions_sha256)
    rows = compile_rows(source, [draft for path in args.drafts for draft in load_drafts(path)], version)
    used_sources={b['sourceSenseId'] for row in rows for sense in row['senses'] for b in sense['sourceBindings']}
    require(all(row['id'] in used_sources for row in source_additions),'unbound_original_source_addition')
    require(rows or args.baseline_manifest, 'empty_learning_sense_pack')
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    notices = collect_notices(args.license_notice)
    for filename in args.license_notice:
        target = output / Path(filename).name
        require(not target.exists(), 'license_notice_output_conflict')
        shutil.copyfile(filename, target)
    if args.collection_id:
        report, rows = emit_collection(source, rows, source_bytes, overlay_bytes, args, output, notices,source_additions)
        current_sha = sha((output / (args.collection_id + '.manifest.json')).read_bytes())
    else:
        report = leaf_report(source, rows, source_bytes, overlay_bytes, args.drafts,
            args.pack_id, version, output, notices,source_additions)
        current_sha = report['sha256']
    gaps, candidates = inventory(source, rows)
    write_lines(output / 'learning-senses-progress.jsonl', gaps)
    write_lines(output / 'learning-senses-candidates.jsonl', candidates)
    write_lines(output / 'learning-senses-authoring-queue.jsonl', authoring_queue(source, rows, candidates))
    audio = [dict(exampleEn=e['exampleEn'], text=audio_text(e['exampleEn']), textHash=e['contentMetadata']['textHash'],
                  source=(copy.deepcopy(e['contentMetadata']) if e['contentMetadata']['kind'] != 'original-authoring'
                    else dict(author='NightStudy contributors', license='MIT', kind='original-authoring')),
                  bundle=args.collection_id or args.pack_id)
        for row in rows for sense in row['senses'] for e in sense['examples']]
    write_lines(output / 'learning-senses-sentences.jsonl', audio)
    progress = dict(activeBookCount=len(overlay_manifest.get('catalog', {}).get('books', [])),
        activeBookWords=len(gaps), sourceSenseRows=sum(gap['sourceSenseRows'] for gap in gaps),
        wordsWithSomeCuratedMeanings=len(rows), curatedLearningSenses=report['senseCount'],
        bilingualContextExamples=len(audio), partiallyCuratedWords=len(rows),
        wordsAwaitingAtomicReview=len(gaps)-len(rows), exhaustivelyReviewedWords=0,
        totalRemainingAtomicMeaningCount=None, totalRemainingContextExampleCount=None,
        unboundWordLevelAndEmbeddedCandidates=len(candidates),
        scope='Every source word has a queue row; source rows are not independent meaning counts.',
        sourceExportSha256=sha(source_bytes), bilingualOverlaySha256=sha(overlay_bytes),
        currentPackSha256=current_sha)
    (output / 'learning-senses-progress.summary.json').write_text(json.dumps(progress,
        ensure_ascii=False, sort_keys=True, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
