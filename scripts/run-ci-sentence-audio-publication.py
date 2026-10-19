#!/usr/bin/env python3
"""Cloud transport/orchestration only; independent tools make acceptance decisions.

Never imports a speech engine or downloads a model. Candidate WAV archives are
never fetched. Each successful MP3 installer is checked, optionally partitioned
against exact qualified legacy media, checked again, and copied to a draft.
The draft cannot be published by this script.
"""
from pathlib import Path
import argparse
import gzip
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile

REPO = Path(__file__).resolve().parent.parent
REPOSITORY = 'wudi000888-svg/nightstudy'
MEDIA = 'media-sentence-v4-014-20261019'
MEDIA_URL = 'https://github.com/' + REPOSITORY + '/releases/download/' + MEDIA
MAPPER_SHA = '20eef6e6da1837c8e46b6c0954eaa201818b8bfeaf3b1e06db2103dfe8066638'
QUAL_SHA = '7303adb0695c62730e4a8bb31f4ffea91bb81d5ae1e77582f5a023e5048db0ec'
SELECTION_SHA = 'd6e8d0b7a3586ceb82c302019190117cb0d86aa966e37dc57c5d695d7917b350'


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as source:
        while block := source.read(256 * 1024):
            h.update(block)
    return h.hexdigest()


def pin(file):
    file = file.absolute()
    need(file.resolve(strict=True) == file and file.is_file() and file.is_relative_to(REPO), 'explicit_real_repo_file')
    return dict(fileName=file.relative_to(REPO).as_posix(), bytes=file.stat().st_size, sha256=digest(file))


def load(file, cap=16 * 1024 ** 2):
    need(file.is_file() and not file.is_symlink() and 0 < file.stat().st_size <= cap, 'bounded_orchestration_json')
    with file.open('rb') as source:
        return json.load(source)


def save(file, value):
    raw = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()
    need(len(raw) <= 16 * 1024 ** 2, 'bounded_orchestration_output')
    with file.open('xb') as output:
        output.write(raw)


def run(args, output=None, timeout=600):
    # No shell; no token, authentication header or credential value in argv.
    with output.open('xb') if output else open(os.devnull, 'wb') as stream:
        subprocess.run([str(x) for x in args], cwd=REPO, stdout=stream if output else None,
                       check=True, timeout=timeout)


def assets(snapshot, names=None):
    value = load(snapshot, 4 * 1024 ** 2)
    need(isinstance(value, list) and len(value) <= 2000, 'explicit_release_asset_snapshot')
    found = {}
    for asset in value:
        if names is not None and isinstance(asset, dict) and asset.get('name') not in names:
            continue
        need(isinstance(asset, dict) and type(asset.get('id')) is int and asset['id'] > 0 and
             re.fullmatch('[A-Za-z0-9._-]+', asset.get('name', '')) and asset['name'] not in found and
             type(asset.get('size')) is int and 0 < asset['size'] < 2 * 1024 ** 3 and
             re.fullmatch('sha256:[a-f0-9]{64}', asset.get('digest', '')), 'immutable_unique_release_asset')
        found[asset['name']] = asset
    return found


def download(index, name, directory):
    need(name in index, 'required_completed_candidate_asset_missing:' + name)
    asset = index[name]
    target = directory / name
    run(['gh', 'api', 'repos/' + REPOSITORY + '/releases/assets/' + str(asset['id']),
         '-H', 'Accept: application/octet-stream'], output=target)
    need(target.stat().st_size == asset['size'] and digest(target) == asset['digest'][7:], 'downloaded_candidate_pin:' + name)
    return target


def bundle(directory, destination):
    files = sorted(file for file in directory.rglob('*') if file.is_file() and file.suffix != '.mp3' and
                   not file.name.endswith('.tar.gz'))
    need(files and all(not file.is_symlink() for file in files), 'metadata_only_evidence_bundle')
    with destination.open('xb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode='w|', format=tarfile.USTAR_FORMAT) as archive:
                for file in files:
                    info = archive.gettarinfo(str(file), arcname=file.relative_to(REPO).as_posix())
                    info.mtime = 0
                    info.uid = info.gid = 0
                    info.uname = info.gname = ''
                    info.mode = 0o644
                    with file.open('rb') as source:
                        archive.addfile(info, source)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--slice', type=int, required=True)
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--media-assets', type=Path, required=True)
    args = parser.parse_args()
    need(sys.platform.startswith('linux') and os.environ.get('GITHUB_ACTIONS') == 'true' and
         os.environ.get('GITHUB_REPOSITORY') == REPOSITORY and 1 <= args.slice <= 101, 'cloud_repository_scope_only')
    mapper_file = REPO / 'scripts/prepare-ci-sentence-audio-publication.py'
    need(digest(mapper_file) == MAPPER_SHA, 'reviewed_stage_mapper_source')
    spec = importlib.util.spec_from_file_location('stage_mapper', mapper_file)
    mapper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mapper)
    pack = 'sentence-audio-v4-%04d' % (100 + args.slice)
    run_id = '39229287197' if args.slice == 1 else '39235933871'
    stem = 'ci-audio-batch-' + run_id + '-1-' + str(args.slice) + '-verified'
    names = {'nightstudy-' + pack + '.tar.gz', pack + '.manifest.json', pack + '.assembly.json',
             stem + '.check.json', stem + '.build.json'}
    index = assets(args.assets, names)
    published = assets(args.media_assets, {'nightstudy-' + pack + '.tar.gz', 'nightstudy-' + pack + '.evidence.tar.gz'})
    stage = REPO / '.ci-publication' / ('slice-%04d' % args.slice)
    need(not os.path.lexists(stage) and stage.parent.resolve() == stage.parent, 'fresh_publication_slice')
    stage.mkdir(mode=0o700)
    request = REPO / '.ci-audio-plan' / ('request-%04d.json' % args.slice)
    request_pin = pin(request)
    need(load(request)['packId'] == pack, 'actual_restored_request')
    archive = download(index, 'nightstudy-' + pack + '.tar.gz', stage)
    descriptor = download(index, pack + '.manifest.json', stage)
    assembly = download(index, pack + '.assembly.json', stage)
    independent = download(index, stem + '.check.json', stage)
    build = download(index, stem + '.build.json', stage)
    check_pin = pin(independent)
    descriptor_pin = pin(descriptor)
    original = stage / 'candidate-extracted'
    run(['python3', 'scripts/audio-extract.py', '--archive', archive, '--output', original], output=stage / 'candidate-unpack.json')
    fresh = stage / 'fresh-installer-check.json'
    policy = REPO / '.ci-audio-inputs/sentence-audio-holds-v1.manifest.json'
    run(['node', 'scripts/check-ci-sentence-audio-installer.mjs', '--request', request,
         '--request-sha256', request_pin['sha256'], '--check', independent, '--check-sha256', check_pin['sha256'],
         '--descriptor', descriptor, '--descriptor-sha256', descriptor_pin['sha256'], '--archive', archive,
         '--extracted', original, '--policy-manifest', policy, '--receipt', fresh])
    check = load(independent)
    candidate = dict(descriptor=descriptor_pin, archive=pin(archive), manifest=pin(original / 'manifest.json'),
                     sources=pin(original / 'sources.manifest.json'), assembly=pin(assembly), installerCheck=pin(fresh))
    batch = dict(sliceNumber=args.slice, packId=pack, request=request_pin, check=check_pin,
                 generation=dict(build=pin(build), manifest=check['generatedManifest'], sources=check['generatedSources']), candidate=candidate)
    qualification, selection = (REPO / '.ci-audio-inputs' / name for name in ('qualification.json', 'approved-selection.json'))
    need(digest(qualification) == QUAL_SHA and digest(selection) == SELECTION_SHA, 'actual_all32_qualification_selection')
    inputs = stage / 'converter-inputs.json'
    save(inputs, mapper.prepare_converter_inputs(batch, pin(qualification), pin(selection)))
    selected = stage / 'selected'
    run(['python3', 'scripts/select-ci-sentence-audio-publication.py', '--inputs', inputs,
         '--evidence-root', REPO, '--output', selected, '--release-url', MEDIA_URL])
    conversion_file = selected / 'conversion-receipt.json'
    conversion = load(conversion_file)
    outputs = None
    selected_archive = archive
    if conversion['mode'] == 'legacy-reuse-conversion':
        selected_archive = selected / ('nightstudy-' + pack + '.tar.gz')
        selected_descriptor = selected / (pack + '.manifest.json')
        selected_extracted = stage / 'selected-extracted'
        run(['python3', 'scripts/audio-extract.py', '--archive', selected_archive, '--output', selected_extracted],
            output=stage / 'selected-unpack.json')
        choice = selected / 'publication-choice.json'
        selected_check = stage / 'selected-installer-check.json'
        run(['node', 'scripts/check-ci-sentence-audio-selected-installer.mjs', '--evidence-root', REPO,
             '--choice', choice, '--choice-sha256', digest(choice), '--descriptor', selected_descriptor,
             '--descriptor-sha256', digest(selected_descriptor), '--archive', selected_archive,
             '--extracted', selected_extracted, '--policy-manifest', policy, '--receipt', selected_check])
        outputs = dict(descriptor=pin(selected_descriptor), archive=pin(selected_archive),
                       manifest=pin(selected_extracted / 'manifest.json'), sources=pin(selected_extracted / 'sources.manifest.json'),
                       choice=pin(choice), installerCheck=pin(selected_check))
    frame = mapper.global_batch_frame(batch, conversion, pin(conversion_file), outputs)
    save(stage / 'batch-frame.json', frame)
    evidence = stage.parent / ('nightstudy-' + pack + '.evidence.tar.gz')
    bundle(stage, evidence)
    to_upload = []
    for asset_file in (selected_archive, evidence):
        if asset_file.name in published:
            old = published[asset_file.name]
            need(old['size'] == asset_file.stat().st_size and old['digest'] == 'sha256:' + digest(asset_file), 'never_overwrite_existing_media')
        else:
            to_upload.append(asset_file)
    if to_upload:
        run(['gh', 'release', 'upload', MEDIA, '--repo', REPOSITORY, *to_upload])
    # Delete only this fresh staging slice's just-verified media. Small immutable
    # JSON evidence stays for the single global collector; production is absent.
    for directory in (original / 'files', selected / 'pack/files', stage / 'selected-extracted/files'):
        if directory.exists():
            need(directory.resolve().is_relative_to(stage), 'own_slice_media_cleanup_only')
            shutil.rmtree(directory)
    for own_archive in (archive, selected / ('nightstudy-' + pack + '.tar.gz')):
        if own_archive.exists():
            own_archive.unlink()
    print(json.dumps(dict(state='DRAFT_SLICE_ACCEPTED_NOT_PUBLISHED', sliceNumber=args.slice, mode=conversion['mode'],
                          frame=pin(stage / 'batch-frame.json'), selectedArchive=frame['publication']['archive'],
                          evidence=pin(evidence), modelUsed=False, publicationAuthorized=False)))


if __name__ == '__main__':
    main()
