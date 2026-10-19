#!/usr/bin/env python3
"""Verify the immutable prepared archive and expose only its first cloud job.

No download, model, frontend, media child or worker import. This is scheduling
input validation, never audio acceptance or permission to publish.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile

REPO = Path(__file__).resolve().parent.parent
ROOT_NAME = '.ci-audio-plan'
MIB = 1048576
MAX_FILE = 8 * MIB
MAX_TOTAL = 512 * MIB
MAX_MEMBERS = 250
PIN_FIELDS = {'fileName', 'bytes', 'sha256'}
PUBLIC_SHA = '0ae4679da6df6459cb2cfe21867942bb8eaa4ae9828def149f08816c42f4ef1b'
FINAL_SHA = 'eaaf987f693cfad6a6a3cb5768b8ef855a1f0300d4c06257bf8683ecf86f69dd'
WORKER_SHA = '4be14408ff260feb89e5e58e7740b4b522b9a7f05d22d2b1d8009669610a252a'
PLANNER_SHA = 'f7d7dc1da1e33a8f99292eacc3abd7f5817aaffde852b59fd614f7f8c69e2ad4'


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha(raw):
    return hashlib.sha256(raw.encode('utf-8') if isinstance(raw, str) else raw).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False)


def decode(raw):
    def unique(pairs):
        out = {}
        for key, value in pairs:
            need(key not in out, 'duplicate_json_key')
            out[key] = value
        return out
    def reject(value):
        raise ValueError('non_json_constant:' + value)
    return json.loads(raw, object_pairs_hook=unique, parse_constant=reject)


def signature(value):
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def safe_name(name):
    need(isinstance(name, str) and 0 < len(name) <= 240 and re.fullmatch('[A-Za-z0-9._/-]+', name)
         and not name.startswith('/') and all(p not in ('', '.', '..') for p in name.split('/')), 'safe_relative_name')
    return name


def valid_pin(pin, cap=MAX_FILE):
    need(isinstance(pin, dict) and set(pin) == PIN_FIELDS and type(pin['bytes']) is int
         and 0 < pin['bytes'] <= cap and isinstance(pin['sha256'], str)
         and re.fullmatch('[a-f0-9]{64}', pin['sha256']), 'exact_bounded_pin')
    safe_name(pin['fileName'])
    return pin


class Inputs:
    def __init__(self, root):
        self.root = root
        self.seen = {}

    def open(self, path, cap, pin=None):
        need(path.resolve() == path, 'no_symlink_input')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            before = os.fstat(fd)
            need(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= cap and
                 (pin is None or before.st_size == pin['bytes']), 'bounded_regular_input')
            total, digest = 0, hashlib.sha256()
            while block := os.read(fd, 256 * 1024):
                total += len(block)
                need(total <= before.st_size, 'input_grew')
                digest.update(block)
            need(total == before.st_size and (pin is None or digest.hexdigest() == pin['sha256']) and
                 signature(before) == signature(os.fstat(fd)) == signature(os.lstat(path)), 'input_hash_identity')
            self.seen[path] = signature(before)
            os.lseek(fd, 0, os.SEEK_SET)
            return fd
        except BaseException:
            os.close(fd)
            raise

    def read(self, path, cap=MAX_FILE, pin=None):
        fd = self.open(path, cap, pin)
        try:
            with os.fdopen(fd, 'rb', closefd=False) as handle:
                raw = handle.read(cap + 1)
            need(len(raw) <= cap and signature(os.fstat(fd)) == self.seen[path], 'read_fd_unchanged')
            return raw
        finally:
            os.close(fd)

    def pin(self, pin, cap=MAX_FILE):
        valid_pin(pin, cap)
        return decode(self.read(self.root / pin['fileName'], cap, pin))

    def unchanged(self):
        for path, before in self.seen.items():
            need(signature(os.lstat(path)) == before, 'late_input_change:' + path.name)


def member_name(member):
    name = member.name
    need(isinstance(name, str) and len(name) <= 240 and not member.linkname and not member.pax_headers,
         'archive_header_metadata')
    if member.isdir():
        need(name.rstrip('/') == ROOT_NAME and member.size == 0, 'archive_only_root_directory')
        return ROOT_NAME
    need(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE) and not member.issparse(), 'archive_regular_only')
    safe_name(name)
    need(name.startswith(ROOT_NAME + '/') and len(Path(name).parts) == 2 and
         re.fullmatch(r'(?:job-manifest|selection\.manifest)\.json|exclusions\.jsonl|(?:request|targets)-[0-9]{4}\.json',
                      Path(name).name) and 0 < member.size <= MAX_FILE, 'archive_allowed_plan_member')
    return name


def unpack_plan(inputs, archive, pin):
    """Preflight all headers before creating the fixed fresh extraction root."""
    valid_pin(pin, 128 * MIB)
    need(archive.name == pin['fileName'] and Path(pin['fileName']).name == pin['fileName'], 'actual_archive_basename')
    destination = inputs.root / ROOT_NAME
    need(inputs.root.resolve() == inputs.root and not os.path.lexists(destination), 'fresh_fixed_plan_root')
    fd = inputs.open(archive, 128 * MIB, pin)
    try:
        seen, sizes, total = set(), {}, 0
        with os.fdopen(fd, 'rb', closefd=False) as handle:
            with tarfile.open(fileobj=handle, mode='r|gz') as source:
                for member in source:
                    name = member_name(member)
                    need(name not in seen and len(seen) < MAX_MEMBERS, 'archive_duplicate_or_member_limit')
                    seen.add(name)
                    if member.isfile():
                        total += member.size
                        need(total <= MAX_TOTAL, 'archive_total_limit')
                        sizes[name] = member.size
        need(ROOT_NAME in seen and sizes, 'archive_root_and_regular_contents')
        need(signature(os.fstat(fd)) == inputs.seen[archive], 'preflight_archive_fd_unchanged')
        destination.mkdir(mode=0o700)
        os.lseek(fd, 0, os.SEEK_SET)
        written = set()
        with os.fdopen(fd, 'rb', closefd=False) as handle:
            with tarfile.open(fileobj=handle, mode='r|gz') as source:
                for member in source:
                    name = member_name(member)
                    if member.isdir():
                        continue
                    need(name in sizes and name not in written and member.size == sizes[name], 'same_preflight_archive_members')
                    stream = source.extractfile(member)
                    need(stream is not None, 'regular_member_stream')
                    output = inputs.root / name
                    target = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(target, 'wb') as handle_out:
                        left = member.size
                        while left:
                            raw = stream.read(min(left, 256 * 1024))
                            need(raw and len(raw) <= left, 'complete_archive_member')
                            handle_out.write(raw)
                            left -= len(raw)
                        need(not stream.read(1), 'exact_archive_member_eof')
                        handle_out.flush()
                        os.fsync(handle_out.fileno())
                    stream.close()
                    written.add(name)
        need(written == set(sizes) and signature(os.fstat(fd)) == inputs.seen[archive], 'whole_archive_extraction_identity')
        inputs.unchanged()
        return written
    finally:
        os.close(fd)


def plan_manifest(value):
    need(isinstance(value, dict) and set(value) == {'kind', 'release', 'archive', 'jobs', 'selection', 'preparedBy'}
         and value['kind'] == 'nightstudy-ci-audio-prepared-plan-pin-v1' and
         re.fullmatch('[A-Za-z0-9._-]{1,100}', value['release']) and set(value['preparedBy']) == {'runId', 'commit'}
         and type(value['preparedBy']['runId']) is int and value['preparedBy']['runId'] > 0 and
         re.fullmatch('[a-f0-9]{40}', value['preparedBy']['commit']), 'committed_actual_plan_manifest')
    valid_pin(value['archive'], 128 * MIB)
    valid_pin(value['jobs'])
    valid_pin(value['selection'])
    need(value['jobs']['fileName'] == ROOT_NAME + '/job-manifest.json' and
         value['selection']['fileName'] == ROOT_NAME + '/selection.manifest.json' and
         value['archive']['fileName'] == 'ci-audio-plan-%d-1.tar.gz' % value['preparedBy']['runId'], 'fixed_plan_manifest_paths')
    return value


def validate_closure(inputs, manifest, extracted):
    jobs = inputs.pin(manifest['jobs'])
    selection = inputs.pin(manifest['selection'])
    count_fields = {'generatedGroups', 'generatedPairs', 'heldExcludedPairs', 'supplementalHeldExcludedPairs',
                    'baselineExcludedPairs', 'blockedExcludedPairs'}
    need(set(jobs) == {'kind', 'state', 'selectionManifest', 'inputs', 'requests', 'modelImported', 'mediaGenerated',
                      'publicationAuthorized'} | count_fields and jobs['kind'] == 'nightstudy-ci-audio-bounded-jobs-v1'
         and jobs['state'] == 'PREPARED_REQUIRES_CLOUD_GENERATION_AND_INDEPENDENT_CHECK' and
         jobs['selectionManifest'] == manifest['selection'] and all(jobs[k] is False for k in
             ('modelImported', 'mediaGenerated', 'publicationAuthorized')), 'actual_unapproved_job_manifest')
    actual_inputs = inputs.pin(jobs['inputs'])
    need(jobs['inputs']['fileName'] == 'data/ci-audio-batch-inputs.manifest.json' and
         actual_inputs['kind'] == 'nightstudy-ci-audio-build-inputs-v1' and actual_inputs['mode'] == 'batch',
         'committed_preparation_inputs')
    selection_fields = {'kind', 'state', 'publicRootSha256', 'finalPolicySha256', 'portableControls', 'supplementalControls',
                        'approvedPilot', 'baseline', 'oldUnapprovedCandidateSelection', 'oldUnapprovedCandidates', 'currentCounts',
                        'firstJobGroups', 'groupsPerJob', 'taskSentenceCap', 'maxWorkers', 'blockedKeys', 'exclusionLedger',
                        'batchWorkerSha256', 'plannerSha256', 'leaves'} | count_fields
    need(set(selection) == selection_fields and selection['kind'] == 'nightstudy-ci-audio-fresh-selection-v1' and
         selection['state'] == 'COMPLETE_EXPLICIT_FRESH_SELECTION' and selection['publicRootSha256'] == PUBLIC_SHA and
         selection['finalPolicySha256'] == FINAL_SHA and selection['batchWorkerSha256'] == WORKER_SHA and
         selection['plannerSha256'] == PLANNER_SHA and selection['currentCounts'] == dict(groups=99940, references=99984, pairs=199880)
         and selection['oldUnapprovedCandidateSelection'] == 'NOT_SELECTED' and selection['oldUnapprovedCandidates'] == 89880
         and selection['firstJobGroups'] == actual_inputs['firstJobGroups'] == 256 and
         selection['groupsPerJob'] == actual_inputs['groupsPerJob'] == 1000 and selection['taskSentenceCap'] == 128 and
         selection['maxWorkers'] == actual_inputs['workers'] == 4 and
         all(selection[k] == actual_inputs[k] for k in ('portableControls', 'supplementalControls', 'approvedPilot', 'baseline', 'blockedKeys')),
         'whole_actual_selection_and_preparation_scope')
    need(all(type(jobs[k]) is int and jobs[k] >= 0 and jobs[k] == selection[k] for k in count_fields)
         and jobs['heldExcludedPairs'] == 79 and jobs['baselineExcludedPairs'] == 392 and
         jobs['generatedPairs'] + sum(jobs[k] for k in count_fields - {'generatedGroups', 'generatedPairs'}) == 199880,
         'complete_current_union_counts')
    need(isinstance(jobs['requests'], list) and isinstance(selection['leaves'], list) and
         1 <= len(jobs['requests']) == len(selection['leaves']) <= 123, 'bounded_complete_requests_and_leaves')
    closure = {manifest['jobs']['fileName'], manifest['selection']['fileName'], selection['exclusionLedger']['fileName']}
    valid_pin(selection['exclusionLedger'])
    exclusions_raw = inputs.read(inputs.root / selection['exclusionLedger']['fileName'], MAX_FILE, selection['exclusionLedger'])
    need(selection['exclusionLedger']['fileName'] == ROOT_NAME + '/exclusions.jsonl' and exclusions_raw.endswith(b'\n'),
         'complete_exclusion_ledger')
    exclusions = {}
    for raw in exclusions_raw.splitlines():
        need(0 < len(raw) <= 16384, 'bounded_exclusion_row')
        row = decode(raw)
        need(set(row) == {'textHash', 'accent', 'decision'} and re.fullmatch('[a-f0-9]{64}', row['textHash']) and
             row['accent'] in ('US', 'UK') and row['decision'] in
             ('hold', 'supplemental-hold', 'pending-explicit', 'published-baseline-exact-current-refs'), 'explicit_exclusion_identity')
        key = row['textHash'], row['accent']
        need(key not in exclusions, 'duplicate_exclusion_key')
        exclusions[key] = row['decision']
    for decision, field in (('hold', 'heldExcludedPairs'), ('supplemental-hold', 'supplementalHeldExcludedPairs'),
                            ('pending-explicit', 'blockedExcludedPairs'), ('published-baseline-exact-current-refs', 'baselineExcludedPairs')):
        need(sum(v == decision for v in exclusions.values()) == jobs[field], 'actual_exclusion_count')
    previous, groups, pairs, matrix, pack_ids = '', 0, 0, [], set()
    for number, (job, leaf) in enumerate(zip(jobs['requests'], selection['leaves']), 1):
        need(set(job) == PIN_FIELDS | {'sliceNumber', 'packId', 'groups', 'pairs'} and
             set(leaf) == PIN_FIELDS | {'sliceNumber', 'groups', 'pairs', 'firstTextHash', 'lastTextHash'} and
             job['sliceNumber'] == leaf['sliceNumber'] == number and
             job['fileName'] == ROOT_NAME + '/request-%04d.json' % number and
             leaf['fileName'] == ROOT_NAME + '/targets-%04d.json' % number and
             re.fullmatch('sentence-audio-v4-[0-9]{4}', job['packId']) and job['packId'] not in pack_ids and
             job['packId'] == 'sentence-audio-v4-%04d' % (actual_inputs['firstPackOrdinal'] + number - 1),
             'ordered_unique_job_leaf_identity')
        job_pin, leaf_pin = ({k: item[k] for k in PIN_FIELDS} for item in (job, leaf))
        request, targets = inputs.pin(job_pin), inputs.pin(leaf_pin)
        cap = 256 if number == 1 else 1000
        need(isinstance(targets, list) and len(targets) == leaf['groups'] == job['groups'] and 1 <= len(targets) <= cap and
             (number == len(jobs['requests']) or len(targets) == cap) and
             leaf['firstTextHash'] == targets[0]['textHash'] and leaf['lastTextHash'] == targets[-1]['textHash'], 'whole_fixed_leaf')
        local_pairs = 0
        for target in targets:
            need(set(target) == {'textHash', 'text', 'references', 'accents'} and
                 isinstance(target['textHash'], str) and re.fullmatch('[a-f0-9]{64}', target['textHash']) and
                 previous < target['textHash'] and isinstance(target['text'], str) and sha(target['text']) == target['textHash'] and
                 target['accents'] in (['US'], ['UK'], ['US', 'UK']) and isinstance(target['references'], list) and
                 1 <= len(target['references']) <= 3, 'complete_disjoint_leaf_targets')
            need(all((target['textHash'], a) not in exclusions for a in target['accents']), 'excluded_pair_not_scheduled')
            previous = target['textHash']
            local_pairs += len(target['accents'])
        need(local_pairs == leaf['pairs'] == job['pairs'], 'actual_leaf_pair_count')
        need(set(request) == {'kind', 'mode', 'packId', 'portableControls', 'voicesManifest', 'publicRootSha256',
                             'finalPolicySha256', 'targets', 'holdChecks', 'batchApproval'} and
             request['kind'] == 'nightstudy-ci-sentence-audio-request-v1' and request['mode'] == 'batch' and
             request['packId'] == job['packId'] and request['targets'] == targets and
             request['publicRootSha256'] == PUBLIC_SHA and request['finalPolicySha256'] == FINAL_SHA and
             request['portableControls'] == selection['portableControls'], 'whole_pinned_request_matches_targets')
        need(request['batchApproval'] == dict(approvedPilot=selection['approvedPilot'], selectionManifest=manifest['selection'],
             selectionLeaf=leaf_pin, sliceNumber=number, workers=selection['maxWorkers'], supplementalControls=selection['supplementalControls']),
             'exact_per_request_approval')
        valid_pin(request['voicesManifest'])
        need(request['voicesManifest']['fileName'] == 'data/audio-voices.manifest.json', 'fixed_request_voice_manifest')
        inputs.pin(request['voicesManifest'])
        need(isinstance(request['holdChecks'], list) and 1 <= len(request['holdChecks']) <= 79, 'explicit_hold_denials')
        holds = set()
        for row in request['holdChecks']:
            need(set(row) == {'textHash', 'accent'} and (row['textHash'], row['accent']) not in holds and
                 exclusions.get((row['textHash'], row['accent'])) == 'hold', 'actual_known_hold_denial')
            holds.add((row['textHash'], row['accent']))
        groups += len(targets)
        pairs += local_pairs
        pack_ids.add(job['packId'])
        closure.update((job['fileName'], leaf['fileName']))
        if number == 1:
            matrix.append(dict(sliceNumber=number, packId=job['packId'], requestFile=job['fileName'],
                               requestSha256=job['sha256'], groups=len(targets), pairs=local_pairs))
    need(groups == jobs['generatedGroups'] and pairs == jobs['generatedPairs'] and closure == extracted and
         {ROOT_NAME + '/' + p.name for p in (inputs.root / ROOT_NAME).iterdir()} == closure, 'no_extra_missing_or_sqlite_archive_members')
    inputs.unchanged()
    return dict(include=matrix)


def write_matrix(path, matrix):
    need(path.resolve() == path and path.parent.is_dir(), 'real_github_output_file')
    fd = os.open(path, os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_size <= 65536, 'bounded_github_output_file')
        old = os.read(fd, 65537)
        need(not old or old.endswith(b'\n'), 'github_output_complete_lines')
        need(not any(line.startswith(b'matrix=') or line.startswith(b'matrix<<') for line in old.splitlines()), 'fresh_matrix_output_key')
        raw = ('matrix=' + canonical(matrix) + '\n').encode('ascii')
        need(len(raw) <= 4096 and os.write(fd, raw) == len(raw), 'single_bounded_matrix_write')
        os.fsync(fd)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--scope', choices=['first'], required=True)
    parser.add_argument('--github-output', type=Path, required=True)
    args = parser.parse_args()
    need(sys.platform.startswith('linux') and os.environ.get('GITHUB_ACTIONS') == 'true', 'cloud_plan_scheduling_only')
    sys.dont_write_bytecode = True
    def audit(event, values):
        need(not event.startswith(('socket.', 'subprocess.', 'os.exec', 'os.spawn')) and event not in
             ('os.system', 'os.fork', 'os.posix_spawn', 'sqlite3.connect'), 'no_network_children_or_database')
        if event == 'open' and values and isinstance(values[0], (str, bytes, os.PathLike)):
            need(not os.fsdecode(values[0]).lower().endswith(('.onnx', '.onnx.json', '.pt', '.pth', '.gguf', '.safetensors', '.mp3', '.wav')),
                 'no_models_or_media')
    sys.addaudithook(audit)
    inputs = Inputs(REPO)
    manifest = plan_manifest(decode(inputs.read(REPO / 'data/ci-audio-batch-plan.manifest.json', 65536)))
    archive = args.archive.absolute()
    extracted = unpack_plan(inputs, archive, manifest['archive'])
    matrix = validate_closure(inputs, manifest, extracted)
    need(len(matrix['include']) == 1 and matrix['include'][0]['sliceNumber'] == 1, 'first_only_no_remaining_approval')
    inputs.unchanged()
    write_matrix(args.github_output.absolute(), matrix)
    print(canonical(dict(state='FIRST_JOB_PREPARED_REQUIRES_GENERATION_AND_INDEPENDENT_CHECK',
                         selectedJobs=1, publicationAuthorized=False, modelImported=False)))


if __name__ == '__main__':
    main()
