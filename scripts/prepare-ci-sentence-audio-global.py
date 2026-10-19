#!/usr/bin/env python3
"""Map 101 explicit completed staging frames to a global inventory, without approval.

This entry hashes existing JSON metadata only. It does not open archives or
media, fetch, invoke a decoder/model/database, or perform global acceptance.
The separate finalizer independently validates every assembled evidence chain.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import stat
import sys

REPO = Path(__file__).resolve().parent.parent
MIB = 1048576
MEDIA_URL = 'https://github.com/wudi000888-svg/nightstudy/releases/download/media-sentence-v4-014-20261019'
PIN_FIELDS = {'fileName', 'bytes', 'sha256'}
BATCH_FIELDS = {'sliceNumber', 'packId', 'request', 'check', 'generation', 'publication'}
PUBLICATION_FIELDS = {'mode', 'selectionProof', 'descriptor', 'archive', 'manifest', 'sources', 'assembly', 'installerCheck'}
CANDIDATE_FIELDS = {'descriptor', 'archive', 'manifest', 'sources', 'assembly', 'installerCheck'}


def need(ok, code):
    if not ok:
        raise ValueError(code)


def signature(value):
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def relative(root, name):
    need(isinstance(name, str) and len(name) <= 240 and re.fullmatch('[A-Za-z0-9._/-]+', name) and
         not name.startswith('/') and all(part not in ('', '.', '..') for part in name.split('/')), 'global_map_relative_path')
    result = root / name
    need(result.resolve() == result and result.is_relative_to(root), 'global_map_no_symlinks')
    return result


def pin(value):
    need(isinstance(value, dict) and set(value) == PIN_FIELDS and type(value['bytes']) is int and
         0 < value['bytes'] < 2 * 1024 ** 3 and isinstance(value['sha256'], str) and
         re.fullmatch('[a-f0-9]{64}', value['sha256']), 'global_map_exact_pin')
    # Generation metadata is a C-declared basename, not an entity to reopen.
    relative(REPO, value['fileName'])
    return value


def decode(raw):
    def unique(pairs):
        out = {}
        for key, value in pairs:
            need(key not in out, 'global_map_duplicate_json_key')
            out[key] = value
        return out
    def reject(value):
        raise ValueError('global_map_non_json_constant:' + value)
    return json.loads(raw, object_pairs_hook=unique, parse_constant=reject)


class Reader:
    def __init__(self, root):
        self.root = root
        self.identities = {}
        self.total = 0

    def take(self, name, cap, capture=False, expected=None):
        file = relative(self.root, name)
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            before = os.fstat(fd)
            need(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= cap, 'global_map_metadata_bounds')
            self.total += before.st_size
            need(self.total <= 128 * MIB, 'global_map_total_metadata_bounds')
            digest, parts, remaining = hashlib.sha256(), [], before.st_size
            while remaining:
                block = os.read(fd, min(remaining, 65536))
                need(block, 'global_map_input_truncated')
                digest.update(block)
                if capture:
                    parts.append(block)
                remaining -= len(block)
            need(not os.read(fd, 1) and signature(before) == signature(os.fstat(fd)) == signature(os.lstat(file)),
                 'global_map_input_identity_changed')
            actual = dict(fileName=name, bytes=before.st_size, sha256=digest.hexdigest())
            if expected is not None:
                need(pin(expected) == actual, 'global_map_existing_pinned_metadata_mismatch')
            previous = self.identities.get(file)
            need(previous is None or previous == signature(before), 'global_map_late_input_replacement')
            self.identities[file] = signature(before)
            return actual, decode(b''.join(parts)) if capture else None
        finally:
            os.close(fd)

    def unchanged(self):
        for file, before in self.identities.items():
            need(signature(os.lstat(file)) == before and file.resolve() == file, 'global_map_final_input_identity_changed')


def checked_frame(value, number):
    need(isinstance(value, dict) and set(value) == BATCH_FIELDS and type(value['sliceNumber']) is int and
         value['sliceNumber'] == number and value['packId'] == 'sentence-audio-v4-%04d' % (100 + number),
         'global_map_all101_explicit_frames_in_order')
    pin(value['request']); pin(value['check'])
    need(set(value['generation']) == {'build', 'manifest', 'sources'}, 'global_map_generation_declarations')
    for item in value['generation'].values():
        pin(item)
    frame = value['publication']
    need(isinstance(frame, dict) and frame.get('mode') in ('original-generation', 'legacy-reuse-conversion'),
         'global_map_explicit_publication_mode')
    converted = frame['mode'] == 'legacy-reuse-conversion'
    need(set(frame) == PUBLICATION_FIELDS | ({'candidate'} if converted else set()), 'global_map_exact_publication_frame')
    for name in CANDIDATE_FIELDS:
        pin(frame[name])
    if converted:
        pin(frame['selectionProof'])
        need(set(frame['candidate']) == CANDIDATE_FIELDS, 'global_map_original_candidate_retained')
        for item in frame['candidate'].values():
            pin(item)
    else:
        need(frame['selectionProof'] is None, 'global_map_no_implicit_choice')
    return value


def assemble(reader):
    plan_pin, plan = reader.take('data/ci-audio-batch-plan.manifest.json', MIB, True)
    need(plan['kind'] == 'nightstudy-ci-audio-prepared-plan-pin-v1', 'global_map_committed_plan_kind')
    for name in ('jobs', 'selection'):
        expected = pin(plan[name])
        reader.take(expected['fileName'], MIB, expected=expected)
    public_pin, _ = reader.take('data/learning-senses-collection-v2.manifest.json', MIB)
    _, configuration = reader.take('data/ci-audio-batch-inputs.manifest.json', 65536, True)
    base = pin(configuration['portableControls'])
    supplement_pin = pin(configuration['supplementalControls'])
    reader.take(base['fileName'], 16 * MIB, expected=base)
    _, supplement = reader.take(supplement_pin['fileName'], 2 * MIB, True, supplement_pin)
    observation_pin = pin(supplement['observation'])
    reader.take(observation_pin['fileName'], MIB, expected=observation_pin)
    hold_manifest, _ = reader.take('.ci-audio-inputs/sentence-audio-holds-v1.manifest.json', MIB)
    hold_payload, _ = reader.take('.ci-audio-inputs/sentence-audio-holds-v1.json', 4 * MIB)
    report, _ = reader.take('.ci-audio-inputs/legacy-overlap-audit.json', 8 * MIB)
    qualification, _ = reader.take('.ci-audio-inputs/qualification.json', 8 * MIB)
    selection, _ = reader.take('.ci-audio-inputs/approved-selection.json', 8 * MIB)
    legacy = []
    for number in range(1, 4):
        pack = 'sentence-audio-v%d' % number
        name = 'sentence-audio.manifest.json' if number == 1 else pack + '.manifest.json'
        descriptor, _ = reader.take('data/' + name, MIB)
        manifest, _ = reader.take('.cloud-legacy/' + pack + '.manifest.json', 64 * MIB)
        sources, _ = reader.take('.cloud-legacy/' + pack + '.sources.manifest.json', 32 * MIB)
        legacy.append(dict(packId=pack, descriptor=descriptor, manifest=manifest, sources=sources))
    frames = []
    for number in range(1, 102):
        _, frame = reader.take('.ci-publication/slice-%04d/batch-frame.json' % number, 128 * 1024, True)
        frames.append(checked_frame(frame, number))
    reader.unchanged()
    return dict(kind='nightstudy-ci-audio-global-publication-inventory-v1', mediaReleaseUrl=MEDIA_URL,
        planManifest=plan_pin, publicRoot=public_pin, controls=dict(base=base, supplement=supplement_pin, observation=observation_pin),
        globalHolds=dict(manifest=hold_manifest, payload=hold_payload), legacyOverlap=report,
        legacyQualification=dict(receipt=qualification, selection=selection), legacyManifests=legacy, batches=frames)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    need(sys.platform.startswith('linux') and os.environ.get('GITHUB_ACTIONS') == 'true', 'global_map_cloud_only')
    sys.dont_write_bytecode = True
    def guard(event, values):
        if event.startswith(('socket.', 'subprocess.', 'os.exec', 'os.spawn')) or event in ('os.system', 'os.fork', 'os.posix_spawn', 'sqlite3.connect'):
            raise PermissionError('global_map_no_network_children_or_database')
        if event == 'open' and values and isinstance(values[0], (str, bytes, os.PathLike)) and os.fsdecode(values[0]).lower().endswith(
                ('.mp3', '.wav', '.tar', '.tar.gz', '.onnx', '.onnx.json', '.gguf', '.pt', '.pth', '.safetensors')):
            raise PermissionError('global_map_metadata_only')
    sys.addaudithook(guard)
    reader = Reader(REPO)
    value = assemble(reader)
    raw = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')
    need(len(raw) <= 2 * MIB, 'global_map_small_output')
    output = args.output.absolute()
    need(not os.path.lexists(output) and output.parent.resolve(strict=True) == output.parent and
         not output.is_relative_to(REPO / 'data'), 'global_map_fresh_output_outside_data')
    reader.unchanged()
    with output.open('xb') as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    print('Explicit 101-frame inventory mapped; global verification and publication remain unapproved.')


if __name__ == '__main__':
    main()
