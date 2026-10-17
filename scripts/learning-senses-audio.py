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
import importlib.metadata
import json
import multiprocessing
import os
import platform
from pathlib import Path
import re
import shutil
import sys
import tarfile
import tempfile

REPO = Path(__file__).resolve().parent.parent
VERSION = 'sentence-audio-v3'
COLLECTION_MAX_DECODED_BYTES = 512 * 1024 * 1024
MAX_DELTA_SENTENCES = 10000
MAX_DELTA_CLIPS = 20000
WORKER_EXECUTION_POLICY = 'bounded-spawn-tasks-v1'
DEFAULT_WORKER_BATCH_SIZE = 128
BASELINE_PINS = {'sentence-audio-v1': 'sentence-audio.manifest.json',
                 'sentence-audio-v2': 'sentence-audio-v2.manifest.json',
                 'sentence-audio-v3': 'sentence-audio-v3.manifest.json'}


def pack_id(value):
    if value == VERSION or value == 'sentence-audio-v4':
        return value
    if re.fullmatch(r'sentence-audio-v4-[0-9]{4}', value) and not value.endswith('-0000'):
        return value
    raise argparse.ArgumentTypeError('Use a fixed sentence-audio-v3/v4 or sentence-audio-v4-0001..9999 ID')


def worker_batch_size(value):
    try:
        size = int(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError('worker batch size must be an integer from 1 to 512') from None
    if not 1 <= size <= 512:
        raise argparse.ArgumentTypeError('worker batch size must be an integer from 1 to 512')
    return size


def bounded_worker_tasks(pending_by_accent, batch_size):
    """Partition each accent once; IDs do not depend on worker concurrency.

    The full ordered-text digest prevents unrelated chunks from sharing a
    journal filename. Existing journals remain separate, identity-checked
    cache inputs; they are never copied or concatenated into a new journal.
    """
    if isinstance(batch_size, bool) or not isinstance(batch_size, int) or not 1 <= batch_size <= 512:
        raise ValueError('invalid_worker_batch_size')
    if set(pending_by_accent) != {'US', 'UK'}:
        raise ValueError('invalid_worker_accents')
    tasks = []
    for accent in ('US', 'UK'):
        ordered = sorted(pending_by_accent[accent], key=lambda row: row['textHash'])
        if len({row['textHash'] for row in ordered}) != len(ordered):
            raise ValueError('duplicate_worker_text_hash')
        for ordinal, start in enumerate(range(0, len(ordered), batch_size)):
            rows = ordered[start:start+batch_size]
            identity = json.dumps({'policy': WORKER_EXECUTION_POLICY, 'accent': accent,
                                   'textHashes': [row['textHash'] for row in rows]},
                                  sort_keys=True, separators=(',', ':')).encode()
            task_id = f'bounded-v1-{accent}-{ordinal:06d}-{hashlib.sha256(identity).hexdigest()}'
            tasks.append({'id': task_id, 'accent': accent, 'rows': rows})
    return tasks


def worker_execution_metadata(tasks, batch_size, workers):
    return {'policy': WORKER_EXECUTION_POLICY, 'workerBatchSize': batch_size,
            'maxTasksPerChild': 1, 'maxWorkers': workers,
            'maximumInFlightTasks': min(workers, len(tasks)),
            'poolLifecycle': 'new-spawn-pool-per-wave; join-before-next-wave',
            'taskOrder': 'US-then-UK-textHash-contiguous-v1',
            'taskIdentity': 'sha256-of-policy-accent-ordered-textHashes-v1',
            'taskCount': len(tasks), 'tasks': [
                {'id': task['id'], 'accent': task['accent'], 'sentenceCount': len(task['rows'])}
                for task in tasks]}


def execute_worker_tasks(tasks, output, models, workers, worker_fn=None):
    """At most one in-flight task per worker, each in a fresh spawned process.

    A wave is fully collected and its pool joined before another is submitted.
    This avoids relying on persistent-pool worker replacement across many
    waves, which older Python versions can mishandle. In particular,
    workers=1 never queues a second inference task alongside the current one.
    If a result fails, later waves are not submitted. Executor teardown joins
    only the processes created by this pool.
    """
    if workers not in (1, 2, 4, 6, 8):
        raise ValueError('invalid_audio_worker_count')
    if not tasks:
        return []
    run_worker = worker_fn or worker
    entries = []
    for start in range(0, len(tasks), workers):
        wave = tasks[start:start+workers]
        with concurrent.futures.ProcessPoolExecutor(
                max_workers=len(wave), mp_context=multiprocessing.get_context('spawn'),
                max_tasks_per_child=1) as pool:
            futures = [pool.submit(run_worker, task['accent'], task['rows'],
                                   str(output), str(models), task['id']) for task in wave]
            for future in futures:
                entries.extend(future.result())
    return entries


def write_build_json(module, file, value, immutable=False):
    if immutable and file.exists():
        raw = (json.dumps(value, ensure_ascii=False, separators=(',', ':'))+'\n').encode()
        if file.is_symlink() or file.read_bytes() != raw:
            raise ValueError('immutable_audio_json_conflict')
        return
    module.pack.atomic_json(file, value)


def build_archive(files, output, archive_file, immutable=False):
    temporary = None
    if immutable:
        with tempfile.NamedTemporaryFile(dir=archive_file.parent, prefix='.audio-shard-', suffix='.tar.gz', delete=False) as handle:
            temporary = Path(handle.name)
    try:
        with (temporary or archive_file).open('wb') as target:
            with gzip.GzipFile(filename='', fileobj=target, mode='wb', mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.USTAR_FORMAT) as archive:
                    for file in files:
                        info = archive.gettarinfo(str(file), arcname=file.relative_to(output).as_posix())
                        info.mtime = 0; info.uid = info.gid = 0; info.uname = info.gname = ''; info.mode = 0o644
                        with file.open('rb') as handle:
                            archive.addfile(info, handle)
        if immutable:
            if temporary.stat().st_size > 2*1024**3:
                raise ValueError('incremental_audio_archive_exceeds_installer_limit')
            if archive_file.exists():
                if archive_file.is_symlink() or digest(archive_file) != digest(temporary):
                    raise ValueError('immutable_audio_archive_conflict')
            else:
                os.replace(temporary, archive_file)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


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


def pronunciation_module():
    spec = importlib.util.spec_from_file_location('meaning_sentence_pronunciation', Path(__file__).with_name('sentence-pronunciation.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def publication_holds_module():
    spec = importlib.util.spec_from_file_location('meaning_sentence_audio_holds', Path(__file__).with_name('sentence-audio-holds.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def build_runtime():
    packages = {}
    for name in ('piper-tts', 'onnxruntime', 'numpy'):
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            packages[name] = None
    return {'pythonVersion': platform.python_version(), 'packages': packages}


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


def pinned_bytes(file, maximum):
    if file.is_symlink() or not file.is_file() or file.stat().st_size > maximum:
        raise ValueError('unsafe_or_oversized_meaning_file')
    return file.read_bytes()


def leaf_words(manifest_file, manifest, content_file=None, budget=None):
    if content_file is None:
        name = manifest.get('fileName', '')
        if not re.fullmatch(r'[a-z0-9.-]+\.jsonl\.gz', name) or Path(name).name != name:
            raise ValueError('invalid_meaning_content_filename')
        content_file = manifest_file.parent/name
    if content_file.is_symlink() or content_file.stat().st_size != manifest['bytes'] or digest(content_file) != manifest['sha256']:
        raise ValueError('meaning_content_pin_mismatch')
    with gzip.open(content_file, 'rb') as compressed:
        raw = compressed.read(64*1024*1024+1)
    if len(raw) > 64*1024*1024:
        raise ValueError('meaning_content_expanded_limit')
    if budget is not None:
        budget[0] -= len(raw)
        if budget[0] < 0:
            raise ValueError('meaning_collection_expanded_limit')
    if hashlib.sha256(raw).hexdigest() != manifest['jsonlSha256']:
        raise ValueError('meaning_content_jsonl_mismatch')
    words = [json.loads(line) for line in raw.decode('utf-8').splitlines()]
    new_source_bindings = {}
    for word in words:
        for sense in word['senses']:
            for binding in sense.get('sourceBindings', []):
                if binding['sourceSenseId'].startswith('learning-source-'):
                    new_source_bindings.setdefault(binding['sourceSenseId'], []).append(binding)
    if new_source_bindings and not manifest.get('sourceAdditions'):
        raise ValueError('meaning_source_additions_pin_required')
    if manifest.get('sourceAdditions') is not None:
        pin = manifest['sourceAdditions']
        if (not isinstance(pin, dict) or set(pin) != {'fileName', 'bytes', 'sha256', 'jsonlSha256', 'rowCount'}
            or not isinstance(pin['fileName'], str)
            or not re.fullmatch(r'learning-sense-sources-[a-z0-9.-]+\.jsonl\.gz', pin['fileName'])
            or type(pin['rowCount']) is not int or not 1 <= pin['rowCount'] <= 1000
            or type(pin['bytes']) is not int or not 0 < pin['bytes'] <= 64*1024*1024):
            raise ValueError('meaning_source_additions_pin_invalid')
        source_file = manifest_file.parent/pin['fileName']
        packed = pinned_bytes(source_file, 64*1024*1024)
        if len(packed) != pin['bytes'] or hashlib.sha256(packed).hexdigest() != pin['sha256']:
            raise ValueError('meaning_source_additions_pin_mismatch')
        with gzip.open(source_file, 'rb') as compressed:
            source_raw = compressed.read(64*1024*1024+1)
        if len(source_raw)+len(raw) > 64*1024*1024:
            raise ValueError('meaning_source_additions_expanded_limit')
        if budget is not None:
            budget[0] -= len(source_raw)
            if budget[0] < 0:
                raise ValueError('meaning_collection_expanded_limit')
        if hashlib.sha256(source_raw).hexdigest() != pin['jsonlSha256']:
            raise ValueError('meaning_source_additions_jsonl_mismatch')
        sources = [json.loads(line) for line in source_raw.decode('utf-8').splitlines()]
        if (len(sources) != pin['rowCount'] or len({row['id'] for row in sources}) != len(sources)
            or {row['id'] for row in sources} != set(new_source_bindings)):
            raise ValueError('meaning_source_additions_count_or_identity')
        spec = importlib.util.spec_from_file_location('audio_original_source_validator', REPO/'scripts/learning-senses-compile.py')
        compiler = importlib.util.module_from_spec(spec); spec.loader.exec_module(compiler)
        active = {word['normalizedLemma']: {'id': word['wordId'], 'normalizedLemma': word['normalizedLemma']}
                  for word in words}
        for source in sources:
            compiler.validate_source_addition(source, active)
            bindings = new_source_bindings[source['id']]
            if not bindings or any(binding['wordId'] != source['wordId']
                or binding['sourcePosSha256'] != compiler.sha(source['pos'])
                or binding['sourceDefinitionZhSha256'] != compiler.sha(source['definitionZh'])
                or binding['sourceDefinitionEnSha256'] != compiler.sha(source['definitionEn']) for binding in bindings):
                raise ValueError('meaning_source_additions_binding_mismatch')
    notices = []
    for notice in manifest.get('licenseNotices', []):
        name = notice['fileName']
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', name) or Path(name).name != name:
            raise ValueError('invalid_meaning_license_filename')
        file = manifest_file.parent/name
        raw_notice = pinned_bytes(file, 128*1024)
        if len(raw_notice) != notice['bytes'] or hashlib.sha256(raw_notice).hexdigest() != notice['sha256']:
            raise ValueError('meaning_license_pin_mismatch')
        notices.append({**notice, 'path': file})
    return words, notices


def content_words(manifest_file, content_file=None):
    manifest = json.loads(pinned_bytes(manifest_file, 1024*1024))
    if manifest.get('formatVersion') != 2:
        words, notices = leaf_words(manifest_file, manifest, content_file)
        if notices:
            manifest['_audioLicenseNotices'] = notices
        return manifest, words
    if (manifest.get('kind') != 'learning-senses-collection' or content_file is not None
        or not isinstance(manifest.get('shards'), list) or not 1 <= len(manifest['shards']) <= 1000):
        raise ValueError('invalid_meaning_collection')
    if (not isinstance(manifest.get('requiredWordCount'), int)
        or not 1 <= manifest['requiredWordCount'] <= 100000
        or manifest['wordCount'] != manifest['requiredWordCount']
        or any(sum(pin[key] for pin in manifest['shards']) != manifest[key]
               for key in ('wordCount', 'senseCount', 'exampleCount'))):
        raise ValueError('meaning_collection_pin_totals_mismatch')
    words, notices = [], []
    budget = [COLLECTION_MAX_DECODED_BYTES]
    filenames, pack_ids, word_ids, lemmas, identities = set(), set(), set(), set(), set()
    senses = examples = 0
    for pin in manifest['shards']:
        name = pin['manifestFileName']
        if not re.fullmatch(r'learning-senses-[a-z0-9.-]+\.manifest\.json', name) or Path(name).name != name:
            raise ValueError('invalid_meaning_shard_filename')
        if name in filenames or pin['id'] in pack_ids:
            raise ValueError('duplicate_meaning_shard')
        filenames.add(name); pack_ids.add(pin['id'])
        shard_file = manifest_file.parent/name
        raw = pinned_bytes(shard_file, 1024*1024)
        if len(raw) != pin['bytes'] or hashlib.sha256(raw).hexdigest() != pin['sha256']:
            raise ValueError('meaning_shard_manifest_pin_mismatch')
        shard = json.loads(raw)
        if (shard.get('formatVersion') != 1 or shard['id'] != pin['id']
            or any(shard[key] != pin[key] for key in ('wordCount', 'senseCount', 'exampleCount'))
            or any(shard[key] != manifest[key] for key in ('sourceExportSha256', 'bilingualOverlaySha256'))):
            raise ValueError('meaning_shard_scope_mismatch')
        rows, leaf_notices = leaf_words(shard_file, shard, budget=budget)
        shard_senses = sum(len(word['senses']) for word in rows)
        shard_examples = sum(len(sense['examples']) for word in rows for sense in word['senses'])
        if (len(rows) != shard['wordCount'] or not 1 <= len(rows) <= 1000
            or shard_senses != shard['senseCount'] or shard_examples != shard['exampleCount']):
            raise ValueError('meaning_shard_statistics_mismatch')
        senses += shard_senses; examples += shard_examples; notices.extend(leaf_notices)
        for word in rows:
            if word['wordId'] in word_ids or word['normalizedLemma'] in lemmas:
                raise ValueError('meaning_word_crosses_shards')
            word_ids.add(word['wordId']); lemmas.add(word['normalizedLemma']); words.append(word)
            for sense in word['senses']:
                for record in [sense, *sense['sourceBindings'], *sense['examples']]:
                    if record['id'] in identities:
                        raise ValueError('meaning_global_duplicate_identity')
                    identities.add(record['id'])
    union = sorted([{'wordId': word['wordId'], 'normalizedLemma': word['normalizedLemma']} for word in words],
                   key=lambda word: (word['wordId'], word['normalizedLemma']))
    union_sha = hashlib.sha256(json.dumps(union, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    if (len(words) != manifest['wordCount'] or len(words) != manifest['requiredWordCount']
        or senses != manifest['senseCount'] or examples != manifest['exampleCount']
        or union_sha != manifest['requiredWordsSha256']):
        raise ValueError('meaning_collection_union_mismatch')
    # Leaf sha256 identifies compressed content; collections instead bind the
    # exact root manifest bytes, which recursively pin every leaf and payload.
    manifest['sha256'] = digest(manifest_file)
    manifest['_audioIdentityKind'] = 'collection-manifest-sha256'
    manifest['_audioLicenseNotices'] = notices
    return manifest, words


def collect(manifest_file, content_file=None):
    manifest, words = content_words(manifest_file, content_file)
    module = pipeline_module()
    rows = {}
    for word in words:
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


def load_incremental_baselines(files, module):
    """Read immutable, locally cached release pins; never fetch or modify them.

    A v4 delta may reuse either accent independently. Every selected asset is
    checked separately before it is referenced by the new pack.
    """
    pairs, references = {}, []
    for file in files:
        if file.is_symlink() or not file.is_file():
            raise ValueError('invalid_audio_baseline_manifest')
        built = json.loads(file.read_text())
        version = built.get('version')
        filename = BASELINE_PINS.get(version)
        if isinstance(version, str) and re.fullmatch(r'sentence-audio-v4(?:-(?!0000)[0-9]{4})?', version):
            filename = version+'.manifest.json'
        if not filename:
            raise ValueError('unknown_audio_baseline')
        pin = json.loads((REPO/'data'/filename).read_text())
        manifest_sha = digest(file)
        if (pin.get('id') != version or pin.get('version') != version
            or built.get('status') != 'ready' or manifest_sha != pin['manifestSha256']):
            raise ValueError('audio_baseline_pin_mismatch')
        source = file.parent/'sources.manifest.json'
        if (source.is_symlink() or not source.is_file()
            or built.get('sourceManifestSha256') != pin['sourceManifestSha256']
            or digest(source) != pin['sourceManifestSha256']):
            raise ValueError('audio_baseline_source_pin_mismatch')
        reference = {'id': version, 'manifestSha256': manifest_sha,
                     'sourceManifestSha256': pin['sourceManifestSha256']}
        if reference in references:
            raise ValueError('duplicate_audio_baseline')
        references.append(reference)
        local_pairs = set()
        for entry in built['entries']:
            accent = entry.get('accent')
            if (accent not in ('US', 'UK') or not entry.get('text')
                or entry.get('textHash') != module.text_hash(entry['text'])):
                raise ValueError('audio_baseline_text_mismatch')
            pair = (entry['textHash'], accent)
            if pair in local_pairs:
                raise ValueError('duplicate_audio_baseline_pair')
            local_pairs.add(pair)
            # An earlier supplied baseline wins deterministically. Each release
            # remains pinned; a later pack cannot silently overwrite its proof.
            pairs.setdefault(pair, (entry, file.parent, reference))
    return pairs, references


def incremental_scope(rows, baseline_pairs, module, holds=None):
    pending = {'US': [], 'UK': []}
    reused, media_references = [], []
    fully_reused = partially_reused = 0
    held_clips, held_sentences, fully_held = 0, 0, 0
    for row in rows:
        retained = []
        row_held = 0
        for accent in ('US', 'UK'):
            # A pending reading cannot be resurrected by a prior release, a
            # recorded clip or a journal cache. The other accent stays eligible.
            if holds is not None and (row['textHash'], accent) in holds:
                held_clips += 1
                row_held += 1
                continue
            previous = baseline_pairs.get((row['textHash'], accent))
            correction = row.get('pronunciationCorrections', {}).get(accent)
            if previous is not None and correction:
                entry = previous[0]
                if entry.get('kind') == 'synthesized' and entry.get('pronunciationCorrectionSha256') != correction['sha256']:
                    previous = None
            if previous is None:
                pending[accent].append(row)
                continue
            entry, directory, baseline = previous
            key = entry['fileKey']
            asset = directory/key
            if (entry['text'] != row['text'] or asset.is_symlink()
                or not asset.resolve().is_relative_to(directory.resolve())
                or not module.pack.validate_entry(entry, directory, entry.get('cacheKey'))):
                raise ValueError('invalid_reused_audio')
            reference = {'textHash': row['textHash'], 'accent': accent,
                         'fileKey': key, 'fileSha256': entry['fileSha256'],
                         'mimeType': entry['mimeType'], 'sizeBytes': entry['sizeBytes'],
                         'kind': entry['kind'], 'baseline': baseline}
            if entry.get('cacheKey'):
                reference['cacheKey'] = entry['cacheKey']
            retained.append(reference)
            media_references.append(reference)
        if row_held:
            held_sentences += 1
            fully_held += int(row_held == 2)
        if retained:
            reused.append({**row, 'pairs': retained})
            if len(retained) == 2:
                fully_reused += 1
            else:
                partially_reused += 1
    generated = sum(len(items) for items in pending.values())
    statistics = {'requestedSentenceCount': len(rows), 'requestedClipCount': len(rows)*2,
                  'reusedClipCount': len(media_references), 'generatedClipCount': generated,
                  'fullyReusedSentenceCount': fully_reused,
                  'partiallyReusedSentenceCount': partially_reused}
    if holds is not None:
        statistics.update({'heldClipCount': held_clips, 'heldSentenceCount': held_sentences,
                           'fullyHeldSentenceCount': fully_held,
                           'eligibleClipCount': len(rows)*2-held_clips})
    return pending, reused, media_references, statistics


def sentence_shard(rows, index, count):
    if not 1 <= count <= 1000 or not 0 <= index < count:
        raise ValueError('invalid_sentence_shard')
    # Hash-based partitions keep every meaning reference of a shared sentence together.
    return [row for row in rows if int(row['textHash'], 16) % count == index]


def check_existing_hold_scope(output, hold_pin):
    """Do not add a new policy sidecar to an already fixed, different build."""
    if not (output/'manifest.json').exists():
        return
    file = output/'sources.manifest.json'
    previous = json.loads(pinned_bytes(file, 64*1024*1024))
    expected = ({**hold_pin, 'sourceFileName': hold_pin['fileName'],
                 'fileName': 'pronunciation-holds.json'} if hold_pin else None)
    if previous.get('pronunciationHolds') != expected:
        raise ValueError('existing_audio_output_hold_scope_mismatch')
    return previous


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',type=Path,required=True)
    parser.add_argument('--content',type=Path,
                        help='leaf payload override; collections resolve all payloads through their pinned leaves')
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--model-dir',type=Path,required=True)
    parser.add_argument('--workers',type=int,choices=(1,2,4,6,8),default=1)
    parser.add_argument('--worker-batch-size', type=worker_batch_size,
                        help='v4 only: sentences per fresh spawned worker task, 1..512 (default 128)')
    parser.add_argument('--pack-id', type=pack_id, default=VERSION,
                        help='v3 reproduces the original pack; v4 builds an accent-level delta')
    parser.add_argument('--plan-only', action='store_true',
                        help='v4 only: validate pinned text/reused media and report missing pairs without synthesis')
    parser.add_argument('--baseline-manifest',type=Path,action='append',default=[])
    parser.add_argument('--sentence-shard-index', type=int, default=0)
    parser.add_argument('--sentence-shard-count', type=int, default=1)
    parser.add_argument('--pronunciation-reviews', type=Path)
    parser.add_argument('--pronunciation-reviews-sha256')
    parser.add_argument('--pronunciation-holds', type=Path,
                        help='v4 only: exact pinned text/accent clips to leave unavailable pending reading review')
    parser.add_argument('--pronunciation-holds-sha256')
    parser.add_argument('--release-url',required=True)
    args = parser.parse_args()
    if args.pack_id == VERSION and args.worker_batch_size is not None:
        raise ValueError('incremental_pack_required_for_worker_batch_size')
    if not args.release_url.startswith('https://github.com/wudi000888-svg/nightstudy/releases/download/') or args.release_url.endswith('/'):
        raise ValueError('explicit_release_url_required')
    output = external(args.output, True)
    (output/'progress').mkdir(exist_ok=True)
    module = pipeline_module()
    manifest, rows = collect(args.manifest,args.content)
    if args.sentence_shard_count != 1 or args.sentence_shard_index != 0:
        if args.pack_id == VERSION:
            raise ValueError('incremental_pack_required_for_sharding')
        rows = sentence_shard(rows, args.sentence_shard_index, args.sentence_shard_count)
    if args.pack_id == VERSION and (args.pronunciation_reviews or args.pronunciation_reviews_sha256):
        raise ValueError('incremental_pack_required_for_pronunciation_reviews')
    if args.pack_id == VERSION and (args.pronunciation_holds or args.pronunciation_holds_sha256):
        raise ValueError('incremental_pack_required_for_pronunciation_holds')
    holds_module = publication_holds_module()
    holds, hold_pin = holds_module.load_holds(args.pronunciation_holds,
        args.pronunciation_holds_sha256, rows)
    pronunciation = pronunciation_module()
    reviews, review_pin = pronunciation.load_reviews(args.pronunciation_reviews,
        args.pronunciation_reviews_sha256, rows, module.pack.DEFAULT_VOICES_MANIFEST)
    if reviews:
        rows = pronunciation.attach_reviews(rows, reviews)
    requested_rows = rows
    incremental = args.pack_id != VERSION
    media_references, baseline_references, coverage = [], [], None
    baseline_pairs = {}
    if incremental:
        baseline_pairs, baseline_references = load_incremental_baselines(args.baseline_manifest, module)
        pending_by_accent, reused, media_references, coverage = incremental_scope(
            rows, baseline_pairs, module, holds if hold_pin else None)
        pending_hashes = {row['textHash'] for items in pending_by_accent.values() for row in items}
        rows = [row for row in rows if row['textHash'] in pending_hashes]
    else:
        # Keep original v3 source/manifest shape and synthesis order reproducible.
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
        pending_by_accent = {accent: rows for accent in ('US', 'UK')}
    batch_size = args.worker_batch_size or DEFAULT_WORKER_BATCH_SIZE
    tasks = bounded_worker_tasks(pending_by_accent, batch_size) if incremental else None
    execution = worker_execution_metadata(tasks, batch_size, args.workers) if incremental else None
    if args.plan_only:
        if not incremental:
            raise ValueError('incremental_pack_required_for_plan')
        print(json.dumps({'phase': 'plan', 'version': args.pack_id,
                          'meaningPackId': manifest['id'], 'meaningPackSha256': manifest['sha256'],
                          'baselinePacks': baseline_references, 'coverage': coverage,
                          'buildExecution': execution,
                          **({'pronunciationHolds': hold_pin} if hold_pin else {}),
                          'pendingByAccent': {accent: len(items) for accent, items in pending_by_accent.items()}}),
              flush=True)
        return
    if not rows:
        if holds:
            # The global policy is still needed by installers/API. A zero-entry
            # archive would violate the existing pack contract, so only the
            # plan reports this scope; do not fabricate a publication delta.
            raise ValueError('no_audio_delta_with_publication_holds')
        raise ValueError('all_audio_already_present_no_delta_needed')
    if incremental and (len(rows) > MAX_DELTA_SENTENCES
                        or sum(len(items) for items in pending_by_accent.values()) > MAX_DELTA_CLIPS):
        raise ValueError('incremental_audio_scope_requires_sharding')
    previous_sources = None
    if incremental:
        previous_sources = check_existing_hold_scope(output, hold_pin)
        if previous_sources is not None and previous_sources.get('buildExecution') != execution:
            raise ValueError('existing_audio_output_worker_execution_mismatch')
    review_file = None
    hold_file = None
    if hold_pin:
        hold_raw = pinned_bytes(args.pronunciation_holds, holds_module.MAX_BYTES)
        if len(hold_raw) != hold_pin['bytes'] or hashlib.sha256(hold_raw).hexdigest() != hold_pin['sha256']:
            raise ValueError('pronunciation_holds_changed_before_build')
        hold_file = output/'pronunciation-holds.json'
        if hold_file.exists():
            if hold_file.is_symlink() or hold_file.read_bytes() != hold_raw:
                raise ValueError('immutable_pronunciation_holds_conflict')
        else:
            hold_file.write_bytes(hold_raw)
    if review_pin:
        review_raw = pinned_bytes(args.pronunciation_reviews, 4*1024*1024)
        if len(review_raw) != review_pin['bytes'] or hashlib.sha256(review_raw).hexdigest() != review_pin['sha256']:
            raise ValueError('pronunciation_reviews_changed_before_build')
        review_file = output/'pronunciation-reviews.json'
        if review_file.exists():
            if review_file.is_symlink() or review_file.read_bytes() != review_raw:
                raise ValueError('immutable_pronunciation_reviews_conflict')
        else:
            review_file.write_bytes(review_raw)
    sources = {'schemaVersion':2,'version':args.pack_id,'meaningPackSha256':manifest['sha256'],'meaningPackId':manifest['id'],'normalization':'NFKC; curly quote to ASCII; collapse whitespace; preserve case','engineSource':json.loads(module.pack.DEFAULT_VOICES_MANIFEST.read_text()),'sentences':rows,'reusedSentences':reused,'policy':'Prebuilt offline with cached voices. Not expert-certified pronunciation.'}
    if incremental:
        sources.update({'requestedSentences': requested_rows, 'baselinePacks': baseline_references,
                        'reusedMediaReferences': media_references, 'coverage': coverage})
        sources['buildRuntime'] = build_runtime()
        sources['buildExecution'] = execution
        if review_pin:
            sources['pronunciationReviews'] = {**review_pin, 'sourceFileName': review_pin['fileName'],
                                               'fileName': 'pronunciation-reviews.json'}
        if hold_pin:
            sources['pronunciationHolds'] = {**hold_pin, 'sourceFileName': hold_pin['fileName'],
                                             'fileName': 'pronunciation-holds.json'}
            sources['heldMediaReferences'] = [
                {'holdId': entry['id'], **{key: entry[key] for key in (
                    'textHash', 'accent', 'learningSenseId', 'exampleId', 'riskCategory')}}
                for _, entry in sorted(holds.items())]
        if args.sentence_shard_count != 1:
            sources['sentencePartition'] = {'algorithm': 'text-sha256-modulo-v1',
                'index': args.sentence_shard_index, 'count': args.sentence_shard_count}
        if manifest.get('_audioIdentityKind'):
            sources['meaningPackIdentityKind'] = manifest['_audioIdentityKind']
        if manifest.get('_audioLicenseNotices'):
            sources['meaningContentLicenseNotices'] = [
                {key: notice[key] for key in ('fileName', 'bytes', 'sha256')}
                for notice in manifest['_audioLicenseNotices']]
        existing = output/'manifest.json'
        if existing.exists():
            previous = json.loads(pinned_bytes(existing, 64*1024*1024))
            previous_sources_file = output/'sources.manifest.json'
            if previous_sources is None:
                previous_sources = json.loads(pinned_bytes(previous_sources_file, 64*1024*1024))
            if (previous.get('version') != args.pack_id or not previous_sources_file.is_file()
                or previous_sources.get('meaningPackSha256') != manifest['sha256']):
                raise ValueError('existing_audio_output_scope_mismatch')
            if previous_sources.get('pronunciationReviews') != sources.get('pronunciationReviews'):
                raise ValueError('existing_audio_output_pronunciation_scope_mismatch')
            if previous_sources.get('pronunciationHolds') != sources.get('pronunciationHolds'):
                raise ValueError('existing_audio_output_hold_scope_mismatch')
            if previous_sources.get('buildExecution') != execution:
                raise ValueError('existing_audio_output_worker_execution_mismatch')
    expected_pairs = {(row['textHash'], accent) for accent, items in pending_by_accent.items() for row in items}
    print(json.dumps({'phase':'scope','sentences':len(rows),'clips':len(expected_pairs),
                      **({'coverage': coverage} if incremental else {})}),flush=True)
    if incremental:
        entries = execute_worker_tasks(tasks, output, args.model_dir.resolve(), args.workers)
    else:
        # Historical v3 execution and source shape stay reproducible.
        shards = max(1, args.workers//2)
        with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers,mp_context=multiprocessing.get_context('spawn')) as pool:
            futures = [pool.submit(worker,accent,pending_by_accent[accent][shard::shards],str(output),str(args.model_dir.resolve()),shard) for accent in ('US','UK') for shard in range(shards) if pending_by_accent[accent][shard::shards]]
            entries = [entry for future in futures for entry in future.result()]
    entries = sorted(entries, key=lambda entry:(entry['textHash'],entry['accent']))
    if len(entries) != len(expected_pairs) or {(entry['textHash'],entry['accent']) for entry in entries} != expected_pairs:
        raise ValueError('sentence_accent_coverage_mismatch')
    if any((entry['textHash'], entry['accent']) in holds for entry in [*entries, *media_references]):
        raise ValueError('held_sentence_audio_cannot_be_published')
    by_hash = {row['textHash']: row for row in rows}
    for entry in entries:
        if not module.pack.validate_entry(entry,output,entry['cacheKey']) or entry['textHash'] != module.text_hash(entry['text']):
            raise ValueError('sentence_asset_invalid')
        correction = by_hash[entry['textHash']].get('pronunciationCorrections', {}).get(entry['accent'])
        if correction:
            expected_identity = pronunciation.corrected_cache_identity(module.pack.synthesis_identity(
                entry['text'], entry['accent'], sources['engineSource']['voices'][entry['accent']]), correction)
            if entry['cacheKey'] != expected_identity or entry.get('pronunciationCorrectionSha256') != correction['sha256']:
                raise ValueError('sentence_pronunciation_correction_identity_mismatch')
    external(output)
    entries = module.audit_entries(entries,output,args.workers)
    sources.update({'acousticQualityPolicy':module.codec.QUALITY_POLICY,'transcodingTool':module.codec.build_tool_identity()})
    write_build_json(module, output/'sources.manifest.json', sources, incremental)
    stats={'lemmaCount':len(rows),'entryCount':len(entries),'recordedCount':0,'synthesizedCount':len(entries),'failedCount':0}
    if incremental:
        stats.update(coverage)
    built={'schemaVersion':2,'version':args.pack_id,'status':'ready','sourceManifestSha256':digest(output/'sources.manifest.json'),'statistics':stats,'entries':entries}
    write_build_json(module, output/'manifest.json', built, incremental)
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
    if incremental:
        notice_hashes = {}
        for notice in manifest.get('_audioLicenseNotices', []):
            destination = licenses/notice['fileName']
            if destination.name in notice_hashes:
                if notice_hashes[destination.name] != notice['sha256']:
                    raise ValueError('meaning_license_name_collision')
                continue
            if destination.exists() and digest(destination) != notice['sha256']:
                raise ValueError('meaning_license_name_collision')
            shutil.copyfile(notice['path'], destination)
            notice_hashes[destination.name] = notice['sha256']
            if destination not in license_files:
                license_files.append(destination)
    for value in (built,sources):
        if any(marker in json.dumps(value,ensure_ascii=False) for marker in ('/Users/','/Volumes/','43.167.217.117')):
            raise ValueError('private_path_in_public_asset')
    for file in [*license_files, *([review_file] if review_file else []), *([hold_file] if hold_file else [])]:
        if any(marker in file.read_text() for marker in ('/Users/','/Volumes/','43.167.217.117')):
            raise ValueError('private_path_in_public_license')
    files=[output/'manifest.json',output/'sources.manifest.json',*([review_file] if review_file else []),*([hold_file] if hold_file else []),*sorted(license_files),*sorted({output/entry['fileKey'] for entry in entries})]
    if hold_file:
        final_hold = pinned_bytes(hold_file, holds_module.MAX_BYTES)
        if len(final_hold) != hold_pin['bytes'] or hashlib.sha256(final_hold).hexdigest() != hold_pin['sha256']:
            raise ValueError('pronunciation_holds_changed_before_archive')
    if any(file.is_symlink() or not file.is_file() or not file.resolve().is_relative_to(output) for file in files):
        raise ValueError('invalid_public_archive_member')
    archive_file=output.parent/('nightstudy-'+args.pack_id+'.tar.gz')
    external(output)
    build_archive(files, output, archive_file, incremental)
    note = ('Reviewed meaning-bound bilingual examples, static US/UK sentence audio delta; historical media remain pinned; no runtime synthesis.'
            if incremental else 'Original meaning-bound bilingual examples, static US/UK sentence audio; no runtime synthesis.')
    pin={'id':args.pack_id,'status':'ready','version':args.pack_id,'source':{'url':args.release_url+'/'+archive_file.name,'sha256':digest(archive_file),'sizeBytes':archive_file.stat().st_size},**stats,'manifestSha256':digest(output/'manifest.json'),'sourceManifestSha256':digest(output/'sources.manifest.json'),'note':note}
    for value in (built,sources,pin):
        if any(marker in json.dumps(value,ensure_ascii=False) for marker in ('/Users/','/Volumes/','43.167.217.117')):
            raise ValueError('private_path_in_public_asset')
    write_build_json(module, output.parent/(args.pack_id+'.pin.json'), pin, incremental)
    print(json.dumps({'phase':'ready',**stats,'archive':str(archive_file)}),flush=True)


if __name__=='__main__':
    main()
