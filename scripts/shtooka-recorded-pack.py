#!/usr/bin/env python3
"""Build an exact-word human recording pack from pinned SWAC archives.

Archive bytes, the original SWAC index and README are retained. SWAC_TEXT is
matched exactly: an article or 'to' is never stripped to force a word match.
US files additionally need their same-name, same-author Commons license because
the historic US README and index have different license declarations.
"""
from __future__ import annotations
import argparse
import configparser
import gzip
import hashlib
import html
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import unicodedata
import urllib.parse

SPEC=importlib.util.spec_from_file_location('recorded',Path(__file__).with_name('recorded-audio-pack.py'))
recorded=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(recorded)

ARCHIVE_SOURCES = {
    'eng-wcp-us': {'sizeBytes': 329292924, 'sha256': 'ded8442282f60855cb0b09a3a5e7693d13c288cbe0b3fe0c950eb9379e5753a1'},
    'eng-balm-judith': {'sizeBytes': 34312928, 'sha256': '645c31fd23e266e6ba18e0b207207dd1d191d3a1c3342df0cd7fd09a293646c1'},
}


def normalize(text):
    return re.sub(r'\s+',' ',unicodedata.normalize('NFKC',text).replace('’',"'").replace('‘',"'")).strip().lower()


def file_sha(filename):
    with filename.open('rb')as handle:return hashlib.file_digest(handle,'sha256').hexdigest()


def validate_archive(filename, pack_id):
    expected = ARCHIVE_SOURCES.get(pack_id)
    if not expected or filename.stat().st_size != expected['sizeBytes'] or file_sha(filename) != expected['sha256']:
        raise ValueError('pinned_swac_archive_checksum_mismatch')


def archive_entries(filename,pack_id,accent,targets,output,commons):
    archive_sha=file_sha(filename)
    archive_url=f'https://fsi-languages.yojik.eu/audiocollections/archives/{pack_id}_flac.tar.xz'
    with tarfile.open(filename,'r:xz')as archive:
        members=archive.getmembers()
        if len(members)>10000 or sum(m.size for m in members)>1024**3:raise ValueError('swac_archive_limit')
        index=next(m for m in members if m.name=='flac/index.tags.txt')
        readme=next(m for m in members if m.name=='flac/readme.txt')
        if index.size>2*1024**2 or readme.size>1024**2:raise ValueError('swac_metadata_limit')
        index_raw=archive.extractfile(index).read();readme_raw=archive.extractfile(readme).read()
        parser=configparser.ConfigParser(interpolation=None,strict=True);parser.optionxform=str
        parser.read_string(index_raw.decode('utf-8-sig').split('\n',1)[1])
        info=dict(parser['GLOBAL'])
        if info.get('SWAC_LANG')!='eng' or info.get('SWAC_SPEAK_LANG_COUNTRY')!=accent:raise ValueError('swac_accent_binding_mismatch')
        if accent=='UK' and info.get('SWAC_SPEAK_LANG_REGION')!='London':raise ValueError('swac_british_region_unconfirmed')
        archive_source={'id':pack_id,'url':archive_url,'sizeBytes':filename.stat().st_size,'sha256':archive_sha,'indexSha256':hashlib.sha256(index_raw).hexdigest(),'readmeSha256':hashlib.sha256(readme_raw).hexdigest(),'global':info,'note':'US archive README and index license conflict; selected US files use the separately checked same-name Commons file license. FLAC mirror is not byte-identical to Commons OGG.'}
        (output/'licenses'/f'{pack_id}-README.txt').write_bytes(readme_raw)
        (output/'licenses'/f'{pack_id}-GLOBAL.json').write_text(json.dumps(archive_source,ensure_ascii=False))
        selected={};rejected={}
        for member in members:
            name=PurePosixPath(member.name)
            if not member.isfile() or name.parent.as_posix()!='flac' or name.suffix!='.flac':continue
            if member.issym() or member.islnk() or member.size>2*1024**2:raise ValueError('swac_audio_member_invalid')
            if name.name not in parser:continue
            row=dict(parser[name.name]);lemma=normalize(row.get('SWAC_TEXT',''))
            if lemma not in targets:continue
            evidence=f"{info.get('SWAC_SPEAK_NAME')}; SWAC_SPEAK_LANG_COUNTRY={accent}; SWAC_SPEAK_LANG_REGION={info.get('SWAC_SPEAK_LANG_REGION')}; SWAC_TEXT={row.get('SWAC_TEXT')}"
            reference=None
            if accent=='US':
                title='File:'+name.stem+'.ogg'
                page=commons.get(title)
                reference=recorded.entry_from_page(page,'US') if page else None
                if not reference or reference['lemma']!=lemma or 'dvortygirl' not in reference['sourceName'].lower():
                    rejected['missing_matching_commons_license']=rejected.get('missing_matching_commons_license',0)+1;continue
                license_name=reference['license'];source_url=reference['sourceUrl'];attribution=reference['attribution'].replace('original unmodified recording.','original human recording redistributed as the SWAC FLAC mirror.')
            else:
                license_name='CC BY 3.0 US';source_url=f'https://fsi-languages.yojik.eu/audiocollections/detailled/{pack_id}/flac/'+urllib.parse.quote(name.name)
                attribution='Association Shtooka, Judith Franck; '+source_url+'; https://creativecommons.org/licenses/by/3.0/us/; original archived human recording.'
            raw=archive.extractfile(member).read()
            if len(raw)!=member.size or raw[:4]!=b'fLaC':raise ValueError('swac_flac_invalid')
            sha=hashlib.sha256(raw).hexdigest();key=f'files/{sha}.flac';(output/key).write_bytes(raw)
            entry={'lemma':lemma,'accent':accent,'kind':'recorded','sourceName':'SWAC / '+info.get('SWAC_COLL_AUTHORS',''),'sourceUrl':source_url,'license':license_name,'attribution':attribution,'fileKey':key,'fileSha256':sha,'mimeType':'audio/flac','sizeBytes':len(raw),'sourceSizeBytes':len(raw),'sourceSha1':hashlib.sha1(raw).hexdigest(),'sourceArchiveUrl':archive_url,'sourceArchiveSha256':archive_sha,'sourceArchiveMember':member.name,'sourceRepresentation':'SWAC FLAC mirror; no speech synthesis','accentEvidence':evidence,'canonicalWordEvidence':row}
            if reference:entry.update({'commonsReferenceSha1':reference['sourceSha1'],'commonsReferenceUrl':reference['downloadUrl'],'commonsAccentEvidence':reference['accentEvidence']})
            selected[(lemma,accent)]=entry
    return list(selected.values()),archive_source,rejected


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lemmas-file',type=Path,required=True)
    parser.add_argument('--archive-dir',type=Path,required=True)
    parser.add_argument('--commons-cache',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();output=args.output.resolve()
    for folder in [output,output/'files',output/'licenses']:folder.mkdir(parents=True,exist_ok=True)
    targets=set(json.loads(args.lemmas_file.read_text()));commons={}
    for filename in (args.commons_cache/'research').glob('metadata-*.json'):
        for page in json.loads(filename.read_text()).get('query',{}).get('pages',{}).values():commons[page['title']]=page
    selected={}
    for marker in (args.commons_cache/'downloads').glob('*.json'):
        entry=json.loads(marker.read_text());source=args.commons_cache/entry['fileKey']
        if entry['lemma']not in targets or not source.is_file()or file_sha(source)!=entry['fileSha256']:continue
        if hashlib.sha1(source.read_bytes()).hexdigest()!=entry['sourceSha1']:raise ValueError('commons_original_sha1_mismatch')
        target=output/entry['fileKey']
        if not target.exists():shutil.copyfile(source,target)
        selected[(entry['lemma'],entry['accent'])]=entry
    sources=[];rejected={}
    for pack_id,accent in [('eng-balm-judith','UK'),('eng-wcp-us','US')]:
        filename=args.archive_dir/(pack_id+'_flac.tar.xz')
        validate_archive(filename, pack_id)
        entries,source,rejects=archive_entries(filename,pack_id,accent,targets,output,commons)
        sources.append(source);rejected[pack_id]=rejects
        for entry in entries:
            # The direct, checked Commons original takes precedence over a mirror.
            selected.setdefault((entry['lemma'],entry['accent']),entry)
        print(json.dumps({'phase':'swac-import','pack':pack_id,'matched':len(entries),'totalReady':len(selected),'rejected':rejects}),flush=True)
    entries=sorted(selected.values(),key=lambda entry:(entry['lemma'],entry['accent']))
    source={'schemaVersion':2,'version':'recorded-audio-v2','policy':'Human recordings only; SWAC_TEXT exact binding, declared native US/California and UK/London speaker evidence. Direct Commons files verified against official SHA1; FLAC mirror verified against pinned archive SHA256 with a separate representation mapping.','archives':sources,'rejections':rejected,'entries':entries}
    source_sha=recorded.atomic_json(output/'sources.manifest.json',source)
    stats={'lemmaCount':len({e['lemma']for e in entries}),'entryCount':len(entries),'recordedCount':len(entries),'synthesizedCount':0,'failedCount':0,'usCount':sum(e['accent']=='US'for e in entries),'ukCount':sum(e['accent']=='UK'for e in entries)}
    manifest={'schemaVersion':2,'version':'recorded-audio-v2','status':'ready','sourceManifestSha256':recorded.digest(source_sha),'statistics':stats,'entries':entries}
    raw=recorded.atomic_json(output/'manifest.json',manifest)
    repo=Path(__file__).resolve().parent.parent
    for notice in (repo/'data/audio-licenses').glob('COMMONS-*.txt'):shutil.copyfile(notice,output/'licenses'/notice.name)
    (output/'licenses/NOTICE.txt').write_text('Original human recordings and archived FLAC representations. Per-entry author, license, exact spoken text, native region and source archive hashes in sources.manifest.json. FLAC is preserved for verification; the H5 word pack separately transcodes recordings to MP3. No synthesized files included.\n')
    archive_path=output.parent/'nightstudy-recorded-audio-v2.tar.gz'
    with archive_path.open('wb')as destination:
        with gzip.GzipFile(filename='',fileobj=destination,mode='wb',mtime=0)as compressed:
            with tarfile.open(fileobj=compressed,mode='w|',format=tarfile.USTAR_FORMAT)as archive:
                files=[output/'manifest.json',output/'sources.manifest.json',*sorted((output/'licenses').glob('*')),*sorted({output/e['fileKey']for e in entries})]
                for filename in files:
                    info=archive.gettarinfo(str(filename),arcname=filename.relative_to(output).as_posix());info.mtime=0;info.uid=info.gid=0;info.uname=info.gname='';info.mode=0o644
                    with filename.open('rb')as handle:archive.addfile(info,handle)
    pin={'id':'recorded-audio-v2','status':'ready','version':'recorded-audio-v2','source':{'url':'https://github.com/wudi000888-svg/nightstudy/releases/download/v0.9.0-alpha.1/'+archive_path.name,'sizeBytes':archive_path.stat().st_size,'sha256':file_sha(archive_path)},**stats,'manifestSha256':recorded.digest(raw),'sourceManifestSha256':recorded.digest(source_sha),'note':'Independently verifiable native human recordings. Direct Commons original OGG and pinned SWAC FLAC mirror; original representations preserved. Default H5 word pack converts them to MP3 with source mapping.'}
    recorded.atomic_json(output.parent/'recorded-audio-v2.pin.json',pin)
    print(json.dumps({'phase':'ready',**pin}),flush=True)


if __name__=='__main__':main()
