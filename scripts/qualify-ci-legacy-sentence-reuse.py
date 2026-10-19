#!/usr/bin/env python3
"""Qualify exactly32 official MP3s for explicit current reuse, cloud only.

No inference, model/config access or WAV claim. Existing generation and its
independent checks remain immutable alternatives; this is publication selection.
"""
from pathlib import Path
import argparse
import builtins
import math
import os
import re
import stat
import sys
import types

REPO=Path(__file__).resolve().parent.parent
PURE=REPO/'scripts/check-ci-sentence-audio-batch.py'
PURE_SHA='16fbaf7f522a0f26382a923df7670b623fa49df4f82a8b6b225f1e2af71913d8'
REPORT_SHA='48425b09c5837edd2c9be3bf19fa438570adf830cd3c1302e9807db54356ef5c'
REPORT_BYTES=3387333
BASE_SHA='3b7f791260a3d7490f89304c58afab7bc062a092271f67c2aa4a9b4c4cd367c7'
POLICY=dict(version=1,decodedSampleRate=22050,channels=1,durationSecondsMin=.05,durationSecondsMax=30,
    peakAmplitudeMin=10,rmsAmplitudeMin=1,clippedSampleFractionMax=.01,timeStretchApplied=False,silenceTrimApplied=False)


def load_pure():
    import hashlib
    fd=os.open(PURE,os.O_RDONLY|os.O_NOFOLLOW)
    sig=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    try:
        before=os.fstat(fd)
        if PURE.resolve()!=PURE or not stat.S_ISREG(before.st_mode) or before.st_size!=44043:
            raise ValueError('fixed_legacy_reuse_helper_size')
        raw=os.read(fd,128*1024+1)
        if len(raw)!=44043 or os.read(fd,1) or hashlib.sha256(raw).hexdigest()!=PURE_SHA or \
                sig(before)!=sig(os.fstat(fd)) or sig(before)!=sig(os.lstat(PURE)):
            raise ValueError('fixed_legacy_reuse_helper_bytes')
        m=types.ModuleType('_legacy_reuse_independent_contract');m.__file__=str(PURE)
        exec(compile(raw,str(PURE),'exec'),m.__dict__)
        h,helper_identity=m.load_helpers()
        return m,h,sig(before),helper_identity
    finally:os.close(fd)


def report_scope(h,value):
    expected=dict(currentGroups=99940,currentOverlapPairs=424,currentPairs=199880,currentReferences=99984,
        exactIdentityMatchingOldEntries=424,heldOverlapPairs=0,legacyEntries=36078,legacyNonCurrentPairs=35654,
        legacyUniquePairs=36078,oldCrossPackDuplicatePairs=0,plannedFreshOverlapPairs=32,preservedBaselineOverlapPairs=392)
    h.need(value['kind']=='nightstudy-ci-legacy-sentence-overlap-audit-v1'
        and value['state']=='COMPLETE_CONFLICT_INVENTORY_ONLY' and value['publicRootSha256']==h.PUBLIC_SHA
        and value['finalPolicySha256']==h.FINAL_SHA and value['summary']==expected
        and all(value[k] is False for k in ('modelImported','mediaDecoded','synthesisApproved','reuseApproved',
            'supersessionApproved','publicationAuthorized')),'fixed_actual_legacy_overlap_inventory')
    rows=[row for row in value['overlaps'] if row['plannedDecision']['decision']=='planned-fresh']
    h.need(len(value['overlaps'])==424 and len(rows)==32 and len({(r['textHash'],r['accent']) for r in rows})==32
        and len({r['textHash'] for r in rows})==16,'whole_actual32_unique_pairs')
    return rows


def current_rows(h,rows,controls,voices):
    targets={};selected=[]
    for row in rows:
        text,key,accent=row['text'],row['textHash'],row['accent']
        h.need(accent in h.ACCENTS and h.normalize(text)==text and h.sha(text)==key
            and key not in controls and row['currentPolicyProhibitsMedia'] is False
            and row['currentControl']==dict(state='base-no-explicit-control',correctionSha256=None,correctionId=None,hold=None),
            'current_holds_and_risks_precede_official_reuse')
        refs=[]
        h.need(isinstance(row['currentReferencesAndContexts'],list) and 1<=len(row['currentReferencesAndContexts'])<=3,
            'whole_current_contexts')
        for pair in row['currentReferencesAndContexts']:
            h.need(set(pair)=={'reference','publicContext'},'complete_public_context_record')
            ref,body=pair['reference'],pair['publicContext']
            h.need(set(body)=={'word','sense','example'} and h.sha(h.canonical(body))==ref['publicContextSha256']
                and h.sha(h.canonical(body['sense']['sourceBindings']))==ref['sourceBindingsSha256']
                and body['word']['wordId']==body['sense']['wordId']==body['example']['wordId']==ref['wordId']
                and body['sense']['id']==ref['learningSenseId']==body['example']['learningSenseId']
                and body['example']['id']==ref['exampleId'] and body['sense']['contentVersion']==ref['contentVersion']
                and body['sense']['bindingHash']==ref['bindingHash']
                and h.normalize(body['example']['exampleEn'])==text,'complete_current_bilingual_body_digest')
            refs.append(ref)
        h.references(refs,False)
        target=dict(textHash=key,text=text,references=refs,accents=['US','UK'])
        h.need(key not in targets or targets[key]==target,'same_contexts_for_both_accents')
        targets[key]=target
        voice=voices['voices'][accent]
        base=dict(text=text,accent=accent,engine='1.8.0',generator='audio-v1',
            model=voice['model']['sha256'],config=voice['config']['sha256'])
        expected=dict(text=text,accent=accent,engineVersion='1.8.0',voiceModelSha256=base['model'],
            voiceConfigSha256=base['config'],cacheKey=h.sha(h.canonical(base,True)),
            pronunciationCorrectionSha256=None,pronunciationCorrectionId=None)
        h.need(row['expectedCurrentSynthesisIdentity']==expected and row['currentCacheIdentityRecipe']==dict(
            baseInputs=base,correctionSha256=None,correctionRenderPolicy=None,synthesisRoute='linux-original-text'),
            'recomputed_complete_current_identity')
        old=row['oldPublishedEntries']
        h.need(len(old)==1 and old[0]['packId'] in ('sentence-audio-v1','sentence-audio-v2')
            and all(old[0]['entry'].get(k)==v for k,v in expected.items())
            and old[0]['exactCurrentSynthesisIdentityMatches'] is True
            and old[0]['missingIdentityFields']==[] and all(old[0]['currentIdentityFieldMatches'].values())
            and old[0]['reuseApproved'] is False,'exact_current_identity_not_text_hash_only')
        selected.append((row,old[0]))
    h.need(len(targets)==16 and {(row['textHash'],row['accent']) for row in rows}
        =={(key,a) for key in targets for a in h.ACCENTS},'complete16_dual_accent_current_targets')
    return sorted(targets.values(),key=lambda t:t['textHash']),selected


def quality(h,entry,metrics):
    h.need(entry['kind']=='synthesized' and entry['mimeType']=='audio/mpeg' and entry['sampleRate']==22050
        and entry['channels']==1 and entry['sampleWidthBytes']==2 and h.digest(entry['fileSha256'])
        and entry['fileKey']=='files/'+entry['fileSha256']+'.mp3'
        and type(entry['sizeBytes']) is int and 0<entry['sizeBytes']<=2*h.MIB,'official_mp3_format_and_size')
    old=entry['qualityMetrics']
    h.need(old['policyVersion']==1 and old['sampleRate']==22050 and old['channels']==1
        and old['timeStretchApplied'] is False and old['silenceTrimApplied'] is False,'original_quality_policy1')
    h.need(all(type(entry[k]) in (int,float) and math.isfinite(entry[k]) and .05<=entry[k]<=30
        for k in ('decodedDurationSeconds','durationSeconds'))
        and abs(metrics['decodedDurationSeconds']-entry['decodedDurationSeconds'])<=.000001
        and abs(metrics['decodedDurationSeconds']-entry['durationSeconds'])<=.2,'whole_official_decoded_duration')
    h.need(.05<=metrics['decodedDurationSeconds']<=30 and metrics['peakAmplitude']>=10
        and math.isfinite(metrics['rmsDbfs']) and metrics['rmsDbfs']>=-90.31
        and 0<=metrics['clippedSampleFraction']<=.01,'independent_complete_policy1_quality')
    return {name:dict(original=old.get(name),current=value,matches=old.get(name)==value)
        for name,value in metrics.items()}


def official_entries(h,inputs,root,report,selected,voices):
    result={}
    for pack,descriptor_file in (('sentence-audio-v1','sentence-audio.manifest.json'),
            ('sentence-audio-v2','sentence-audio-v2.manifest.json')):
        source=next(r for r in report['legacySources'] if r['packId']==pack)
        evidence=next(r for r in report['descriptors'] if r['descriptor']['id']==pack)
        raw=inputs.read(REPO/'data'/descriptor_file,65536,evidence['sha256'],evidence['bytes'])
        descriptor=h.decode(raw)
        h.need(descriptor==evidence['descriptor'] and descriptor['id']==descriptor['version']==pack,
            'exact_official_release_descriptor')
        manifest=inputs.json(h.relative(root,pack+'/manifest.json'),64*h.MIB,
            descriptor['manifestSha256'],source['manifest']['bytes'])
        sources=inputs.json(h.relative(root,pack+'/sources.manifest.json'),32*h.MIB,
            descriptor['sourceManifestSha256'],source['sources']['bytes'])
        h.need(manifest['version']==sources['version']==pack and manifest['status']=='ready'
            and manifest['sourceManifestSha256']==descriptor['sourceManifestSha256']
            and len(manifest['entries'])==descriptor['entryCount'] and sources['engineSource']==voices
            and sources['acousticQualityPolicy']==POLICY,'official_whole_manifest_source_and_quality_policy')
        wanted={(row['textHash'],row['accent']):old for row,old in selected if old['packId']==pack}
        found={}
        for entry in manifest['entries']:
            key=entry['textHash'],entry['accent']
            if key not in wanted:continue
            h.need(key not in found and entry==wanted[key]['entry']
                and wanted[key]['manifestSha256']==descriptor['manifestSha256']
                and wanted[key]['sourceManifestSha256']==descriptor['sourceManifestSha256'],
                'whole_original_official_entry_unchanged')
            found[key]=dict(entry=entry,baseline=dict(id=pack,manifestSha256=descriptor['manifestSha256'],
                sourceManifestSha256=descriptor['sourceManifestSha256']),officialDescriptor=evidence)
        h.need(set(found)==set(wanted) and len(found)==16,'all16_original_entries_per_official_pack')
        result.update(found)
    h.need(len(result)==32,'whole32_official_original_entries')
    return result


def write_new(h,path,value):
    raw=(h.canonical(value)+'\n').encode('utf-8')
    h.need(0<len(raw)<=8*h.MIB,'bounded_official_reuse_output')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as handle:
        handle.write(raw);handle.flush();os.fsync(handle.fileno())
    return dict(fileName=path.name,bytes=len(raw),sha256=h.sha(raw))


def complete_qualification(h,entries):
    pairs={(e['textHash'],e['accent']) for e in entries}
    hashes={key for key,_ in pairs}
    h.need(len(entries)==len(pairs)==32 and len(hashes)==16
        and pairs=={(key,a) for key in hashes for a in h.ACCENTS}
        and all(e['fullMp3EofDecoded'] is True and e['originalWavRevalidated'] is False
            and e['originalWavAvailableInPublishedArchive'] is False for e in entries),
        'all32_complete_eof_results_required_for_reuse')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('report','legacy-root','ffmpeg','output'):p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--report-sha256',required=True);args=p.parse_args()
    m,h,pure_identity,helper_identity=load_pure()
    h.need(sys.platform.startswith('linux') and os.environ.get('GITHUB_ACTIONS')=='true','cloud_only_official_reuse_qualification')
    h.need(args.report_sha256==REPORT_SHA,'actual_report_pin_required_before_media')
    sys.dont_write_bytecode=True
    original=builtins.__import__
    forbidden=(*h.FORBIDDEN,'sqlite3')
    def safe_import(name,*rest,**kwargs):
        h.need(not any(name==v or name.startswith(v+'.') for v in forbidden),'no_reuse_model_or_network_import')
        return original(name,*rest,**kwargs)
    h.need(not any(any(name==v or name.startswith(v+'.') for v in forbidden) for name in sys.modules),
        'no_preloaded_reuse_model_or_network')
    builtins.__import__=safe_import
    ffmpeg=args.ffmpeg.absolute()
    h.need(ffmpeg.resolve(strict=True)==ffmpeg,'real_official_reuse_decoder')
    def guard(event,values):
        h.need(not event.startswith(('socket.','http.client.','os.exec','os.spawn'))
            and event not in ('urllib.Request','os.system','os.fork','os.posix_spawn','sqlite3.connect'),'no_reuse_network_or_other_child')
        if event=='subprocess.Popen':
            h.need(values[0]==str(ffmpeg) and isinstance(values[1],list) and values[1][0]==str(ffmpeg)
                and '-t' not in values[1] and '-to' not in values[1] and '-fs' not in values[1],
                'only_complete_pinned_ffmpeg_decoder_child')
        if event=='open' and values and isinstance(values[0],(str,bytes,os.PathLike)):
            h.need(not os.fsdecode(values[0]).lower().endswith(('.onnx','.onnx.json','.pt','.pth','.gguf','.safetensors')),
                'no_reuse_model_or_config_access')
    sys.addaudithook(guard)
    inputs=h.Inputs();inputs.identities[PURE]=pure_identity;inputs.identities[m.HELPER]=helper_identity
    self_raw=inputs.read(Path(__file__),128*1024)
    report=inputs.json(args.report.absolute(),8*h.MIB,REPORT_SHA,REPORT_BYTES)
    rows=report_scope(h,report)
    configuration=inputs.json(REPO/'data/ci-audio-batch-inputs.manifest.json',65536)
    h.need(report['controls']==dict(base=configuration['portableControls'],supplement=configuration['supplementalControls'])
        and configuration['portableControls']['sha256']==BASE_SHA,'same_current_controls_as_actual_inventory')
    voices=inputs.json(REPO/'data/audio-voices.manifest.json',65536,h.VOICES_SHA)
    base=h.controls_index(inputs.pin(configuration['portableControls'],64*h.MIB))
    controls,_=m.supplement(h,inputs,configuration['supplementalControls'],base,voices)
    targets,selected=current_rows(h,rows,controls,voices)
    h.public_targets(inputs,targets,controls)
    plan=inputs.json(REPO/'data/ci-audio-batch-plan.manifest.json',65536)
    h.need(report['actualSelection']==plan['selection'],'same_immutable_fresh_generation_selection')
    root=args.legacy_root.absolute()
    h.need(root.resolve(strict=True)==root and root.is_dir(),'real_official_legacy_root')
    official=official_entries(h,inputs,root,report,selected,voices)
    fd,decoder_sha,_=inputs.checked_fd(ffmpeg,128*h.MIB);os.close(fd)
    output=args.output.absolute()
    h.need(not os.path.lexists(output) and output.parent.resolve(strict=True)==output.parent,'fresh_official_qualification_output')
    output.mkdir(mode=0o700)
    approved=[]
    for row,old in sorted(selected,key=lambda item:(item[0]['textHash'],item[0]['accent'])):
        key=row['textHash'],row['accent'];actual=official[key];entry=actual['entry']
        media=h.relative(root,old['packId']+'/'+entry['fileKey'])
        metrics=h.decode_mp3(inputs,media,entry['fileSha256'],entry['sizeBytes'],ffmpeg,output)
        comparisons=quality(h,entry,metrics)
        approved.append(dict(textHash=key[0],accent=key[1],text=row['text'],entry=entry,baseline=actual['baseline'],
            officialDescriptor=actual['officialDescriptor'],expectedCurrentSynthesisIdentity=row['expectedCurrentSynthesisIdentity'],
            currentReferencesAndContexts=row['currentReferencesAndContexts'],plannedDecision=row['plannedDecision'],
            fullMp3EofDecoded=True,metrics=metrics,originalPublishedMetricComparison=comparisons,
            originalWavRevalidated=False,originalWavAvailableInPublishedArchive=False))
    complete_qualification(h,approved)
    inputs.unchanged()
    report_pin=dict(fileName=args.report.name,bytes=REPORT_BYTES,sha256=REPORT_SHA)
    qualified=dict(kind='nightstudy-ci-official-legacy-reuse-qualification-v1',state='VERIFIED_OFFICIAL32_MP3_REUSE_ONLY',
        checkerSourceSha256=h.sha(self_raw),pureBatchHelperSha256=PURE_SHA,pureDecoderHelperSha256=m.HELPER_SHA,
        report=report_pin,publicRootSha256=h.PUBLIC_SHA,finalPolicySha256=h.FINAL_SHA,actualSelection=report['actualSelection'],
        groups=16,pairs=32,completeMp3EofDecodes=32,decoderInputProtocol='fd',seekablePinnedInput=True,
        decoderThreads=1,decoderBinarySha256=decoder_sha,acousticQualityPolicy=POLICY,
        originalWavsRevalidated=0,originalWavsAvailableInPublishedArchive=False,oldArchiveRehashedHere=False,
        originalArchiveVerificationRequiredByWorkflow=True,allCurrentReferencesBound=True,
        currentIdentityMatchesEveryOldEntry=True,activeHoldOverlapPairs=0,all32Passed=True,entries=approved,
        newGenerationProofUnchanged=True,modelsUsed=False,newMediaGenerated=False,expertCertified=False,listened=False,
        authorizedForReuse=True,publicationAuthorized=False)
    qualification_pin=write_new(h,output/'qualification.json',qualified)
    write_new(h,output/'approved-selection.json',dict(kind='nightstudy-ci-official-legacy-reuse-selection-v1',
        state='APPROVED_EXACT32_OFFICIAL_REUSE_ONLY',qualification=qualification_pin,report=report_pin,
        publicRootSha256=h.PUBLIC_SHA,finalPolicySha256=h.FINAL_SHA,actualSelection=report['actualSelection'],
        groups=16,pairs=32,entries=approved,authorizedForReuse=True,newGenerationProofUnchanged=True,publicationAuthorized=False))
    print(h.canonical(dict(state=qualified['state'],pairs=32,authorizedForReuse=True,publicationAuthorized=False)))


if __name__=='__main__':main()
