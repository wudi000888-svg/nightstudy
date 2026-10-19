#!/usr/bin/env python3
"""Cloud-only deterministic fresh selection and disjoint bounded requests.

The immutable published baseline is preserved. Old unapproved candidates are
explicitly NOT_SELECTED, which is not a claim that they are unusable. No model,
frontend, decoder, download or database service is started by this planner.
"""
from __future__ import annotations
import argparse
import gzip
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import platform
import re
import sqlite3

ROOT=Path(__file__).resolve().parent.parent
SPEC=importlib.util.spec_from_file_location('_ci_fresh_batch_contract',Path(__file__).with_name('ci-sentence-audio-batch.py'))
b=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(b)
w=b.w


def pin(path):
    return w.file_pin(path,ROOT)


def public_reference(word,sense,example,index,leaf_sha,payload_sha):
    body=dict(word={key:word[key] for key in ('wordId','normalizedLemma')},
        sense={key:value for key,value in sense.items() if key!='examples'},example=example)
    return dict(wordId=word['wordId'],learningSenseId=sense['id'],exampleId=example['id'],
        contentVersion=sense['contentVersion'],bindingHash=sense['bindingHash'],leafIndex=index,
        leafManifestSha256=leaf_sha,payloadSha256=payload_sha,
        publicContextSha256=w.sha(w.canonical(body)),sourceBindingsSha256=w.sha(w.canonical(sense['sourceBindings'])))


def risky(sense,example):
    for metadata in (sense['contentMetadata'],example['contentMetadata']):
        w.require(isinstance(metadata,dict),'complete_current_content_metadata')
        if 'pronunciation' not in metadata:continue
        policy=metadata['pronunciation']
        if not isinstance(policy,dict) or policy.get('wordAudioCompatible') is not True:return True
        if policy.get('sentenceAudioCompatible') is False or any(policy.get(k) is True
            for k in ('sentenceAudioReviewRequired','reviewRequired')) or any(
            isinstance(policy.get(k),str) and policy[k] in ('pending','unreviewed','requires-review','hold')
            for k in ('decision','review')):return True
    return False


def ingest(db,controls):
    collection=w.json_bytes(w.read_bounded(ROOT/'data/learning-senses-collection-v2.manifest.json',65536,w.PUBLIC_ROOT_SHA))
    w.require(collection['wordCount']==18767 and collection['senseCount']==49992
        and collection['exampleCount']==99984 and len(collection['shards'])==95,'whole_public_collection')
    totals=[0,0,0]
    for index,leaf in enumerate(collection['shards']):
        manifest=w.pin_value(dict(fileName='data/'+leaf['manifestFileName'],bytes=leaf['bytes'],sha256=leaf['sha256']),65536)
        payload=w.read_bounded(w.relative_file('data/'+manifest['fileName']),8*w.MIB,manifest['sha256'],manifest['bytes'])
        h=hashlib.sha256();expanded=0;local=[0,0,0]
        with gzip.GzipFile(fileobj=io.BytesIO(payload)) as stream:
            while raw:=stream.readline(2*w.MIB+1):
                expanded+=len(raw)
                w.require(len(raw)<=2*w.MIB and raw.endswith(b'\n') and expanded<=16*w.MIB,'bounded_public_leaf_decode')
                h.update(raw);word=w.json_bytes(raw);local[0]+=1
                w.require(set(word)=={'wordId','normalizedLemma','senses'} and local[0]<=200
                    and isinstance(word['senses'],list) and 1<=len(word['senses'])<=512,'bounded_public_word')
                for sense in word['senses']:
                    local[1]+=1
                    w.require(sense['wordId']==word['wordId'] and 1<=len(sense['examples'])<=20,'public_sense_parent')
                    for example in sense['examples']:
                        local[2]+=1
                        w.require(example['wordId']==word['wordId'] and example['learningSenseId']==sense['id'],'public_example_parent')
                        text=normalize(example['exampleEn']);text_hash=w.sha(text)
                        w.require(15<=len(text)<=4000 and (text_hash in controls or not risky(sense,example)),
                            'unresolved_current_pronunciation_scope')
                        db.execute('INSERT OR IGNORE INTO groups VALUES(?,?)',(text_hash,text))
                        w.require(db.execute('SELECT text FROM groups WHERE textHash=?',(text_hash,)).fetchone()[0]==text,
                            'public_text_hash_collision')
                        ref=public_reference(word,sense,example,index,leaf['sha256'],manifest['sha256'])
                        db.execute('INSERT INTO refs VALUES(?,?,?,?)',(text_hash,sense['id'],example['id'],w.canonical(ref)))
        w.require(h.hexdigest()==manifest['jsonlSha256'] and local==[manifest['wordCount'],manifest['senseCount'],manifest['exampleCount']]
            ==[leaf['wordCount'],leaf['senseCount'],leaf['exampleCount']],'entire_public_leaf_hash_and_counts')
        totals=[a+c for a,c in zip(totals,local)];db.commit()
        w.require(Path(db.execute('PRAGMA database_list').fetchone()[2]).stat().st_size<=512*w.MIB,'compact_index512mib')
    w.require(totals==[18767,49992,99984] and db.execute('SELECT count(*) FROM groups').fetchone()[0]==99940
        and db.execute('SELECT count(*) FROM refs').fetchone()[0]==99984,'all_current_groups_and_references')
    return collection


def normalize(text):
    import unicodedata
    return re.sub(r'\s+',' ',unicodedata.normalize('NFKC',text).translate(str.maketrans({'‘':"'",'’':"'",'“':'"','”':'"'}))).strip()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs',required=True)
    parser.add_argument('--output',required=True,help='Fresh repository-relative plan directory')
    args=parser.parse_args()
    w.require(platform.system()=='Linux' and os.environ.get('GITHUB_ACTIONS')=='true','cloud_only_batch_plan')
    inputs_raw=w.read_bounded(w.relative_file(args.inputs),262144)
    inputs=w.json_bytes(inputs_raw)
    w.require(isinstance(inputs,dict) and set(inputs)=={'kind','mode','portableControls','supplementalControls',
        'approvedPilot','firstJobGroups','groupsPerJob','workers','firstPackOrdinal','blockedKeys','baseline'}
        and inputs['kind']=='nightstudy-ci-audio-build-inputs-v1' and inputs['mode']=='batch'
        and type(inputs['groupsPerJob']) is int and 1<=inputs['groupsPerJob']<=1000
        and type(inputs['firstJobGroups']) is int and 1<=inputs['firstJobGroups']<=inputs['groupsPerJob']
        and type(inputs['workers']) is int and inputs['workers'] in (1,2,4)
        and type(inputs['firstPackOrdinal']) is int and 2<=inputs['firstPackOrdinal']<=9999,
        'explicit_committed_batch_inputs')
    b.approved_pilot(inputs['approvedPilot'])
    w.require(inputs['portableControls']['sha256']==b.BASE_CONTROLS_SHA,'fixed_complete_controls_pin')
    builder=w.load_builder();pipeline=builder.pipeline_module()
    controls=w.validate_controls(w.pin_value(inputs['portableControls'],64*w.MIB),pipeline.pronunciation,builder.publication_holds_module())
    controls,supplemented=b.merge_supplement(inputs['supplementalControls'],controls,pipeline,builder.publication_holds_module())
    blocked={}
    w.require(isinstance(inputs['blockedKeys'],list) and len(inputs['blockedKeys'])<=1000,'bounded_explicit_blocked_keys')
    for row in inputs['blockedKeys']:
        w.require(isinstance(row,dict) and set(row)=={'textHash','accent','reason'}
            and re.fullmatch('[a-f0-9]{64}',row['textHash']) and row['accent'] in ('US','UK')
            and isinstance(row['reason'],str) and 15<=len(row['reason'].strip())<=4000,'explicit_blocked_key')
        key=row['textHash'],row['accent'];w.require(key not in blocked,'duplicate_blocked_key');blocked[key]=row
    w.require(supplemented or {(b.SUPPLEMENT_HASH,'US'),(b.SUPPLEMENT_HASH,'UK')}<=set(blocked),
        'unreviewed_known_two_keys_stay_blocked')
    w.require(isinstance(args.output,str) and re.fullmatch('[A-Za-z0-9._/-]+',args.output)
        and not Path(args.output).is_absolute() and all(p not in ('.','..') for p in Path(args.output).parts),'fresh_plan_relative_path')
    output=ROOT/args.output
    w.require(output.parent.resolve(strict=True)==output.parent and not os.path.lexists(output),'fresh_plan_directory')
    output.mkdir(mode=0o700)
    index=output/'planning.sqlite'
    db=sqlite3.connect(index)
    try:
        db.executescript('PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA journal_mode=DELETE;'
            'CREATE TABLE groups(textHash TEXT PRIMARY KEY,text TEXT NOT NULL) WITHOUT ROWID;'
            'CREATE TABLE refs(textHash TEXT NOT NULL,senseId TEXT NOT NULL,exampleId TEXT NOT NULL,body TEXT NOT NULL,'
            'PRIMARY KEY(textHash,senseId,exampleId)) WITHOUT ROWID;')
        collection=ingest(db,controls)
        baseline=inputs['baseline']
        w.require(isinstance(baseline,dict) and set(baseline)=={'textManifest','audioManifest'},'exact_published_baseline_inputs')
        expected_text=dict(fileName='data/'+collection['shards'][0]['manifestFileName'],bytes=collection['shards'][0]['bytes'],
            sha256=collection['shards'][0]['sha256'])
        text_manifest=w.pin_value(baseline['textManifest'],65536)
        audio_manifest=w.pin_value(baseline['audioManifest'],65536)
        w.require(baseline['textManifest']==expected_text and text_manifest['id']=='learning-senses-v1'
            and text_manifest['sha256']=='1984c9aedcd97241ee50d90ee34b68da1542c55ecd17a281af9bb3e5c03182db'
            and text_manifest['wordCount']==35 and text_manifest['senseCount']==98 and text_manifest['exampleCount']==196
            and baseline['audioManifest']['fileName']=='data/sentence-audio-v3.manifest.json'
            and audio_manifest['id']==audio_manifest['version']=='sentence-audio-v3'
            and audio_manifest['lemmaCount']==196 and audio_manifest['entryCount']==392
            and audio_manifest['source']['sha256']=='74f7ab46ed20b64014a253bdbca3110c7c80f13de77b0b430a41b14457f021c0',
            'immutable_exact_published_baseline')
        hold_checks=[dict(textHash=h,accent=a) for h,g in sorted(controls.items()) for a in ('US','UK')
            if h not in supplemented and g['accents'][a]['state']=='hold'][:1]
        counts=dict(generatedGroups=0,generatedPairs=0,heldExcludedPairs=0,supplementalHeldExcludedPairs=0,
            baselineExcludedPairs=0,blockedExcludedPairs=0)
        leaves=[];chunk=[];seen_controls=set();seen_blocks=set();baseline_refs=0
        exclusions=output/'exclusions.jsonl'
        def flush():
            if not chunk:return
            number=len(leaves)+1;file=output/f'targets-{number:04d}.json'
            w.write_new(file,chunk)
            leaves.append(dict(sliceNumber=number,**pin(file),groups=len(chunk),pairs=sum(len(t['accents']) for t in chunk),
                firstTextHash=chunk[0]['textHash'],lastTextHash=chunk[-1]['textHash']))
            chunk.clear()
        with exclusions.open('x',encoding='utf-8') as ledger:
            for text_hash,text in db.execute('SELECT textHash,text FROM groups ORDER BY textHash'):
                refs=[w.json_bytes(row[0]) for row in db.execute('SELECT body FROM refs WHERE textHash=? ORDER BY senseId,exampleId',(text_hash,))]
                w.validate_references(refs);baseline_refs+=sum(ref['leafIndex']==0 for ref in refs)
                group=controls.get(text_hash)
                if group:
                    seen_controls.add(text_hash)
                    common=('wordId','learningSenseId','exampleId','contentVersion','bindingHash','leafIndex',
                        'leafManifestSha256','payloadSha256','sourceBindingsSha256')
                    expected=sorted(group['references'],key=lambda r:(r['learningSenseId'],r['exampleId']))
                    w.require(group['text']==text and [{k:r[k] for k in common} for r in refs]==
                        [{k:r[k] for k in common} for r in expected],'complete_control_current_public_refs')
                    if text_hash in supplemented:w.require(refs==expected,'complete_supplement_public_context_refs')
                accents=[]
                for accent in ('US','UK'):
                    key=text_hash,accent;control=group['accents'][accent] if group else None
                    decision=None
                    if control and control['state']=='hold':
                        w.require(key not in blocked,'hold_and_pending_exclusion_conflict')
                        counts['supplementalHeldExcludedPairs' if text_hash in supplemented else 'heldExcludedPairs']+=1
                        decision='supplemental-hold' if text_hash in supplemented else 'hold'
                    elif key in blocked:
                        seen_blocks.add(key);counts['blockedExcludedPairs']+=1;decision='pending-explicit'
                    elif all(ref['leafIndex']==0 for ref in refs):
                        w.require(control is None or control['state']=='reviewed-retain','baseline_correction_cannot_be_exempted')
                        counts['baselineExcludedPairs']+=1;decision='published-baseline-exact-current-refs'
                    else:accents.append(accent)
                    if decision:ledger.write(w.canonical(dict(textHash=text_hash,accent=accent,decision=decision))+'\n')
                if accents:
                    target=dict(textHash=text_hash,text=text,references=group['references'] if group else refs,accents=accents)
                    chunk.append(target);counts['generatedGroups']+=1;counts['generatedPairs']+=len(accents)
                    if len(chunk)==(inputs['firstJobGroups'] if not leaves else inputs['groupsPerJob']):flush()
            flush()
        w.require(seen_controls==set(controls) and seen_blocks==set(blocked) and baseline_refs==196
            and counts['heldExcludedPairs']==79 and counts['generatedPairs']+counts['heldExcludedPairs']+
            counts['supplementalHeldExcludedPairs']+counts['baselineExcludedPairs']+counts['blockedExcludedPairs']==199880,
            'every_current_target_policy_and_baseline_accounted')
        w.require(len(leaves)>0 and inputs['firstPackOrdinal']+len(leaves)-1<=9999,'reserved_pack_ordinal_bounds')
        selection=dict(kind='nightstudy-ci-audio-fresh-selection-v1',state='COMPLETE_EXPLICIT_FRESH_SELECTION',
            publicRootSha256=w.PUBLIC_ROOT_SHA,finalPolicySha256=w.FINAL_POLICY_SHA,
            portableControls=inputs['portableControls'],supplementalControls=inputs['supplementalControls'],
            approvedPilot=inputs['approvedPilot'],baseline=baseline,oldUnapprovedCandidateSelection='NOT_SELECTED',
            oldUnapprovedCandidates=89880,currentCounts=dict(groups=99940,references=99984,pairs=199880),
            firstJobGroups=inputs['firstJobGroups'],groupsPerJob=inputs['groupsPerJob'],taskSentenceCap=128,maxWorkers=inputs['workers'],
            blockedKeys=[blocked[key] for key in sorted(blocked)],exclusionLedger=pin(exclusions),
            batchWorkerSha256=w.digest(Path(b.__file__)),plannerSha256=w.digest(Path(__file__)),leaves=leaves,**counts)
        selection_file=output/'selection.manifest.json';w.write_new(selection_file,selection);selection_pin=pin(selection_file)
        requests=[]
        for leaf in leaves:
            number=leaf['sliceNumber'];targets=w.pin_value({k:leaf[k] for k in ('fileName','bytes','sha256')},8*w.MIB)
            request=dict(kind='nightstudy-ci-sentence-audio-request-v1',mode='batch',
                packId=f"sentence-audio-v4-{inputs['firstPackOrdinal']+number-1:04d}",portableControls=inputs['portableControls'],
                voicesManifest=pin(ROOT/'data/audio-voices.manifest.json'),publicRootSha256=w.PUBLIC_ROOT_SHA,
                finalPolicySha256=w.FINAL_POLICY_SHA,targets=targets,holdChecks=hold_checks,
                batchApproval=dict(approvedPilot=inputs['approvedPilot'],selectionManifest=selection_pin,
                    selectionLeaf={k:leaf[k] for k in ('fileName','bytes','sha256')},sliceNumber=number,
                    workers=inputs['workers'],supplementalControls=inputs['supplementalControls']))
            b.prepare_request(request,controls,pipeline)
            file=output/f'request-{number:04d}.json';w.write_new(file,request)
            requests.append(dict(sliceNumber=number,packId=request['packId'],groups=leaf['groups'],pairs=leaf['pairs'],**pin(file)))
        w.write_new(output/'job-manifest.json',dict(kind='nightstudy-ci-audio-bounded-jobs-v1',
            state='PREPARED_REQUIRES_CLOUD_GENERATION_AND_INDEPENDENT_CHECK',selectionManifest=selection_pin,
            inputs=dict(fileName=args.inputs,bytes=len(inputs_raw),sha256=w.sha(inputs_raw)),requests=requests,
            modelImported=False,mediaGenerated=False,publicationAuthorized=False,**counts))
    finally:
        db.close()
        index.unlink(missing_ok=True)


if __name__=='__main__':main()
