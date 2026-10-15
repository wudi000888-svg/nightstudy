#!/usr/bin/env python3
"""Consolidate verified offline word packs, preferring original human recordings.

WAV speech and original human OGG/FLAC recordings are encoded to MP3 once.
Inputs remain untouched; only the separately selected outputs are archived.
"""
from __future__ import annotations
import argparse
import concurrent.futures
import fcntl
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tarfile

SPEC = importlib.util.spec_from_file_location("codec", Path(__file__).with_name("offline-audio-codec.py"))
codec = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(codec)
PACK_SPEC = importlib.util.spec_from_file_location('word_audio_pack', Path(__file__).with_name('audio-pack.py'))
pack = importlib.util.module_from_spec(PACK_SPEC)
PACK_SPEC.loader.exec_module(pack)


def sha(filename):
    with filename.open('rb') as handle:
        return hashlib.file_digest(handle,'sha256').hexdigest()


def atomic_json(filename,value):
    raw=(json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n').encode()
    temporary=filename.with_suffix(filename.suffix+'.part');temporary.write_bytes(raw);temporary.replace(filename)
    return hashlib.sha256(raw).hexdigest()


def materialize(task,output):
    entry,root=task
    source=root/entry['fileKey']
    if not source.is_file() or source.is_symlink() or sha(source)!=entry['fileSha256']:
        raise ValueError('input_audio_hash_mismatch')
    marker=output/'converted'/(entry['fileSha256']+'.json')
    if marker.exists():
        previous=json.loads(marker.read_text());cached=output/previous['fileKey']
        if cached.is_file() and sha(cached)==previous['fileSha256'] and previous.get('qualityMetrics',{}).get('policyVersion')==codec.QUALITY_POLICY['version']:
            reused={**entry,**{key:value for key,value in previous.items() if key in ('fileKey','fileSha256','sizeBytes','mimeType','encoding','decodedDurationSeconds','originalFileSha256','originalMimeType','durationSeconds','qualityMetrics')}}
            return {**reused,'attribution':codec.output_attribution(entry,bool(previous.get('encoding')))}
    if entry['mimeType']!='audio/mpeg':
        entry=codec.encode_mp3(entry,output,root)
    else:
        target=output/entry['fileKey']
        if not target.exists() or target.is_symlink() or sha(target)!=entry['fileSha256']:
            if target.is_symlink():raise ValueError('output_audio_symlink')
            shutil.copyfile(source,target)
        if entry.get('qualityMetrics',{}).get('policyVersion')!=codec.QUALITY_POLICY['version']:entry={**entry,'qualityMetrics':codec.inspect_media(entry,output)}
    atomic_json(marker,entry)
    return entry


def materialize_with_fallback(tasks,output):
    failures=[]
    for task in tasks:
        try:
            entry=materialize(task,output)
            return {**entry,'qualityFallbacks':failures} if failures else entry
        except Exception as error:
            # No host paths or subprocess command strings enter the public pack.
            failures.append({'sourceFileSha256':task[0]['fileSha256'],'reason':str(error) if isinstance(error,ValueError) else type(error).__name__})
    raise ValueError('all_sources_failed_acoustic_qc:'+tasks[0][0]['lemma']+':'+tasks[0][0]['accent'])


def inherit_phonetic_metadata(entry, alternatives):
    if entry.get('phonetic'):
        return entry
    for candidate, _ in reversed(alternatives):
        if (candidate['lemma'], candidate['accent']) != (entry['lemma'], entry['accent']):
            raise ValueError('phonetic_word_accent_binding_mismatch')
        if candidate.get('phonetic') and candidate.get('phoneticSource'):
            fields = {key: value for key, value in candidate.items() if key.startswith('phonetic')}
            return {**entry, **fields, 'phoneticMetadataReference': {
                'kind': 'existing-offline-pack-entry', 'lemma': candidate['lemma'],
                'accent': candidate['accent'], 'fileSha256': candidate['fileSha256'],
                'note': 'Independent display IPA metadata, not extracted from or applied to the human recording.'}}
    return entry


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-manifest',type=Path,action='append',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--workers',type=int,default=6,choices=(2,4,6))
    parser.add_argument('--cache-only',action='store_true',help='Convert and verify selected media only; do not write pack manifests, source metadata, pin or archive.')
    args=parser.parse_args();output=args.output.resolve()
    folders=[output,output/'files',output/'converted']
    if not args.cache_only:folders.append(output/'licenses')
    for folder in folders:folder.mkdir(parents=True,exist_ok=True)
    with (output/'.conversion.lock').open('a') as conversion_lock:
        fcntl.flock(conversion_lock,fcntl.LOCK_EX)
        return build_pack(args,output)


def build_pack(args,output):
    selected={};alternatives={};sources=[]
    for index,filename in enumerate(args.input_manifest):
        root=filename.resolve().parent;manifest=json.loads(filename.read_text())
        if manifest.get('status')!='ready':raise ValueError('input_pack_not_ready')
        originals=[root/(filename.name.replace('.manifest.json','.sources.manifest.json')),root/'sources.manifest.json']
        original=next((candidate for candidate in originals if candidate.exists() and sha(candidate)==manifest['sourceManifestSha256']),None)
        if original is None:raise ValueError('input_source_manifest_mismatch')
        sources.append({'version':manifest['version'],'manifestSha256':sha(filename),'sourceManifestSha256':sha(original),'sources':json.loads(original.read_text())})
        for entry in manifest['entries']:
            key=(entry['lemma'],entry['accent']);before=selected.get(key)
            alternatives.setdefault(key,[]).append((entry,root))
            if before and before[0]['kind']=='recorded' and entry['kind']!='recorded':continue
            selected[key]=(entry,root)
        if not args.cache_only:
            for notice in (root/'licenses').glob('*'):
                if notice.is_file() and not notice.is_symlink():shutil.copyfile(notice,output/'licenses'/f'part{index}-{notice.name}')
    source={'schemaVersion':2,'version':'word-audio-v2','policy':'Original human recordings preferred per word/accent; static offline synthesis only for remaining pairs. No runtime voice engine or browser speech. Both human OGG/FLAC and synthetic WAV are encoded MP3 48kbps with original digest and MIME mappings retained.','phoneticPolicy':'Independent display IPA is inherited only from a validated same-lemma, same-accent offline input entry; remaining blanks use bundled eSpeak-NG phonemizer only, without loading or running an acoustic model. Installer fills only empty typed IPA fields. This metadata does not change the recorded speech or serve as a voice input.','acousticQualityPolicy':codec.QUALITY_POLICY,'transcodingTool':codec.build_tool_identity(),'inputs':sources}
    source_sha=atomic_json(output/'sources.manifest.json',source) if not args.cache_only else None
    print(json.dumps({'phase':'consolidate-scope','pairs':len(selected)}),flush=True)
    entries=[]
    tasks=[]
    for key,first in selected.items():
        others=[task for task in reversed(alternatives[key]) if task[0]['fileSha256']!=first[0]['fileSha256']]
        tasks.append([first,*others])
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers)as pool:
        for entry in pool.map(lambda task:materialize_with_fallback(task,output),tasks):
            entries.append(entry)
            if len(entries)%1000==0:print(json.dumps({'phase':'consolidate','ready':len(entries),'total':len(selected)}),flush=True)
    if args.cache_only:
        print(json.dumps({'phase':'cache-only-ready','convertedEntries':len(entries),
                          'manifestsWritten':False,'pinWritten':False,'archiveWritten':False}),flush=True)
        return
    phonemizer=None;inherited_ipa=0;new_ipa=0
    for index,entry in enumerate(entries):
        inherited=inherit_phonetic_metadata(entry,alternatives[(entry['lemma'],entry['accent'])])
        if not entry.get('phonetic') and inherited.get('phonetic'):inherited_ipa+=1
        if not inherited.get('phonetic'):
            if phonemizer is None:phonemizer=pack.make_phonemizer()
            inherited={**inherited,**pack.algorithmic_phonetic(entry['lemma'],entry['accent'],phonemizer)}
            new_ipa+=1
        entries[index]=inherited
    print(json.dumps({'phase':'independent-ipa','inheritedFromExistingEntries':inherited_ipa,
                      'newPhonemizerOnly':new_ipa,'audioBytesChanged':False}),flush=True)
    entries.sort(key=lambda entry:(entry['lemma'],entry['accent']))
    atomic_json(output/'quality-exclusions.json',[{'lemma':entry['lemma'],'accent':entry['accent'],'rejected':entry['qualityFallbacks']}for entry in entries if entry.get('qualityFallbacks')])
    stats={'lemmaCount':len({e['lemma']for e in entries}),'entryCount':len(entries),'recordedCount':sum(e['kind']=='recorded'for e in entries),'synthesizedCount':sum(e['kind']=='synthesized'for e in entries),'failedCount':0,'usCount':sum(e['accent']=='US'for e in entries),'ukCount':sum(e['accent']=='UK'for e in entries),'phoneticCount':sum(bool(e.get('phonetic'))for e in entries),'inheritedPhoneticCount':inherited_ipa,'newPhonemizerOnlyCount':new_ipa}
    manifest={'schemaVersion':2,'version':'word-audio-v2','status':'ready','sourceManifestSha256':source_sha,'statistics':stats,'entries':entries}
    manifest_sha=atomic_json(output/'manifest.json',manifest)
    archive_path=output.parent/'nightstudy-word-audio-v2.tar.gz'
    with archive_path.open('wb')as destination:
        with gzip.GzipFile(filename='',fileobj=destination,mode='wb',mtime=0)as compressed:
            with tarfile.open(fileobj=compressed,mode='w|',format=tarfile.USTAR_FORMAT)as archive:
                files=[output/'manifest.json',output/'sources.manifest.json',*sorted((output/'licenses').glob('*')),*sorted({output/e['fileKey']for e in entries})]
                for filename in files:
                    info=archive.gettarinfo(str(filename),arcname=filename.relative_to(output).as_posix());info.mtime=0;info.uid=info.gid=0;info.uname=info.gname='';info.mode=0o644
                    with filename.open('rb')as handle:archive.addfile(info,handle)
    pin={'id':'word-audio-v2','status':'ready','version':'word-audio-v2','source':{'url':'https://github.com/wudi000888-svg/nightstudy/releases/download/v0.9.0-alpha.1/'+archive_path.name,'sizeBytes':archive_path.stat().st_size,'sha256':sha(archive_path)},**stats,'manifestSha256':manifest_sha,'sourceManifestSha256':source_sha,'note':'Consolidated prebuilt word and phrase audio. Human recordings preferred, then locally generated missing pairs. No voice model/engine download or runtime synthesis; one static cache per installation.'}
    atomic_json(output.parent/'word-audio-v2.pin.json',pin)
    print(json.dumps({'phase':'ready',**pin}),flush=True)


if __name__=='__main__':main()
