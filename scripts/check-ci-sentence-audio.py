#!/usr/bin/env python3
"""Independent Linux pilot acceptance: no worker, voice, model or numpy import.

Verify pinned current public text and portable decisions before opening media.
Decode every actual MP3 to EOF, one single-thread child at a time. A successful
pilot receipt is not a publication decision or an expert listening certificate.
"""
from pathlib import Path
import argparse
import array
import builtins
import gzip
import hashlib
import json
import math
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unicodedata
import wave

REPO = Path(__file__).resolve().parent.parent
MIB = 1048576
PUBLIC_SHA = '0ae4679da6df6459cb2cfe21867942bb8eaa4ae9828def149f08816c42f4ef1b'
FINAL_SHA = 'eaaf987f693cfad6a6a3cb5768b8ef855a1f0300d4c06257bf8683ecf86f69dd'
VOICES_SHA = '3dafe3867fc2005ce1cf0be24485e771671121f4cca185521b17b8d381e7489f'
HELPERS = {
    'learning-senses-audio.py': '9ab7399484c8c3cf1afb6368a88cc212a89d6c238990eaebac8952382909e33b',
    'sentence-audio-pack.py': '15bced3b8465a91868314065d54b353c9bbf5aa98884f13337eb97b46036a057',
    'audio-pack.py': '2727eba2fda579f0eea898b122e1963f09b690bea99fa6298f9b21d46cf0b727',
    'audio-journal.py': 'f29690765c98c8f445cfa05a43219b3b58a89e73c8df38490173232ab9ec90b9',
    'sentence-pronunciation.py': '3ab0527d2f2c5e457e031fa63ab3724f14917435dff1d8187a5d63543b5f1fb5',
    'offline-audio-codec.py': '23f3a007a5bf1b84302c067592a455b06a3cc560620a6af382d794a7cd973205',
    'sentence-audio-holds.py': 'be3518c1bee3fa6ca06611296325753ae54032c355937e5b1b50708f4e142d6f',
}
HEX = re.compile('[a-f0-9]{64}')
ACCENTS = ('US', 'UK')
REF_PUBLIC = {'wordId', 'learningSenseId', 'exampleId', 'contentVersion', 'bindingHash',
              'leafIndex', 'leafManifestSha256', 'payloadSha256', 'publicContextSha256',
              'sourceBindingsSha256'}
REF_REVIEW = REF_PUBLIC - {'publicContextSha256'} | {
    'semanticSha256', 'proofSourceBindingsSha256', 'packetReferenceSha256'}
FORBIDDEN = ('piper', 'onnx', 'onnxruntime', 'numpy', 'torch', 'transformers',
             'requests', 'socket', 'http', 'urllib.request')


def need(value, reason):
    if not value:
        raise ValueError(reason)


def canonical(value, ascii_only=False):
    return json.dumps(value, ensure_ascii=ascii_only, sort_keys=True,
                      separators=(',', ':'), allow_nan=False)


def sha(value):
    return hashlib.sha256(value.encode('utf-8') if isinstance(value, str) else value).hexdigest()


def digest(value):
    return isinstance(value, str) and HEX.fullmatch(value) is not None


def normalize(value):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', value).translate(
        str.maketrans({'‘': "'", '’': "'", '“': '"', '”': '"'}))).strip()


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


def identity(value):
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def relative(root, name):
    need(isinstance(name, str) and 0 < len(name) <= 240 and
         re.fullmatch('[A-Za-z0-9._/-]+', name) and not name.startswith('/') and
         all(p not in ('', '.', '..') for p in name.split('/')), 'safe_relative_path')
    path = root / name
    need(path.resolve() == path and path.is_relative_to(root), 'real_input_path')
    return path


class Inputs:
    def __init__(self):
        self.identities = {}

    def checked_fd(self, path, maximum, expected=None, size=None):
        path = Path(path)
        need(path.resolve() == path, 'no_symlink_input_components')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            before = os.fstat(fd)
            need(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= maximum and
                 (size is None or before.st_size == size) and
                 identity(before) == identity(os.lstat(path)), 'bounded_regular_file_before_read')
            count, h = 0, hashlib.sha256()
            while block := os.read(fd, 256 * 1024):
                count += len(block)
                need(count <= before.st_size, 'input_grew')
                h.update(block)
            need(count == before.st_size and (expected is None or h.hexdigest() == expected) and
                 identity(before) == identity(os.fstat(fd)) == identity(os.lstat(path)),
                 'whole_input_hash_and_fd_identity')
            self.identities[path] = identity(before)
            os.lseek(fd, 0, os.SEEK_SET)
            return fd, h.hexdigest(), before
        except BaseException:
            os.close(fd)
            raise

    def read(self, path, maximum, expected=None, size=None):
        fd, checksum, before = self.checked_fd(path, maximum, expected, size)
        try:
            with os.fdopen(fd, 'rb', closefd=False) as handle:
                raw = handle.read(maximum + 1)
            need(len(raw) == before.st_size and sha(raw) == checksum and
                 identity(before) == identity(os.fstat(fd)), 'bounded_parsed_input_unchanged')
            return raw
        finally:
            os.close(fd)

    def json(self, path, maximum, expected=None, size=None):
        return decode(self.read(path, maximum, expected, size))

    def pin(self, pin, maximum, root=REPO):
        need(isinstance(pin, dict) and set(pin) == {'fileName', 'bytes', 'sha256'} and
             type(pin['bytes']) is int and 0 < pin['bytes'] <= maximum and
             digest(pin['sha256']), 'exact_file_pin')
        return self.json(relative(root, pin['fileName']), maximum, pin['sha256'], pin['bytes'])

    def unchanged(self):
        for path, before in self.identities.items():
            need(identity(os.lstat(path)) == before, 'final_input_identity:' + path.name)


def references(value, reviewed):
    fields = REF_REVIEW if reviewed else REF_PUBLIC
    need(isinstance(value, list) and 1 <= len(value) <= 3, 'all_current_references_bounds')
    keys = []
    for ref in value:
        need(isinstance(ref, dict) and set(ref) == fields and
             isinstance(ref['wordId'], str) and 0 < len(ref['wordId']) <= 100 and
             re.fullmatch('learning-sense-[a-f0-9]{64}', ref['learningSenseId']) and
             re.fullmatch('sense-example-[a-f0-9]{64}', ref['exampleId']) and
             isinstance(ref['contentVersion'], str) and 0 < len(ref['contentVersion']) <= 1024 and
             type(ref['leafIndex']) is int and 0 <= ref['leafIndex'] < 95,
             'complete_current_reference_identity')
        for key in fields - {'wordId', 'learningSenseId', 'exampleId', 'contentVersion',
                             'leafIndex', 'packetReferenceSha256'}:
            need(digest(ref[key]), 'complete_current_reference_digest')
        if reviewed:
            need(ref['packetReferenceSha256'] is None or digest(ref['packetReferenceSha256']),
                 'packet_reference_origin_digest')
        keys.append((ref['learningSenseId'], ref['exampleId']))
    need(len(set(keys)) == len(keys), 'all_current_references_unique')
    return set(keys)


def raw_arrays(tokens, joined, allow_empty=False):
    need(isinstance(tokens, list) and isinstance(joined, list) and
         1 <= len(tokens) == len(joined) <= 10, 'complete_raw_array_shape')
    for part, text in zip(tokens, joined):
        need(isinstance(part, list) and len(part) <= 16000 and
             all(isinstance(t, str) and 0 < len(t) <= 64 and '[' not in t and ']' not in t
                 and not re.search(r'[\x00-\x1f]', t) for t in part) and
             isinstance(text, str) and len(text) <= 8000 and ''.join(part) == text and
             (allow_empty or bool(text)), 'original_tokens_join_and_empty_policy')


def review_record(record):
    need(isinstance(record, dict) and set(record) == {
        'id', 'text', 'textHash', 'accent', 'learningSenseId', 'exampleId',
        'originalPhonemes', 'replacements', 'review'}, 'whole_review_record_fields')
    policy_record(record, 'sentence-pronunciation-', 'publish')
    old = record['originalPhonemes']
    need(isinstance(old, list) and 1 <= len(old) <= 10 and
         all(isinstance(s, str) and 0 < len(s) <= 8000 for s in old), 'review_whole_original')
    edits = record['replacements']
    need(isinstance(edits, list) and 1 <= len(edits) <= 10, 'review_explicit_replacements')
    used, result = set(), old[:]
    for edit in sorted(edits, key=lambda e: (e['sentence'], e['start']), reverse=True):
        need(set(edit) == {'sentence', 'start', 'from', 'to'}, 'review_span_fields')
        sent, start, before, after = (edit[k] for k in ('sentence', 'start', 'from', 'to'))
        need(type(sent) is int and type(start) is int and 0 <= sent < len(old) and start >= 0
             and isinstance(before, str) and isinstance(after, str) and
             0 < len(before) <= 200 and 0 < len(after) <= 200 and before != after and
             old[sent][start:start + len(before)] == before, 'review_unicode_literal_span')
        positions = {(sent, i) for i in range(start, start + len(before))}
        need(not positions & used, 'review_overlapping_edits')
        used.update(positions)
        result[sent] = result[sent][:start] + after + result[sent][start + len(before):]
    return dict(record=record, sha256=sha(canonical(record)), correctedPhonemes=result)


def policy_record(record, prefix, decision):
    need(record['accent'] in ACCENTS and isinstance(record['text'], str) and
         15 <= len(record['text']) <= 4000 and normalize(record['text']) == record['text'] and
         sha(record['text']) == record['textHash'] and record['id'] ==
         prefix + sha(record['textHash'] + '\0' + record['accent']), 'policy_record_identity')
    value = record['review']
    need(isinstance(value, dict) and set(value) == {'reviewer', 'decision', 'expertCertified', 'reason'}
         and value['reviewer'] == 'Codex' and value['decision'] == decision and
         value['expertCertified'] is False and isinstance(value['reason'], str) and
         15 <= len(value['reason'].strip()) <= 4000 and
         not re.search(r'[\x00-\x1f]', value['reason']), 'whole_human_policy_review')


def controls_index(value):
    need(set(value) == {'kind', 'engineVersion', 'voicesManifestSha256', 'publicRootSha256',
                       'finalPolicySha256', 'counts', 'groups'} and
         value['kind'] == 'nightstudy-portable-pronunciation-controls-v1' and
         value['engineVersion'] == '1.8.0' and value['voicesManifestSha256'] == VOICES_SHA and
         value['publicRootSha256'] == PUBLIC_SHA and value['finalPolicySha256'] == FINAL_SHA and
         value['counts'] == dict(groups=3643, keys=7286, corrections=1757, holds=79) and
         isinstance(value['groups'], list) and len(value['groups']) == 3643, 'complete_portable_controls')
    groups, corrections, held, raw_null = {}, 0, 0, 0
    for group in value['groups']:
        need(set(group) == {'textHash', 'text', 'references', 'rawTokenSegments',
                           'originalPhonemes', 'accents'} and
             normalize(group['text']) == group['text'] and sha(group['text']) == group['textHash']
             and group['textHash'] not in groups and set(group['accents']) == set(ACCENTS),
             'complete_portable_group')
        refs = references(group['references'], True)
        both = all(c['state'] == 'hold' for c in group['accents'].values())
        if group['rawTokenSegments'] is None or group['originalPhonemes'] is None:
            need(both and group['rawTokenSegments'] is None and group['originalPhonemes'] is None,
                 'raw_null_only_double_hold')
            raw_null += 1
        else:
            raw_arrays(group['rawTokenSegments'], group['originalPhonemes'], both)
        for accent, control in group['accents'].items():
            need(set(control) == {'state', 'correction', 'hold'}, 'complete_regional_control')
            record = None
            if control['state'] == 'reviewed-correction':
                checked = review_record(control['correction']['record'])
                need(checked == control['correction'] and control['hold'] is None and
                     checked['record']['originalPhonemes'] == group['originalPhonemes'],
                     'whole_portable_corrected_record')
                record = checked['record']
                corrections += 1
            elif control['state'] == 'hold':
                record = control['hold']
                need(set(record) == {'id', 'text', 'textHash', 'accent', 'learningSenseId',
                                    'exampleId', 'riskCategory', 'review'} and
                     record['riskCategory'] in ('wrong-lexeme', 'insufficient-regional-evidence',
                                                'insufficient-reading-evidence') and
                     control['correction'] is None, 'whole_active_hold')
                policy_record(record, 'sentence-audio-hold-', 'hold')
                held += 1
            else:
                need(control['state'] == 'reviewed-retain' and control['correction'] is None
                     and control['hold'] is None, 'explicit_retained_control')
            if record is not None:
                need(record['textHash'] == group['textHash'] and record['text'] == group['text']
                     and record['accent'] == accent and
                     (record['learningSenseId'], record['exampleId']) in refs, 'policy_all_current_anchor')
        groups[group['textHash']] = group
    need(corrections == 1757 and held == 79 and raw_null == 11, 'all_portable_policy_counts')
    return groups


def risky(sense, example):
    for metadata in (sense['contentMetadata'], example['contentMetadata']):
        need(isinstance(metadata, dict), 'complete_current_metadata')
        if 'pronunciation' not in metadata:
            continue
        policy = metadata['pronunciation']
        if not isinstance(policy, dict) or policy.get('wordAudioCompatible') is not True:
            return True
        if policy.get('sentenceAudioCompatible') is False or any(policy.get(k) is True for k in
                ('sentenceAudioReviewRequired', 'reviewRequired')) or any(
                isinstance(policy.get(k), str) and policy[k] in ('pending', 'unreviewed', 'requires-review', 'hold')
                for k in ('decision', 'review')):
            return True
    return False


def public_targets(inputs, targets, controls):
    root = inputs.json(REPO / 'data/learning-senses-collection-v2.manifest.json', 128 * 1024, PUBLIC_SHA)
    need(root['wordCount'] == 18767 and root['senseCount'] == 49992 and root['exampleCount'] == 99984
         and len(root['shards']) == 95, 'all95_current_public_leaves')
    wanted = {t['textHash']: t for t in targets}
    found = {h: [] for h in wanted}
    total = [0, 0, 0]
    for index, pin in enumerate(root['shards']):
        manifest = inputs.json(relative(REPO / 'data', pin['manifestFileName']), 128 * 1024,
                               pin['sha256'], pin['bytes'])
        payload = relative(REPO / 'data', manifest['fileName'])
        fd, _, before = inputs.checked_fd(payload, 64 * MIB, manifest['sha256'], manifest['bytes'])
        local, h, uncompressed = [0, 0, 0], hashlib.sha256(), 0
        try:
            with os.fdopen(fd, 'rb', closefd=False) as source:
                with gzip.GzipFile(fileobj=source) as stream:
                    while raw := stream.readline(2 * MIB + 1):
                        uncompressed += len(raw)
                        need(len(raw) <= 2 * MIB and raw.endswith(b'\n') and uncompressed <= 64 * MIB,
                             'bounded_public_jsonl_before_decode')
                        h.update(raw)
                        word = decode(raw)
                        local[0] += 1
                        for sense in word['senses']:
                            local[1] += 1
                            for example in sense['examples']:
                                local[2] += 1
                                text_hash = sha(normalize(example['exampleEn']))
                                if text_hash not in wanted:
                                    continue
                                need(normalize(example['exampleEn']) == wanted[text_hash]['text'],
                                     'current_public_target_text')
                                body = dict(word={k: word[k] for k in ('wordId', 'normalizedLemma')},
                                            sense={k: v for k, v in sense.items() if k != 'examples'}, example=example)
                                ref = dict(wordId=word['wordId'], learningSenseId=sense['id'], exampleId=example['id'],
                                           contentVersion=sense['contentVersion'], bindingHash=sense['bindingHash'],
                                           leafIndex=index, leafManifestSha256=pin['sha256'], payloadSha256=manifest['sha256'],
                                           publicContextSha256=sha(canonical(body)),
                                           sourceBindingsSha256=sha(canonical(sense['sourceBindings'])))
                                need(text_hash in controls or not risky(sense, example), 'base_has_no_unresolved_current_risk')
                                found[text_hash].append(ref)
                                need(len(found[text_hash]) <= 3, 'all_current_target_references_cap')
            need(identity(before) == identity(os.fstat(fd)), 'public_payload_original_fd')
        finally:
            os.close(fd)
        need(h.hexdigest() == manifest['jsonlSha256'] and local == [manifest['wordCount'], manifest['senseCount'], manifest['exampleCount']]
             == [pin['wordCount'], pin['senseCount'], pin['exampleCount']], 'whole_public_leaf_sha_and_counts')
        total = [a + b for a, b in zip(total, local)]
    need(total == [18767, 49992, 99984], 'complete_public_current_text_counts')
    for target in targets:
        actual = {(r['learningSenseId'], r['exampleId']): r for r in found[target['textHash']]}
        need(set(actual) == references(target['references'], target['textHash'] in controls), 'every_current_public_reference')
        for ref in target['references']:
            current = actual[ref['learningSenseId'], ref['exampleId']]
            fields = REF_PUBLIC - {'publicContextSha256'} if target['textHash'] in controls else REF_PUBLIC
            need(all(ref[k] == current[k] for k in fields), 'public_full_context_or_review_binding_changed')


def expected_targets(request, controls, voices):
    need(set(request) == {'kind', 'mode', 'packId', 'portableControls', 'voicesManifest',
                         'publicRootSha256', 'finalPolicySha256', 'targets', 'holdChecks'} and
         request['kind'] == 'nightstudy-ci-sentence-audio-request-v1' and request['mode'] == 'pilot'
         and request['publicRootSha256'] == PUBLIC_SHA and request['finalPolicySha256'] == FINAL_SHA
         and re.fullmatch('sentence-audio-v4-[0-9]{4}', request['packId'])
         and not request['packId'].endswith('-0000') and 1 <= len(request['targets']) <= 8
         and 1 <= len(request['holdChecks']) <= 79, 'exact_bounded_pilot_request')
    expected, identities, denials, seen = {}, [], [], set()
    base_count = correction_count = 0
    for target in request['targets']:
        need(set(target) == {'textHash', 'text', 'references', 'accents'} and
             isinstance(target['text'], str) and 15 <= len(target['text']) <= 4000 and
             normalize(target['text']) == target['text'] and sha(target['text']) == target['textHash']
             and target['textHash'] not in seen and target['accents'] in (['US'], ['UK'], ['US', 'UK']),
             'explicit_unique_current_pilot_sentence')
        seen.add(target['textHash'])
        group = controls.get(target['textHash'])
        references(target['references'], group is not None)
        need(group is None or (group['text'] == target['text'] and group['references'] == target['references']),
             'whole_current_reviewed_target_references')
        for accent in target['accents']:
            control = group['accents'][accent] if group else None
            need(control is None or control['state'] != 'hold', 'held_target_has_no_media_authorization')
            correction = control['correction'] if control else None
            voice = voices['voices'][accent]
            base = sha(canonical(dict(text=target['text'], accent=accent, engine='1.8.0',
                       model=voice['model']['sha256'], config=voice['config']['sha256'], generator='audio-v1'), True))
            corrected = dict(baseSynthesisIdentity=base, pronunciationCorrectionSha256=correction['sha256']) if correction else None
            if correction and len(correction['correctedPhonemes']) > 1:
                corrected['renderPolicy'] = 'piper-raw-per-sentence-wav-v1'
            row = dict(textHash=target['textHash'], accent=accent, baseSynthesisIdentity=base,
                       cacheKey=sha(canonical(corrected)) if corrected else base,
                       route='frozen-reviewed-raw-per-sentence' if group else 'linux-original-text',
                       correctionSha256=correction['sha256'] if correction else None,
                       referencesSha256=sha(canonical(target['references'])))
            identities.append(row)
            expected[target['textHash'], accent] = dict(identity=row, target=target, group=group, correction=correction)
            base_count += group is None
            correction_count += correction is not None
    hold_keys = set()
    for hold in request['holdChecks']:
        need(set(hold) == {'textHash', 'accent'} and hold['accent'] in ACCENTS, 'explicit_hold_check')
        key = hold['textHash'], hold['accent']
        need(key not in hold_keys and key not in expected and key[0] in controls and
             controls[key[0]]['accents'][key[1]]['state'] == 'hold', 'actual_exact_hold_denial')
        hold_keys.add(key)
        denials.append(dict(textHash=key[0], accent=key[1], decision='hold',
                            hold=controls[key[0]]['accents'][key[1]]['hold'], modelLoaded=False, mediaGenerated=False))
    need(1 <= len(expected) <= 16 and base_count >= 1 and correction_count >= 1,
         'pilot_has_base_correction_and_hold_controls')
    return expected, identities, denials


def execution_metadata(expected):
    tasks = []
    for accent in ACCENTS:
        hashes = sorted(h for h, a in expected if a == accent)
        if not hashes:
            continue
        task = 'bounded-v1-' + accent + '-000000-' + sha(canonical(
            dict(policy='bounded-spawn-tasks-v1', accent=accent, textHashes=hashes), True))
        tasks.append(dict(id=task, accent=accent, sentenceCount=len(hashes)))
    return dict(policy='bounded-spawn-tasks-v1', workerBatchSize=8, maxTasksPerChild=1, maxWorkers=1,
                maximumInFlightTasks=1, poolLifecycle='new-spawn-pool-per-wave; join-before-next-wave',
                taskOrder='US-then-UK-textHash-contiguous-v1', taskIdentity='sha256-of-policy-accent-ordered-textHashes-v1',
                taskCount=len(tasks), tasks=tasks)


def validate_routes(events, expected, task, parent_pgid):
    seen, worker_ids = {}, set()
    common = {'textHash', 'accent', 'displayedTextUnchanged', 'taskId', 'workerPid',
              'workerPgid', 'referencesSha256', 'route', 'frontendPrecheckOnly',
              'rawRouteObserved', 'completedPublicCall'}
    for event in events:
        key = event['textHash'], event['accent']
        need(key in expected and event['accent'] == task['accent'] and event['taskId'] == task['id']
             and type(event['workerPid']) is int and event['workerPid'] > 1
             and event['workerPgid'] == parent_pgid and event['completedPublicCall'] is True,
             'actual_completed_public_call_task_and_process')
        selected = expected[key]
        need(event['displayedTextUnchanged'] == selected['target']['text'] and
             event['referencesSha256'] == selected['identity']['referencesSha256'] and
             event['route'] == selected['identity']['route'], 'route_full_current_identity')
        worker_ids.add(event['workerPid'])
        seen.setdefault(key, []).append(event)
        group, correction = selected['group'], selected['correction']
        if group is None:
            need(set(event) == common | {'actualFrontendTokenSegments', 'actualFrontendPhonemes'} and
                 event['frontendPrecheckOnly'] is True and event['rawRouteObserved'] is False,
                 'base_precheck_not_claimed_as_internal_raw_route')
            raw_arrays(event['actualFrontendTokenSegments'], event['actualFrontendPhonemes'])
        else:
            rendered = correction['correctedPhonemes'] if correction else group['originalPhonemes']
            need(set(event) == common | {'sentenceIndex', 'rawPayload', 'originalTokenSegments',
                 'originalPhonemes', 'renderedPhonemes', 'correctionSha256', 'correctionId',
                 'linuxDisplayedTextPhonemizeCalled'} and event['frontendPrecheckOnly'] is False and
                 event['rawRouteObserved'] is True and event['linuxDisplayedTextPhonemizeCalled'] is False and
                 event['originalTokenSegments'] == group['rawTokenSegments'] and
                 event['originalPhonemes'] == group['originalPhonemes'] and event['renderedPhonemes'] == rendered and
                 event['correctionSha256'] == (correction['sha256'] if correction else None) and
                 event['correctionId'] == (correction['record']['id'] if correction else None) and
                 type(event['sentenceIndex']) is int and 0 <= event['sentenceIndex'] < len(rendered) and
                 event['rawPayload'] == '[[' + rendered[event['sentenceIndex']] + ']]',
                 'actual_entire_frozen_unicode_raw_route')
    task_keys = {k for k in expected if k[1] == task['accent']}
    need(set(seen) == task_keys and len(worker_ids) == 1, 'all_task_pairs_one_fresh_worker')
    for key, rows in seen.items():
        selected = expected[key]
        if selected['group'] is None:
            need(len(rows) == 1, 'one_base_public_display_call')
        else:
            parts = selected['correction']['correctedPhonemes'] if selected['correction'] else selected['group']['originalPhonemes']
            need([r['sentenceIndex'] for r in rows] == list(range(len(parts))), 'all_raw_segments_once_in_original_order')
    return next(iter(worker_ids))


def pcm_metrics(pcm):
    samples = array.array('h')
    samples.frombytes(pcm)
    if sys.byteorder != 'little':
        samples.byteswap()
    need(len(samples) >= 100 and .05 <= len(samples) / 22050 <= 30, 'complete_decoded_duration')
    peak = max(abs(x) for x in samples)
    rms = math.sqrt(sum(x * x for x in samples) / len(samples))
    clipping = sum(abs(x) >= 32760 for x in samples) / len(samples)
    need(peak >= 10 and math.isfinite(rms) and rms >= 1 and clipping <= .01, 'decoded_quality')
    threshold = max(20, peak * .003)
    first = next((i for i, x in enumerate(samples) if abs(x) > threshold), None)
    last = next((i for i, x in enumerate(reversed(samples)) if abs(x) > threshold), None)
    need(first is not None, 'decoded_silent')
    return dict(peakAmplitude=peak, rmsDbfs=round(20 * math.log10(rms / 32768), 3),
                clippedSampleFraction=round(clipping, 8), decodedDurationSeconds=round(len(samples) / 22050, 6),
                leadingSilenceSeconds=round(first / 22050, 6),
                trailingSilenceSeconds=round(last / 22050, 6))


def complete_wav(handle):
    with wave.open(handle, 'rb') as wav:
        need((wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) ==
             (1, 2, 22050, 'NONE'), 'native_pcm_format')
        pcm = wav.readframes(30 * 22050 + 1)
        need(not wav.readframes(1) and len(pcm) == wav.getnframes() * 2 and
             0 < len(pcm) <= 30 * 22050 * 2, 'complete_wav_pcm_eof_not_header_only')
        return pcm


def decode_mp3(inputs, path, expected_sha, expected_bytes, ffmpeg, temporary):
    """Decode the pinned open descriptor to EOF. No time/sample truncation flags."""
    fd, _, before = inputs.checked_fd(path, 2 * MIB, expected_sha, expected_bytes)
    try:
        with tempfile.TemporaryDirectory(prefix='nightstudy-audio-check-', dir=temporary) as folder:
            output, errors = Path(folder) / 'pcm.wav', Path(folder) / 'decoder.stderr'
            with errors.open('xb') as stderr:
                command = [str(ffmpeg), '-nostdin', '-v', 'error', '-xerror', '-threads', '1',
                           '-filter_threads', '1', '-filter_complex_threads', '1', '-protocol_whitelist', 'file,fd',
                           '-fd', str(fd), '-i', 'fd:', '-map', '0:a:0', '-vn', '-sn', '-dn',
                           '-c:a', 'pcm_s16le', '-threads', '1', '-f', 'wav', str(output)]
                child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=stderr,
                                         pass_fds=(fd,), start_new_session=True)
                start = time.monotonic()
                try:
                    while child.poll() is None:
                        need(time.monotonic() - start < 8, 'decoder_child_timeout')
                        need((not output.exists() or output.stat().st_size <= 2 * MIB) and errors.stat().st_size <= 65536,
                             'decoder_child_output_cap')
                        time.sleep(.02)
                    need(child.returncode == 0 and errors.stat().st_size == 0, 'complete_ffmpeg_decode_failed')
                    need(os.lseek(fd, 0, os.SEEK_CUR) == before.st_size and not os.read(fd, 1),
                         'decoder_must_consume_original_file_to_eof')
                finally:
                    if child.poll() is None:
                        os.killpg(child.pid, signal.SIGTERM)
                        try:
                            child.wait(timeout=.5)
                        except subprocess.TimeoutExpired:
                            os.killpg(child.pid, signal.SIGKILL)
                            child.wait(timeout=.5)
            need(0 < output.stat().st_size <= 2 * MIB and errors.stat().st_size <= 65536,
                 'complete_decoded_file_cap')
            with output.open('rb') as stream:
                pcm = complete_wav(stream)
        need(identity(before) == identity(os.fstat(fd)) == identity(os.lstat(path)), 'media_fd_identity_after_full_decode')
        return pcm_metrics(pcm)
    finally:
        os.close(fd)


def verify(args):
    inputs = Inputs()
    request = inputs.json(args.request.absolute(), 256 * 1024, args.request_sha256)
    need(request['voicesManifest']['fileName'] == 'data/audio-voices.manifest.json' and
         request['voicesManifest']['sha256'] == VOICES_SHA, 'fixed_existing_voices')
    voices = inputs.pin(request['voicesManifest'], 64 * 1024)
    controls = controls_index(inputs.pin(request['portableControls'], 64 * MIB))
    expected, identities, denials = expected_targets(request, controls, voices)
    public_targets(inputs, request['targets'], controls)
    root = args.output.absolute()
    need(root.resolve() == root and root.is_dir(), 'real_generated_output')
    read = lambda name, cap=2 * MIB: inputs.json(relative(root, name), cap)
    build = read('build-receipt.json')
    need(set(build) == {'kind', 'state', 'requestSha256', 'workerSourceSha256', 'elapsedSeconds',
                       'publicRootSha256', 'finalPolicySha256', 'generatedPairs', 'holdDenials', 'files',
                       'independentFullDecodePassed', 'publicationAuthorized'} and
         build['kind'] == 'nightstudy-ci-audio-generated-v1' and
         build['state'] == 'GENERATED_REQUIRES_INDEPENDENT_CHECK' and build['requestSha256'] == args.request_sha256 and
         build['publicRootSha256'] == PUBLIC_SHA and build['finalPolicySha256'] == FINAL_SHA and
         build['generatedPairs'] == len(expected) and build['holdDenials'] == len(denials) and
         build['independentFullDecodePassed'] is False and build['publicationAuthorized'] is False,
         'actual_generated_unapproved_receipt')
    worker_source = inputs.read(REPO / 'scripts/ci-sentence-audio-worker.py', 128 * 1024)
    need(build['workerSourceSha256'] == sha(worker_source), 'actual_worker_source_identity')
    pins = {}
    for pin in build['files']:
        need(set(pin) == {'fileName', 'bytes', 'sha256'} and pin['fileName'] not in pins and
             type(pin['bytes']) is int and 0 < pin['bytes'] <= 2 * MIB and digest(pin['sha256']), 'unique_artifact_pin')
        fd, _, _ = inputs.checked_fd(relative(root, pin['fileName']), 2 * MIB, pin['sha256'], pin['bytes'])
        os.close(fd)
        pins[pin['fileName']] = pin
    need(read('request.json') == request and read('expected-identities.json') == identities and
         read('held-denials.json') == denials, 'full_request_expected_identities_and_hold_denials')
    start, sources, manifest = read('build-start.json'), read('sources.manifest.json'), read('manifest.json')
    execution = execution_metadata(expected)
    need(start['kind'] == 'nightstudy-ci-audio-start-v1' and start['requestSha256'] == args.request_sha256 and
         type(start['parentPid']) is int and start['parentPid'] > 1 and type(start['parentPgid']) is int and
         start['parentPgid'] > 1 and start['buildExecution'] == execution and start['threadsPerVoice'] == 1 and
         start['modelsDownloaded'] is False and start['heldDenialCount'] == len(denials) and
         start['publicationAuthorized'] is False, 'actual_serial_build_start')
    need(sources['schemaVersion'] == 2 and sources['version'] == request['packId'] and
         sources['meaningPackId'] == 'learning-senses-collection-v2' and sources['meaningPackSha256'] == PUBLIC_SHA and
         sources['meaningPackIdentityKind'] == 'collection-manifest-sha256' and sources['engineSource'] == voices and
         sources['portableControls'] == request['portableControls'] and sources['finalPolicySha256'] == FINAL_SHA and
         sources['requestedSentences'] == request['targets'] and sources['baselinePacks'] == [] and
         sources['reusedMediaReferences'] == [] and sources['buildExecution'] == execution and
         sources['frozenRetainedRawUsesBaseIdentity'] is True and sources['publicationAuthorized'] is False and
         sources['helperSha256'] == HELPERS and
         sources['buildRuntime']['packages']['piper-tts'] == '1.8.0', 'complete_source_manifest_current_provenance')
    for name, checksum in sources['helperSha256'].items():
        inputs.read(relative(REPO / 'scripts', name), 128 * 1024, checksum)
    ffmpeg = args.ffmpeg.absolute()
    fd, ffmpeg_sha, _ = inputs.checked_fd(ffmpeg, 128 * MIB)
    os.close(fd)
    need(sources['transcodingTool']['executableSha256'] == ffmpeg_sha and
         sources['transcodingTool']['executableSizeBytes'] == ffmpeg.stat().st_size,
         'actual_decoder_same_recorded_binary')
    need(manifest['schemaVersion'] == 2 and manifest['version'] == request['packId'] and manifest['status'] == 'ready' and
         manifest['sourceManifestSha256'] == pins['sources.manifest.json']['sha256'] and
         manifest['statistics'] == dict(lemmaCount=len(request['targets']), entryCount=len(expected),
                                       recordedCount=0, synthesizedCount=len(expected), failedCount=0), 'complete_pilot_manifest')
    entries = manifest['entries']
    need(isinstance(entries, list) and len(entries) == len(expected) and
         entries == sorted(entries, key=lambda e: (e['textHash'], e['accent'])) and
         {(e['textHash'], e['accent']) for e in entries} == set(expected), 'all_authorized_pairs_no_held_or_extra_media')
    task_ids, progress_files, pids = set(), set(), set()
    for task in execution['tasks']:
        name = 'routes/' + task['id'] + '.jsonl'
        raw = inputs.read(relative(root, name), 2 * MIB)
        events = [decode(line) for line in raw.splitlines()]
        need(raw.endswith(b'\n') and 1 <= len(events) <= 80 and all(len(line) <= 256 * 1024 for line in raw.splitlines()),
             'bounded_complete_route_log')
        pid = validate_routes(events, expected, task, start['parentPgid'])
        need(pid not in pids and pid != start['parentPid'], 'fresh_serial_model_worker_pid')
        pids.add(pid)
        task_ids.add(name)
        journal = 'progress/' + task['accent'] + '-' + task['id'] + '.jsonl'
        progress_files.add(journal)
        records = [decode(line) for line in inputs.read(relative(root, journal), 2 * MIB).splitlines()]
        need(len(records) == task['sentenceCount'] and records == [e for e in entries if e['accent'] == task['accent']],
             'complete_fresh_progress_equals_selected_entries')
    files, checked_media = set(), []
    for entry in entries:
        key = entry['textHash'], entry['accent']
        selected, voice = expected[key], voices['voices'][key[1]]
        correction = selected['correction']
        need(entry['text'] == entry['lemma'] == selected['target']['text'] and
             entry['cacheKey'] == selected['identity']['cacheKey'] and entry['kind'] == 'synthesized' and
             entry['engineVersion'] == '1.8.0' and entry['inferenceBackend'] == 'CPUExecutionProvider' and
             entry['voiceModelSha256'] == voice['model']['sha256'] and entry['voiceConfigSha256'] == voice['config']['sha256']
             and all(entry[k] == voice[k] for k in ('sourceName', 'sourceUrl', 'license', 'attribution')),
             'entry_independent_synthesis_identity_and_voice_source')
        if correction:
            need(entry['pronunciationCorrectionSha256'] == correction['sha256'] and
                 entry['pronunciationCorrectionId'] == correction['record']['id'], 'whole_correction_entry_identity')
        else:
            need('pronunciationCorrectionSha256' not in entry and 'pronunciationCorrectionId' not in entry,
                 'base_or_retain_has_no_invented_correction')
        need(digest(entry['fileSha256']) and digest(entry['originalFileSha256']) and
             entry['fileKey'] == 'files/' + entry['fileSha256'] + '.mp3' and entry['mimeType'] == 'audio/mpeg' and
             entry['originalMimeType'] == 'audio/wav' and entry['sampleRate'] == 22050 and entry['channels'] == 1 and
             entry['sampleWidthBytes'] == 2, 'content_addressed_original_and_mp3_identity')
        original = 'files/' + entry['originalFileSha256'] + '.wav'
        files.update((entry['fileKey'], original))
        fd, _, _ = inputs.checked_fd(relative(root, original), 2 * MIB, entry['originalFileSha256'])
        try:
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                original_pcm = complete_wav(stream)
        finally:
            os.close(fd)
        need(abs(len(original_pcm) / 44100 - entry['durationSeconds']) <= .000001, 'whole_original_wav_duration')
        original_metrics = pcm_metrics(original_pcm)
        del original_pcm
        metrics = decode_mp3(inputs, relative(root, entry['fileKey']), entry['fileSha256'],
                             entry['sizeBytes'], ffmpeg, root)
        need(abs(metrics['decodedDurationSeconds'] - entry['decodedDurationSeconds']) <= .000001 and
             abs(metrics['decodedDurationSeconds'] - entry['durationSeconds']) <= .2, 'full_decoded_duration_provenance')
        quality = entry['qualityMetrics']
        for name, value in metrics.items():
            need(abs(value - quality[name]) <= (.002 if name == 'rmsDbfs' else .000001), 'independent_full_decode_metric:' + name)
        need(quality['policyVersion'] == 1 and quality['sampleRate'] == 22050 and quality['channels'] == 1 and
             quality['timeStretchApplied'] is False and quality['silenceTrimApplied'] is False,
             'independent_quality_policy')
        checked_media.append(dict(textHash=key[0], accent=key[1], fileSha256=entry['fileSha256'],
                                  originalWavSha256=entry['originalFileSha256'], cacheKey=entry['cacheKey'],
                                  originalWavMetrics=original_metrics, metrics=metrics))
    fixed = {'request.json', 'expected-identities.json', 'held-denials.json', 'build-start.json',
             'sources.manifest.json', 'manifest.json'}
    need(set(pins) == fixed | files | task_ids and
         {p.relative_to(root).as_posix() for p in (root / 'files').iterdir()} == files and
         {p.relative_to(root).as_posix() for p in (root / 'routes').iterdir()} == task_ids and
         {p.relative_to(root).as_posix() for p in (root / 'progress').iterdir()} == progress_files and
         {p.name for p in root.iterdir()} == fixed | {'files', 'routes', 'progress', 'build-receipt.json'},
         'whole_media_and_route_artifact_inventory_no_held_output')
    inputs.unchanged()
    return dict(kind='nightstudy-ci-sentence-audio-independent-check-v1', state='VERIFIED_PILOT_ONLY',
                requestSha256=args.request_sha256, publicRootSha256=PUBLIC_SHA, finalPolicySha256=FINAL_SHA,
                generatedPairs=len(expected), heldDenials=len(denials), currentPublicLeaves=95,
                allCurrentReferencesBound=True, reviewedFrozenRawCallsVerified=True,
                baseFrontendObservationsArePrechecksOnly=True, completeMp3EofDecodes=len(checked_media),
                originalWavsFullyRead=len(checked_media), decoderThreads=1, decoderBinarySha256=ffmpeg_sha,
                decoderInputProtocol='fd', seekablePinnedInput=True,
                media=checked_media, expertCertified=False, listened=False, publicationAuthorized=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('request', 'output', 'ffmpeg', 'receipt'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--request-sha256', required=True)
    args = parser.parse_args()
    need(sys.platform.startswith('linux') and os.environ.get('GITHUB_ACTIONS') == 'true', 'cloud_linux_checker_only')
    need(digest(args.request_sha256), 'explicit_request_sha256')
    original = builtins.__import__
    def safe_import(name, *rest, **kwargs):
        need(not any(name == p or name.startswith(p + '.') for p in FORBIDDEN), 'no_model_or_network_import')
        return original(name, *rest, **kwargs)
    need(not any(any(n == p or n.startswith(p + '.') for p in FORBIDDEN) for n in sys.modules), 'no_preloaded_model_or_network')
    builtins.__import__ = safe_import
    def audit(event, values):
        need(not event.startswith('socket.'), 'no_checker_network')
        if event == 'open' and values and isinstance(values[0], (str, bytes, os.PathLike)):
            need(not os.fsdecode(values[0]).lower().endswith(('.onnx', '.onnx.json', '.pt', '.pth', '.gguf', '.safetensors')),
                 'no_checker_model_or_model_config_open')
    sys.addaudithook(audit)
    sys.dont_write_bytecode = True
    receipt = args.receipt.absolute()
    need(not os.path.lexists(receipt) and receipt.parent.resolve() == receipt.parent, 'fresh_independent_receipt')
    result = verify(args)
    raw = (canonical(result) + '\n').encode()
    fd = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    print(canonical(dict(state=result['state'], generatedPairs=result['generatedPairs'],
                         completeMp3EofDecodes=result['completeMp3EofDecodes'], publicationAuthorized=False)))


if __name__ == '__main__':
    main()
