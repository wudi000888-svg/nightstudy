#!/usr/bin/env python3
"""Explicit fresh cloud batches; the separately accepted eight-sentence pilot stays unchanged.

Every batch requires an explicitly pinned accepted pilot and a complete immutable
fresh selection. No old unapproved media is reused or declared unusable here.
"""
from __future__ import annotations
import argparse
import io
import json
import os
from pathlib import Path
import platform
import re
import stat
import sys
import time
import types

REPO = Path(__file__).resolve().parent.parent
PILOT_WORKER_SHA = 'b2b47af3ef55f7f8288db7ae50ea4a89eb2f50640b643577e567d2434026d3b3'
BASE_CONTROLS_SHA = '3b7f791260a3d7490f89304c58afab7bc062a092271f67c2aa4a9b4c4cd367c7'
SUPPLEMENT_HASH = '00022a53ae06cabc23f1c80195da75d98f14395ed24c901dfbbbb4995119a226'
APPROVED_PILOT_SHA = '0fa7270c6bee04ccc3641fdb4f9e4bdc24fdc113b19353c31df456984fdfa2bb'
JOURNAL_POLICY = 'disabled-fresh-generation-no-progress-inputs-v1'


def load_pilot():
    import hashlib
    file = REPO / 'scripts/ci-sentence-audio-worker.py'
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size != 27414:
            raise ValueError('fixed_pilot_contract_source_size')
        with os.fdopen(fd, 'rb', closefd=False) as handle:
            raw = handle.read(128 * 1024 + 1)
        signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
        if (len(raw) != 27414 or hashlib.sha256(raw).hexdigest() != PILOT_WORKER_SHA or
                signature(before) != signature(os.fstat(fd)) or
                signature(before) != signature(os.lstat(file))):
            raise ValueError('fixed_pilot_contract_source_pin')
    finally:
        os.close(fd)
    module = types.ModuleType('_nightstudy_accepted_pilot_contract')
    module.__file__ = str(file)
    sys.modules[module.__name__] = module
    exec(compile(raw, str(file), 'exec'), module.__dict__)
    return module


w = load_pilot()


def merge_supplement(pin, controls, pipeline, holds):
    """Separate explicit current Linux review; never mutate frozen1757/79."""
    if pin is None:
        return controls, set()
    value = w.pin_value(pin, 2*w.MIB)
    w.require(isinstance(value,dict) and set(value)=={'kind','engineVersion','voicesManifestSha256',
        'publicRootSha256','finalPolicySha256','baseControlsSha256','groups','observation','review'}
        and value['kind']=='nightstudy-ci-audio-supplemental-controls-v1'
        and value['engineVersion']=='1.8.0' and value['voicesManifestSha256']==w.VOICES_SHA
        and value['publicRootSha256']==w.PUBLIC_ROOT_SHA and value['finalPolicySha256']==w.FINAL_POLICY_SHA
        and value['baseControlsSha256']==BASE_CONTROLS_SHA and isinstance(value['groups'],list)
        and len(value['groups'])==1,'separate_explicit_supplement_envelope')
    group=value['groups'][0]
    w.require(isinstance(group,dict) and set(group)=={'textHash','text','references',
        'rawTokenSegments','originalPhonemes','accents'} and group['textHash']==SUPPLEMENT_HASH
        and group['textHash'] not in controls and w.sha(group['text'])==group['textHash']
        and group['text']=='The critic contrasts genuine curiosity with a sordid hunger for profit.'
        and set(group['accents'])=={'US','UK'},'exact_new_supplement_group')
    observation=w.pin_value(value['observation'],256*1024)
    w.require(observation.get('kind')=='nightstudy-ci-sentence-frontend-observation-v1'
        and observation.get('state')=='OBSERVED_REQUIRES_EXPLICIT_REGIONAL_HUMAN_REVIEW'
        and observation.get('textHash')==group['textHash'] and observation.get('text')==group['text']
        and observation.get('publicRootSha256')==w.PUBLIC_ROOT_SHA
        and observation.get('unchangedFinalPolicySha256')==w.FINAL_POLICY_SHA
        and observation.get('voicesManifestSha256')==w.VOICES_SHA and observation.get('engineVersion')=='1.8.0'
        and observation.get('actualSharedEspeakVoice')=='en' and observation.get('frontendCalls')==1
        and observation.get('allCurrentPublicReferencesVerified') is True
        and observation.get('references')==group['references']
        and observation.get('rawTokenSegments')==group['rawTokenSegments']
        and observation.get('originalPhonemes')==group['originalPhonemes']
        and observation.get('rawTokenSegmentsSha256')==w.sha(w.canonical(group['rawTokenSegments']))
        and observation.get('originalPhonemesSha256')==w.sha(w.canonical(group['originalPhonemes']))
        and observation.get('regionalDecisions')==dict(US=None,UK=None)
        and observation.get('literalCorrections')==[] and observation.get('noInferenceSessionConstructed') is True
        and observation.get('publicClass')=='piper.phonemize_espeak.EspeakPhonemizer'
        and observation.get('classSourceSha256')=='d5ff275d847502345821898efa15e3e4e956fe884cea7c78ae87102d539e6594'
        and observation.get('audioPackSourceSha256')==w.HELPERS['audio-pack.py']
        and observation.get('forbiddenAttemptCounts')==dict(networkOrChild=0,modelWeightOpen=0,inferenceSession=0)
        and all(observation.get(k) is False for k in ('modelWeightsOpened','networkUsed','childProcessStarted',
            'mediaGenerated','synthesisApproved','policiesModified','cacheReuseAuthorized','publicationAuthorized')),
        'actual_unapproved_linux_frontend_evidence')
    voices=pipeline.pack.load_sources(pipeline.pack.DEFAULT_VOICES_MANIFEST)['voices']
    expected_configs={accent:dict(fileName=source['config']['fileName'],bytes=source['config']['sizeBytes'],
        sha256=source['config']['sha256'],espeakVoice='en',modelSha256=source['model']['sha256'])
        for accent,source in voices.items()}
    w.require(observation.get('configs')==expected_configs,'unchanged_supplement_observed_configs')
    review=value['review']
    w.require(isinstance(review,dict) and set(review)=={'reviewer','expertCertified','observationSha256','regionalReasons'}
        and review['reviewer']=='Codex' and review['expertCertified'] is False
        and review['observationSha256']==value['observation']['sha256']
        and set(review['regionalReasons'])=={'US','UK'}
        and all(isinstance(reason,str) and 15<=len(reason.strip())<=4000
            for reason in review['regionalReasons'].values()),'explicit_current_regional_human_supplement')
    refs=w.validate_references(group['references'])
    ref_fields={'wordId','learningSenseId','exampleId','contentVersion','bindingHash','leafIndex',
        'leafManifestSha256','payloadSha256','publicContextSha256','sourceBindingsSha256'}
    w.require(all(set(ref)==ref_fields for ref in group['references']),'supplement_honest_public_refs')
    both=all(c.get('state')=='hold' for c in group['accents'].values())
    w.validate_raw(group['rawTokenSegments'],group['originalPhonemes'],both)
    for accent,control in group['accents'].items():
        w.require(set(control)=={'state','correction','hold'},'supplement_explicit_regional_decision')
        record=None
        if control['state']=='reviewed-correction':
            checked=pipeline.pronunciation.validate_review(control['correction']['record'])
            w.require(checked==control['correction'] and checked['record']['originalPhonemes']==group['originalPhonemes']
                and control['hold'] is None,'supplement_entire_current_correction')
            record=checked['record']
        elif control['state']=='hold':
            record=holds.validate_hold(control['hold'])
            w.require(control['correction'] is None,'supplement_hold_before_correction')
        else:
            w.require(control['state']=='reviewed-retain' and control['correction'] is None
                and control['hold'] is None,'supplement_no_default_retain')
        if record is not None:
            w.require(record['textHash']==group['textHash'] and record['text']==group['text']
                and record['accent']==accent and (record['learningSenseId'],record['exampleId']) in refs,
                'supplement_all_current_anchor')
    return dict(controls,**{group['textHash']:group}), {SUPPLEMENT_HASH}


def approved_pilot(pin):
    w.require(isinstance(pin,dict) and pin.get('bytes')==12250 and pin.get('sha256')==APPROVED_PILOT_SHA,
        'actual_accepted_pilot3_pin_required')
    receipt = w.pin_value(pin, 256 * 1024)
    w.require(receipt.get('kind') == 'nightstudy-ci-sentence-audio-independent-check-v1'
        and receipt.get('state') == 'VERIFIED_PILOT_ONLY'
        and receipt.get('publicRootSha256') == w.PUBLIC_ROOT_SHA
        and receipt.get('finalPolicySha256') == w.FINAL_POLICY_SHA
        and receipt.get('generatedPairs') == receipt.get('completeMp3EofDecodes') ==
            receipt.get('originalWavsFullyRead') == 16
        and receipt.get('heldDenials', 0) >= 1
        and receipt.get('allCurrentReferencesBound') is True
        and receipt.get('reviewedFrozenRawCallsVerified') is True
        and receipt.get('decoderInputProtocol')=='fd' and receipt.get('seekablePinnedInput') is True
        and receipt.get('publicationAuthorized') is False,
        'explicit_successful_pilot_approval_required')
    return receipt


def cloud_resource_admission(workers,cpu_count,available):
    w.require(type(workers) is int and workers in (1,2,4) and type(cpu_count) is int
        and cpu_count>=workers,'explicit_workers_fit_actual_cloud_cpu')
    w.require(type(available) is int and available>0 and (workers!=4 or available>=8*1024**3),
        'four_cloud_workers_require_eight_gib_available')
    return dict(cpuCount=cpu_count,memAvailableBytes=available,workers=workers,
        threadsPerVoice=1,fourWorkersRequireAvailableBytes=8*1024**3)


def fresh_generation_entries(unused_paths,wanted,accent,expected,expected_accent):
    """Do not iterate a glob or read another active worker's progress file."""
    w.require(accent==expected_accent and wanted==expected,'fresh_only_exact_task_identities')
    return {}


def selection_inputs(approval, request):
    w.require(isinstance(approval, dict) and set(approval) == {
        'approvedPilot', 'selectionManifest', 'selectionLeaf', 'sliceNumber', 'workers','supplementalControls'}
        and type(approval['sliceNumber']) is int and approval['sliceNumber'] >= 1
        and type(approval['workers']) is int and approval['workers'] in (1, 2, 4),
        'explicit_batch_approval_shape')
    approved_pilot(approval['approvedPilot'])
    selection = w.pin_value(approval['selectionManifest'], 2 * w.MIB)
    w.require(selection.get('kind') == 'nightstudy-ci-audio-fresh-selection-v1'
        and selection.get('state') == 'COMPLETE_EXPLICIT_FRESH_SELECTION'
        and selection.get('approvedPilot') == approval['approvedPilot']
        and selection.get('publicRootSha256') == w.PUBLIC_ROOT_SHA
        and selection.get('finalPolicySha256') == w.FINAL_POLICY_SHA
        and selection.get('portableControls') == request['portableControls']
        and selection.get('supplementalControls')==approval['supplementalControls']
        and selection.get('oldUnapprovedCandidateSelection') == 'NOT_SELECTED'
        and selection.get('oldUnapprovedCandidates')==89880
        and selection.get('taskSentenceCap') == 128
        and selection.get('batchWorkerSha256')==w.digest(Path(__file__))
        and selection.get('maxWorkers') == approval['workers']
        and selection.get('currentCounts') == dict(groups=99940, references=99984, pairs=199880)
        and selection.get('heldExcludedPairs') == 79
        and isinstance(selection.get('leaves'), list)
        and 1 <= len(selection['leaves']) <= 1000,
        'complete_current_fresh_union_selection_required')
    w.require(type(selection.get('baselineExcludedPairs')) is int and 0<=selection['baselineExcludedPairs']<=392
        and type(selection.get('supplementalHeldExcludedPairs')) is int and 0<=selection['supplementalHeldExcludedPairs']<=2
        and isinstance(selection.get('blockedKeys'),list) and len(selection['blockedKeys'])<=1000
        and type(selection.get('blockedExcludedPairs')) is int
        and selection['blockedExcludedPairs']==len(selection['blockedKeys']), 'bounded_exact_exclusion_counts')
    block_keys=set()
    for row in selection['blockedKeys']:
        w.require(isinstance(row,dict) and set(row)=={'textHash','accent','reason'}
            and re.fullmatch('[a-f0-9]{64}',row['textHash']) and row['accent'] in ('US','UK')
            and isinstance(row['reason'],str) and 15<=len(row['reason'].strip())<=4000
            and (row['textHash'],row['accent']) not in block_keys,'unique_explicit_pending_exclusion')
        block_keys.add((row['textHash'],row['accent']))
    w.require(approval['supplementalControls'] is not None or selection['supplementalHeldExcludedPairs']==0,
        'no_unproven_supplemental_hold_count')
    previous, groups, pairs = '', 0, 0
    selected = None
    for number, leaf in enumerate(selection['leaves'], 1):
        w.require(isinstance(leaf, dict) and set(leaf) == {
            'sliceNumber', 'fileName', 'bytes', 'sha256', 'groups', 'pairs',
            'firstTextHash', 'lastTextHash'} and leaf['sliceNumber'] == number
            and type(leaf['groups']) is int and 1 <= leaf['groups'] <= selection['groupsPerJob'] <= 1000
            and type(leaf['pairs']) is int and leaf['groups'] <= leaf['pairs'] <= 2 * leaf['groups']
            and isinstance(leaf['fileName'],str) and len(leaf['fileName'])<=240
            and type(leaf['bytes']) is int and 0<leaf['bytes']<=8*w.MIB
            and re.fullmatch('[a-f0-9]{64}',leaf['sha256'])
            and re.fullmatch('[a-f0-9]{64}', leaf['firstTextHash'])
            and re.fullmatch('[a-f0-9]{64}', leaf['lastTextHash'])
            and previous < leaf['firstTextHash'] <= leaf['lastTextHash'],
            'ordered_disjoint_fixed_batch_leaves')
        previous = leaf['lastTextHash']
        cap=selection['firstJobGroups'] if number==1 else selection['groupsPerJob']
        w.require(leaf['groups']<=cap and (number==len(selection['leaves']) or leaf['groups']==cap),
            'first256_and_remaining_fixed1000_groups')
        groups += leaf['groups']; pairs += leaf['pairs']
        if number == approval['sliceNumber']:
            selected = leaf
    w.require(groups == selection['generatedGroups'] and pairs == selection['generatedPairs']
        and pairs + selection['heldExcludedPairs'] + selection['supplementalHeldExcludedPairs'] + selection['baselineExcludedPairs'] +
            selection['blockedExcludedPairs'] == 199880 and selected is not None,
        'exact_current_accent_union_accounted')
    pin = {key: selected[key] for key in ('fileName', 'bytes', 'sha256')}
    w.require(pin == approval['selectionLeaf'], 'selected_leaf_exact_approved_pin')
    targets = w.pin_value(pin, 8 * w.MIB)
    w.require(targets == request['targets'] and len(targets) == selected['groups']
        and sum(len(t['accents']) for t in targets) == selected['pairs']
        and targets[0]['textHash'] == selected['firstTextHash']
        and targets[-1]['textHash'] == selected['lastTextHash'], 'whole_selected_leaf_targets')
    return selection


def prepare_request(request, controls, pipeline):
    fields = {'kind', 'mode', 'packId', 'portableControls', 'voicesManifest', 'publicRootSha256',
              'finalPolicySha256', 'targets', 'holdChecks', 'batchApproval'}
    w.require(isinstance(request, dict) and set(request) == fields
        and request['kind'] == 'nightstudy-ci-sentence-audio-request-v1'
        and request['mode'] == 'batch' and request['publicRootSha256'] == w.PUBLIC_ROOT_SHA
        and request['finalPolicySha256'] == w.FINAL_POLICY_SHA
        and isinstance(request['targets'], list) and 1 <= len(request['targets']) <= 1000
        and isinstance(request['holdChecks'], list) and 1 <= len(request['holdChecks']) <= 79
        and re.fullmatch('sentence-audio-v4-[0-9]{4}', request['packId'])
        and not request['packId'].endswith('-0000'), 'bounded_explicit_batch_request')
    selection = selection_inputs(request['batchApproval'], request)
    blocked = {(row['textHash'], row['accent']) for row in selection['blockedKeys']}
    w.require((request['batchApproval']['supplementalControls'] is not None) or
        {(SUPPLEMENT_HASH,'US'),(SUPPLEMENT_HASH,'UK')} <= blocked,'unreviewed_known_reading_stays_blocked')
    pending, identities, denials = {'US': [], 'UK': []}, [], []
    seen = ''
    sources = pipeline.pack.load_sources(pipeline.pack.DEFAULT_VOICES_MANIFEST)['voices']
    for target in request['targets']:
        w.require(isinstance(target, dict) and set(target) == {
            'textHash', 'text', 'references', 'accents'} and isinstance(target['text'], str)
            and 15 <= len(target['text']) <= 4000
            and pipeline.normalize(target['text']) == target['text']
            and w.sha(target['text']) == target['textHash'] and seen < target['textHash']
            and target['accents'] in (['US'], ['UK'], ['US', 'UK']), 'ordered_batch_current_target')
        seen = target['textHash']
        w.validate_references(target['references'])
        w.require(not all(ref.get('leafIndex')==0 for ref in target['references']),
            'published_exact_baseline_is_not_a_fresh_target')
        group = controls.get(target['textHash'])
        w.require(group is None or (group['text'] == target['text'] and
            w.canonical(group['references']) == w.canonical(target['references'])),
            'all_batch_current_control_references')
        for accent in target['accents']:
            control = group['accents'][accent] if group else None
            w.require((target['textHash'], accent) not in blocked and
                (control is None or control['state'] != 'hold'), 'blocked_or_held_batch_target_forbidden')
            correction = control['correction'] if control else None
            base = pipeline.pack.synthesis_identity(target['text'], accent, sources[accent])
            row = {key: target[key] for key in ('textHash', 'text', 'references')}
            row['portableControl'] = group
            if correction:
                row['pronunciationCorrections'] = {accent: correction}
            pending[accent].append(row)
            identities.append(dict(textHash=target['textHash'], accent=accent,
                baseSynthesisIdentity=base,
                cacheKey=pipeline.pronunciation.corrected_cache_identity(base, correction),
                route='frozen-reviewed-raw-per-sentence' if group else 'linux-original-text',
                correctionSha256=correction['sha256'] if correction else None,
                referencesSha256=w.sha(w.canonical(target['references']))))
    seen_checks = set()
    for check in request['holdChecks']:
        w.require(set(check) == {'textHash', 'accent'} and check['accent'] in ('US', 'UK'), 'batch_hold_control')
        key = (check['textHash'], check['accent'])
        group = controls.get(key[0])
        w.require(key not in seen_checks and group is not None and
            group['accents'][key[1]]['state'] == 'hold', 'actual_unique_batch_hold_denial')
        seen_checks.add(key)
        denials.append(dict(textHash=key[0], accent=key[1], decision='hold',
            hold=group['accents'][key[1]]['hold'], modelLoaded=False, mediaGenerated=False))
    return pending, identities, denials


def worker(accent, rows, output_string, models_string, task_id):
    w.require(platform.system() == 'Linux' and len(rows) <= 128
        and all(os.environ.get(name) == '1' for name in w.THREAD_ENV), 'bounded_cloud_task')
    sys.dont_write_bytecode = True
    sys.addaudithook(w.deny_network)
    pipeline = w.load_builder().pipeline_module()
    by_text = {row['text']: row for row in rows}
    w.require(len(by_text) == len(rows), 'unique_task_texts')
    route_file = Path(output_string) / 'routes' / (task_id + '.jsonl')
    w.require(not route_file.exists(), 'fresh_batch_route_file')
    own_journal=Path(output_string)/'progress'/(accent+'-'+task_id+'.jsonl')
    w.require(not os.path.lexists(own_journal),'fresh_own_task_journal_required')
    source=pipeline.pack.load_sources(pipeline.pack.DEFAULT_VOICES_MANIFEST)['voices'][accent]
    expected_wanted={(row['textHash'],pipeline.pronunciation.corrected_cache_identity(
        pipeline.pack.synthesis_identity(row['text'],accent,source),
        row.get('pronunciationCorrections',{}).get(accent))) for row in rows}
    pipeline.journals.select_entries=lambda paths,wanted,a:fresh_generation_entries(
        paths,wanted,a,expected_wanted,accent)

    def selected_voice(voice, text, correction):
        row = by_text.get(text)
        w.require(row is not None, 'unexpected_batch_sentence')
        group = row['portableControl']
        expected = group['accents'][accent]['correction'] if group else None
        w.require(correction == expected and (group is None or
            group['accents'][accent]['state'] != 'hold'), 'batch_policy_changed')

        class ObservedVoice:
            def synthesize_wav(self, displayed, wav_file):
                w.require(displayed == text, 'batch_displayed_text_changed')
                common = dict(textHash=row['textHash'], accent=accent, displayedTextUnchanged=text,
                    taskId=task_id, workerPid=os.getpid(), workerPgid=os.getpgrp(),
                    referencesSha256=w.sha(w.canonical(row['references'])))
                if group is None:
                    tokens = voice.phonemize(displayed)
                    joined = [''.join(segment) for segment in tokens]
                    w.validate_raw(tokens, joined, False)
                    voice.synthesize_wav(displayed, wav_file)
                    w.append_event(route_file, dict(common, route='linux-original-text',
                        actualFrontendTokenSegments=tokens, actualFrontendPhonemes=joined,
                        frontendPrecheckOnly=True, rawRouteObserved=False, completedPublicCall=True))
                else:
                    rendered = correction['correctedPhonemes'] if correction else group['originalPhonemes']
                    def report(index, payload):
                        w.append_event(route_file, dict(common, route='frozen-reviewed-raw-per-sentence',
                            sentenceIndex=index, rawPayload=payload,
                            originalTokenSegments=group['rawTokenSegments'], originalPhonemes=group['originalPhonemes'],
                            renderedPhonemes=rendered, correctionSha256=correction['sha256'] if correction else None,
                            correctionId=correction['record']['id'] if correction else None,
                            linuxDisplayedTextPhonemizeCalled=False, frontendPrecheckOnly=False,
                            rawRouteObserved=True, completedPublicCall=True))
                    w.raw_render(voice, text, group, correction, wav_file, report)
        return ObservedVoice()

    pipeline.pronunciation.corrected_voice = selected_voice
    return pipeline.worker(accent, rows, output_string, models_string, task_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('request', 'models', 'output', 'ffmpeg'):
        parser.add_argument('--'+name, type=Path, required=True)
    parser.add_argument('--request-sha256', required=True)
    args = parser.parse_args()
    w.require(platform.system() == 'Linux' and os.environ.get('GITHUB_ACTIONS') == 'true', 'cloud_only_no_local_models')
    for name in w.THREAD_ENV:
        os.environ[name] = '1'
    sys.dont_write_bytecode = True
    sys.addaudithook(w.deny_network)
    request = w.json_bytes(w.read_bounded(args.request, 8*w.MIB, args.request_sha256))
    builder = w.load_builder(); pipeline = builder.pipeline_module()
    voices = w.pin_value(request['voicesManifest'], 64*1024)
    w.require(request['voicesManifest']['fileName'] == 'data/audio-voices.manifest.json'
        and request['voicesManifest']['sha256'] == w.VOICES_SHA
        and voices == pipeline.pack.load_sources(pipeline.pack.DEFAULT_VOICES_MANIFEST), 'exact_existing_voice_manifest')
    controls = w.validate_controls(w.pin_value(request['portableControls'],64*w.MIB),
        pipeline.pronunciation,builder.publication_holds_module())
    w.require(request['portableControls']['sha256']==BASE_CONTROLS_SHA,'unchanged_frozen_base_controls')
    controls,_=merge_supplement(request['batchApproval']['supplementalControls'],controls,
        pipeline,builder.publication_holds_module())
    pending, identities, denials = prepare_request(request,controls,pipeline)
    del controls
    workers = request['batchApproval']['workers']
    available=None
    for line in Path('/proc/meminfo').read_text().splitlines():
        if line.startswith('MemAvailable:'):
            available=int(line.split()[1])*1024
    resource_evidence=cloud_resource_admission(workers,os.cpu_count() or 0,available)
    models = args.models.absolute()
    w.require(models.resolve(strict=True) == models and models.is_dir(), 'real_existing_model_directory')
    for source in voices['voices'].values():
        for kind in ('model','config'):
            item=source[kind]; file=models/item['fileName']
            w.require(file.is_file() and not file.is_symlink() and file.stat().st_size == item['sizeBytes']
                and w.digest(file)==item['sha256'], 'original_model_or_config_pin')
        w.require(w.json_bytes(w.read_bounded(models/source['config']['fileName'],16384))['espeak']['voice']=='en',
            'unchanged_model_en_config')
    ffmpeg=args.ffmpeg.absolute()
    w.require(ffmpeg.is_file() and not ffmpeg.is_symlink(),'real_ffmpeg_required')
    os.environ['NIGHTSTUDY_BUILD_FFMPEG']=str(ffmpeg)
    output=args.output.absolute()
    w.require(not os.path.lexists(output) and output.parent.resolve(strict=True)==output.parent,'fresh_batch_output')
    output.mkdir(mode=0o700)
    for name in ('files','routes','progress'):(output/name).mkdir()
    for name,value in (('request.json',request),('expected-identities.json',identities),('held-denials.json',denials)):
        w.write_new(output/name,value)
    tasks=builder.bounded_worker_tasks(pending,128)
    execution=builder.worker_execution_metadata(tasks,128,workers)
    w.write_new(output/'build-start.json',dict(kind='nightstudy-ci-audio-start-v1',requestSha256=args.request_sha256,
        parentPid=os.getpid(),parentPgid=os.getpgrp(),buildExecution=execution,threadsPerVoice=1,
        modelsDownloaded=False,heldDenialCount=len(denials),publicationAuthorized=False,
        cloudResourceAdmission=resource_evidence,journalReusePolicy=JOURNAL_POLICY))
    started=time.monotonic()
    entries=builder.execute_worker_tasks(tasks,output,models,workers,worker_fn=worker)
    expected={(i['textHash'],i['accent']):i for i in identities}
    w.require(len(entries)==len(expected) and {(e['textHash'],e['accent']) for e in entries}==set(expected),'whole_batch_pair_union')
    for entry in entries:
        target=expected[(entry['textHash'],entry['accent'])]
        w.require(entry['cacheKey']==target['cacheKey'] and entry['mimeType']=='audio/mpeg'
            and pipeline.pack.validate_entry(entry,output,target['cacheKey']),'batch_generated_identity')
    w.write_new(output/'sources.manifest.json',dict(schemaVersion=2,version=request['packId'],
        meaningPackId='learning-senses-collection-v2',meaningPackSha256=w.PUBLIC_ROOT_SHA,
        meaningPackIdentityKind='collection-manifest-sha256',engineSource=voices,
        portableControls=request['portableControls'],finalPolicySha256=w.FINAL_POLICY_SHA,
        requestedSentences=request['targets'],baselinePacks=[],reusedMediaReferences=[],
        buildRuntime=builder.build_runtime(),buildExecution=execution,frozenRetainedRawUsesBaseIdentity=True,
        publicationAuthorized=False,helperSha256=w.HELPERS,transcodingTool=pipeline.codec.build_tool_identity(),
        acousticQualityPolicy=pipeline.codec.QUALITY_POLICY,batchApproval=request['batchApproval'],
        pilotWorkerSourceSha256=PILOT_WORKER_SHA,oldUnapprovedCandidateSelection='NOT_SELECTED',
        journalReusePolicy=JOURNAL_POLICY))
    w.write_new(output/'manifest.json',dict(schemaVersion=2,version=request['packId'],status='ready',
        sourceManifestSha256=w.digest(output/'sources.manifest.json'),statistics=dict(lemmaCount=len(request['targets']),
        entryCount=len(entries),recordedCount=0,synthesizedCount=len(entries),failedCount=0),
        entries=sorted(entries,key=lambda e:(e['textHash'],e['accent']))))
    files=sorted([output/name for name in ('request.json','expected-identities.json','held-denials.json',
        'build-start.json','sources.manifest.json','manifest.json')]+list((output/'files').glob('*'))+list((output/'routes').glob('*.jsonl')))
    w.write_new(output/'build-receipt.json',dict(kind='nightstudy-ci-audio-generated-v1',
        state='GENERATED_REQUIRES_INDEPENDENT_CHECK',requestSha256=args.request_sha256,
        workerSourceSha256=w.digest(Path(__file__)),elapsedSeconds=round(time.monotonic()-started,6),
        publicRootSha256=w.PUBLIC_ROOT_SHA,finalPolicySha256=w.FINAL_POLICY_SHA,generatedPairs=len(entries),
        holdDenials=len(denials),files=[w.file_pin(file,output) for file in files],
        independentFullDecodePassed=False,publicationAuthorized=False))


if __name__=='__main__':
    main()
