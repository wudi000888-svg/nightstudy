#!/usr/bin/env python3
"""Observe one exact unresolved sentence with the original Linux eSpeak frontend.

This is not a pronunciation approval or an audio generator. Both regional
decisions remain null. It never rewrites the frozen correction/hold controls.
The already downloaded model directory supplies only the two JSON configs;
model weights are neither read nor loaded. No network or child process is used.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.metadata
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import re
import stat
import sys
import time
import unicodedata

ROOT = Path(__file__).resolve().parent.parent
MIB = 1024 * 1024
TEXT = 'The critic contrasts genuine curiosity with a sordid hunger for profit.'
TEXT_SHA = '00022a53ae06cabc23f1c80195da75d98f14395ed24c901dfbbbb4995119a226'
ROOT_SHA = '0ae4679da6df6459cb2cfe21867942bb8eaa4ae9828def149f08816c42f4ef1b'
VOICES_SHA = '3dafe3867fc2005ce1cf0be24485e771671121f4cca185521b17b8d381e7489f'
FINAL_POLICY_SHA = 'eaaf987f693cfad6a6a3cb5768b8ef855a1f0300d4c06257bf8683ecf86f69dd'
PACK_SHA = '2727eba2fda579f0eea898b122e1963f09b690bea99fa6298f9b21d46cf0b727'
CLASS_SOURCE_SHA = 'd5ff275d847502345821898efa15e3e4e956fe884cea7c78ae87102d539e6594'
EXPECTED_ANCHOR = (
    '631712aebc2abdbbb2f8e3852c7b01f189ac599f3498f4f0c2b3802093daff62',
    'learning-sense-de06914135785df9efcfdd09a60b8b4b230b9887065a43c10f154b84ad223c74',
    'sense-example-5dee5eb8ad170b13265895e615aad3c61a52dfd91224a159e11fd640a115af58')
PUBLIC_CONTEXT_SHA = '0284756bbc8d34805512257a41b8782be8ac8654e1b95b4dcbb803354ed5e230'
CONFIG_PINS = {
    'US': (4970, '7e1f4634af596d83cca997fb7a931ba80b70f8a316a2655ee69c55365e0ace14'),
    'UK': (4963, '9e7fb5b5671612c22f3c81cbe46c1ae87b031a4632bcb509e499dad6f1e2adec'),
}
START = time.monotonic()
ATTEMPTS = dict(networkOrChild=0, modelWeightOpen=0, inferenceSession=0)


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def boundary():
    require(time.monotonic() - START < 75, 'observation_internal_deadline')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha(value):
    return hashlib.sha256(value.encode('utf-8') if isinstance(value, str) else value).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate_json_key')
        result[key] = value
    return result


def decode(raw):
    return json.loads(raw, object_pairs_hook=unique_object,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError('nonfinite_json')))


def read_bounded(path, cap, digest=None, size=None):
    boundary()
    path = Path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= cap
                and (size is None or before.st_size == size), 'bounded_input:' + path.name)
        with os.fdopen(fd, 'rb', closefd=False) as handle:
            raw = handle.read(cap + 1)
        after = os.fstat(fd)
        now = path.stat(follow_symlinks=False)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(identity(before) == identity(after) == identity(now)
                and len(raw) == before.st_size and (digest is None or sha(raw) == digest),
                'input_identity:' + path.name)
        return raw
    finally:
        os.close(fd)


def public_file(name):
    require(isinstance(name, str) and re.fullmatch('[a-z0-9.-]+', name)
            and name not in ('.', '..'), 'public_leaf_name')
    path = ROOT / 'data' / name
    require(not path.is_symlink() and path.resolve(strict=True).parent == ROOT / 'data',
            'public_leaf_path')
    return path


def public_body(word, sense, example):
    return dict(word={key: word[key] for key in ('wordId', 'normalizedLemma')},
                sense={key: value for key, value in sense.items() if key != 'examples'},
                example=example)


def normalize_text(value):
    # Exact sentence-pronunciation.py normalize contract; do not lowercase.
    require(isinstance(value, str), 'public_example_text_type')
    value = unicodedata.normalize('NFKC', value).translate(
        str.maketrans({'‘': "'", '’': "'", '“': '"', '”': '"'}))
    return re.sub(r'\s+', ' ', value).strip()


def complete_public_contexts():
    """Stream the fixed 95 leaves, retaining every reference of this one text."""
    root = decode(read_bounded(public_file('learning-senses-collection-v2.manifest.json'),
                               64 * 1024, ROOT_SHA))
    require(root['formatVersion'] == 2 and root['id'] == 'learning-senses-collection-v2'
            and len(root['shards']) == 95, 'fixed_public_collection')
    contexts = []
    totals = dict(words=0, senses=0, examples=0)
    for index, shard in enumerate(root['shards']):
        boundary()
        leaf = decode(read_bounded(public_file(shard['manifestFileName']),
                                   64 * 1024, shard['sha256'], shard['bytes']))
        require(leaf['id'] == shard['id'] and 1 <= leaf['wordCount'] <= 200
                and 0 < leaf['bytes'] <= 8 * MIB, 'bounded_public_leaf')
        compressed = read_bounded(public_file(leaf['fileName']), 8 * MIB,
                                  leaf['sha256'], leaf['bytes'])
        decoded_hash = hashlib.sha256()
        decoded_bytes = 0
        counts = dict(words=0, senses=0, examples=0)
        with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode='rb') as handle:
            while True:
                boundary()
                raw = handle.readline(2 * MIB + 1)
                if not raw:
                    break
                decoded_bytes += len(raw)
                require(len(raw) <= 2 * MIB and raw.endswith(b'\n') and decoded_bytes <= 16 * MIB,
                        'public_decoded_bounds')
                decoded_hash.update(raw)
                word = decode(raw)
                require(set(word) == {'wordId', 'normalizedLemma', 'senses'}
                        and isinstance(word['senses'], list) and 1 <= len(word['senses']) <= 512,
                        'public_word_shape')
                counts['words'] += 1
                require(counts['words'] <= 200, 'public_word_count_bound')
                for sense in word['senses']:
                    counts['senses'] += 1
                    require(sense['wordId'] == word['wordId']
                            and isinstance(sense['examples'], list)
                            and 1 <= len(sense['examples']) <= 20, 'public_sense_hierarchy')
                    for example in sense['examples']:
                        counts['examples'] += 1
                        require(example['wordId'] == word['wordId']
                                and example['learningSenseId'] == sense['id'], 'public_example_hierarchy')
                        if normalize_text(example['exampleEn']) != TEXT:
                            continue
                        body = public_body(word, sense, example)
                        ref = dict(wordId=word['wordId'], learningSenseId=sense['id'],
                            exampleId=example['id'], contentVersion=sense['contentVersion'],
                            bindingHash=sense['bindingHash'], leafIndex=index,
                            leafManifestSha256=shard['sha256'], payloadSha256=leaf['sha256'],
                            publicContextSha256=sha(canonical(body)),
                            sourceBindingsSha256=sha(canonical(sense['sourceBindings'])))
                        contexts.append(dict(reference=ref, publicContext=body))
                        require(len(contexts) <= 3, 'single_text_all_refs_bound')
        require(decoded_hash.hexdigest() == leaf['jsonlSha256'], 'public_jsonl_sha')
        for key, source in (('words', 'wordCount'), ('senses', 'senseCount'), ('examples', 'exampleCount')):
            require(counts[key] == leaf[source] == shard[source], 'public_leaf_counts')
            totals[key] += counts[key]
    require(totals == dict(words=18767, senses=49992, examples=99984) and contexts,
            'complete_public_reference_scan')
    contexts.sort(key=lambda c: (c['reference']['learningSenseId'], c['reference']['exampleId']))
    anchors = [(c['reference']['wordId'], c['reference']['learningSenseId'],
                c['reference']['exampleId']) for c in contexts]
    require(len(set(anchors)) == len(anchors) and EXPECTED_ANCHOR in anchors,
            'complete_public_anchors')
    expected = contexts[anchors.index(EXPECTED_ANCHOR)]
    require(expected['reference']['publicContextSha256'] == PUBLIC_CONTEXT_SHA,
            'explicit_current_public_context_changed')
    return contexts, totals


def deny_external_work(event, args):
    if event.startswith(('socket.', 'http.client.', 'subprocess.', 'os.exec', 'os.spawn')) or event in (
            'urllib.Request', 'os.system', 'os.fork', 'os.posix_spawn'):
        ATTEMPTS['networkOrChild'] += 1
        raise PermissionError('frontend_observer_network_or_child_forbidden')
    if event == 'open' and args and isinstance(args[0], (str, bytes, os.PathLike)):
        name = os.fsdecode(args[0]).lower()
        if name.endswith(('.onnx', '.onnx.data', '.pt', '.pth', '.safetensors', '.gguf', '.bin')):
            ATTEMPTS['modelWeightOpen'] += 1
            raise PermissionError('frontend_observer_model_weight_open_forbidden')


def forbidden_session(*args, **kwargs):
    ATTEMPTS['inferenceSession'] += 1
    raise PermissionError('frontend_observer_inference_session_forbidden')


def observe():
    require(importlib.metadata.version('piper-tts') == '1.8.0', 'pinned_piper_version')
    # Importing the Linux library is allowed. Constructing an inference session
    # is not: patch public and already loaded CAPI constructors before Piper's
    # package initializer can import its voice module.
    import onnxruntime as ort
    ort.InferenceSession = forbidden_session
    patched = ['onnxruntime.InferenceSession']
    for module_name in ('onnxruntime.capi.onnxruntime_inference_collection',
                        'onnxruntime.capi._pybind_state',
                        'onnxruntime.capi.onnxruntime_pybind11_state'):
        module = sys.modules.get(module_name)
        if module is not None and hasattr(module, 'InferenceSession'):
            module.InferenceSession = forbidden_session
            patched.append(module_name + '.InferenceSession')
    require(len(patched) >= 3, 'inference_constructor_guards_missing')
    distribution = importlib.metadata.distribution('piper-tts')
    class_path = Path(distribution.locate_file('piper/phonemize_espeak.py'))
    read_bounded(class_path, 64 * 1024, CLASS_SOURCE_SHA)
    pack_path = ROOT / 'scripts/audio-pack.py'
    read_bounded(pack_path, 128 * 1024, PACK_SHA)
    spec = importlib.util.spec_from_file_location('nightstudy_frontend_only_audio_pack', pack_path)
    pack = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pack)
    require(pack.ENGINE_VERSION == '1.8.0', 'original_pack_engine')
    phonemizer = pack.make_phonemizer()
    require(type(phonemizer).__name__ == 'EspeakPhonemizer'
            and type(phonemizer).__module__ == 'piper.phonemize_espeak', 'public_phonemizer_class')
    # Both actual voice configs require exactly 'en'; do not switch accents to
    # en-us/en-gb-x-rp or use algorithmic_phonetic's word-IPA transformation.
    raw = phonemizer.phonemize('en', TEXT)
    require(isinstance(raw, list) and 1 <= len(raw) <= 10, 'actual_raw_segment_bounds')
    for segment in raw:
        require(isinstance(segment, list) and len(segment) <= 8000
                and all(isinstance(token, str) and 1 <= len(token) <= 64 for token in segment),
                'actual_raw_token_bounds')
    joined = [''.join(segment) for segment in raw]
    require(all(len(segment) <= 8000 for segment in joined), 'actual_joined_bounds')
    require(ATTEMPTS == dict(networkOrChild=0, modelWeightOpen=0, inferenceSession=0),
            'frontend_observation_forbidden_attempt')
    return raw, joined, patched


def write_new(path, value):
    path = path.absolute()
    require(path.parent.resolve(strict=True) == path.parent and not path.is_symlink(),
            'real_output_parent')
    raw = (canonical(value) + '\n').encode('utf-8')
    require(len(raw) <= 128 * 1024, 'observation_output_bounds')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', type=Path, required=True,
                        help='Existing four-file download directory; only configs are opened')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    require(platform.system() == 'Linux' and os.environ.get('GITHUB_ACTIONS') == 'true',
            'github_linux_only_no_local_frontend_launch')
    require(sha(TEXT) == TEXT_SHA, 'fixed_exact_sentence_identity')
    sys.dont_write_bytecode = True
    for name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS',
                 'NUMEXPR_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS'):
        os.environ[name] = '1'
    sys.addaudithook(deny_external_work)
    directory = args.models.absolute()
    require(directory == directory.resolve(strict=True) and directory.is_dir(), 'real_config_directory')
    voices = decode(read_bounded(public_file('audio-voices.manifest.json'), 64 * 1024, VOICES_SHA))
    require(voices['engine']['version'] == '1.8.0' and set(voices['voices']) == {'US', 'UK'},
            'fixed_voices_engine')
    configs = {}
    for accent in ('US', 'UK'):
        source = voices['voices'][accent]
        item = source['config']
        size, config_sha = CONFIG_PINS[accent]
        require(Path(item['fileName']).name == item['fileName']
                and item['sizeBytes'] == size and item['sha256'] == config_sha,
                'exact_original_config_pin')
        raw_config = read_bounded(directory / item['fileName'], 16 * 1024, config_sha, size)
        config = decode(raw_config)
        require(config['espeak']['voice'] == 'en', 'unchanged_shared_frontend_voice')
        configs[accent] = dict(fileName=item['fileName'], bytes=size, sha256=config_sha,
                              espeakVoice='en', modelSha256=source['model']['sha256'])
    contexts, totals = complete_public_contexts()
    raw, joined, patched = observe()
    boundary()
    write_new(args.output, dict(kind='nightstudy-ci-sentence-frontend-observation-v1',
        state='OBSERVED_REQUIRES_EXPLICIT_REGIONAL_HUMAN_REVIEW', textHash=TEXT_SHA, text=TEXT,
        publicRootSha256=ROOT_SHA, voicesManifestSha256=VOICES_SHA,
        unchangedFinalPolicySha256=FINAL_POLICY_SHA,
        references=[context['reference'] for context in contexts], publicContexts=contexts,
        publicCountsVerified=totals, allCurrentPublicReferencesVerified=True,
        engineVersion='1.8.0', publicClass='piper.phonemize_espeak.EspeakPhonemizer',
        classSourceSha256=CLASS_SOURCE_SHA, audioPackSourceSha256=PACK_SHA,
        observerSourceSha256=sha(read_bounded(Path(__file__), 128 * 1024)),
        configs=configs, requestedAccents=['US', 'UK'], actualSharedEspeakVoice='en',
        frontendCalls=1, rawTokenSegments=raw, originalPhonemes=joined,
        rawTokenSegmentsSha256=sha(canonical(raw)), originalPhonemesSha256=sha(canonical(joined)),
        emptySegmentIndexes=[i for i, segment in enumerate(raw) if not segment],
        regionalDecisions=dict(US=None, UK=None), literalCorrections=[],
        inferenceSessionGuardedApis=patched, forbiddenAttemptCounts=ATTEMPTS,
        noInferenceSessionConstructed=True, modelWeightsOpened=False, networkUsed=False,
        childProcessStarted=False, mediaGenerated=False, synthesisApproved=False,
        policiesModified=False, cacheReuseAuthorized=False, publicationAuthorized=False,
        elapsedSeconds=round(time.monotonic() - START, 6)))


if __name__ == '__main__':
    main()
