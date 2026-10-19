#!/usr/bin/env python3
"""Prepare one deterministic, model-free eight-sentence cloud pilot request.

Every public leaf is streamed and verified. The seven ordinary sentences were
already explicit metadata-base targets; the eighth exercises a complete frozen
correction. A real active hold is a denial control, never a generation target.
"""
from __future__ import annotations
import argparse
import gzip
import hashlib
import importlib.util
import io
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('nightstudy_ci_pilot_worker_contract',
                                              Path(__file__).with_name('ci-sentence-audio-worker.py'))
w = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(w)
BASE_TEXTS = {
    '00005a0ed42cb1cee275e1bee143b71d0b6e21882a03222eb3f43fcd24d23af8':
        'The diagram shows a dark horizon below the surface.',
    '0000c41d2a5798d702bb355d836bcb0adb5b2579685b7cdf9be18546919e87bc':
        'The performance mixed comedy and sadness in different measures.',
    '0001e746d1765e267592a7e20f7789fc0c63df15e7af189578df027caae46693':
        'The potter kept the red slip in a covered jar.',
    '00020f2e9b9892f4c02a207b27771ddb2b5c4b0e96efbdbc4686ff43e52a3eac':
        'The map shows a coral reef beyond the sandy bay.',
    '00027a35fe13d352910355523cd85df01cf87e5484ebc983a7d8d645e2b1903b':
        'She waited until the last stroke of the bell had faded before speaking.',
    '00032ca432ca4dcb537866e9739d82973bb4a60f6ca9b673a83851664e423400':
        'His wide reading gave him a broad education.',
    '000432a8c524d4396d79018bd27759599528c0312fe627a7c1570d9939d41845':
        "The novel gradually breaks the character's delusion of complete independence.",
}


def plain_filename(name):
    w.require(isinstance(name, str) and re.fullmatch('[a-z0-9.-]+', name)
              and name not in ('.', '..'), 'public_leaf_filename')
    return w.relative_file('data/' + name)


def reference(word, sense, example, leaf_index, leaf_sha, payload_sha):
    """A public-body digest, explicitly distinct from proof-only semantic SHA."""
    body = dict(word={key: word[key] for key in ('wordId', 'normalizedLemma')},
                sense={key: value for key, value in sense.items() if key != 'examples'},
                example=example)
    return dict(wordId=word['wordId'], learningSenseId=sense['id'], exampleId=example['id'],
        contentVersion=sense['contentVersion'], bindingHash=sense['bindingHash'],
        leafIndex=leaf_index, leafManifestSha256=leaf_sha, payloadSha256=payload_sha,
        publicContextSha256=w.sha(w.canonical(body)),
        sourceBindingsSha256=w.sha(w.canonical(sense['sourceBindings'])))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', required=True, help='Repository-relative committed input manifest')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    input_file = w.relative_file(args.inputs)
    inputs_raw = w.read_bounded(input_file, 128 * 1024)
    inputs = w.json_bytes(inputs_raw)
    w.require(isinstance(inputs, dict) and set(inputs) == {
        'kind', 'mode', 'packId', 'portableControls'}
        and inputs['kind'] == 'nightstudy-ci-audio-build-inputs-v1'
        and inputs['mode'] == 'pilot', 'committed_pilot_inputs_shape')
    builder = w.load_builder()
    pipeline = builder.pipeline_module()
    controls_pin = inputs['portableControls']
    controls = w.validate_controls(w.pin_value(controls_pin, 64 * w.MIB),
                                  pipeline.pronunciation, builder.publication_holds_module())
    for text_hash, text in BASE_TEXTS.items():
        w.require(w.sha(text) == text_hash and text_hash not in controls,
                  'fixed_base_control_or_identity_drift')
    corrected = [group for _, group in sorted(controls.items())
        if 30 <= len(group['text']) <= 180 and group['rawTokenSegments'] is not None
        and group['originalPhonemes'] and all(group['originalPhonemes'])
        and all(c['state'] != 'hold' for c in group['accents'].values())
        and any(c['state'] == 'reviewed-correction' for c in group['accents'].values())]
    w.require(bool(corrected), 'no_short_nonheld_frozen_correction_control')
    chosen = corrected[0]
    held = [(text_hash, accent) for text_hash, group in sorted(controls.items())
            for accent in ('US', 'UK') if group['accents'][accent]['state'] == 'hold']
    w.require(bool(held), 'no_actual_held_denial_control')
    wanted = set(BASE_TEXTS) | {chosen['textHash']}
    found = {key: [] for key in wanted}
    collection_path = ROOT / 'data/learning-senses-collection-v2.manifest.json'
    collection_raw = w.read_bounded(collection_path, 64 * 1024, w.PUBLIC_ROOT_SHA)
    collection = w.json_bytes(collection_raw)
    w.require(collection['formatVersion'] == 2 and collection['id'] == 'learning-senses-collection-v2'
              and isinstance(collection['shards'], list) and len(collection['shards']) == 95,
              'full_public_collection_required')
    totals = dict(words=0, senses=0, examples=0)
    for index, shard in enumerate(collection['shards']):
        manifest_path = plain_filename(shard['manifestFileName'])
        manifest = w.json_bytes(w.read_bounded(manifest_path, 64 * 1024,
                                              shard['sha256'], shard['bytes']))
        w.require(manifest['id'] == shard['id'] and 1 <= manifest['wordCount'] <= 200
                  and 0 < manifest['bytes'] <= 8 * w.MIB, 'bounded_public_leaf_manifest')
        compressed = w.read_bounded(plain_filename(manifest['fileName']), 8 * w.MIB,
                                     manifest['sha256'], manifest['bytes'])
        decoded_sha = hashlib.sha256()
        leaf_counts = dict(words=0, senses=0, examples=0)
        decoded_bytes = 0
        with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode='rb') as handle:
            while True:
                raw = handle.readline(2 * w.MIB + 1)
                if not raw:
                    break
                decoded_bytes += len(raw)
                w.require(len(raw) <= 2 * w.MIB and raw.endswith(b'\n')
                          and decoded_bytes <= 16 * w.MIB, 'public_leaf_decoded_bounds')
                decoded_sha.update(raw)
                word = w.json_bytes(raw)
                w.require(isinstance(word, dict) and set(word) == {
                    'wordId', 'normalizedLemma', 'senses'} and isinstance(word['senses'], list)
                    and 1 <= len(word['senses']) <= 512, 'public_word_shape')
                leaf_counts['words'] += 1
                w.require(leaf_counts['words'] <= 200, 'public_leaf_word_bounds')
                for sense in word['senses']:
                    leaf_counts['senses'] += 1
                    examples = sense['examples']
                    w.require(sense['wordId'] == word['wordId'] and isinstance(examples, list)
                              and 1 <= len(examples) <= 20, 'public_sense_hierarchy')
                    for example in examples:
                        leaf_counts['examples'] += 1
                        w.require(example['wordId'] == word['wordId']
                                  and example['learningSenseId'] == sense['id'],
                                  'public_example_hierarchy')
                        text = pipeline.normalize(example['exampleEn'])
                        text_hash = w.sha(text)
                        if text_hash not in wanted:
                            continue
                        expected_text = BASE_TEXTS.get(text_hash, chosen['text'])
                        w.require(text == expected_text, 'public_target_text_drift')
                        if text_hash in BASE_TEXTS:
                            # An ordinary pilot cannot bypass any pronunciation
                            # metadata, even if its word alone seems familiar.
                            w.require(all(isinstance(meta, dict) and 'pronunciation' not in meta
                                for meta in (sense['contentMetadata'], example['contentMetadata'])),
                                'base_requires_explicit_scope_instead')
                        found[text_hash].append(reference(word, sense, example, index,
                                                         shard['sha256'], manifest['sha256']))
                        w.require(len(found[text_hash]) <= 3, 'pilot_all_current_refs_bounds')
        w.require(decoded_sha.hexdigest() == manifest['jsonlSha256'], 'public_leaf_jsonl_sha')
        for key, manifest_key in (('words', 'wordCount'), ('senses', 'senseCount'),
                                  ('examples', 'exampleCount')):
            w.require(leaf_counts[key] == manifest[manifest_key] == shard[manifest_key],
                      'public_leaf_exact_counts')
            totals[key] += leaf_counts[key]
    w.require(totals == dict(words=18767, senses=49992, examples=99984)
              and all(found.values()), 'public_whole_collection_and_targets_closed')
    # The controls already bind exact all-ref proof digests. Verify all public
    # anchors/pins again here without pretending public data contains ORM proof.
    control_refs = sorted(chosen['references'], key=lambda r: (r['learningSenseId'], r['exampleId']))
    actual_refs = sorted(found[chosen['textHash']], key=lambda r: (r['learningSenseId'], r['exampleId']))
    common = ('wordId', 'learningSenseId', 'exampleId', 'contentVersion', 'bindingHash',
              'leafIndex', 'leafManifestSha256', 'payloadSha256', 'sourceBindingsSha256')
    w.require([{key: r[key] for key in common} for r in control_refs] ==
              [{key: r[key] for key in common} for r in actual_refs],
              'reviewed_control_all_public_refs_drift')
    targets = [dict(textHash=key, text=BASE_TEXTS[key],
                    references=sorted(found[key], key=lambda r: (r['learningSenseId'], r['exampleId'])),
                    accents=['US', 'UK']) for key in sorted(BASE_TEXTS)]
    targets.append(dict(textHash=chosen['textHash'], text=chosen['text'],
                        references=chosen['references'], accents=['US', 'UK']))
    request = dict(kind='nightstudy-ci-sentence-audio-request-v1', mode='pilot', packId=inputs['packId'],
        portableControls=controls_pin,
        voicesManifest=dict(fileName='data/audio-voices.manifest.json',
            bytes=(ROOT/'data/audio-voices.manifest.json').stat().st_size, sha256=w.VOICES_SHA),
        publicRootSha256=w.PUBLIC_ROOT_SHA, finalPolicySha256=w.FINAL_POLICY_SHA,
        targets=targets, holdChecks=[dict(textHash=held[0][0], accent=held[0][1])])
    pending, identities, denials = w.prepare_request(request, controls, pipeline)
    w.require(sum(map(len, pending.values())) == 16 and len(identities) == 16 and len(denials) == 1,
              'pilot_exact_coverage')
    w.write_new(args.output, request)
    w.write_new(Path(str(args.output)+'.receipt.json'), dict(
        kind='nightstudy-ci-audio-pilot-prepared-v1', state='PREPARED_NO_MODELS',
        inputs=dict(fileName=args.inputs, bytes=len(inputs_raw), sha256=w.sha(inputs_raw)),
        prepareSourceSha256=w.digest(Path(__file__)), workerSourceSha256=w.digest(Path(w.__file__)),
        request=dict(fileName=args.output.name, bytes=args.output.stat().st_size,
                     sha256=w.digest(args.output)),
        publicRootSha256=w.PUBLIC_ROOT_SHA, portableControls=controls_pin,
        publicCounts=totals, generatedSentenceCount=8, generatedPairCount=16,
        heldDenialCount=1, expectedIdentities=identities, modelImported=False,
        modelDownloaded=False, mediaGenerated=False, publicationAuthorized=False))


if __name__ == '__main__':
    main()
