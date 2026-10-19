#!/usr/bin/env python3
"""Inventory published legacy/current intersections; never authorize reuse.

The cloud workflow supplies archive-verified original legacy manifests/sources.
This entry rechecks their committed pins and reports full old entry identity,
complete current contexts, current explicit controls and planned pair decisions.
No model, media, decoder, download or worker module is opened.
"""
import argparse
import gzip
import hashlib
import os
from pathlib import Path
import stat
import sys
import types

REPO = Path(__file__).resolve().parent.parent
MIB = 1048576
PURE_FILE = REPO / 'scripts/check-ci-sentence-audio-batch.py'
PURE_SHA = '16fbaf7f522a0f26382a923df7670b623fa49df4f82a8b6b225f1e2af71913d8'
PURE_BYTES = 44043
LEGACY = ('sentence-audio.manifest.json', 'sentence-audio-v2.manifest.json', 'sentence-audio-v3.manifest.json')


def load_pure():
    fd = os.open(PURE_FILE, os.O_RDONLY | os.O_NOFOLLOW)
    sig = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    try:
        before = os.fstat(fd)
        if PURE_FILE.resolve() != PURE_FILE or not stat.S_ISREG(before.st_mode) or before.st_size != PURE_BYTES:
            raise ValueError('fixed_independent_source_size')
        raw = os.read(fd, 128 * 1024 + 1)
        if len(raw) != PURE_BYTES or os.read(fd, 1) or hashlib.sha256(raw).hexdigest() != PURE_SHA or \
                sig(before) != sig(os.fstat(fd)) or sig(before) != sig(os.lstat(PURE_FILE)):
            raise ValueError('fixed_independent_source_hash_identity')
        module = types.ModuleType('_nightstudy_pure_overlap_validation')
        module.__file__ = str(PURE_FILE)
        exec(compile(raw, str(PURE_FILE), 'exec'), module.__dict__)
        helper, _ = module.load_helpers()
        return module, helper, sig(before)
    finally:
        os.close(fd)


def read_legacy(h, inputs):
    entries, sources, descriptors = {}, [], []
    for number, name in enumerate(LEGACY, 1):
        descriptor_path = REPO / 'data' / name
        descriptor_raw = inputs.read(descriptor_path, 65536)
        descriptor = h.decode(descriptor_raw)
        pack = 'sentence-audio-v%d' % number
        h.need(descriptor['id'] == descriptor['version'] == pack and descriptor['status'] == 'ready' and
               h.digest(descriptor['manifestSha256']) and h.digest(descriptor['sourceManifestSha256']), 'fixed_legacy_descriptor_identity')
        manifest_path = REPO / '.cloud-legacy' / (pack + '.manifest.json')
        source_path = REPO / '.cloud-legacy' / (pack + '.sources.manifest.json')
        manifest_raw = inputs.read(manifest_path, 64 * MIB, descriptor['manifestSha256'])
        source_raw = inputs.read(source_path, 32 * MIB, descriptor['sourceManifestSha256'])
        manifest, source = h.decode(manifest_raw), h.decode(source_raw)
        h.need(manifest['version'] == pack and manifest['status'] == 'ready' and
               manifest['sourceManifestSha256'] == descriptor['sourceManifestSha256'] and source['version'] == pack and
               len(manifest['entries']) == manifest['statistics']['entryCount'] == descriptor['entryCount'] and
               manifest['statistics']['lemmaCount'] == descriptor['lemmaCount'], 'actual_legacy_manifest_sources_and_counts')
        local = set()
        for entry in manifest['entries']:
            text, key, accent = entry['text'], entry['textHash'], entry['accent']
            h.need(isinstance(text, str) and h.normalize(text) == text and h.sha(text) == key and accent in h.ACCENTS and
                   (key, accent) not in local and h.digest(entry['fileSha256']) and
                   isinstance(entry['fileKey'], str) and h.digest(entry['cacheKey']) and
                   type(entry['sizeBytes']) is int and entry['sizeBytes'] > 0, 'whole_legacy_entry_key_asset_identity')
            local.add((key, accent))
            entries.setdefault((key, accent), []).append(dict(packId=pack, entry=entry,
                manifestSha256=descriptor['manifestSha256'], sourceManifestSha256=descriptor['sourceManifestSha256']))
        runtime_keys = ('engineSource', 'buildRuntime', 'buildExecution', 'transcodingTool', 'acousticQualityPolicy',
                        'helperSha256', 'engineVersion', 'meaningPackId', 'meaningPackSha256', 'meaningPackIdentityKind',
                        'pronunciationReviews', 'pronunciationHolds', 'normalization', 'policy')
        sources.append(dict(packId=pack, manifest=dict(fileName=manifest_path.relative_to(REPO).as_posix(),
            bytes=len(manifest_raw), sha256=h.sha(manifest_raw)), sources=dict(fileName=source_path.relative_to(REPO).as_posix(),
            bytes=len(source_raw), sha256=h.sha(source_raw)), runtimeMetadata={key: source[key] for key in runtime_keys if key in source},
            completeSourceFields=sorted(source), fieldsNotCopied={key: dict(type=type(value).__name__,
                canonicalSha256=h.sha(h.canonical(value)), count=len(value) if isinstance(value, (list, dict)) else None)
                for key, value in source.items() if key not in runtime_keys}))
        descriptors.append(dict(fileName='data/' + name, bytes=len(descriptor_raw), sha256=h.sha(descriptor_raw), descriptor=descriptor))
    return entries, sources, descriptors


def public_index(m, h, inputs, legacy_hashes, controls):
    root = inputs.json(REPO / 'data/learning-senses-collection-v2.manifest.json', 65536, h.PUBLIC_SHA)
    h.need(root['wordCount'] == 18767 and root['senseCount'] == 49992 and root['exampleCount'] == 99984 and
           len(root['shards']) == 95, 'fixed_whole_public95_scope')
    refs, contexts, totals, baseline, outside = {}, {}, [0, 0, 0], set(), set()
    for index, leaf in enumerate(root['shards']):
        manifest = inputs.json(h.relative(REPO / 'data', leaf['manifestFileName']), 65536, leaf['sha256'], leaf['bytes'])
        payload = h.relative(REPO / 'data', manifest['fileName'])
        fd, _, before = inputs.checked_fd(payload, 8 * MIB, manifest['sha256'], manifest['bytes'])
        local, expanded, digest = [0, 0, 0], 0, hashlib.sha256()
        try:
            with os.fdopen(fd, 'rb', closefd=False) as raw_file:
                with gzip.GzipFile(fileobj=raw_file) as stream:
                    while raw := stream.readline(2 * MIB + 1):
                        expanded += len(raw)
                        h.need(len(raw) <= 2 * MIB and raw.endswith(b'\n') and expanded <= 16 * MIB, 'bounded_full_public_leaf')
                        digest.update(raw)
                        word = h.decode(raw)
                        local[0] += 1
                        for sense in word['senses']:
                            local[1] += 1
                            for example in sense['examples']:
                                local[2] += 1
                                text = h.normalize(example['exampleEn'])
                                key = h.sha(text)
                                h.need(sense['wordId'] == word['wordId'] == example['wordId'] and
                                       example['learningSenseId'] == sense['id'] and
                                       (key in controls or not h.risky(sense, example)), 'current_parent_and_pronunciation_scope')
                                body = dict(word={k: word[k] for k in ('wordId', 'normalizedLemma')},
                                    sense={k: v for k, v in sense.items() if k != 'examples'}, example=example)
                                ref = dict(wordId=word['wordId'], learningSenseId=sense['id'], exampleId=example['id'],
                                    contentVersion=sense['contentVersion'], bindingHash=sense['bindingHash'], leafIndex=index,
                                    leafManifestSha256=leaf['sha256'], payloadSha256=manifest['sha256'],
                                    publicContextSha256=h.sha(h.canonical(body)), sourceBindingsSha256=h.sha(h.canonical(sense['sourceBindings'])))
                                refs.setdefault(key, []).append(m.reference_fingerprint(h, ref, False))
                                h.need(len(refs[key]) <= 3, 'complete_current_refs_cap')
                                (baseline if index == 0 else outside).add(key)
                                if key in legacy_hashes:
                                    contexts.setdefault(key, []).append(dict(reference=ref, publicContext=body))
            h.need(h.identity(os.fstat(fd)) == h.identity(before), 'public_input_fd_identity')
        finally:
            os.close(fd)
        h.need(digest.hexdigest() == manifest['jsonlSha256'] and local ==
               [leaf['wordCount'], leaf['senseCount'], leaf['exampleCount']] ==
               [manifest['wordCount'], manifest['senseCount'], manifest['exampleCount']], 'whole_public_leaf_sha_counts')
        totals = [a + b for a, b in zip(totals, local)]
    h.need(totals == [18767, 49992, 99984] and len(refs) == 99940 and len(baseline) == 196 and
           not baseline & outside, 'complete_public_global_universe')
    return refs, contexts, baseline


def plan_decisions(m, h, inputs, public, baseline, controls, base):
    pins = inputs.json(REPO / 'data/ci-audio-batch-plan.manifest.json', 65536)
    selection = inputs.pin(pins['selection'], 2 * MIB)
    h.need(selection['kind'] == 'nightstudy-ci-audio-fresh-selection-v1' and selection['state'] == 'COMPLETE_EXPLICIT_FRESH_SELECTION' and
           selection['publicRootSha256'] == h.PUBLIC_SHA and selection['finalPolicySha256'] == h.FINAL_SHA and
           selection['currentCounts'] == dict(groups=99940, references=99984, pairs=199880) and
           selection['oldUnapprovedCandidateSelection'] == 'NOT_SELECTED' and len(selection['leaves']) == 101,
           'actual_prepared_selection_scope')
    exclusions_raw = inputs.read(h.relative(REPO, selection['exclusionLedger']['fileName']), MIB,
        selection['exclusionLedger']['sha256'], selection['exclusionLedger']['bytes'])
    h.need(exclusions_raw.endswith(b'\n'), 'complete_exclusion_ledger')
    decisions = {}
    for raw in exclusions_raw.splitlines():
        row = h.decode(raw)
        pair = row['textHash'], row['accent']
        h.need(set(row) == {'textHash', 'accent', 'decision'} and pair not in decisions and pair[0] in public and
               pair[1] in h.ACCENTS and row['decision'] in ('hold', 'supplemental-hold', 'pending-explicit', 'published-baseline-exact-current-refs'),
               'unique_current_exclusion')
        decisions[pair] = dict(decision=row['decision'])
    previous, groups, pairs = '', 0, 0
    for number, leaf in enumerate(selection['leaves'], 1):
        h.need(set(leaf) == {'sliceNumber', 'fileName', 'bytes', 'sha256', 'groups', 'pairs', 'firstTextHash', 'lastTextHash'} and
               leaf['sliceNumber'] == number, 'ordered_pinned_selection_leaf')
        pin = {key: leaf[key] for key in ('fileName', 'bytes', 'sha256')}
        targets = inputs.pin(pin, 8 * MIB)
        h.need(len(targets) == leaf['groups'] and targets[0]['textHash'] == leaf['firstTextHash'] and
               targets[-1]['textHash'] == leaf['lastTextHash'], 'whole_actual_selection_leaf')
        local = 0
        for target in targets:
            key = target['textHash']
            h.need(key in public and previous < key and h.sha(target['text']) == key and h.normalize(target['text']) == target['text'] and
                   target['accents'] in (['US'], ['UK'], ['US', 'UK']), 'unique_ordered_current_selection_target')
            m.current_selection_references(h, target, public, key in base)
            if key in controls:
                h.need(target['references'] == controls[key]['references'], 'selected_current_controls_allrefs')
            for accent in target['accents']:
                h.need((key, accent) not in decisions, 'fresh_exclusion_conflict')
                decisions[key, accent] = dict(decision='planned-fresh', sliceNumber=number, selectionLeaf=pin)
            previous = key
            local += len(target['accents'])
        h.need(local == leaf['pairs'], 'actual_selection_leaf_pairs')
        groups += len(targets)
        pairs += local
    h.need(groups == selection['generatedGroups'] == 99726 and pairs == selection['generatedPairs'] == 199409 and
           len(decisions) == 199880 and {k for k, _ in decisions} == set(public) and
           {pair for pair, row in decisions.items() if row['decision'] == 'published-baseline-exact-current-refs'} ==
           {(key, accent) for key in baseline for accent in h.ACCENTS}, 'full_actual_pair_union_and_exact_baseline')
    expected_holds = {(key, accent) for key, group in controls.items() for accent in h.ACCENTS if group['accents'][accent]['state'] == 'hold'}
    h.need({pair for pair, row in decisions.items() if row['decision'] in ('hold', 'supplemental-hold')} == expected_holds and
           len(expected_holds) == 79, 'exact_global_hold_exclusions')
    return decisions, pins['selection']


def expected_identity(h, text, accent, group, voices):
    voice = voices['voices'][accent]
    control = group['accents'][accent] if group else None
    correction = control['correction'] if control else None
    base = h.sha(h.canonical(dict(text=text, accent=accent, engine='1.8.0', generator='audio-v1',
        model=voice['model']['sha256'], config=voice['config']['sha256']), True))
    changed = dict(baseSynthesisIdentity=base, pronunciationCorrectionSha256=correction['sha256']) if correction else None
    if correction and len(correction['correctedPhonemes']) > 1:
        changed['renderPolicy'] = 'piper-raw-per-sentence-wav-v1'
    return dict(text=text, accent=accent, engineVersion='1.8.0', voiceModelSha256=voice['model']['sha256'],
        voiceConfigSha256=voice['config']['sha256'], cacheKey=h.sha(h.canonical(changed)) if changed else base,
        pronunciationCorrectionSha256=correction['sha256'] if correction else None,
        pronunciationCorrectionId=correction['record']['id'] if correction else None)


def compare_entry(entry, expected):
    comparisons = {field: entry.get(field) == value for field, value in expected.items()}
    return dict(currentIdentityFieldMatches=comparisons, exactCurrentSynthesisIdentityMatches=all(comparisons.values()),
        missingIdentityFields=[field for field, value in expected.items() if value is not None and field not in entry],
        mediaDecodedInThisAudit=False, reuseApproved=False)


def audit(args):
    m, h, pure_identity = load_pure()
    inputs = h.Inputs()
    inputs.identities[PURE_FILE] = pure_identity
    configuration = inputs.json(REPO / 'data/ci-audio-batch-inputs.manifest.json', 65536)
    h.need(args.controls.absolute() == h.relative(REPO, configuration['portableControls']['fileName']) and
           args.supplement.absolute() == h.relative(REPO, configuration['supplementalControls']['fileName']), 'explicit_fixed_control_paths')
    voices = inputs.json(REPO / 'data/audio-voices.manifest.json', 65536, h.VOICES_SHA)
    base = h.controls_index(inputs.pin(configuration['portableControls'], 64 * MIB))
    controls, observation = m.supplement(h, inputs, configuration['supplementalControls'], base, voices)
    h.need(observation is not None, 'required_actual_current_linux_supplement')
    old, source_pins, descriptors = read_legacy(h, inputs)
    public, contexts, baseline = public_index(m, h, inputs, {key for key, _ in old} | {m.SUPPLEMENT_HASH}, controls)
    for group in controls.values():
        m.current_selection_references(h, group, public, group['textHash'] in base)
    actual_observed = sorted(contexts.get(m.SUPPLEMENT_HASH, []), key=lambda r: (r['reference']['learningSenseId'], r['reference']['exampleId']))
    h.need(actual_observed == observation['publicContexts'], 'full_actual_overlay_public_context')
    decisions, selection_pin = plan_decisions(m, h, inputs, public, baseline, controls, base)
    overlaps, fresh, baseline_keys, held, same = [], 0, 0, 0, 0
    for pair, old_rows in sorted(old.items()):
        key, accent = pair
        if key not in public:
            continue
        current = contexts[key]
        text = h.normalize(current[0]['publicContext']['example']['exampleEn'])
        group = controls.get(key)
        control = group['accents'][accent] if group else None
        expected = expected_identity(h, text, accent, group, voices)
        prior = []
        for item in old_rows:
            entry = item['entry']
            comparison = compare_entry(entry, expected)
            same += comparison['exactCurrentSynthesisIdentityMatches']
            prior.append(dict(**item, **comparison))
        decision = decisions[pair]
        fresh += decision['decision'] == 'planned-fresh'
        baseline_keys += decision['decision'] == 'published-baseline-exact-current-refs'
        held += decision['decision'] in ('hold', 'supplemental-hold')
        overlaps.append(dict(textHash=key, accent=accent, text=text, plannedDecision=decision,
            currentReferencesAndContexts=current,
            currentPolicyProhibitsMedia=bool(control and control['state'] == 'hold'),
            currentCacheIdentityRecipe=dict(baseInputs=dict(text=text, accent=accent, engine='1.8.0', generator='audio-v1',
                model=voices['voices'][accent]['model']['sha256'], config=voices['voices'][accent]['config']['sha256']),
                correctionSha256=expected['pronunciationCorrectionSha256'],
                correctionRenderPolicy='piper-raw-per-sentence-wav-v1' if control and control['correction'] and
                    len(control['correction']['correctedPhonemes']) > 1 else None,
                synthesisRoute='frozen-reviewed-raw-per-sentence' if group else 'linux-original-text'),
            currentControl=dict(state=control['state'] if control else 'base-no-explicit-control',
                correctionSha256=control['correction']['sha256'] if control and control['correction'] else None,
                correctionId=control['correction']['record']['id'] if control and control['correction'] else None,
                hold=control['hold'] if control and control['state'] == 'hold' else None),
            expectedCurrentSynthesisIdentity=expected, oldPublishedEntries=prior))
    inputs.unchanged()
    return dict(kind='nightstudy-ci-legacy-sentence-overlap-audit-v1', state='COMPLETE_CONFLICT_INVENTORY_ONLY',
        publicRootSha256=h.PUBLIC_SHA, finalPolicySha256=h.FINAL_SHA, actualSelection=selection_pin,
        controls=dict(base=configuration['portableControls'], supplement=configuration['supplementalControls']),
        descriptors=descriptors, legacySources=source_pins,
        summary=dict(legacyEntries=sum(len(rows) for rows in old.values()), legacyUniquePairs=len(old),
            legacyNonCurrentPairs=sum(key not in public for key, _ in old), currentOverlapPairs=len(overlaps),
            plannedFreshOverlapPairs=fresh, preservedBaselineOverlapPairs=baseline_keys, heldOverlapPairs=held,
            exactIdentityMatchingOldEntries=same, oldCrossPackDuplicatePairs=sum(len(rows) > 1 for rows in old.values()),
            currentGroups=99940, currentReferences=99984, currentPairs=199880),
        overlaps=overlaps, modelImported=False, mediaDecoded=False, synthesisApproved=False, reuseApproved=False,
        supersessionApproved=False, publicationAuthorized=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--controls', type=Path, required=True)
    parser.add_argument('--supplement', type=Path, required=True)
    args = parser.parse_args()
    if not sys.platform.startswith('linux') or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('cloud_only_legacy_overlap_audit')
    sys.dont_write_bytecode = True
    def guard(event, values):
        if event.startswith(('socket.', 'subprocess.', 'os.exec', 'os.spawn')) or event in ('os.system', 'os.fork', 'sqlite3.connect'):
            raise PermissionError('legacy_audit_no_network_child_or_database')
        if event == 'open' and values and isinstance(values[0], (str, bytes, os.PathLike)) and \
                os.fsdecode(values[0]).lower().endswith(('.onnx', '.onnx.json', '.mp3', '.wav', '.gguf', '.pt', '.pth', '.safetensors')):
            raise PermissionError('legacy_audit_no_models_or_media')
    sys.addaudithook(guard)
    result = audit(args)
    _, h, _ = load_pure()
    output = args.output.absolute()
    h.need(output.resolve() == output and output.parent.is_dir() and not os.path.lexists(output), 'fresh_overlap_report')
    raw = (h.canonical(result) + '\n').encode('utf-8')
    h.need(len(raw) <= 64 * MIB, 'bounded_complete_overlap_report')
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    print(h.canonical(dict(state=result['state'], **result['summary'], reuseApproved=False)))


if __name__ == '__main__':
    main()
