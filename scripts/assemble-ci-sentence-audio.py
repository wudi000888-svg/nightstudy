#!/usr/bin/env python3
"""Package independently accepted MP3s for the existing v4 installer.

This entry never imports a model or decodes/renders audio. Original WAVs and
route/progress evidence remain untouched outside the installer archive.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import sys
import types

ROOT=Path(__file__).resolve().parent.parent
BATCH_SHA='4be14408ff260feb89e5e58e7740b4b522b9a7f05d22d2b1d8009669610a252a'
CHECKER_SHA='16fbaf7f522a0f26382a923df7670b623fa49df4f82a8b6b225f1e2af71913d8'
PURE_CHECKER_SHA='8d4c07d943331228790aa6d0376b664677180705c0b590d42c6c73b32dcc9057'
HOLDS_SHA='138e3923cccc0a2b77f4dc0d2da38e9d24c5fd336e26a4b83bfa274c679129e3'
HOLD_MANIFEST_SHA='f61bdf164dbeb594c8ee45d91e3996a97e2aee8537ef297ddafd0f3b6344e956'


def load_contract():
    file=Path(__file__).with_name('ci-sentence-audio-batch.py')
    if file.resolve(strict=True)!=file:raise ValueError('fixed_package_contract_path')
    fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
    identity=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size!=29397:
            raise ValueError('fixed_package_contract_size')
        raw=os.read(fd,128*1024+1)
        if len(raw)!=29397 or os.read(fd,1) or hashlib.sha256(raw).hexdigest()!=BATCH_SHA or \
                identity(before)!=identity(os.fstat(fd)) or identity(before)!=identity(os.lstat(file)):
            raise ValueError('fixed_package_contract_bytes')
    finally:os.close(fd)
    module=types.ModuleType('_ci_audio_package_batch_contract')
    module.__file__=str(file)
    exec(compile(raw,str(file),'exec'),module.__dict__)
    return module


b=load_contract()
w=b.w


def public_bytes(path,raw):
    w.require(not any(marker in raw for marker in (b'/Users/',b'/Volumes/',b'43.167.217.117')),
        'private_marker_in_public_package')
    with Path(path).open('xb') as handle:
        handle.write(raw);handle.flush();os.fsync(handle.fileno())


def json_output(path,value):
    public_bytes(path,(w.canonical(value)+'\n').encode('utf-8'))


def copy_pin(source,target,expected,maximum,size=None):
    raw=w.read_bounded(source,maximum,expected,size)
    with target.open('xb') as handle:
        handle.write(raw);handle.flush();os.fsync(handle.fileno())


def accepted_output_pin(check,field,name,raw):
    w.require(check.get(field)==dict(fileName=name,bytes=len(raw),sha256=w.sha(raw)),
        'independently_accepted_output_pin:'+name)


def check_acceptance(check,request,request_sha):
    w.require(check.get('kind')=='nightstudy-ci-sentence-audio-batch-independent-check-v1'
        and check.get('state')=='VERIFIED_SELECTED_BATCH_ONLY' and check.get('requestSha256')==request_sha
        and check.get('publicRootSha256')==w.PUBLIC_ROOT_SHA and check.get('finalPolicySha256')==w.FINAL_POLICY_SHA
        and check.get('batchApproval')==request['batchApproval'] and check.get('publicationAuthorized') is False
        and check.get('allCurrentReferencesBound') is True and check.get('selectionPairUnionVerified') is True
        and check.get('reviewedFrozenRawCallsVerified') is True and check.get('decoderInputProtocol')=='fd'
        and check.get('seekablePinnedInput') is True and check.get('batchWorkerSha256')==BATCH_SHA
        and check.get('checkerSourceSha256')==CHECKER_SHA and check.get('purePilotHelperSha256')==PURE_CHECKER_SHA
        and check.get('journalReusePolicy')==b.JOURNAL_POLICY
        and check.get('oldUnapprovedCandidateSelection')=='NOT_SELECTED' and check.get('oldUnapprovedCandidates')==89880
        and check.get('taskSentenceCap')==128 and check.get('workers')==request['batchApproval']['workers']
        and check.get('threadsPerVoice')==1 and check.get('decoderThreads')==1,
        'actual_selected_batch_independent_acceptance_required')


def policy_files(name):
    policy_file=w.relative_file(name)
    policy_manifest=w.json_bytes(w.read_bounded(policy_file,65536,HOLD_MANIFEST_SHA,375))
    w.require(policy_file.name=='sentence-audio-holds-v1.manifest.json'
        and policy_manifest==dict(formatVersion=1,id='sentence-audio-holds-v1',
            fileName='sentence-audio-holds-v1.json',bytes=80987,sha256=HOLDS_SHA,holdCount=79,
            learningSensesManifestFileName='learning-senses-collection-v2.manifest.json',
            learningSensesManifestSha256=w.PUBLIC_ROOT_SHA),'explicit_exact_global_hold_policy')
    # The policy is staged beside its manifest until the final complete three-
    # file collection is ready. Do not install a partial policy into data/.
    hold_raw=w.read_bounded(policy_file.parent/policy_manifest['fileName'],4*w.MIB,
        policy_manifest['sha256'],policy_manifest['bytes'])
    hold_policy=w.json_bytes(hold_raw)
    w.require(set(hold_policy)=={'formatVersion','id','entries'} and hold_policy['formatVersion']==1
        and hold_policy['id']=='sentence-audio-holds-v1' and len(hold_policy['entries'])==79,'whole_global79_hold_policy')
    return policy_manifest,hold_raw,hold_policy


def verify_archive_members(output,files):
    names=[file.relative_to(output).as_posix() for file in files]
    metadata={'manifest.json','sources.manifest.json','pronunciation-holds.json','pronunciation-reviews.json'}
    allowed=lambda name:name in metadata or bool(re.fullmatch(
        r'files/[a-f0-9]{64}\.mp3|licenses/[A-Za-z0-9][A-Za-z0-9._-]*',name))
    w.require(len(names)==len(set(names)) and all(allowed(name) for name in names)
        and all(file.is_file() and not file.is_symlink() and file.resolve().is_relative_to(output) for file in files)
        and {file.relative_to(output).as_posix() for file in output.rglob('*') if file.is_file()}==set(names),
        'exact_installer_members_mp3_no_wav_or_evidence')


def coverage(request,entries,holds):
    by_hash={row['textHash']:row for row in request['targets']}
    applicable={key:record for key,record in holds.items() if key[0] in by_hash}
    held_refs=[]
    for key,record in sorted(applicable.items()):
        row=by_hash[key[0]]
        w.require(row['text']==record['text'] and any(ref['learningSenseId']==record['learningSenseId']
            and ref['exampleId']==record['exampleId'] for ref in row['references']),'package_hold_current_reference')
        held_refs.append(dict(holdId=record['id'],**{name:record[name] for name in (
            'textHash','accent','learningSenseId','exampleId','riskCategory')}))
    expected={(text_hash,accent) for text_hash in by_hash for accent in ('US','UK')}-set(applicable)
    actual={(entry['textHash'],entry['accent']) for entry in entries}
    w.require(len(actual)==len(entries) and actual==expected,'installer_requires_every_nonheld_requested_accent')
    held_hashes={key[0] for key in applicable}
    stats=dict(requestedSentenceCount=len(by_hash),requestedClipCount=len(by_hash)*2,
        generatedClipCount=len(entries),reusedClipCount=0,fullyReusedSentenceCount=0,
        partiallyReusedSentenceCount=0,heldClipCount=len(applicable),heldSentenceCount=len(held_hashes),
        fullyHeldSentenceCount=sum(all((text_hash,a) in applicable for a in ('US','UK')) for text_hash in by_hash),
        eligibleClipCount=len(expected))
    return stats,held_refs


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('request','build-output','check-receipt','output'):
        parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--request-sha256',required=True)
    parser.add_argument('--check-sha256',required=True)
    parser.add_argument('--policy-manifest',required=True,help='Repository-relative staged exact global hold manifest')
    parser.add_argument('--release-url',required=True)
    args=parser.parse_args()
    w.require(platform.system()=='Linux' and os.environ.get('GITHUB_ACTIONS')=='true','cloud_only_package_assembly')
    sys.dont_write_bytecode=True
    sys.addaudithook(w.deny_network)
    def audit(event,values):
        w.require(not event.startswith(('subprocess.','os.exec','os.spawn')) and event not in
            ('os.system','os.fork','os.posix_spawn','sqlite3.connect'),'no_package_model_child_or_db')
        if event=='open' and values and isinstance(values[0],(str,bytes,os.PathLike)):
            w.require(not os.fsdecode(values[0]).lower().endswith(('.onnx','.onnx.json','.pt','.pth','.gguf','.safetensors')),
                'no_package_model_weight_or_config_open')
    sys.addaudithook(audit)
    request=w.json_bytes(w.read_bounded(args.request,8*w.MIB,args.request_sha256))
    check=w.json_bytes(w.read_bounded(args.check_receipt,16*w.MIB,args.check_sha256))
    check_acceptance(check,request,args.request_sha256)
    w.require(isinstance(args.release_url,str) and re.fullmatch(
        'https://github.com/wudi000888-svg/nightstudy/releases/download/[A-Za-z0-9._-]+',args.release_url),
        'explicit_public_release_url')
    builder=w.load_builder();pipeline=builder.pipeline_module()
    base_controls=w.validate_controls(w.pin_value(request['portableControls'],64*w.MIB),
        pipeline.pronunciation,builder.publication_holds_module())
    controls,_=b.merge_supplement(request['batchApproval']['supplementalControls'],base_controls,
        pipeline,builder.publication_holds_module())
    _,identities,denials=b.prepare_request(request,controls,pipeline)
    expected={(row['textHash'],row['accent']):row for row in identities}
    w.require(check['generatedPairs']==check['completeMp3EofDecodes']==check['originalWavsFullyRead']==len(expected)
        and check['heldDenials']==len(denials) and isinstance(check.get('media'),list)
        and len(check['media'])==len(expected),'accepted_whole_batch_media_count')
    accepted={(row['textHash'],row['accent']):row for row in check['media']}
    w.require(len(accepted)==len(check['media']) and set(accepted)==set(expected),'accepted_whole_key_set')
    source_dir=args.build_output.absolute()
    w.require(source_dir.resolve(strict=True)==source_dir and source_dir.is_dir(),'real_accepted_build_directory')
    built_raw=w.read_bounded(source_dir/'manifest.json',16*w.MIB)
    accepted_output_pin(check,'generatedManifest','manifest.json',built_raw)
    built=w.json_bytes(built_raw)
    source_raw=w.read_bounded(source_dir/'sources.manifest.json',16*w.MIB,built['sourceManifestSha256'])
    accepted_output_pin(check,'generatedSources','sources.manifest.json',source_raw)
    sources=w.json_bytes(source_raw)
    build_raw=w.read_bounded(source_dir/'build-receipt.json',4*w.MIB)
    accepted_output_pin(check,'generationReceipt','build-receipt.json',build_raw)
    build=w.json_bytes(build_raw)
    w.require(build['requestSha256']==args.request_sha256 and build['generatedPairs']==len(expected)
        and build['state']=='GENERATED_REQUIRES_INDEPENDENT_CHECK'
        and built['version']==request['packId'] and built['status']=='ready'
        and sources['requestedSentences']==request['targets'] and sources['batchApproval']==request['batchApproval'],
        'accepted_generation_request_and_source_identity')
    entries=built['entries']
    w.require(isinstance(entries,list) and len(entries)==len(expected)
        and {(e['textHash'],e['accent']) for e in entries}==set(expected),'complete_selected_generated_entries')
    for entry in entries:
        key=entry['textHash'],entry['accent'];verified=accepted[key]
        w.require(entry['cacheKey']==verified['cacheKey']==expected[key]['cacheKey']
            and entry['fileSha256']==verified['fileSha256'] and entry['originalFileSha256']==verified['originalWavSha256']
            and entry['mimeType']=='audio/mpeg' and entry['fileKey']=='files/'+entry['fileSha256']+'.mp3',
            'every_packaged_mp3_is_the_independently_accepted_asset')
        w.require(type(entry['sizeBytes']) is int and 0<entry['sizeBytes']<=2*w.MIB,
            'bounded_accepted_mp3_size')
    w.require(sum(e['sizeBytes'] for e in entries)<2*1024**3-128*w.MIB,'bounded_mp3_archive_input_budget')
    policy_manifest,hold_raw,hold_policy=policy_files(args.policy_manifest)
    holds_module=builder.publication_holds_module()
    holds={(record['textHash'],record['accent']):holds_module.validate_hold(record) for record in hold_policy['entries']}
    expected_holds={(h,a):c['hold'] for h,g in controls.items() for a,c in g['accents'].items() if c['state']=='hold'}
    w.require(len(holds)==79 and holds==expected_holds,'global_policy_exact_current_records_not_reserialized')
    pack_coverage,held_refs=coverage(request,entries,holds)
    output=args.output.absolute()
    w.require(not os.path.lexists(output) and output.parent.resolve(strict=True)==output.parent,'fresh_installer_output')
    output.mkdir(mode=0o700);(output/'files').mkdir();(output/'licenses').mkdir()
    public_bytes(output/'pronunciation-holds.json',hold_raw)
    reviews=[]
    for key in sorted(expected):
        group=controls.get(key[0]);correction=group['accents'][key[1]]['correction'] if group else None
        if correction:reviews.append(correction['record'])
    if reviews:
        json_output(output/'pronunciation-reviews.json',dict(formatVersion=1,id='sentence-pronunciation-v1',
            engineVersion='1.8.0',voicesManifestSha256=w.VOICES_SHA,entries=reviews))
    publication_sources=dict(sources,sentences=request['targets'],requestedSentences=request['targets'],
        reusedSentences=[],reusedMediaReferences=[],baselinePacks=[],coverage=pack_coverage,heldMediaReferences=held_refs,
        pronunciationHolds=dict(fileName='pronunciation-holds.json',sourceFileName=policy_manifest['fileName'],
            bytes=len(hold_raw),sha256=w.sha(hold_raw),holdCount=79,appliedClipCount=len(held_refs)),
        normalization='NFKC; curly quote to ASCII; collapse whitespace; preserve case',
        cloudBuildEvidence=dict(requestSha256=args.request_sha256,independentCheckSha256=args.check_sha256,
            generatedManifestSha256=w.sha(built_raw),generatedSourcesSha256=w.sha(source_raw),buildReceiptSha256=w.sha(build_raw)),
        policy='Prebuilt with the existing cached voices. Independently checked complete files; not expert-certified pronunciation.')
    if reviews:
        review_file=output/'pronunciation-reviews.json'
        publication_sources['pronunciationReviews']=dict(fileName=review_file.name,sourceFileName=review_file.name,
            bytes=review_file.stat().st_size,sha256=w.digest(review_file),appliedClipCount=len(reviews),
            engineVersion='1.8.0',expertCertified=False)
    json_output(output/'sources.manifest.json',publication_sources)
    statistics=dict(built['statistics'],**pack_coverage)
    public_manifest=dict(built,sourceManifestSha256=w.digest(output/'sources.manifest.json'),statistics=statistics)
    json_output(output/'manifest.json',public_manifest)
    media=set()
    for entry in entries:
        name=entry['fileKey']
        if name in media:continue
        media.add(name)
        copy_pin(source_dir/name,output/name,entry['fileSha256'],2*w.MIB,entry['sizeBytes'])
    notice_files=[]
    for relative in sources['engineSource']['licenseNotices']:
        file=w.relative_file('data/'+relative)
        raw=w.read_bounded(file,128*1024)
        target=output/'licenses'/file.name
        w.require(not target.exists(),'distinct_voice_notice_names')
        public_bytes(target,raw);notice_files.append(target)
    target=output/'licenses/NIGHTSTUDY-MIT.txt';public_bytes(target,w.read_bounded(ROOT/'LICENSE',128*1024));notice_files.append(target)
    # Preserve any separately pinned meaning-source notices without loading the
    # full public collection or borrowing a provider's license declaration.
    collection=w.json_bytes(w.read_bounded(ROOT/'data/learning-senses-collection-v2.manifest.json',65536,w.PUBLIC_ROOT_SHA))
    for shard in collection['shards']:
        manifest=w.pin_value(dict(fileName='data/'+shard['manifestFileName'],bytes=shard['bytes'],sha256=shard['sha256']),65536)
        for notice in manifest.get('licenseNotices',[]):
            w.require(re.fullmatch('[A-Za-z0-9][A-Za-z0-9.-]*',notice['fileName']),'public_notice_basename')
            raw=w.read_bounded(w.relative_file('data/'+notice['fileName']),128*1024,notice['sha256'],notice['bytes'])
            target=output/'licenses'/notice['fileName']
            if target.exists():w.require(w.digest(target)==notice['sha256'],'same_name_notice_hash_collision')
            else:public_bytes(target,raw);notice_files.append(target)
    files=[output/'manifest.json',output/'sources.manifest.json',output/'pronunciation-holds.json',
        *([output/'pronunciation-reviews.json'] if reviews else []),*sorted(notice_files),*[output/name for name in sorted(media)]]
    verify_archive_members(output,files)
    archive=output.parent/('nightstudy-'+request['packId']+'.tar.gz')
    w.require(not os.path.lexists(archive),'fresh_immutable_archive_name')
    builder.build_archive(files,output,archive,immutable=True)
    w.require(0<archive.stat().st_size<2*1024**3,'installer_archive_strictly_below_two_gib')
    descriptor=dict(id=request['packId'],status='ready',version=request['packId'],
        source=dict(url=args.release_url+'/'+archive.name,sha256=w.digest(archive),sizeBytes=archive.stat().st_size),
        **statistics,manifestSha256=w.digest(output/'manifest.json'),sourceManifestSha256=w.digest(output/'sources.manifest.json'),
        note='Reviewed current meaning-bound static US/UK sentence audio. Existing immutable baseline preserved; no runtime synthesis.')
    json_output(output.parent/(request['packId']+'.manifest.json'),descriptor)
    w.write_new(output.parent/(request['packId']+'.assembly.json'),dict(kind='nightstudy-ci-audio-installer-assembly-v1',
        state='ASSEMBLED_REQUIRES_INSTALLER_ACCEPTANCE',requestSha256=args.request_sha256,
        independentCheckSha256=args.check_sha256,assemblerSourceSha256=w.digest(Path(__file__)),
        archive=dict(fileName=archive.name,bytes=archive.stat().st_size,sha256=descriptor['source']['sha256']),
        mp3Files=len(media),originalWavsInArchive=0,modelFilesInArchive=0,evidenceLogsInArchive=0,
        pronunciationReviewCount=len(reviews),globalHoldCount=79,coverage=pack_coverage,
        modelImported=False,publicationAuthorized=False))


if __name__=='__main__':main()
