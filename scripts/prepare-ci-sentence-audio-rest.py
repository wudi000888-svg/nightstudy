#!/usr/bin/env python3
"""Schedule the remaining fixed100 jobs after the actual accepted first job.

Reuses the source-pinned immutable first scheduler's archive/closure validation.
It never imports workers, models or media, and never authorizes publication.
"""
import argparse
import hashlib
import os
from pathlib import Path
import re
import stat
import sys
import types

REPO = Path(__file__).resolve().parent.parent
HELPER = REPO / 'scripts/prepare-ci-sentence-audio-run.py'
HELPER_SHA = '32378ef6c986b9de502620c559b70d12135e0a92976a559492c4328bd5089c88'
HELPER_BYTES = 20409
APPROVAL_SHA = '5cb039e70d27602b825e8e83331af919cd91fb22b91f8276f78a0c322bbcf65e'
FIRST_CHECK_SHA = '5a02b5d95f2c0a7d433b04e4b7ad4d9d4708a3aeeb27391394deb3057f37b975'
FIRST_REQUEST_SHA = '7a27537e72bb52398657d64945189d81b655cd7151df4039fa293fff383200bd'
CHECKER_SHA = '16fbaf7f522a0f26382a923df7670b623fa49df4f82a8b6b225f1e2af71913d8'


def load_helper():
    fd = os.open(HELPER, os.O_RDONLY | os.O_NOFOLLOW)
    sig = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    try:
        before = os.fstat(fd)
        if HELPER.resolve() != HELPER or not stat.S_ISREG(before.st_mode) or before.st_size != HELPER_BYTES:
            raise ValueError('fixed_first_helper_size')
        raw = os.read(fd, 128 * 1024 + 1)
        if len(raw) != HELPER_BYTES or os.read(fd, 1) or hashlib.sha256(raw).hexdigest() != HELPER_SHA or \
                sig(before) != sig(os.fstat(fd)) or sig(before) != sig(os.lstat(HELPER)):
            raise ValueError('fixed_first_helper_hash_identity')
        module = types.ModuleType('_nightstudy_original_first_plan_validation')
        module.__file__ = str(HELPER)
        exec(compile(raw, str(HELPER), 'exec'), module.__dict__)
        return module, sig(before)
    finally:
        os.close(fd)


def accepted_source(r, approval, manifest, job):
    r.need(set(approval) == {'kind', 'source', 'packId', 'selectionManifest', 'request', 'check', 'assembly', 'unpack', 'archive'} and
           approval['kind'] == 'nightstudy-ci-audio-first-accepted-v1' and approval['packId'] == job['packId'] == 'sentence-audio-v4-0101' and
           approval['selectionManifest'] == manifest['selection'] and approval['request'] == {key: job[key] for key in r.PIN_FIELDS} and
           approval['request']['bytes'] == 248810 and approval['request']['sha256'] == FIRST_REQUEST_SHA and
           approval['check']['bytes'] == 368196 and approval['check']['sha256'] == FIRST_CHECK_SHA and
           approval['source'] == dict(release='audio-build-batches-014-20261019', runId=39229287197, attempt=1,
               commit='3b8da3fc09ca89883f96a539c8dad73f0980559d', conclusion='success'), 'explicit_actual_first_job_conclusion')
    for name in ('check', 'assembly', 'unpack'):
        r.valid_pin(approval[name])
        r.need(approval[name]['fileName'].startswith('.ci-audio-inputs/'), 'first_evidence_input_namespace')
    r.valid_pin(approval['archive'], 128 * r.MIB)


def first_check(r, receipt, request):
    r.need(receipt['kind'] == 'nightstudy-ci-sentence-audio-batch-independent-check-v1' and
           receipt['state'] == 'VERIFIED_SELECTED_BATCH_ONLY' and receipt['requestSha256'] == FIRST_REQUEST_SHA and
           receipt['publicRootSha256'] == r.PUBLIC_SHA and receipt['finalPolicySha256'] == r.FINAL_SHA and
           receipt['batchApproval'] == request['batchApproval'] and receipt['batchApproval']['sliceNumber'] == 1 and
           receipt['selectedLeafGroups'] == 256 and receipt['generatedPairs'] == receipt['completeMp3EofDecodes'] ==
               receipt['originalWavsFullyRead'] == 512 and receipt['heldDenials'] >= 1 and
           receipt['allCurrentReferencesBound'] is True and receipt['selectionPairUnionVerified'] is True and
           receipt['oldUnapprovedCandidateSelection'] == 'NOT_SELECTED' and receipt['oldUnapprovedCandidates'] == 89880 and
           receipt['workers'] == 4 and receipt['threadsPerVoice'] == receipt['decoderThreads'] == 1 and
           receipt['decoderInputProtocol'] == 'fd' and receipt['seekablePinnedInput'] is True and
           receipt['reviewedFrozenRawCallsVerified'] is True and receipt['publicationAuthorized'] is False and
           receipt['batchWorkerSha256'] == r.WORKER_SHA and receipt['checkerSourceSha256'] == CHECKER_SHA and
           receipt['purePilotHelperSha256'] == '8d4c07d943331228790aa6d0376b664677180705c0b590d42c6c73b32dcc9057' and
           receipt['journalReusePolicy'] == 'disabled-fresh-generation-no-progress-inputs-v1', 'whole_actual_first_independent_acceptance')
    expected = {(target['textHash'], accent) for target in request['targets'] for accent in target['accents']}
    r.need(isinstance(receipt['media'], list) and len(receipt['media']) == len(expected) == 512 and
           {(row['textHash'], row['accent']) for row in receipt['media']} == expected and
           all(all(isinstance(row[key], str) and re.fullmatch('[a-f0-9]{64}', row[key]) for key in
               ('cacheKey', 'fileSha256', 'originalWavSha256')) and isinstance(row['metrics'], dict) and
               isinstance(row['originalWavMetrics'], dict) for row in receipt['media']), 'first_all512_media_keys_and_original_wavs')


def first_assembly(r, assembly, unpack, approval):
    r.need(assembly['kind'] == 'nightstudy-ci-audio-installer-assembly-v1' and
           assembly['state'] == 'ASSEMBLED_REQUIRES_INSTALLER_ACCEPTANCE' and
           assembly['requestSha256'] == FIRST_REQUEST_SHA and assembly['independentCheckSha256'] == FIRST_CHECK_SHA and
           assembly['assemblerSourceSha256'] == '5103ef2fbe8567fb94cf22f0270c33fb7b6beaea668c5e8890131d1b5c96e314' and
           assembly['archive'] == approval['archive'] and assembly['mp3Files'] == 512 and assembly['globalHoldCount'] == 79 and
           assembly['originalWavsInArchive'] == assembly['modelFilesInArchive'] == assembly['evidenceLogsInArchive'] == 0 and
           assembly['modelImported'] is False and assembly['publicationAuthorized'] is False and
           assembly['coverage'] == dict(requestedSentenceCount=256, requestedClipCount=512, generatedClipCount=512,
               reusedClipCount=0, fullyReusedSentenceCount=0, partiallyReusedSentenceCount=0, heldClipCount=0,
               heldSentenceCount=0, fullyHeldSentenceCount=0, eligibleClipCount=512), 'actual_first_mp3_only_assembly')
    r.need(set(unpack) == {'ok', 'members', 'files', 'expandedBytes'} and unpack['ok'] is True and
           unpack['members'] == unpack['files'] == 525 and unpack['expandedBytes'] == 11794191,
           'actual_first_complete_installer_extraction')


def remaining_matrix(r, jobs):
    r.need(len(jobs['requests']) == 101 and jobs['requests'][0]['sliceNumber'] == 1, 'exact101_actual_plan_jobs')
    result = []
    for number, job in enumerate(jobs['requests'][1:], 2):
        r.need(job['sliceNumber'] == number and job['packId'] == 'sentence-audio-v4-%04d' % (100 + number) and
               job['fileName'] == '.ci-audio-plan/request-%04d.json' % number, 'remaining_ordered_unique_identity')
        result.append(dict(sliceNumber=number, packId=job['packId'], requestFile=job['fileName'],
                           requestSha256=job['sha256'], groups=job['groups'], pairs=job['pairs']))
    r.need(len(result) == 100 and all(row['sliceNumber'] != 1 for row in result), 'never_repeat_first_job')
    return dict(include=result)


def write_matrix(r, path, matrix):
    r.need(path.resolve() == path and path.parent.is_dir(), 'real_remaining_github_output_file')
    fd = os.open(path, os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        r.need(stat.S_ISREG(before.st_mode) and before.st_size <= 65536, 'bounded_remaining_github_output_file')
        old = os.read(fd, 65537)
        r.need((not old or old.endswith(b'\n')) and not any(line.startswith(b'matrix=') or line.startswith(b'matrix<<')
               for line in old.splitlines()), 'fresh_remaining_matrix_key')
        raw = ('matrix=' + r.canonical(matrix) + '\n').encode('ascii')
        r.need(len(raw) <= 65536 and os.write(fd, raw) == len(raw), 'bounded_complete_remaining_matrix_write')
        os.fsync(fd)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--scope', choices=['remaining'], required=True)
    parser.add_argument('--github-output', type=Path, required=True)
    args = parser.parse_args()
    r, identity = load_helper()
    r.need(sys.platform.startswith('linux') and os.environ.get('GITHUB_ACTIONS') == 'true', 'cloud_remaining_schedule_only')
    sys.dont_write_bytecode = True
    def guard(event, values):
        r.need(not event.startswith(('socket.', 'subprocess.', 'os.exec', 'os.spawn')) and event not in
               ('os.system', 'os.fork', 'os.posix_spawn', 'sqlite3.connect'), 'no_rest_network_children_or_database')
        if event == 'open' and values and isinstance(values[0], (str, bytes, os.PathLike)):
            r.need(not os.fsdecode(values[0]).lower().endswith(('.onnx', '.onnx.json', '.mp3', '.wav', '.pt', '.pth', '.gguf', '.safetensors')),
                   'no_rest_models_or_media')
    sys.addaudithook(guard)
    inputs = r.Inputs(REPO)
    inputs.seen[HELPER] = identity
    plan = r.plan_manifest(r.decode(inputs.read(REPO / 'data/ci-audio-batch-plan.manifest.json', 65536)))
    archive = args.archive.absolute()
    extracted = r.unpack_plan(inputs, archive, plan['archive'])
    r.validate_closure(inputs, plan, extracted)
    jobs = inputs.pin(plan['jobs'])
    approval_raw = inputs.read(REPO / 'data/ci-audio-first-accepted.manifest.json', 65536)
    r.need(len(approval_raw) == 1427 and r.sha(approval_raw) == APPROVAL_SHA, 'committed_actual_first_approval_bytes')
    approval = r.decode(approval_raw)
    accepted_source(r, approval, plan, jobs['requests'][0])
    request = inputs.pin(approval['request'])
    first_check(r, inputs.pin(approval['check']), request)
    first_assembly(r, inputs.pin(approval['assembly']), inputs.pin(approval['unpack']), approval)
    matrix = remaining_matrix(r, jobs)
    inputs.unchanged()
    write_matrix(r, args.github_output.absolute(), matrix)
    print(r.canonical(dict(state='REMAINING100_PREPARED_AFTER_ACTUAL_FIRST_ACCEPTANCE', selectedJobs=100,
        acceptedFirstCheckSha256=FIRST_CHECK_SHA, firstRepeated=False, modelImported=False, publicationAuthorized=False)))


if __name__ == '__main__':
    main()
