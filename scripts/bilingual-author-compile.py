#!/usr/bin/env python3
"""Compile directly authored drafts and pinned public-corpus selections.

This tool joins identities and attribution; it never generates definitions,
translations or example sentences. A partial build is explicitly nonpublishable.
"""
import argparse
import copy
import gzip
import hashlib
import json
import re
from pathlib import Path


def sha(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def load_lines(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def original(**extra):
    return dict(kind='original-authoring', author='NightStudy contributors', license='MIT',
                review='pending', authoringMethod='Direct Codex-assisted bilingual writing', **extra)


def occurrence(lemma, text):
    return re.search(r'(?<![^\W\d_])' + re.escape(lemma) + r'(?![^\W\d_])', text, re.I) is not None


def learning_sense(sense):
    quality = sense.get('contentMetadata', {}).get('lexicalQuality', {})
    field = quality.get('field')
    return not (quality.get('excludeFromLearning') is True and
                field in ('definitionZh', 'definitionEn') and
                quality.get('sourceTextSha256') == sha(sense.get(field, '')))


def catalog_proof(source, reviews):
    books = []
    for book in source['books']:
        items = book['items']
        require(len({item[1] for item in items}) == len(items), 'duplicate_catalog_word')
        active = [item for item in items if item[1] not in reviews.get('withdrawals', {})]
        encode = lambda rows: json.dumps(rows, ensure_ascii=False, separators=(',', ':'))
        books.append(dict({k: book[k] for k in ('id','slug','goal','kind','version')},
            sourceWordCount=len(items), sourceItemsSha256=sha(encode(items)),
            wordCount=len(active), itemsSha256=sha(encode(active)),
            withdrawnLemmas=[item[1] for item in items if item[1] in reviews.get('withdrawals', {})]))
    return dict(books=books,sourceBookItems=sum(b['sourceWordCount'] for b in books),
                activeBookItems=sum(b['wordCount'] for b in books),
                activeWords=len({item[1] for b in source['books'] for item in b['items']
                                if item[1] not in reviews.get('withdrawals', {})}))


def compile_rows(source, drafts, inputs, ledger, reviews, overlays, extra_definitions, extra_examples=()):
    source_by_lemma = {row['normalizedLemma']: row for row in source}
    require(len(source_by_lemma) == len(source), 'duplicate_source_word')
    require(set(drafts) <= set(inputs), 'unexpected_draft_word')
    require(set(reviews.get('withdrawals', {})) <= set(source_by_lemma), 'unexpected_withdrawal')
    require(set(reviews.get('exampleCorrections', {})) <= set(source_by_lemma), 'unexpected_example_correction_word')
    require(set(reviews.get('sensePositions', {})) <= set(source_by_lemma), 'unexpected_sense_position_word')
    inputs=copy.deepcopy(inputs)
    for word in source:
        primary=next(s for s in word['senses'] if s['id']==word['primarySenseId'])
        has_example=any(e.get('exampleEn','').strip() and e.get('exampleZh','').strip()
                        for e in [*[s for s in word['senses'] if learning_sense(s)],*word['examples']])
        if word['normalizedLemma'] not in inputs and (not primary['definitionEn'].strip() or not has_example):
            inputs[word['normalizedLemma']]=dict(needD=not primary['definitionEn'].strip(),needE=not has_example)
    surface_reviews = {(item['lemma'], item['surface']): item['kind'] for item in reviews.get('surfaces', [])}
    output, pending, surfaces, audio = [], [], [], []
    counts = dict(definitionFields=0, exampleFields=0, exampleTranslations=0, posFields=0, correctedSenses=0, exampleWords=0,
                  corpusPairs=0, translatedCorpusExamples=0, originalExamples=0, withdrawals=0)
    extra_by_word = {}
    for item in extra_definitions:
        extra_by_word.setdefault(item['w'], []).append(item)
    examples_by_word = {}
    for item in extra_examples:
        examples_by_word.setdefault(item['w'], []).append(item)
    for word in source:
        lemma = word['normalizedLemma']
        row = dict(normalizedLemma=lemma, senses=[], examples=[])
        primary = next(s for s in word['senses'] if s['id'] == word['primarySenseId'])
        withdrawal = reviews.get('withdrawals', {}).get(lemma)
        if withdrawal:
            row['defaultBookWithdrawal'] = dict(withdrawal, sourceSenseId=primary['id'],
                sourceDefinitionZhSha256=sha(primary['definitionZh']), sourceRef=word['sourceRef'],
                contentVersion=word['contentVersion'])
            counts['withdrawals'] += 1
            output.append(row)
            continue
        draft = copy.deepcopy(reviews.get('overrides', {}).get(lemma, drafts.get(lemma)))
        needed = inputs.get(lemma)
        if needed and (not draft or draft.get('hold')):
            pending.append(dict(w=lemma, reason=(draft or {}).get('hold', 'not_authored')))
            draft = None
        def add_definition(sense, value, pos=None):
            require(not sense['definitionEn'], 'definition_target_already_nonempty:' + lemma)
            require(re.search('[A-Za-z]', value) and not re.search('[\u4e00-\u9fff]', value), 'invalid_english_definition:' + lemma)
            patch = dict(id=sense['id'], definitionEn=value, contentMetadata=dict(definitionEn=original(
                sourceSenseId=sense['id'], sourceLanguage='zh', sourceTextSha256=sha(sense['definitionZh']))))
            if pos:
                require(not sense['pos'], 'pos_source_not_empty:' + lemma)
                patch.update(pos=pos, sourceDefinitionZhSha256=sha(sense['definitionZh']))
                patch['contentMetadata']['pos'] = original(sourceTextSha256=sha(sense['definitionZh']))
                counts['posFields'] += 1
            row['senses'].append(patch)
            counts['definitionFields'] += 1
        def add_correction(sense, change, evidence=()):
            require(change['z'].strip() and change['d'].strip() and change['p'].strip(), 'empty_correction:' + lemma)
            identity = '\0'.join([lemma,sense['id'],change['z'],change['d'],change['p']])
            row.setdefault('corrections', []).append(dict(
                id='bilingual-sense-' + sha(identity), replacesSenseId=sense['id'],
                sourceDefinitionZhSha256=sha(sense['definitionZh']), sourceDefinitionEnSha256=sha(sense['definitionEn']),
                sourcePos=sense['pos'], definitionZh=change['z'], definitionEn=change['d'], pos=change['p'],
                reason=change['why'], contentMetadata=dict(
                    definitionZh=original(sourceSenseId=sense['id'], sourceTextSha256=sha(sense['definitionZh']),
                        usageEvidenceUrls=list(evidence)),
                    definitionEn=original(sourceLanguage='zh',sourceTextSha256=sha(change['z']),
                        usageEvidenceUrls=list(evidence)))))
            counts['correctedSenses'] += 1
        # Existing, source-hash-bound usage corrections must not disappear when
        # filling an English field would disable their old display overlay.
        protected = [v for v in overlays if v['normalizedLemma']==lemma]
        protected_ids = {v['senseId'] for v in protected}
        for view in protected:
            sense = next(s for s in word['senses'] if s['id']==view['senseId'])
            require(sha(sense['definitionZh'])==view['sourceTextSha256'], 'usage_overlay_source_changed:' + lemma)
            add_correction(sense, dict(z=view['definitionZh'],d=view['definitionEn'],p=sense['pos'] or 'n.',why=view['reason']),
                           [view['usageEvidenceUrl']])
        if draft:
            if primary['id'] not in protected_ids:
                if draft.get('x'):
                    add_correction(primary,draft['x'],draft.get('evidence', []))
                elif needed and needed['needD']:
                    require(bool(draft.get('d')), 'missing_authored_definition:' + lemma)
                    add_definition(primary,draft['d'],draft.get('p'))
                elif draft.get('p'):
                    require(not primary['pos'], 'pos_source_not_empty:' + lemma)
                    row['senses'].append(dict(id=primary['id'],pos=draft['p'],sourceDefinitionZhSha256=sha(primary['definitionZh']),
                        contentMetadata=dict(pos=original(sourceTextSha256=sha(primary['definitionZh'])))))
                    counts['posFields'] += 1
            if (needed and needed['needE']) or draft.get('e'):
                selection = draft.get('e')
                require(bool(selection), 'missing_authored_example:' + lemma)
                if 'j' in selection:
                    candidates=ledger.get(lemma, [])
                    require(type(selection['j']) is int and 0 <= selection['j'] < len(candidates), 'invalid_candidate:' + lemma)
                    chosen=copy.deepcopy(candidates[selection['j']])
                    reviewed_candidates=(needed or {}).get('c', [])
                    reviewed=next((c for c in reviewed_candidates if c.get('j')==selection['j']), None)
                    require(reviewed is not None and reviewed.get('en')==chosen['exampleEn'],
                            'reviewed_candidate_changed:' + lemma)
                    en=chosen['exampleEn']; zh=selection.get('z', chosen.get('exampleZh'))
                    require(bool(zh), 'missing_corpus_translation:' + lemma)
                    metadata=chosen['contentMetadata']
                    require(metadata['exampleEn']['sourceTextSha256']==sha(en),'corpus_english_hash:' + lemma)
                    if 'z' in selection:
                        metadata['exampleZh']=original(sourceLanguage='en',sourceTextSha256=sha(en),
                            translatedFrom=copy.deepcopy(metadata['exampleEn']))
                        counts['translatedCorpusExamples'] += 1
                    else:
                        require(reviewed.get('zh')==zh, 'reviewed_candidate_translation_changed:' + lemma)
                        require(metadata['exampleZh']['sourceTextSha256']==sha(zh),'corpus_chinese_hash:' + lemma)
                        counts['corpusPairs'] += 1
                else:
                    en=selection['en']; zh=selection['z']
                    metadata=dict(exampleEn=original(language='en',sourceTextSha256=sha(en)),
                                  exampleZh=original(language='zh-CN',sourceLanguage='en',sourceTextSha256=sha(en)))
                    counts['originalExamples'] += 1
                require(re.search('[A-Za-z]',en) and re.search('[\u4e00-\u9fff]',zh), 'invalid_bilingual_example:' + lemma)
                example=dict(exampleEn=en,exampleZh=zh,contentMetadata=metadata)
                if not occurrence(lemma,en):
                    surface=selection.get('surface')
                    kind=surface_reviews.get((lemma,surface))
                    if not kind:
                        surfaces.append(dict(lemma=lemma,surface=surface,exampleEn=en))
                        example=None
                    else:
                        require(occurrence(surface,en), 'surface_absent:' + lemma)
                        example['targetSurface']=dict(lemma=lemma,form=surface,kind=kind,review='codex-reviewed')
                if example is not None:
                    row['examples'].append(example)
                    counts['exampleWords'] += 1
        for extra in extra_by_word.get(lemma, []):
            sense=next(s for s in word['senses'] if s['id']==extra['id'])
            require(sense['id']!=primary['id'], 'extra_repeats_primary:' + lemma)
            add_definition(sense,extra['d'],extra.get('p'))
        # An automatic book can focus an already bilingual, non-primary sense.
        # Its missing POS must be authored explicitly rather than guessed from
        # the headword or silently replaced by a different learning sense.
        positioned = set()
        for position in reviews.get('sensePositions', {}).get(lemma, []):
            sense=next((s for s in word['senses'] if s['id']==position['id']),None)
            require(sense is not None and not sense['pos'], 'position_source_not_empty_or_unknown:' + lemma)
            require(position['id'] not in positioned, 'duplicate_sense_position:' + lemma)
            positioned.add(position['id'])
            require(isinstance(position['p'],str) and 0<len(position['p'].strip())<=100, 'invalid_authored_position:' + lemma)
            require(all(sense.get('contentMetadata',{}).get(field,{}).get('kind')!='site-authored'
                        for field in ('definitionZh','definitionEn','pos')), 'position_source_site_authored:' + lemma)
            patch=next((p for p in row['senses'] if p['id']==sense['id']),None)
            if patch is None:
                patch=dict(id=sense['id'],contentMetadata={})
                row['senses'].append(patch)
            require('pos' not in patch, 'position_already_authored:' + lemma)
            patch.update(pos=position['p'],sourceDefinitionZhSha256=sha(sense['definitionZh']))
            patch['contentMetadata']['pos']=original(sourceSenseId=sense['id'],sourceTextSha256=sha(sense['definitionZh']))
            counts['posFields']+=1
        supplemented_senses = copy.deepcopy(word['senses'])
        supplemented_examples = copy.deepcopy(word['examples'])
        correction_ids = set()
        for change in reviews.get('exampleCorrections', {}).get(lemma, []):
            require(change['id'] not in correction_ids, 'duplicate_example_correction:' + lemma)
            correction_ids.add(change['id'])
            example=next((ex for ex in supplemented_examples if ex['id']==change['id']), None)
            require(example is not None and change['z'].strip() and change['why'].strip(), 'invalid_example_correction:' + lemma)
            old_en,old_zh=example['exampleEn'],example['exampleZh']
            require(old_en.strip() and old_zh.strip(), 'example_correction_requires_original_pair:' + lemma)
            require(all(example['contentMetadata'].get(field,{}).get('kind')!='site-authored'
                        for field in ('exampleEn','exampleZh')), 'example_correction_site_authored:' + lemma)
            new_en=change.get('en',old_en)
            require(re.search('[A-Za-z]',new_en) and re.search('[\u4e00-\u9fff]',change['z']), 'invalid_corrected_pair:' + lemma)
            source=copy.deepcopy(example['contentMetadata'].get('exampleEn',{}))
            metadata={}
            if 'en' in change:
                require(occurrence(lemma,new_en), 'corrected_example_missing_word:' + lemma)
                source=original(language='en',sourceTextSha256=sha(new_en))
                metadata['exampleEn']=source
            metadata['exampleZh']=original(language='zh-CN',sourceLanguage='en',sourceTextSha256=sha(new_en),translatedFrom=source)
            patch=dict(id=example['id'],sourceExampleEnSha256=sha(old_en),sourceExampleZhSha256=sha(old_zh),
                       exampleZh=change['z'],reason=change['why'],contentMetadata=metadata)
            if 'en' in change:patch['exampleEn']=new_en
            row.setdefault('exampleCorrections',[]).append(patch)
            example.update(exampleEn=new_en,exampleZh=change['z'])
            example['contentMetadata'].update(metadata)
            counts['exampleTranslations']+=1
        for extra in examples_by_word.get(lemma, []):
            sense=next(s for s in supplemented_senses if s['id']==extra['id'])
            require(sense['exampleEn']==extra['en'] and not sense['exampleZh'], 'extra_example_source_changed:' + lemma)
            english_source=extra['englishSource']
            require(english_source['sourceTextSha256']==sha(sense['exampleEn']) and
                    english_source['license']=='MIT' and english_source['author']=='NightStudy contributors',
                    'extra_example_source_attribution:' + lemma)
            metadata=original(sourceLanguage='en',sourceTextSha256=sha(sense['exampleEn']),translatedFrom=english_source)
            patch=next((p for p in row['senses'] if p['id']==sense['id']),None)
            if patch is None:
                patch=dict(id=sense['id'],contentMetadata={})
                row['senses'].append(patch)
            patch['exampleZh']=extra['z']
            patch['contentMetadata']['exampleZh']=metadata
            sense['exampleZh']=extra['z']
            sense['contentMetadata'].update(exampleEn=english_source,exampleZh=metadata)
            counts['exampleFields']+=1
        output.append(row)
        corrected_ids = {change['replacesSenseId'] for change in row.get('corrections', [])}
        effective_examples = [*supplemented_examples,
            *[s for s in supplemented_senses if learning_sense(s) and s['id'] not in corrected_ids],
            *row['examples']]
        if draft and not any(ex.get('exampleEn','').strip() and ex.get('exampleZh','').strip()
                             for ex in effective_examples) and not (needed and needed['needE']):
            pending.append(dict(w=lemma, reason='correction_retires_only_bilingual_example'))
        for ex in effective_examples:
            if ex.get('exampleEn','').strip() and ex.get('exampleZh','').strip():
                metadata=ex.get('contentMetadata',{}).get('exampleEn',{})
                require(bool(metadata.get('license')), 'audio_sentence_missing_license:' + lemma)
                audio_source=copy.deepcopy(metadata)
                audio_source['author']=metadata.get('author') or metadata.get('sourceOwner') or metadata.get('owner')
                require(bool(audio_source['author']), 'audio_sentence_missing_author:' + lemma)
                if audio_source['license']=='CC BY 2.0 FR':
                    audio_source['sourceLicenseLabel']=audio_source['license']
                    audio_source['license']='CC-BY-2.0-FR'
                audio.append(dict(normalizedLemma=lemma,exampleEn=ex['exampleEn'],exampleZh=ex['exampleZh'],source=audio_source))
    return output, audio, dict(counts, pending=pending, unreviewedSurfaces=surfaces)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--source-sha256',required=True)
    parser.add_argument('--authors',type=Path,required=True)
    parser.add_argument('--reviews',type=Path,required=True)
    parser.add_argument('--extra-focus-input',type=Path,required=True)
    parser.add_argument('--extra-focus-authored',type=Path,required=True)
    parser.add_argument('--extra-examples-input',type=Path,required=True)
    parser.add_argument('--extra-examples-authored',type=Path,required=True)
    parser.add_argument('--catalog-source',type=Path,required=True)
    parser.add_argument('--catalog-source-sha256',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--partial',action='store_true')
    args=parser.parse_args()
    require(sha(args.source.read_bytes())==args.source_sha256,'source_export_checksum_mismatch')
    assignment=json.loads((args.authors/'assignment.json').read_text())
    inputs,drafts,evidence={},{},[]
    for lane,contract in assignment.items():
        folder=args.authors/lane
        require(sha((folder/'input.jsonl').read_bytes())==contract['inputSha256'],'author_lane_input_changed:' + lane)
        for row in load_lines(folder/'input.jsonl'):
            require(row['w'] not in inputs,'duplicate_input_word')
            inputs[row['w']]=row
        progress=json.loads((folder/'progress.json').read_text())
        require(not progress['errors'],'author_lane_structure_errors:' + lane)
        for file in progress['files']:
            path=folder/'drafts'/file['name']
            require(sha(path.read_bytes())==file['sha256'],'draft_changed_since_check:' + str(path.name))
            evidence.append(dict(lane=lane,file=file['name'],sha256=file['sha256']))
            for row in load_lines(path):
                require(row['w'] not in drafts,'duplicate_draft_word:' + row['w'])
                drafts[row['w']]=row
    reviews=json.loads(args.reviews.read_text())
    require(sha(args.catalog_source.read_bytes())==args.catalog_source_sha256,'catalog_source_checksum_mismatch')
    catalog_source=json.loads(args.catalog_source.read_text())
    require(catalog_source['sourceExportSha256']==args.source_sha256,'catalog_source_realm_mismatch')
    source=load_lines(args.source)
    ledger={row['w']:row['candidates'] for row in load_lines(args.authors/'candidate-ledger.jsonl')}
    extra_inputs=json.loads(args.extra_focus_input.read_text())
    extra_text=json.loads(args.extra_focus_authored.read_text())
    require(set(extra_text)=={item['w'] for item in extra_inputs},'extra_focus_coverage_mismatch')
    extras=[dict(w=item['w'],id=item['id'],d=extra_text[item['w']]) for item in extra_inputs]
    example_inputs=json.loads(args.extra_examples_input.read_text())
    example_text=json.loads(args.extra_examples_authored.read_text())
    require(set(example_text)=={item['w'] for item in example_inputs},'extra_example_coverage_mismatch')
    example_extras=[dict(item,z=example_text[item['w']]) for item in example_inputs]
    overlays=json.loads((Path(__file__).resolve().parent.parent/'data/learning-definitions.json').read_text())
    rows,audio,statistics=compile_rows(source,drafts,inputs,ledger,reviews,overlays,extras,example_extras)
    complete=not statistics['pending'] and not statistics['unreviewedSurfaces']
    require(args.partial or complete,'authoring_or_surface_review_incomplete')
    args.output.mkdir(parents=True,exist_ok=False)
    decoded=''.join(json.dumps(row,ensure_ascii=False,separators=(',',':'))+'\n' for row in rows).encode()
    packed=gzip.compress(decoded,compresslevel=9,mtime=0)
    # Python 3.11/3.12 can expose zlib's platform-specific gzip OS byte.
    # Normalize it so the published checksum reproduces across build hosts.
    packed=packed[:9]+b'\xff'+packed[10:]
    pack_id='bilingual-v2' if not args.partial else 'bilingual-v2-preview'
    filename=pack_id+'.jsonl.gz'
    (args.output/filename).write_bytes(packed)
    manifest=dict(formatVersion=1,id=pack_id,version='0.10.0-alpha.1',fileName=filename,
        bytes=len(packed),sha256=sha(packed),jsonlSha256=sha(decoded),wordCount=len(rows),
        sourceUrl='https://github.com/wudi000888-svg/nightstudy',license='MIT AND CC-BY-2.0-FR',
        scope='Paired primary learning definitions and independent bilingual examples for valid built-in vocabulary and phrase books.',
        qualityReview='pending',semanticQualityCertified=False,publishable=complete and not args.partial,
        sourceExportSha256=args.source_sha256,authoringDrafts=evidence,
        authoringInputs={lane:contract['inputSha256'] for lane,contract in assignment.items()},
        candidateLedgerSha256=sha((args.authors/'candidate-ledger.jsonl').read_bytes()),
        extraFocusInputSha256=sha(args.extra_focus_input.read_bytes()),
        extraFocusAuthoredSha256=sha(args.extra_focus_authored.read_bytes()),
        extraExamplesInputSha256=sha(args.extra_examples_input.read_bytes()),
        extraExamplesAuthoredSha256=sha(args.extra_examples_authored.read_bytes()),
        reviewDecisionsSha256=sha(args.reviews.read_bytes()),
        catalogSourceSha256=args.catalog_source_sha256,
        catalog=catalog_proof(catalog_source,reviews),
        statistics={k:v for k,v in statistics.items() if k not in ['pending','unreviewedSurfaces']})
    (args.output/'bilingual-v2.manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n')
    (args.output/'sentences.jsonl').write_text(''.join(json.dumps(row,ensure_ascii=False,separators=(',',':'))+'\n' for row in audio))
    (args.output/'review-queue.json').write_text(json.dumps(statistics,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(dict(words=len(rows),drafts=len(drafts),publishable=manifest['publishable'],
                         pending=len(statistics['pending']),surfaces=len(statistics['unreviewedSurfaces']),bytes=len(packed),sha256=sha(packed))))


if __name__=='__main__':
    main()
