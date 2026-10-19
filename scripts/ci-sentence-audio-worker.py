#!/usr/bin/env python3
"""Small, offline Linux pilot using the two existing pinned Piper voices.

Only CI runs this entry. It deliberately cannot start a local macOS model,
download a voice, resume an old journal, publish a pack, or approve its own
audio. The independent checker must accept the resulting complete artifacts.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import platform
import re
import stat
import sys
import time
import types
import wave

REPO = Path(__file__).resolve().parent.parent
MIB = 1024 * 1024
FINAL_POLICY_SHA = 'eaaf987f693cfad6a6a3cb5768b8ef855a1f0300d4c06257bf8683ecf86f69dd'
PUBLIC_ROOT_SHA = '0ae4679da6df6459cb2cfe21867942bb8eaa4ae9828def149f08816c42f4ef1b'
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
THREAD_ENV = ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS',
              'NUMEXPR_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS')


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha(raw):
    return hashlib.sha256(raw.encode('utf-8') if isinstance(raw, str) else raw).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate_json_key')
        result[key] = value
    return result


def digest(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def read_bounded(path, maximum, expected_sha=None, expected_bytes=None):
    """Validate the open regular file before allocating its bounded contents."""
    path = Path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= maximum,
                'input_file_bounds:' + path.name)
        require(expected_bytes is None or before.st_size == expected_bytes,
                'input_file_size:' + path.name)
        with os.fdopen(fd, 'rb', closefd=False) as handle:
            raw = handle.read(maximum + 1)
        after = os.fstat(fd)
        current = path.stat(follow_symlinks=False)
        identity = lambda x: (x.st_dev, x.st_ino, x.st_size, x.st_mtime_ns)
        require(identity(before) == identity(after) == identity(current)
                and len(raw) == before.st_size, 'input_file_changed:' + path.name)
        require(expected_sha is None or sha(raw) == expected_sha,
                'input_file_hash:' + path.name)
        return raw
    finally:
        os.close(fd)


def json_bytes(raw):
    return json.loads(raw, object_pairs_hook=unique_object)


def relative_file(name):
    require(isinstance(name, str) and len(name) <= 240 and
            re.fullmatch(r'[A-Za-z0-9._/-]+', name) is not None,
            'input_relative_filename')
    parts = Path(name).parts
    require(parts and not Path(name).is_absolute() and all(p not in ('.', '..') for p in parts),
            'input_relative_filename')
    file = REPO / name
    for parent in (file, *file.parents):
        require(not parent.is_symlink(), 'input_symlink')
        if parent == REPO:
            break
    require(file.resolve(strict=True).is_relative_to(REPO), 'input_escaped_repository')
    return file


def pin_value(pin, maximum):
    require(isinstance(pin, dict) and set(pin) == {'fileName', 'bytes', 'sha256'}
            and type(pin['bytes']) is int and 0 < pin['bytes'] <= maximum
            and isinstance(pin['sha256'], str) and re.fullmatch('[a-f0-9]{64}', pin['sha256']),
            'input_pin_shape')
    return json_bytes(read_bounded(relative_file(pin['fileName']), maximum,
                                   pin['sha256'], pin['bytes']))


def load_builder():
    for name, expected in HELPERS.items():
        read_bounded(REPO / 'scripts' / name, 128 * 1024, expected)
    name = 'nightstudy_ci_audio_builder'
    file = REPO / 'scripts/learning-senses-audio.py'
    raw = read_bounded(file, 128 * 1024, HELPERS[file.name])
    module = types.ModuleType(name)
    module.__file__ = str(file)
    sys.modules[name] = module
    exec(compile(raw, str(file), 'exec'), module.__dict__)
    return module


def validate_references(refs):
    require(isinstance(refs, list) and 1 <= len(refs) <= 3, 'current_references_bounds')
    keys = set()
    for ref in refs:
        require(isinstance(ref, dict) and len(ref) <= 16
                and isinstance(ref.get('wordId'), str) and 0 < len(ref['wordId']) <= 100
                and re.fullmatch('learning-sense-[a-f0-9]{64}', ref.get('learningSenseId', ''))
                and re.fullmatch('sense-example-[a-f0-9]{64}', ref.get('exampleId', '')),
                'current_reference_identity')
        key = (ref['learningSenseId'], ref['exampleId'])
        require(key not in keys, 'duplicate_current_reference')
        keys.add(key)
    return keys


def validate_raw(tokens, joined, allow_empty):
    require(isinstance(tokens, list) and isinstance(joined, list)
            and 1 <= len(tokens) == len(joined) <= 10, 'frozen_raw_shape')
    for segment, text in zip(tokens, joined):
        require(isinstance(segment, list) and len(segment) <= 8000
                and all(isinstance(token, str) and 1 <= len(token) <= 64
                        and '[' not in token and ']' not in token
                        and not re.search(r'[\x00-\x1f]', token) for token in segment)
                and isinstance(text, str) and len(text) <= 8000
                and ''.join(segment) == text and (allow_empty or bool(text)),
                'frozen_raw_segment')


def validate_controls(value, pronunciation, holds):
    require(isinstance(value, dict) and set(value) == {
        'kind', 'engineVersion', 'voicesManifestSha256', 'publicRootSha256',
        'finalPolicySha256', 'counts', 'groups'} and
        value['kind'] == 'nightstudy-portable-pronunciation-controls-v1'
        and value['engineVersion'] == '1.8.0' and value['voicesManifestSha256'] == VOICES_SHA
        and value['publicRootSha256'] == PUBLIC_ROOT_SHA
        and value['finalPolicySha256'] == FINAL_POLICY_SHA
        and value['counts'] == dict(groups=3643, keys=7286, corrections=1757, holds=79)
        and isinstance(value['groups'], list) and len(value['groups']) == 3643,
        'portable_controls_envelope')
    groups = {}
    corrections = held = 0
    for group in value['groups']:
        require(isinstance(group, dict) and set(group) == {
            'textHash', 'text', 'references', 'rawTokenSegments', 'originalPhonemes', 'accents'}
            and isinstance(group['text'], str) and 15 <= len(group['text']) <= 4000
            and pronunciation.normalize(group['text']) == group['text']
            and sha(group['text']) == group['textHash'] and group['textHash'] not in groups,
            'portable_control_text')
        refs = validate_references(group['references'])
        require(isinstance(group['accents'], dict) and set(group['accents']) == {'US', 'UK'},
                'portable_control_accents')
        both_held = all(isinstance(a, dict) and a.get('state') == 'hold'
                        for a in group['accents'].values())
        if group['rawTokenSegments'] is None or group['originalPhonemes'] is None:
            require(both_held and group['rawTokenSegments'] is None
                    and group['originalPhonemes'] is None, 'missing_nonheld_frozen_raw')
        else:
            validate_raw(group['rawTokenSegments'], group['originalPhonemes'], both_held)
        for accent, control in group['accents'].items():
            require(isinstance(control, dict) and set(control) == {'state', 'correction', 'hold'}
                    and control['state'] in ('reviewed-retain', 'reviewed-correction', 'hold'),
                    'portable_control_decision')
            if control['state'] == 'hold':
                record = holds.validate_hold(control['hold'])
                require(control['correction'] is None, 'held_correction_conflict')
                held += 1
            elif control['state'] == 'reviewed-correction':
                correction = control['correction']
                require(isinstance(correction, dict) and set(correction) == {
                    'record', 'sha256', 'correctedPhonemes'} and
                    pronunciation.validate_review(correction['record']) == correction
                    and correction['record']['originalPhonemes'] == group['originalPhonemes']
                    and control['hold'] is None, 'portable_correction_full_identity')
                record = correction['record']
                corrections += 1
            else:
                require(control['correction'] is None and control['hold'] is None,
                        'retained_control_has_policy')
                continue
            require(record['textHash'] == group['textHash'] and record['text'] == group['text']
                    and record['accent'] == accent
                    and (record['learningSenseId'], record['exampleId']) in refs,
                    'portable_policy_current_reference')
        groups[group['textHash']] = group
    require(corrections == 1757 and held == 79, 'portable_policy_count_closure')
    return groups


def prepare_request(request, controls, pipeline):
    require(isinstance(request, dict) and set(request) == {
        'kind', 'mode', 'packId', 'portableControls', 'voicesManifest', 'publicRootSha256',
        'finalPolicySha256', 'targets', 'holdChecks'}
        and request['kind'] == 'nightstudy-ci-sentence-audio-request-v1'
        and request['mode'] == 'pilot' and request['publicRootSha256'] == PUBLIC_ROOT_SHA
        and request['finalPolicySha256'] == FINAL_POLICY_SHA,
        'pilot_request_envelope')
    require(re.fullmatch('sentence-audio-v4-[0-9]{4}', request['packId'])
            and not request['packId'].endswith('-0000'), 'pilot_pack_id')
    require(isinstance(request['targets'], list) and 1 <= len(request['targets']) <= 8
            and isinstance(request['holdChecks'], list) and 1 <= len(request['holdChecks']) <= 79,
            'pilot_target_bounds')
    pending = {'US': [], 'UK': []}
    identities, denials, seen = [], [], set()
    base_count = corrected_count = 0
    for target in request['targets']:
        require(isinstance(target, dict) and set(target) == {
            'textHash', 'text', 'references', 'accents'}
            and isinstance(target['text'], str) and 15 <= len(target['text']) <= 4000
            and pipeline.normalize(target['text']) == target['text']
            and sha(target['text']) == target['textHash'] and target['textHash'] not in seen,
            'pilot_target_text')
        seen.add(target['textHash'])
        validate_references(target['references'])
        require(target['accents'] in (['US'], ['UK'], ['US', 'UK']), 'pilot_target_accents')
        group = controls.get(target['textHash'])
        if group is not None:
            require(target['text'] == group['text']
                    and canonical(target['references']) == canonical(group['references']),
                    'pilot_target_current_context_changed')
        for accent in target['accents']:
            control = group['accents'][accent] if group else None
            # A request cannot turn a hold into a base key or into a generated clip.
            require(control is None or control['state'] != 'hold', 'held_target_generation_forbidden')
            correction = control['correction'] if control else None
            source = pipeline.pack.load_sources(pipeline.pack.DEFAULT_VOICES_MANIFEST)['voices'][accent]
            base = pipeline.pack.synthesis_identity(target['text'], accent, source)
            identity = pipeline.pronunciation.corrected_cache_identity(base, correction)
            row = {key: target[key] for key in ('textHash', 'text', 'references')}
            row['portableControl'] = group
            if correction:
                row['pronunciationCorrections'] = {accent: correction}
                corrected_count += 1
            if group is None:
                base_count += 1
            pending[accent].append(row)
            identities.append(dict(textHash=target['textHash'], accent=accent,
                baseSynthesisIdentity=base, cacheKey=identity,
                route='frozen-reviewed-raw-per-sentence' if group else 'linux-original-text',
                correctionSha256=correction['sha256'] if correction else None,
                referencesSha256=sha(canonical(target['references']))))
    check_keys = set()
    for check in request['holdChecks']:
        require(isinstance(check, dict) and set(check) == {'textHash', 'accent'}
                and check['accent'] in ('US', 'UK'), 'hold_check_shape')
        key = (check['textHash'], check['accent'])
        require(key not in check_keys, 'duplicate_hold_check')
        check_keys.add(key)
        group = controls.get(check['textHash'])
        require(group is not None and group['accents'][check['accent']]['state'] == 'hold',
                'hold_check_not_active')
        denials.append(dict(textHash=key[0], accent=key[1], decision='hold',
            hold=group['accents'][key[1]]['hold'], modelLoaded=False, mediaGenerated=False))
    require(1 <= sum(map(len, pending.values())) <= 16 and base_count >= 1
            and corrected_count >= 1, 'pilot_requires_base_and_correction_controls')
    return pending, identities, denials


def append_event(path, event):
    raw = (canonical(event) + '\n').encode('utf-8')
    require(len(raw) <= 256 * 1024, 'route_event_bounds')
    with Path(path).open('ab') as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())


def raw_render(voice, text, group, correction, wav_file, report):
    """Use Piper's public raw-block API; retain upstream tokenization evidence.

    The frozen token arrays are never reconstructed with list(joined_text).
    As in corrected_voice, each complete joined segment is passed to the public
    [[...]] parser. Never run the displayed reviewed sentence through Linux G2P.
    """
    rendered = correction['correctedPhonemes'] if correction else group['originalPhonemes']
    validate_raw(group['rawTokenSegments'], group['originalPhonemes'], False)
    require(isinstance(rendered, list) and 1 <= len(rendered) <= 10
            and all(isinstance(s, str) and 1 <= len(s) <= 8000 and '[' not in s
                    and ']' not in s and all(p in voice.config.phoneme_id_map for p in s)
                    for s in rendered), 'unsupported_frozen_raw_render')
    chunks, expected = [], None
    for index, sentence in enumerate(rendered):
        payload = '[[' + sentence + ']]'
        if len(rendered) == 1:
            voice.synthesize_wav(payload, wav_file)
        else:
            buffer = io.BytesIO()
            with wave.open(buffer, 'wb') as sentence_wav:
                voice.synthesize_wav(payload, sentence_wav)
            require(buffer.tell() <= 2 * MIB, 'raw_sentence_wav_limit')
            buffer.seek(0)
            with wave.open(buffer, 'rb') as sentence_wav:
                actual = (sentence_wav.getnchannels(), sentence_wav.getsampwidth(),
                          sentence_wav.getframerate(), sentence_wav.getcomptype())
                require(actual == (1, 2, 22050, 'NONE'), 'raw_sentence_wav_format')
                if expected is None:
                    expected = actual
                require(actual == expected, 'raw_sentence_wav_format_changed')
                frames = sentence_wav.getnframes()
                require(0 < frames <= 30 * 22050, 'raw_sentence_frames_limit')
                pcm = sentence_wav.readframes(frames)
                require(len(pcm) == frames * 2, 'raw_sentence_wav_truncated')
                chunks.append(pcm)
                require(sum(map(len, chunks)) <= 30 * 22050 * 2, 'raw_total_frames_limit')
        report(index, payload)
    if chunks:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(22050)
        for pcm in chunks:
            wav_file.writeframes(pcm)


def portable_worker(accent, rows, output_string, models_string, task_id):
    """One fresh spawned process/model at a time, using the mature small worker."""
    require(platform.system() == 'Linux', 'cloud_linux_worker_required')
    require(all(os.environ.get(name) == '1' for name in THREAD_ENV), 'worker_thread_limits')
    sys.dont_write_bytecode = True
    sys.addaudithook(deny_network)
    builder = load_builder()
    pipeline = builder.pipeline_module()
    by_text = {row['text']: row for row in rows}
    require(len(by_text) == len(rows) <= 8, 'worker_rows_bounds')
    route_file = Path(output_string) / 'routes' / (task_id + '.jsonl')
    require(not route_file.exists(), 'fresh_worker_route_required')

    def selected_voice(voice, text, correction):
        row = by_text.get(text)
        require(row is not None, 'unexpected_worker_sentence')
        group = row['portableControl']
        expected = (group['accents'][accent]['correction'] if group else None)
        require(correction == expected and (group is None or
                group['accents'][accent]['state'] != 'hold'), 'worker_policy_changed')

        class ObservedVoice:
            def synthesize_wav(self, display, wav_file):
                require(display == text, 'displayed_text_changed')
                common = dict(textHash=row['textHash'], accent=accent,
                    displayedTextUnchanged=text, taskId=task_id,
                    workerPid=os.getpid(), workerPgid=os.getpgrp(),
                    referencesSha256=sha(canonical(row['references'])))
                if group is None:
                    actual = voice.phonemize(display)
                    joined = [''.join(segment) for segment in actual]
                    validate_raw(actual, joined, False)
                    # This observes a public precheck, not the engine's internal
                    # second phonemize call. Do not claim raw-route observation.
                    voice.synthesize_wav(display, wav_file)
                    append_event(route_file, dict(common, route='linux-original-text',
                        actualFrontendTokenSegments=actual, actualFrontendPhonemes=joined,
                        frontendPrecheckOnly=True, rawRouteObserved=False,
                        completedPublicCall=True))
                else:
                    rendered = correction['correctedPhonemes'] if correction else group['originalPhonemes']

                    def report(index, payload):
                        append_event(route_file, dict(common,
                            route='frozen-reviewed-raw-per-sentence', sentenceIndex=index,
                            rawPayload=payload, originalTokenSegments=group['rawTokenSegments'],
                            originalPhonemes=group['originalPhonemes'], renderedPhonemes=rendered,
                            correctionSha256=correction['sha256'] if correction else None,
                            correctionId=correction['record']['id'] if correction else None,
                            linuxDisplayedTextPhonemizeCalled=False,
                            frontendPrecheckOnly=False, rawRouteObserved=True,
                            completedPublicCall=True))

                    raw_render(voice, text, group, correction, wav_file, report)

        return ObservedVoice()

    # Reuse the mature cached-model, identity, WAV and MP3 pipeline. Only the
    # public voice adapter changes; the ONNX/model/config implementations do not.
    pipeline.pronunciation.corrected_voice = selected_voice
    return pipeline.worker(accent, rows, output_string, models_string, task_id)


def file_pin(path, base):
    return dict(fileName=Path(path).relative_to(base).as_posix(),
                bytes=Path(path).stat().st_size, sha256=digest(path))


def write_new(path, value):
    with Path(path).open('x', encoding='utf-8') as handle:
        handle.write(canonical(value) + '\n')
        handle.flush()
        os.fsync(handle.fileno())


def deny_network(event, args):
    if event.startswith('socket.'):
        raise ValueError('offline_ci_worker_network_denied')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True, type=Path)
    parser.add_argument('--request-sha256', required=True)
    parser.add_argument('--models', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--ffmpeg', required=True, type=Path)
    args = parser.parse_args()
    require(platform.system() == 'Linux' and os.environ.get('GITHUB_ACTIONS') == 'true',
            'github_linux_only_no_local_model_launch')
    require(re.fullmatch('[a-f0-9]{64}', args.request_sha256), 'explicit_request_pin_required')
    sys.dont_write_bytecode = True
    for name in THREAD_ENV:
        os.environ[name] = '1'
    sys.addaudithook(deny_network)
    raw = read_bounded(args.request, 256 * 1024, args.request_sha256)
    request = json_bytes(raw)
    builder = load_builder()
    pipeline = builder.pipeline_module()
    voices = pin_value(request.get('voicesManifest'), 64 * 1024)
    require(request['voicesManifest']['fileName'] == 'data/audio-voices.manifest.json'
            and request['voicesManifest']['sha256'] == VOICES_SHA
            and voices == pipeline.pack.load_sources(pipeline.pack.DEFAULT_VOICES_MANIFEST),
            'unchanged_voices_manifest_required')
    controls = validate_controls(pin_value(request.get('portableControls'), 64 * MIB),
                                 pipeline.pronunciation, builder.publication_holds_module())
    pending, identities, denials = prepare_request(request, controls, pipeline)
    del controls
    models = args.models.absolute()
    require(models == models.resolve(strict=True) and models.is_dir(), 'real_cached_model_directory')
    for source in voices['voices'].values():
        for kind in ('model', 'config'):
            item = source[kind]
            file = models / item['fileName']
            require(not file.is_symlink() and file.is_file() and
                    file.stat().st_size == item['sizeBytes'] and digest(file) == item['sha256'],
                    'existing_cached_model_pin:' + item['fileName'])
        config = json_bytes(read_bounded(models / source['config']['fileName'], 16 * 1024))
        require(config['espeak']['voice'] == 'en', 'original_model_frontend_config_required')
    ffmpeg = args.ffmpeg.absolute()
    require(ffmpeg.is_file() and not ffmpeg.is_symlink(), 'real_ffmpeg_required')
    os.environ['NIGHTSTUDY_BUILD_FFMPEG'] = str(ffmpeg)
    output = args.output.absolute()
    require(not output.exists() and not output.is_symlink()
            and output.parent.resolve(strict=True) == output.parent, 'fresh_real_output_directory')
    output.mkdir(mode=0o700)
    for name in ('files', 'progress', 'routes'):
        (output / name).mkdir()
    write_new(output / 'request.json', request)
    write_new(output / 'expected-identities.json', identities)
    write_new(output / 'held-denials.json', denials)
    tasks = builder.bounded_worker_tasks(pending, 8)
    execution = builder.worker_execution_metadata(tasks, 8, 1)
    start = time.monotonic()
    write_new(output / 'build-start.json', dict(kind='nightstudy-ci-audio-start-v1',
        requestSha256=args.request_sha256, parentPid=os.getpid(), parentPgid=os.getpgrp(),
        buildExecution=execution, threadsPerVoice=1, modelsDownloaded=False,
        heldDenialCount=len(denials), publicationAuthorized=False))
    entries = builder.execute_worker_tasks(tasks, output, models, 1, worker_fn=portable_worker)
    expected = {(i['textHash'], i['accent']): i for i in identities}
    require(len(entries) == len(expected) and
            {(e['textHash'], e['accent']) for e in entries} == set(expected), 'generated_pair_closure')
    for entry in entries:
        target = expected[(entry['textHash'], entry['accent'])]
        require(entry['cacheKey'] == target['cacheKey'] and entry['mimeType'] == 'audio/mpeg'
                and entry['inferenceBackend'] == 'CPUExecutionProvider'
                and pipeline.pack.validate_entry(entry, output, target['cacheKey']),
                'generated_identity_or_artifact_changed')
    for name, expected_sha in HELPERS.items():
        read_bounded(REPO / 'scripts' / name, 128 * 1024, expected_sha)
    write_new(output / 'sources.manifest.json', dict(schemaVersion=2,
        version=request['packId'], meaningPackId='learning-senses-collection-v2',
        meaningPackSha256=PUBLIC_ROOT_SHA, meaningPackIdentityKind='collection-manifest-sha256',
        engineSource=voices, portableControls=request['portableControls'],
        finalPolicySha256=FINAL_POLICY_SHA, requestedSentences=request['targets'],
        baselinePacks=[], reusedMediaReferences=[], buildRuntime=builder.build_runtime(),
        buildExecution=execution, frozenRetainedRawUsesBaseIdentity=True,
        publicationAuthorized=False, helperSha256=HELPERS,
        transcodingTool=pipeline.codec.build_tool_identity(),
        acousticQualityPolicy=pipeline.codec.QUALITY_POLICY))
    write_new(output / 'manifest.json', dict(schemaVersion=2, version=request['packId'],
        status='ready', sourceManifestSha256=digest(output / 'sources.manifest.json'),
        statistics=dict(lemmaCount=len(request['targets']), entryCount=len(entries),
                        recordedCount=0, synthesizedCount=len(entries), failedCount=0),
        entries=sorted(entries, key=lambda e: (e['textHash'], e['accent']))))
    artifacts = sorted([output / 'request.json', output / 'expected-identities.json',
        output / 'held-denials.json', output / 'build-start.json',
        output / 'sources.manifest.json', output / 'manifest.json',
        *(output / 'routes').glob('*.jsonl'), *(output / 'files').glob('*')])
    write_new(output / 'build-receipt.json', dict(kind='nightstudy-ci-audio-generated-v1',
        state='GENERATED_REQUIRES_INDEPENDENT_CHECK', requestSha256=args.request_sha256,
        workerSourceSha256=digest(Path(__file__)), elapsedSeconds=round(time.monotonic()-start, 6),
        publicRootSha256=PUBLIC_ROOT_SHA, finalPolicySha256=FINAL_POLICY_SHA,
        generatedPairs=len(entries), holdDenials=len(denials),
        files=[file_pin(file, output) for file in artifacts],
        independentFullDecodePassed=False, publicationAuthorized=False))


if __name__ == '__main__':
    main()
