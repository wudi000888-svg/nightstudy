#!/usr/bin/env python3
"""Select qualified official overlaps without changing generation or old packs.

Inputs are explicit pins relative to one evidence root. No model, media decoder,
network, database, directory-based source selection or in-place rewrite.
"""
from pathlib import Path
import argparse
import gzip
import hashlib
import json
import math
import os
import re
import stat
import struct
import sys
import tarfile
import types

REPO=Path(__file__).resolve().parent.parent
QUALIFIER=REPO/'scripts/qualify-ci-legacy-sentence-reuse.py'
QUALIFIER_SHA='2cd9ac702dff5c3023909e80452098ef395cde3d0286085641d0aa37b0eb75d3'
REPORT_SHA='48425b09c5837edd2c9be3bf19fa438570adf830cd3c1302e9807db54356ef5c'
HOLDS_SHA='138e3923cccc0a2b77f4dc0d2da38e9d24c5fd336e26a4b83bfa274c679129e3'
CHOICE_KIND='nightstudy-ci-sentence-audio-publication-choice-v1'
ENTRY_HASH_RECIPE='typed-json-ieee754be-v1'
FRESH_NODE_SHA='53112b8094452a3a4db53fb6920b1fc70fbffdbe141bd996af454d470b5652f1'
CANDIDATE_FIELDS={'descriptor','archive','manifest','sources','freshInstallerCheck'}
PIN_FIELDS={'fileName','bytes','sha256'}


def full_entry_sha(h,entry):
    """Full JSON semantic record; interoperable with Node including 0.0/-0.0."""
    def typed(value,depth=0):
        h.need(depth<=128,'entry_hash_depth')
        if value is None:return ['null']
        if type(value) is bool:return ['boolean',value]
        if isinstance(value,str):value.encode('utf-8');return ['string',value]
        if type(value) in (int,float):
            h.need(math.isfinite(value) and abs(value)<=2**53-1,'entry_hash_finite_safe_number')
            return ['number',struct.pack('>d',float(value)).hex()]
        if isinstance(value,list):return ['array',[typed(v,depth+1) for v in value]]
        h.need(isinstance(value,dict) and all(isinstance(k,str) for k in value),'entry_hash_json_type')
        return ['object',[[k,typed(value[k],depth+1)] for k in sorted(value,key=lambda k:k.encode('utf-8'))]]
    return h.sha(h.canonical(typed(entry)))


def load_contract():
    fd=os.open(QUALIFIER,os.O_RDONLY|os.O_NOFOLLOW)
    signature=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    try:
        before=os.fstat(fd)
        if QUALIFIER.resolve()!=QUALIFIER or not stat.S_ISREG(before.st_mode) or before.st_size!=17406:
            raise ValueError('fixed_publication_qualification_contract_size')
        raw=os.read(fd,128*1024+1)
        if len(raw)!=17406 or os.read(fd,1) or hashlib.sha256(raw).hexdigest()!=QUALIFIER_SHA or \
                signature(before)!=signature(os.fstat(fd)) or signature(before)!=signature(os.lstat(QUALIFIER)):
            raise ValueError('fixed_publication_qualification_contract_pin')
        q=types.ModuleType('_official_publication_qualification');q.__file__=str(QUALIFIER)
        exec(compile(raw,str(QUALIFIER),'exec'),q.__dict__)
        _,h,_,_=q.load_pure()
        return q,h,signature(before)
    finally:os.close(fd)


def pin_path(h,root,pin,cap):
    h.need(isinstance(pin,dict) and set(pin)==PIN_FIELDS and type(pin['bytes']) is int and 0<pin['bytes']<=cap
        and h.digest(pin['sha256']),'explicit_publication_pin')
    return h.relative(root,pin['fileName'])


def read_pin(h,reader,root,pin,cap):
    return h.decode(reader.read(pin_path(h,root,pin,cap),cap,pin['sha256'],pin['bytes']))


def qualification(h,qualified,selection,qualification_pin):
    h.need(qualified['kind']=='nightstudy-ci-official-legacy-reuse-qualification-v1'
        and qualified['state']=='VERIFIED_OFFICIAL32_MP3_REUSE_ONLY' and qualified['checkerSourceSha256']==QUALIFIER_SHA
        and qualified['publicRootSha256']==h.PUBLIC_SHA and qualified['finalPolicySha256']==h.FINAL_SHA
        and qualified['pairs']==qualified['completeMp3EofDecodes']==32 and qualified['groups']==16
        and qualified['report']['sha256']==REPORT_SHA and qualified['all32Passed'] is True
        and qualified['authorizedForReuse'] is True and qualified['publicationAuthorized'] is False
        and qualified['currentIdentityMatchesEveryOldEntry'] is True and qualified['allCurrentReferencesBound'] is True
        and qualified['activeHoldOverlapPairs']==0 and qualified['originalWavsRevalidated']==0
        and qualified['decoderInputProtocol']=='fd' and qualified['seekablePinnedInput'] is True
        and qualified['decoderThreads']==1 and qualified['newGenerationProofUnchanged'] is True,
        'actual_all32_qualification_required')
    h.need(selection['kind']=='nightstudy-ci-official-legacy-reuse-selection-v1'
        and selection['state']=='APPROVED_EXACT32_OFFICIAL_REUSE_ONLY' and selection['pairs']==32 and selection['groups']==16
        and selection['authorizedForReuse'] is True and selection['publicationAuthorized'] is False
        and selection['newGenerationProofUnchanged'] is True
        and selection['publicRootSha256']==h.PUBLIC_SHA and selection['finalPolicySha256']==h.FINAL_SHA
        and selection['report']==qualified['report'] and selection['actualSelection']==qualified['actualSelection']
        and selection['entries']==qualified['entries'] and selection['qualification']==dict(fileName='qualification.json',
            bytes=qualification_pin['bytes'],sha256=qualification_pin['sha256']), 'exact_approved32_selection_binding')
    entries=selection['entries']
    h.need(len(entries)==32 and len({(e['textHash'],e['accent']) for e in entries})==32
        and all(e['fullMp3EofDecoded'] is True and e['originalWavRevalidated'] is False for e in entries),
        'complete32_qualified_original_entries')
    return {(e['textHash'],e['accent']):e for e in entries}


def partition(h,request,accepted,manifest,approved,voices):
    original={(e['textHash'],e['accent']):e for e in manifest['entries']}
    proof={(e['textHash'],e['accent']):e for e in accepted['media']}
    targets={t['textHash']:t for t in request['targets']}
    h.need(len(original)==len(manifest['entries'])==len(proof)==len(accepted['media'])==accepted['generatedPairs']
        and set(original)==set(proof)=={(t['textHash'],a) for t in request['targets'] for a in t['accents']},
        'complete_original_generation_pair_set')
    for key,entry in original.items():
        compared=proof[key]
        h.need(entry['cacheKey']==compared['cacheKey'] and entry['fileSha256']==compared['fileSha256']
            and entry['originalFileSha256']==compared['originalWavSha256'],'original_generation_entry_identity')
    overlap=set(original)&set(approved)
    reused=[]
    for key in sorted(overlap):
        row=approved[key];entry=row['entry'];current=targets[key[0]];voice=voices['voices'][key[1]]
        h.need(row['text']==current['text']==entry['text'] and entry['textHash']==key[0] and entry['accent']==key[1]
            and row['expectedCurrentSynthesisIdentity']['cacheKey']==entry['cacheKey']==original[key]['cacheKey']
            and row['baseline']['id'] in ('sentence-audio-v1','sentence-audio-v2')
            and row['baseline']['manifestSha256']==row['officialDescriptor']['descriptor']['manifestSha256']
            and row['baseline']['sourceManifestSha256']==row['officialDescriptor']['descriptor']['sourceManifestSha256']
            and [r['reference'] for r in row['currentReferencesAndContexts']]==current['references']
            and entry['engineVersion']=='1.8.0' and entry['voiceModelSha256']==voice['model']['sha256']
            and entry['voiceConfigSha256']==voice['config']['sha256']
            and not entry.get('pronunciationCorrectionSha256') and not original[key].get('pronunciationCorrectionSha256'),
            'qualified_current_full_reference_and_identity_match')
        reused.append({name:entry[name] for name in ('textHash','accent','fileKey','fileSha256','mimeType','sizeBytes','kind','cacheKey')}
            |dict(baseline=row['baseline']))
    selected=[entry for key,entry in sorted(original.items()) if key not in overlap]
    h.need(selected,'nonempty_selected_delta_required')
    selected_rows=[dict(textHash=e['textHash'],accent=e['accent'],originalGeneratedEntrySha256=full_entry_sha(h,e)) for e in selected]
    omitted=[dict(textHash=key[0],accent=key[1],originalGeneratedEntrySha256=full_entry_sha(h,original[key])) for key in sorted(overlap)]
    old=[dict(textHash=key[0],accent=key[1],officialEntrySha256=full_entry_sha(h,approved[key]['entry'])) for key in sorted(overlap)]
    h.need({(e['textHash'],e['accent']) for e in selected_rows}.isdisjoint(overlap)
        and len(selected_rows)+len(omitted)==len(original),'explicit_generated_partition')
    return selected,reused,selected_rows,old,omitted


def coverage(h,request,entries,reused,holds):
    hashes={t['textHash'] for t in request['targets']};held={key for key in holds if key[0] in hashes}
    fresh={(e['textHash'],e['accent']) for e in entries};old={(e['textHash'],e['accent']) for e in reused}
    expected={(key,a) for key in hashes for a in h.ACCENTS}
    h.need(len(fresh)==len(entries) and len(old)==len(reused) and not fresh&old and not (fresh|old)&held
        and fresh|old|held==expected,'selected_fresh_official_reused_held_exact_coverage')
    counts={key:sum((key,a) in old for a in h.ACCENTS) for key in hashes}
    return dict(requestedSentenceCount=len(hashes),requestedClipCount=len(hashes)*2,generatedClipCount=len(entries),
        reusedClipCount=len(reused),fullyReusedSentenceCount=sum(v==2 for v in counts.values()),
        partiallyReusedSentenceCount=sum(v==1 for v in counts.values()),heldClipCount=len(held),
        heldSentenceCount=len({key for key,_ in held}),fullyHeldSentenceCount=sum(all((key,a) in held for a in h.ACCENTS) for key in hashes),
        eligibleClipCount=len(expected)-len(held))


def write_json(h,file,value):
    raw=(h.canonical(value)+'\n').encode()
    h.need(len(raw)<=32*h.MIB and not any(m in raw for m in (b'/Users/',b'/Volumes/',b'43.167.217.117')),
        'bounded_publication_json_without_private_paths')
    with file.open('xb') as target:target.write(raw);target.flush();os.fsync(target.fileno())
    return dict(fileName=file.name,bytes=len(raw),sha256=h.sha(raw))


def file_pin(h,reader,file,cap):
    fd,digest,before=reader.checked_fd(file,cap)
    os.close(fd)
    return dict(fileName=file.name,bytes=before.st_size,sha256=digest)


def archive(files,root,target):
    # Same deterministic USTAR/gzip member recipe as the frozen mature builder.
    with target.open('xb') as stream:
        with gzip.GzipFile(filename='',fileobj=stream,mode='wb',mtime=0) as zipped:
            with tarfile.open(fileobj=zipped,mode='w|',format=tarfile.USTAR_FORMAT) as output:
                for file in sorted(files):
                    info=output.gettarinfo(str(file),arcname=file.relative_to(root).as_posix())
                    info.mtime=0;info.uid=info.gid=0;info.uname=info.gname='';info.mode=0o644
                    with file.open('rb') as source:output.addfile(info,source)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('inputs','evidence-root','output'):p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--release-url',required=True);args=p.parse_args()
    q,h,contract_identity=load_contract()
    h.need(sys.platform.startswith('linux') and os.environ.get('GITHUB_ACTIONS')=='true','cloud_only_publication_selection')
    sys.dont_write_bytecode=True
    def guard(event,values):
        h.need(not event.startswith(('socket.','subprocess.','os.exec','os.spawn'))
            and event not in ('os.system','os.fork','os.posix_spawn','sqlite3.connect'),'no_publication_model_decoder_network_or_database')
        if event=='open' and values and isinstance(values[0],(str,bytes,os.PathLike)):
            h.need(not os.fsdecode(values[0]).lower().endswith(('.onnx','.onnx.json','.pt','.pth','.gguf','.safetensors','.wav')),
                'no_publication_models_or_original_wav')
    sys.addaudithook(guard)
    reader=h.Inputs();reader.identities[QUALIFIER]=contract_identity
    self_raw=reader.read(Path(__file__),128*1024)
    root=args.evidence_root.absolute()
    h.need(root.resolve(strict=True)==root and root.is_dir(),'real_publication_evidence_root')
    data=h.decode(reader.read(args.inputs.absolute(),65536))
    h.need(set(data)=={'kind','request','independentCheck','candidate','legacyQualification','legacySelection'}
        and data['kind']=='nightstudy-ci-audio-publication-inputs-v1' and set(data['candidate'])==CANDIDATE_FIELDS,
        'explicit_stage_publication_inputs')
    request=read_pin(h,reader,root,data['request'],8*h.MIB)
    check=read_pin(h,reader,root,data['independentCheck'],16*h.MIB)
    candidate={name:read_pin(h,reader,root,pin,32*h.MIB) for name,pin in data['candidate'].items() if name!='archive'}
    descriptor,manifest,source,node=(candidate[n] for n in ('descriptor','manifest','sources','freshInstallerCheck'))
    archive_file=pin_path(h,root,data['candidate']['archive'],2*1024**3-1)
    fd,_,_=reader.checked_fd(archive_file,2*1024**3-1,data['candidate']['archive']['sha256'],data['candidate']['archive']['bytes']);os.close(fd)
    node_source=reader.read(REPO/'scripts/check-ci-sentence-audio-installer.mjs',128*1024,FRESH_NODE_SHA)
    h.need(check['kind']=='nightstudy-ci-sentence-audio-batch-independent-check-v1'
        and check['state']=='VERIFIED_SELECTED_BATCH_ONLY' and check['requestSha256']==data['request']['sha256']
        and check['checkerSourceSha256']==q.PURE_SHA and check['batchApproval']==request['batchApproval']
        and check['batchWorkerSha256']=='4be14408ff260feb89e5e58e7740b4b522b9a7f05d22d2b1d8009669610a252a'
        and check['purePilotHelperSha256']=='8d4c07d943331228790aa6d0376b664677180705c0b590d42c6c73b32dcc9057'
        and check['publicRootSha256']==h.PUBLIC_SHA and check['finalPolicySha256']==h.FINAL_SHA
        and check['generatedPairs']==check['completeMp3EofDecodes']==check['originalWavsFullyRead']
        and check['allCurrentReferencesBound'] is True and check['selectionPairUnionVerified'] is True
        and check['reviewedFrozenRawCallsVerified'] is True and check['decoderInputProtocol']=='fd'
        and check['seekablePinnedInput'] is True and check['publicationAuthorized'] is False
        and node['kind']=='nightstudy-ci-sentence-audio-installer-check-v1' and node['state']=='VERIFIED_EXTRACTED_PACK_ONLY'
        and node['requestSha256']==data['request']['sha256'] and node['independentCheckSha256']==data['independentCheck']['sha256']
        and node['descriptorSha256']==data['candidate']['descriptor']['sha256']
        and node['checkerSourceSha256']==h.sha(node_source)
        and node['archiveSha256']==data['candidate']['archive']['sha256']==descriptor['source']['sha256']
        and node['archiveBytes']==data['candidate']['archive']['bytes']==descriptor['source']['sizeBytes']
        and node['manifestSha256']==descriptor['manifestSha256']==data['candidate']['manifest']['sha256']
        and node['sourceManifestSha256']==descriptor['sourceManifestSha256']==data['candidate']['sources']['sha256']
        and manifest['sourceManifestSha256']==descriptor['sourceManifestSha256']
        and node['maturePinnedEntryCheckPassed'] is True and node['matureHoldPackCheckPassed'] is True
        and node['exactMp3OnlyFileClosure'] is True and node['publicationAuthorized'] is False,
        'actual_independently_accepted_original_candidate')
    h.need(request['packId']==descriptor['id']==manifest['version']==source['version']
        and source['requestedSentences']==request['targets'] and source['reusedMediaReferences']==[]
        and source['baselinePacks']==[] and source['cloudBuildEvidence']['generatedManifestSha256']==check['generatedManifest']['sha256']
        and source['cloudBuildEvidence']['generatedSourcesSha256']==check['generatedSources']['sha256']
        and source['cloudBuildEvidence']['buildReceiptSha256']==check['generationReceipt']['sha256'],
        'original_candidate_scope_and_generation_proof')
    qualified=read_pin(h,reader,root,data['legacyQualification'],8*h.MIB)
    selection=read_pin(h,reader,root,data['legacySelection'],8*h.MIB)
    approved=qualification(h,qualified,selection,data['legacyQualification'])
    h.need(selection['actualSelection']==request['batchApproval']['selectionManifest'],'same_current_complete_selection')
    voices=reader.json(REPO/'data/audio-voices.manifest.json',65536,h.VOICES_SHA)
    entries,reused,fresh_rows,reused_rows,omitted=partition(h,request,check,manifest,approved,voices)
    output=args.output.absolute()
    h.need(not os.path.lexists(output) and output.parent.resolve(strict=True)==output.parent,'fresh_selected_publication_output')
    output.mkdir(mode=0o700)
    if not reused:
        reader.unchanged()
        write_json(h,output/'conversion-receipt.json',dict(kind='nightstudy-ci-sentence-publication-conversion-v1',
            state='UNCHANGED_ORIGINAL_GENERATION',packId=request['packId'],mode='original-generation',
            selectedPublication=data['candidate'],generationProofUnchanged=True,publicationAuthorized=False))
        return
    choice=dict(kind=CHOICE_KIND,state='EXPLICIT_CURRENT_PUBLICATION_PARTITION',packId=request['packId'],
        entryHashRecipe=ENTRY_HASH_RECIPE,
        publicRootSha256=h.PUBLIC_SHA,finalPolicySha256=h.FINAL_SHA,request=data['request'],independentCheck=data['independentCheck'],
        candidate=data['candidate'],legacyQualification=data['legacyQualification'],legacySelection=data['legacySelection'],
        selectedFreshPairs=fresh_rows,reusedOfficialPairs=reused_rows,generatedNotSelectedPairs=omitted,
        generationProofUnchanged=True,publicationAuthorized=False)
    choice_pin=write_json(h,output/'publication-choice.json',choice)
    original_root=pin_path(h,root,data['candidate']['manifest'],32*h.MIB).parent
    h.need(pin_path(h,root,data['candidate']['sources'],32*h.MIB).parent==original_root,'one_original_extracted_root')
    hold_raw=reader.read(h.relative(original_root,'pronunciation-holds.json'),4*h.MIB,HOLDS_SHA,80987)
    holds={(e['textHash'],e['accent']):e for e in h.decode(hold_raw)['entries']}
    stats=coverage(h,request,entries,reused,holds)
    pack=output/'pack';pack.mkdir();(pack/'files').mkdir();(pack/'licenses').mkdir()
    def copy(source_file,target_file,digest=None,size=None,cap=2*h.MIB):
        raw=reader.read(source_file,cap,digest,size)
        with target_file.open('xb') as target:target.write(raw);target.flush();os.fsync(target.fileno())
    copy(h.relative(original_root,'pronunciation-holds.json'),pack/'pronunciation-holds.json',
        HOLDS_SHA,80987,4*h.MIB)
    if source.get('pronunciationReviews'):
        pin=source['pronunciationReviews']
        copy(h.relative(original_root,'pronunciation-reviews.json'),pack/'pronunciation-reviews.json',pin['sha256'],pin['bytes'],4*h.MIB)
    seen=set()
    for entry in entries:
        if entry['fileKey'] in seen:continue
        seen.add(entry['fileKey'])
        h.need(re.fullmatch('files/[a-f0-9]{64}\.mp3',entry['fileKey']),'selected_mp3_only')
        copy(h.relative(original_root,entry['fileKey']),pack/entry['fileKey'],entry['fileSha256'],entry['sizeBytes'])
    notices=h.relative(original_root,'licenses')
    h.need(notices.is_dir(),'original_public_notices_required')
    for name in sorted(notices.iterdir()):
        h.need(re.fullmatch('[A-Za-z0-9_.-]+\.(txt|json|md)',name.name),'public_notice_name')
        copy(h.relative(notices,name.name),pack/'licenses'/name.name,cap=128*1024)
    selected_hashes={e['textHash'] for e in entries}
    by_hash={t['textHash']:t for t in request['targets']}
    reused_hashes=sorted({r['textHash'] for r in reused})
    reuse_sentences=[dict(textHash=key,text=by_hash[key]['text'],references=by_hash[key]['references'],
        pairs=[r for r in reused if r['textHash']==key]) for key in reused_hashes]
    baselines=sorted({r['baseline']['id']:r['baseline'] for r in reused}.values(),key=lambda b:b['id'])
    new_source=dict(source,sentences=[t for t in request['targets'] if t['textHash'] in selected_hashes],
        reusedMediaReferences=reused,reusedSentences=reuse_sentences,baselinePacks=baselines,coverage=stats,
        publicationSelection=dict(kind=CHOICE_KIND,choiceProof=choice_pin,legacySelectionSha256=data['legacySelection']['sha256'],
            qualificationSha256=data['legacyQualification']['sha256']))
    source_pin=write_json(h,pack/'sources.manifest.json',new_source)
    new_stats=dict(manifest['statistics'],lemmaCount=len(selected_hashes),entryCount=len(entries),recordedCount=0,
        synthesizedCount=len(entries),failedCount=0,**stats)
    new_manifest=dict(manifest,sourceManifestSha256=source_pin['sha256'],statistics=new_stats,entries=entries)
    manifest_pin=write_json(h,pack/'manifest.json',new_manifest)
    files=sorted([file for file in pack.rglob('*') if file.is_file()])
    h.need(all(not file.is_symlink() and file.resolve().is_relative_to(pack) for file in files),'safe_selected_archive_members')
    target=output/('nightstudy-'+request['packId']+'.tar.gz')
    archive(files,pack,target)
    archive_pin=file_pin(h,reader,target,2*1024**3-1)
    h.need(re.fullmatch('https://github.com/wudi000888-svg/nightstudy/releases/download/[A-Za-z0-9._-]+',args.release_url),
        'explicit_selected_public_release_url')
    new_descriptor=dict(descriptor,source=dict(url=args.release_url+'/'+target.name,sha256=archive_pin['sha256'],sizeBytes=archive_pin['bytes']),
        manifestSha256=manifest_pin['sha256'],sourceManifestSha256=source_pin['sha256'],**new_stats)
    descriptor_pin=write_json(h,output/(request['packId']+'.manifest.json'),new_descriptor)
    reader.unchanged()
    write_json(h,output/'conversion-receipt.json',dict(kind='nightstudy-ci-sentence-publication-conversion-v1',
        state='CONVERTED_REQUIRES_SELECTED_INSTALLER_CHECK',packId=request['packId'],mode='legacy-reuse-conversion',
        converterSourceSha256=h.sha(self_raw),choiceProof=choice_pin,originalCandidate=data['candidate'],
        selectedPublication=dict(descriptor=descriptor_pin,archive=archive_pin,manifest=manifest_pin,sources=source_pin),
        originalGeneratedPairs=check['generatedPairs'],selectedFreshPairs=len(entries),reusedOfficialPairs=len(reused),
        generatedNotSelectedPairs=len(omitted),generationProofUnchanged=True,coverage=stats,
        originalArchivesModified=False,modelUsed=False,mediaDecodedHere=False,publicationAuthorized=False))


if __name__=='__main__':main()
