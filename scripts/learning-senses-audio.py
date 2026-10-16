#!/usr/bin/env python3
"""Offline static US/UK sentence audio for a pinned atomic-meaning content pack.

Uses already cached voices. No model download, database connection or runtime synthesis.
The package contains public original sentences, audio and attribution only.
"""
from __future__ import annotations
import argparse
import concurrent.futures
import gzip
import hashlib
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import sys
import tarfile

REPO = Path(__file__).resolve().parent.parent
VERSION = 'sentence-audio-v3'


def digest(file):
    with Path(file).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def external(directory, create=False):
    if not Path('/Volumes/XXX').is_mount():
        raise ValueError('external_disk_not_mounted')
    directory = Path(directory).absolute()
    parent = directory
    while not parent.exists():
        parent = parent.parent
    if not parent.resolve().is_relative_to('/Volumes/XXX/Codex'):
        raise ValueError('external_output_required')
    if create:
        directory.mkdir(parents=True, exist_ok=True)
    if directory.is_symlink() or not directory.resolve().is_relative_to('/Volumes/XXX/Codex'):
        raise ValueError('external_output_required')
    return directory.resolve(strict=True)


def pipeline_module():
    spec = importlib.util.spec_from_file_location('nightstudy_meaning_sentence_audio', REPO / 'scripts/sentence-audio-pack.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def worker(accent, rows, output, models, shard):
    external(output)
    module = pipeline_module()
    synthesize, encode = module.pack.synthesize_entry, module.codec.encode_mp3
    def guarded_synthesize(*args, **kwargs):
        external(output)
        return synthesize(*args, **kwargs)
    def guarded_encode(*args, **kwargs):
        external(output)
        return encode(*args, **kwargs)
    module.pack.synthesize_entry = guarded_synthesize
    module.codec.encode_mp3 = guarded_encode
    return module.worker(accent, rows, output, models, shard)


def collect(manifest_file, content_file):
    manifest = json.loads(manifest_file.read_text())
    if content_file.is_symlink() or content_file.stat().st_size != manifest['bytes'] or digest(content_file) != manifest['sha256']:
        raise ValueError('meaning_content_pin_mismatch')
    raw = gzip.decompress(content_file.read_bytes())
    if hashlib.sha256(raw).hexdigest() != manifest['jsonlSha256']:
        raise ValueError('meaning_content_jsonl_mismatch')
    module = pipeline_module()
    rows = {}
    for line in raw.decode('utf-8').splitlines():
        word = json.loads(line)
        for sense in word['senses']:
            for example in sense['examples']:
                if (sense['status'] != 'published' or example['status'] != 'published'
                    or sense['wordId'] != word['wordId'] or example['wordId'] != word['wordId']
                    or example['learningSenseId'] != sense['id']
                    or example['contentVersion'] != sense['contentVersion']
                    or not example['contextLabel'].strip() or not example['exampleZh'].strip()
                    or not example['exampleEn'].strip()):
                    raise ValueError('unpublished_or_unbound_sentence')
                text = module.normalize(example['exampleEn'])
                identity = module.text_hash(text)
                row = rows.setdefault(identity, {'textHash':identity,'text':text,'references':[]})
                row['references'].append({'wordId':word['wordId'],'learningSenseId':sense['id'],'exampleId':example['id'],'contextLabel':example['contextLabel'],'source':example['contentMetadata']})
    return manifest, sorted(rows.values(), key=lambda row:row['textHash'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',type=Path,required=True)
    parser.add_argument('--content',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--model-dir',type=Path,required=True)
    parser.add_argument('--workers',type=int,choices=(2,4,6,8),default=4)
    parser.add_argument('--baseline-manifest',type=Path,action='append',default=[])
    parser.add_argument('--release-url',required=True)
    args = parser.parse_args()
    if not args.release_url.startswith('https://github.com/wudi000888-svg/nightstudy/releases/download/') or args.release_url.endswith('/'):
        raise ValueError('explicit_release_url_required')
    output = external(args.output, True)
    (output/'progress').mkdir(exist_ok=True)
    module = pipeline_module()
    manifest, rows = collect(args.manifest,args.content)
    baseline_pairs = {}
    for file in args.baseline_manifest:
        built = json.loads(file.read_text())
        version = built['version']
        filename = {'sentence-audio-v1':'sentence-audio.manifest.json','sentence-audio-v2':'sentence-audio-v2.manifest.json'}.get(version)
        if not filename:
            raise ValueError('unknown_audio_baseline')
        pin = json.loads((REPO/'data'/filename).read_text())
        if digest(file) != pin['manifestSha256']:
            raise ValueError('audio_baseline_pin_mismatch')
        for entry in built['entries']:
            if entry['textHash'] != module.text_hash(entry['text']):
                raise ValueError('audio_baseline_text_mismatch')
            baseline_pairs[(entry['textHash'],entry['accent'])] = (entry,file.parent)
    reused = []
    pending = []
    for row in rows:
        if all((row['textHash'],accent) in baseline_pairs for accent in ('US','UK')):
            pairs=[]
            for accent in ('US','UK'):
                entry, directory=baseline_pairs[(row['textHash'],accent)]
                if not module.pack.validate_entry(entry,directory,entry['cacheKey']):
                    raise ValueError('invalid_reused_audio')
                pairs.append({'accent':accent,'fileSha256':entry['fileSha256']})
            reused.append({**row,'pairs':pairs})
        else:
            pending.append(row)
    rows = pending
    if not rows:
        raise ValueError('all_audio_already_present_no_delta_needed')
    sources = {'schemaVersion':2,'version':VERSION,'meaningPackSha256':manifest['sha256'],'meaningPackId':manifest['id'],'normalization':'NFKC; curly quote to ASCII; collapse whitespace; preserve case','engineSource':json.loads(module.pack.DEFAULT_VOICES_MANIFEST.read_text()),'sentences':rows,'reusedSentences':reused,'policy':'Prebuilt offline with cached voices. Not expert-certified pronunciation.'}
    print(json.dumps({'phase':'scope','sentences':len(rows),'clips':len(rows)*2}),flush=True)
    shards = args.workers//2
    with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers,mp_context=multiprocessing.get_context('spawn')) as pool:
        futures = [pool.submit(worker,accent,rows[shard::shards],str(output),str(args.model_dir.resolve()),shard) for accent in ('US','UK') for shard in range(shards)]
        entries = sorted([entry for future in futures for entry in future.result()],key=lambda entry:(entry['textHash'],entry['accent']))
    if {(entry['textHash'],entry['accent']) for entry in entries} != {(row['textHash'],accent) for row in rows for accent in ('US','UK')}:
        raise ValueError('sentence_accent_coverage_mismatch')
    for entry in entries:
        if not module.pack.validate_entry(entry,output,entry['cacheKey']) or entry['textHash'] != module.text_hash(entry['text']):
            raise ValueError('sentence_asset_invalid')
    external(output)
    entries = module.audit_entries(entries,output,args.workers)
    sources.update({'acousticQualityPolicy':module.codec.QUALITY_POLICY,'transcodingTool':module.codec.build_tool_identity()})
    module.pack.atomic_json(output/'sources.manifest.json',sources)
    stats={'lemmaCount':len(rows),'entryCount':len(entries),'recordedCount':0,'synthesizedCount':len(entries),'failedCount':0}
    built={'schemaVersion':2,'version':VERSION,'status':'ready','sourceManifestSha256':digest(output/'sources.manifest.json'),'statistics':stats,'entries':entries}
    module.pack.atomic_json(output/'manifest.json',built)
    licenses=output/'licenses';licenses.mkdir(exist_ok=True)
    license_files = []
    for name in sources['engineSource']['licenseNotices']:
        source_license = Path(name)
        if source_license.is_absolute() or '..' in source_license.parts:
            raise ValueError('invalid_public_license_path')
        destination = licenses/source_license.name
        if destination in license_files:
            raise ValueError('duplicate_public_license_name')
        shutil.copyfile(module.pack.DEFAULT_VOICES_MANIFEST.parent/name,destination)
        license_files.append(destination)
    original_license = licenses/'NIGHTSTUDY-MIT.txt'
    shutil.copyfile(REPO/'LICENSE',original_license)
    license_files.append(original_license)
    for value in (built,sources):
        if any(marker in json.dumps(value,ensure_ascii=False) for marker in ('/Users/','/Volumes/','43.167.217.117')):
            raise ValueError('private_path_in_public_asset')
    for file in license_files:
        if any(marker in file.read_text() for marker in ('/Users/','/Volumes/','43.167.217.117')):
            raise ValueError('private_path_in_public_license')
    files=[output/'manifest.json',output/'sources.manifest.json',*sorted(license_files),*sorted({output/entry['fileKey'] for entry in entries})]
    if any(file.is_symlink() or not file.is_file() or not file.resolve().is_relative_to(output) for file in files):
        raise ValueError('invalid_public_archive_member')
    archive_file=output.parent/('nightstudy-'+VERSION+'.tar.gz')
    external(output)
    with archive_file.open('wb') as target:
        with gzip.GzipFile(filename='',fileobj=target,mode='wb',mtime=0) as compressed:
            with tarfile.open(fileobj=compressed,mode='w|',format=tarfile.USTAR_FORMAT) as archive:
                for file in files:
                    info=archive.gettarinfo(str(file),arcname=file.relative_to(output).as_posix())
                    info.mtime=0;info.uid=info.gid=0;info.uname=info.gname='';info.mode=0o644
                    with file.open('rb') as handle:archive.addfile(info,handle)
    pin={'id':VERSION,'status':'ready','version':VERSION,'source':{'url':args.release_url+'/'+archive_file.name,'sha256':digest(archive_file),'sizeBytes':archive_file.stat().st_size},**stats,'manifestSha256':digest(output/'manifest.json'),'sourceManifestSha256':digest(output/'sources.manifest.json'),'note':'Original meaning-bound bilingual examples, static US/UK sentence audio; no runtime synthesis.'}
    for value in (built,sources,pin):
        if any(marker in json.dumps(value,ensure_ascii=False) for marker in ('/Users/','/Volumes/','43.167.217.117')):
            raise ValueError('private_path_in_public_asset')
    module.pack.atomic_json(output.parent/(VERSION+'.pin.json'),pin)
    print(json.dumps({'phase':'ready',**stats,'archive':str(archive_file)}),flush=True)


if __name__=='__main__':
    main()
