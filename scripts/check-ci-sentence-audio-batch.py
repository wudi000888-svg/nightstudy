#!/usr/bin/env python3
"""Independent bounded cloud-batch acceptance; never imports a model or worker.

The eight-sentence pilot remains a separate, fixed accepted entry. This entry
uses its source-pinned pure validation/EOF decoder helpers, not its pilot limits
or approval computation. Every batch stays unpublished after verification.
"""
from pathlib import Path
import argparse
import gzip
import hashlib
import os
import re
import stat
import sys
import types

REPO = Path(__file__).resolve().parent.parent
HELPER = REPO / 'scripts/check-ci-sentence-audio.py'
HELPER_SHA = '8d4c07d943331228790aa6d0376b664677180705c0b590d42c6c73b32dcc9057'
HELPER_BYTES = 43978
WORKER_SHA = '4be14408ff260feb89e5e58e7740b4b522b9a7f05d22d2b1d8009669610a252a'
PLANNER_SHA = 'f7d7dc1da1e33a8f99292eacc3abd7f5817aaffde852b59fd614f7f8c69e2ad4'
PILOT_WORKER_SHA = 'b2b47af3ef55f7f8288db7ae50ea4a89eb2f50640b643577e567d2434026d3b3'
PILOT_SHA = '0fa7270c6bee04ccc3641fdb4f9e4bdc24fdc113b19353c31df456984fdfa2bb'
BASE_CONTROLS_SHA = '3b7f791260a3d7490f89304c58afab7bc062a092271f67c2aa4a9b4c4cd367c7'
SUPPLEMENT_HASH = '00022a53ae06cabc23f1c80195da75d98f14395ed24c901dfbbbb4995119a226'
SUPPLEMENT_TEXT = 'The critic contrasts genuine curiosity with a sordid hunger for profit.'
OBSERVER_SHA = '7092902c98bd226dd7a326630bd9eca209614611504b3a309e8680480023c5b0'
MIB = 1048576
JOURNAL_POLICY = 'disabled-fresh-generation-no-progress-inputs-v1'


def load_helpers():
    if HELPER.resolve() != HELPER:
        raise ValueError('fixed_pure_checker_no_symlink')
    fd = os.open(HELPER, os.O_RDONLY | os.O_NOFOLLOW)
    ident = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size != HELPER_BYTES:
            raise ValueError('fixed_pure_checker_size')
        raw = os.read(fd, 128 * 1024 + 1)
        if len(raw) != HELPER_BYTES or os.read(fd, 1) or hashlib.sha256(raw).hexdigest() != HELPER_SHA or \
                ident(before) != ident(os.fstat(fd)) or ident(before) != ident(os.lstat(HELPER)):
            raise ValueError('fixed_pure_checker_bytes_identity')
        module = types.ModuleType('_nightstudy_batch_independent_validation')
        module.__file__ = str(HELPER)
        exec(compile(raw, str(HELPER), 'exec'), module.__dict__)
        return module, ident(before)
    finally:
        os.close(fd)


def hold_record(h, record):
    h.need(isinstance(record, dict) and set(record) == {'id', 'text', 'textHash', 'accent',
           'learningSenseId', 'exampleId', 'riskCategory', 'review'} and record['riskCategory'] in
           ('wrong-lexeme', 'insufficient-regional-evidence', 'insufficient-reading-evidence'), 'whole_supplement_hold')
    h.policy_record(record, 'sentence-audio-hold-', 'hold')


def supplement(h, inputs, pin, base, voices):
    if pin is None:
        return dict(base), None
    value = inputs.pin(pin, 2 * MIB)
    h.need(set(value) == {'kind', 'engineVersion', 'voicesManifestSha256', 'publicRootSha256',
           'finalPolicySha256', 'baseControlsSha256', 'groups', 'observation', 'review'} and
           value['kind'] == 'nightstudy-ci-audio-supplemental-controls-v1' and value['engineVersion'] == '1.8.0'
           and value['voicesManifestSha256'] == h.VOICES_SHA and value['publicRootSha256'] == h.PUBLIC_SHA
           and value['finalPolicySha256'] == h.FINAL_SHA and value['baseControlsSha256'] == BASE_CONTROLS_SHA
           and isinstance(value['groups'], list) and len(value['groups']) == 1, 'separate_explicit_current_supplement')
    group = value['groups'][0]
    h.need(set(group) == {'textHash', 'text', 'references', 'rawTokenSegments', 'originalPhonemes', 'accents'}
           and group['textHash'] == SUPPLEMENT_HASH and group['text'] == SUPPLEMENT_TEXT
           and h.sha(group['text']) == SUPPLEMENT_HASH and SUPPLEMENT_HASH not in base
           and set(group['accents']) == set(h.ACCENTS), 'exact_supplement_not_historical_override')
    refs = h.references(group['references'], False)
    obs = inputs.pin(value['observation'], 256 * 1024)
    h.need(obs['kind'] == 'nightstudy-ci-sentence-frontend-observation-v1' and
           obs['state'] == 'OBSERVED_REQUIRES_EXPLICIT_REGIONAL_HUMAN_REVIEW' and
           obs['textHash'] == SUPPLEMENT_HASH and obs['text'] == SUPPLEMENT_TEXT and
           obs['publicRootSha256'] == h.PUBLIC_SHA and obs['unchangedFinalPolicySha256'] == h.FINAL_SHA and
           obs['voicesManifestSha256'] == h.VOICES_SHA and obs['engineVersion'] == '1.8.0' and
           obs['observerSourceSha256'] == OBSERVER_SHA and obs['actualSharedEspeakVoice'] == 'en' and
           obs['frontendCalls'] == 1 and obs['allCurrentPublicReferencesVerified'] is True and
           obs['references'] == group['references'] and obs['rawTokenSegments'] == group['rawTokenSegments'] and
           obs['originalPhonemes'] == group['originalPhonemes'] and
           obs['rawTokenSegmentsSha256'] == h.sha(h.canonical(group['rawTokenSegments'])) and
           obs['originalPhonemesSha256'] == h.sha(h.canonical(group['originalPhonemes'])) and
           obs['regionalDecisions'] == dict(US=None, UK=None) and obs['literalCorrections'] == [] and
           obs['requestedAccents'] == ['US', 'UK'] and obs['publicClass'] == 'piper.phonemize_espeak.EspeakPhonemizer' and
           obs['classSourceSha256'] == 'd5ff275d847502345821898efa15e3e4e956fe884cea7c78ae87102d539e6594' and
           obs['audioPackSourceSha256'] == h.HELPERS['audio-pack.py'] and
           obs['forbiddenAttemptCounts'] == dict(networkOrChild=0, modelWeightOpen=0, inferenceSession=0) and
           obs['noInferenceSessionConstructed'] is True and all(obs[k] is False for k in
               ('modelWeightsOpened', 'networkUsed', 'childProcessStarted', 'mediaGenerated', 'synthesisApproved',
                'policiesModified', 'cacheReuseAuthorized', 'publicationAuthorized')), 'actual_unapproved_linux_observation')
    expected_configs = {a: dict(fileName=v['config']['fileName'], bytes=v['config']['sizeBytes'],
        sha256=v['config']['sha256'], espeakVoice='en', modelSha256=v['model']['sha256']) for a, v in voices['voices'].items()}
    h.need(obs['configs'] == expected_configs and obs['publicCountsVerified'] == dict(words=18767, senses=49992, examples=99984),
           'actual_original_observer_configs_and_public_scope')
    review = value['review']
    h.need(set(review) == {'reviewer', 'expertCertified', 'observationSha256', 'regionalReasons'} and
           review['reviewer'] == 'Codex' and review['expertCertified'] is False and
           review['observationSha256'] == value['observation']['sha256'] and
           set(review['regionalReasons']) == set(h.ACCENTS) and all(isinstance(r, str) and
               15 <= len(r.strip()) <= 4000 and not re.search(r'[\x00-\x1f]', r)
               for r in review['regionalReasons'].values()), 'explicit_current_human_regional_decisions')
    both = all(c['state'] == 'hold' for c in group['accents'].values())
    h.raw_arrays(group['rawTokenSegments'], group['originalPhonemes'], both)
    h.need(obs['emptySegmentIndexes'] == [i for i, p in enumerate(group['rawTokenSegments']) if not p], 'observer_empty_segments_preserved')
    for accent, control in group['accents'].items():
        h.need(set(control) == {'state', 'correction', 'hold'}, 'supplement_explicit_accent')
        record = None
        if control['state'] == 'reviewed-correction':
            checked = h.review_record(control['correction']['record'])
            h.need(checked == control['correction'] and checked['record']['originalPhonemes'] == group['originalPhonemes']
                   and control['hold'] is None, 'supplement_whole_mature_unicode_correction')
            record = checked['record']
        elif control['state'] == 'hold':
            hold_record(h, control['hold'])
            h.need(control['correction'] is None, 'supplement_hold_no_correction')
            record = control['hold']
        else:
            h.need(control['state'] == 'reviewed-retain' and control['correction'] is None and control['hold'] is None,
                   'supplement_explicit_retain_no_default')
        if record is not None:
            h.need(record['textHash'] == SUPPLEMENT_HASH and record['text'] == SUPPLEMENT_TEXT and
                   record['accent'] == accent and (record['learningSenseId'], record['exampleId']) in refs,
                   'supplement_current_all_reference_anchor')
    return dict(base, **{SUPPLEMENT_HASH: group}), obs


def public_scope(h, inputs, targets, controls, base, observation):
    """Verify all current text hashes and this batch's complete public bodies."""
    root = inputs.json(REPO / 'data/learning-senses-collection-v2.manifest.json', 65536, h.PUBLIC_SHA)
    h.need(root['wordCount'] == 18767 and root['senseCount'] == 49992 and root['exampleCount'] == 99984
           and len(root['shards']) == 95, 'fixed_all95_public_collection')
    wanted = {t['textHash']: t for t in targets}
    if observation is not None:
        wanted[SUPPLEMENT_HASH] = controls[SUPPLEMENT_HASH]
    found = {key: [] for key in wanted}
    public_refs, baseline, after_baseline = {}, set(), set()
    totals = [0, 0, 0]
    for index, pin in enumerate(root['shards']):
        manifest = inputs.json(h.relative(REPO / 'data', pin['manifestFileName']), 65536, pin['sha256'], pin['bytes'])
        payload = h.relative(REPO / 'data', manifest['fileName'])
        fd, _, before = inputs.checked_fd(payload, 8 * MIB, manifest['sha256'], manifest['bytes'])
        counts, expanded, digest = [0, 0, 0], 0, hashlib.sha256()
        try:
            with os.fdopen(fd, 'rb', closefd=False) as source:
                with gzip.GzipFile(fileobj=source) as stream:
                    while raw := stream.readline(2 * MIB + 1):
                        expanded += len(raw)
                        h.need(len(raw) <= 2 * MIB and raw.endswith(b'\n') and expanded <= 16 * MIB, 'bounded_public_payload')
                        digest.update(raw)
                        word = h.decode(raw)
                        h.need(set(word) == {'wordId', 'normalizedLemma', 'senses'} and
                               1 <= len(word['senses']) <= 512, 'public_word_shape')
                        counts[0] += 1
                        for sense in word['senses']:
                            counts[1] += 1
                            h.need(sense['wordId'] == word['wordId'] and sense['status'] == 'published' and
                                   1 <= len(sense['examples']) <= 20, 'public_sense_current_parent')
                            for example in sense['examples']:
                                counts[2] += 1
                                h.need(example['wordId'] == word['wordId'] and example['learningSenseId'] == sense['id']
                                       and example['status'] == 'published', 'public_example_current_parent')
                                text = h.normalize(example['exampleEn'])
                                key = h.sha(text)
                                h.need(key in controls or not h.risky(sense, example), 'no_global_unresolved_pronunciation_scope')
                                (baseline if index == 0 else after_baseline).add(key)
                                body = dict(word={k: word[k] for k in ('wordId', 'normalizedLemma')},
                                            sense={k: v for k, v in sense.items() if k != 'examples'}, example=example)
                                ref = dict(wordId=word['wordId'], learningSenseId=sense['id'], exampleId=example['id'],
                                           contentVersion=sense['contentVersion'], bindingHash=sense['bindingHash'], leafIndex=index,
                                           leafManifestSha256=pin['sha256'], payloadSha256=manifest['sha256'],
                                           publicContextSha256=h.sha(h.canonical(body)),
                                           sourceBindingsSha256=h.sha(h.canonical(sense['sourceBindings'])))
                                public_refs.setdefault(key, []).append(reference_fingerprint(h, ref, False))
                                h.need(len(public_refs[key]) <= 3, 'all_public_reference_group_cap')
                                if key not in wanted:
                                    continue
                                h.need(text == wanted[key]['text'], 'selected_current_public_text')
                                found[key].append(dict(reference=ref, publicContext=body))
                                h.need(len(found[key]) <= 3, 'selected_all_public_references_cap')
            h.need(h.identity(before) == h.identity(os.fstat(fd)), 'original_public_payload_fd')
        finally:
            os.close(fd)
        h.need(digest.hexdigest() == manifest['jsonlSha256'] and counts ==
               [manifest['wordCount'], manifest['senseCount'], manifest['exampleCount']] ==
               [pin['wordCount'], pin['senseCount'], pin['exampleCount']], 'whole_public_leaf_hash_counts')
        totals = [a + b for a, b in zip(totals, counts)]
    h.need(totals == [18767, 49992, 99984] and len(public_refs) == 99940 and len(baseline) == 196 and
           not baseline & after_baseline and set(controls) <= set(public_refs), 'complete_public_universe_and_exact196_baseline')
    for group in controls.values():
        current_selection_references(h, group, public_refs, group['textHash'] in base)
    for key, target in wanted.items():
        current = {(item['reference']['learningSenseId'], item['reference']['exampleId']): item['reference'] for item in found[key]}
        h.need(set(current) == h.references(target['references'], key in base), 'every_selected_current_public_reference')
        fields = h.REF_PUBLIC - {'publicContextSha256'} if key in base else h.REF_PUBLIC
        for ref in target['references']:
            h.need(all(ref[k] == current[ref['learningSenseId'], ref['exampleId']][k] for k in fields),
                   'selected_complete_public_context_and_bindings')
    if observation is not None:
        actual = sorted(found[SUPPLEMENT_HASH], key=lambda r: (r['reference']['learningSenseId'], r['reference']['exampleId']))
        h.need(actual == observation['publicContexts'], 'actual_observer_complete_public_bodies_not_claimed_digest')
    return root, public_refs, baseline


def reference_fingerprint(h, ref, reviewed):
    """Two honest product projections; private proof digests stay in controls."""
    common = {key: ref[key] for key in h.REF_PUBLIC - {'publicContextSha256'}}
    return (ref['learningSenseId'], ref['exampleId'], h.sha(h.canonical(common)),
            None if reviewed else h.sha(h.canonical(ref)))


def current_selection_references(h, target, public, reviewed):
    h.references(target['references'], reviewed)
    current = sorted(public[target['textHash']])
    proposed = sorted(reference_fingerprint(h, ref, reviewed) for ref in target['references'])
    h.need(len(current) == len(proposed) and all(a[:3] == b[:3] and (reviewed or a[3] == b[3])
           for a, b in zip(current, proposed)), 'all_selection_complete_current_public_references')


def selection(h, inputs, request, controls, base, public, baseline):
    approval = request['batchApproval']
    h.need(set(approval) == {'approvedPilot', 'selectionManifest', 'selectionLeaf', 'sliceNumber', 'workers', 'supplementalControls'}
           and type(approval['sliceNumber']) is int and approval['sliceNumber'] >= 1 and
           type(approval['workers']) is int and approval['workers'] in (1, 2, 4), 'explicit_batch_approval')
    pilot_pin = approval['approvedPilot']
    h.need(pilot_pin['bytes'] == 12250 and pilot_pin['sha256'] == PILOT_SHA, 'actual_verified_pilot3_pin')
    pilot = inputs.pin(pilot_pin, 256 * 1024)
    h.need(pilot['kind'] == 'nightstudy-ci-sentence-audio-independent-check-v1' and pilot['state'] == 'VERIFIED_PILOT_ONLY'
           and pilot['publicRootSha256'] == h.PUBLIC_SHA and pilot['finalPolicySha256'] == h.FINAL_SHA and
           pilot['generatedPairs'] == pilot['completeMp3EofDecodes'] == pilot['originalWavsFullyRead'] == 16 and
           pilot['heldDenials'] >= 1 and pilot['decoderInputProtocol'] == 'fd' and pilot['seekablePinnedInput'] is True and
           pilot['allCurrentReferencesBound'] is True and pilot['reviewedFrozenRawCallsVerified'] is True and
           pilot['publicationAuthorized'] is False, 'actual_successful_independent_pilot_not_shape_only')
    plan = inputs.pin(approval['selectionManifest'], 2 * MIB)
    fields = {'kind', 'state', 'publicRootSha256', 'finalPolicySha256', 'portableControls', 'supplementalControls',
              'approvedPilot', 'baseline', 'oldUnapprovedCandidateSelection', 'oldUnapprovedCandidates', 'currentCounts',
              'firstJobGroups', 'groupsPerJob', 'taskSentenceCap', 'maxWorkers', 'blockedKeys', 'exclusionLedger',
              'batchWorkerSha256', 'plannerSha256', 'leaves', 'generatedGroups', 'generatedPairs', 'heldExcludedPairs',
              'supplementalHeldExcludedPairs', 'baselineExcludedPairs', 'blockedExcludedPairs'}
    h.need(set(plan) == fields and plan['kind'] == 'nightstudy-ci-audio-fresh-selection-v1' and
           plan['state'] == 'COMPLETE_EXPLICIT_FRESH_SELECTION' and plan['publicRootSha256'] == h.PUBLIC_SHA and
           plan['finalPolicySha256'] == h.FINAL_SHA and plan['portableControls'] == request['portableControls'] and
           plan['supplementalControls'] == approval['supplementalControls'] and plan['approvedPilot'] == pilot_pin and
           plan['oldUnapprovedCandidateSelection'] == 'NOT_SELECTED' and plan['oldUnapprovedCandidates'] == 89880 and
           plan['currentCounts'] == dict(groups=99940, references=99984, pairs=199880) and
           plan['taskSentenceCap'] == 128 and plan['maxWorkers'] == approval['workers'] and
           plan['batchWorkerSha256'] == WORKER_SHA and plan['plannerSha256'] == PLANNER_SHA and
           plan['firstJobGroups'] == 256 and plan['groupsPerJob'] == 1000 and 1 <= len(plan['leaves']) <= 1000,
           'actual_complete_explicit_fresh_selection_not_old_cache_approval')
    h.need(set(plan['baseline']) == {'textManifest', 'audioManifest'}, 'exact_published_baseline_pins')
    collection = inputs.json(REPO / 'data/learning-senses-collection-v2.manifest.json', 65536, h.PUBLIC_SHA)
    leaf0 = collection['shards'][0]
    h.need(plan['baseline']['textManifest'] == dict(fileName='data/' + leaf0['manifestFileName'],
           bytes=leaf0['bytes'], sha256=leaf0['sha256']), 'exact_current_published35_text_leaf')
    text = inputs.pin(plan['baseline']['textManifest'], 65536)
    audio = inputs.pin(plan['baseline']['audioManifest'], 65536)
    h.need(text['id'] == 'learning-senses-v1' and text['wordCount'] == 35 and text['senseCount'] == 98 and
           text['exampleCount'] == 196 and text['sha256'] == '1984c9aedcd97241ee50d90ee34b68da1542c55ecd17a281af9bb3e5c03182db' and
           plan['baseline']['audioManifest']['fileName'] == 'data/sentence-audio-v3.manifest.json' and
           audio['id'] == audio['version'] == 'sentence-audio-v3' and audio['lemmaCount'] == 196 and audio['entryCount'] == 392 and
           audio['source']['sha256'] == '74f7ab46ed20b64014a253bdbca3110c7c80f13de77b0b430a41b14457f021c0', 'immutable_published196_392_baseline')
    blocked = {}
    for row in plan['blockedKeys']:
        h.need(set(row) == {'textHash', 'accent', 'reason'} and row['textHash'] in public and row['accent'] in h.ACCENTS
               and isinstance(row['reason'], str) and 15 <= len(row['reason'].strip()) <= 4000, 'explicit_current_blocked_key')
        key = row['textHash'], row['accent']
        h.need(key not in blocked, 'duplicate_blocked_key')
        blocked[key] = 'pending-explicit'
    if approval['supplementalControls'] is None:
        h.need({(SUPPLEMENT_HASH, a) for a in h.ACCENTS} <= set(blocked), 'known_contrasts_both_keys_stay_blocked')
    held = {(key, a): 'hold' for key, group in base.items() for a in h.ACCENTS if group['accents'][a]['state'] == 'hold'}
    additional = {(key, a): 'supplemental-hold' for key, group in controls.items() if key not in base
                  for a in h.ACCENTS if group['accents'][a]['state'] == 'hold'}
    published = {(key, a): 'published-baseline-exact-current-refs' for key in baseline for a in h.ACCENTS}
    exclusions = {}
    for part in (held, additional, blocked, published):
        h.need(not set(exclusions) & set(part), 'disjoint_hold_pending_published_exclusions')
        exclusions.update(part)
    for key in baseline & set(controls):
        h.need(all(control['state'] == 'reviewed-retain' for control in controls[key]['accents'].values()),
               'published_baseline_cannot_hide_new_correction')
    raw = inputs.read(h.relative(REPO, plan['exclusionLedger']['fileName']), 4 * MIB,
                      plan['exclusionLedger']['sha256'], plan['exclusionLedger']['bytes'])
    actual = {}
    h.need(raw.endswith(b'\n'), 'complete_exclusion_jsonl')
    for line in raw.splitlines():
        h.need(len(line) <= 16384, 'bounded_exclusion_line')
        row = h.decode(line)
        key = row['textHash'], row['accent']
        h.need(set(row) == {'textHash', 'accent', 'decision'} and key not in actual, 'unique_complete_exclusion_row')
        actual[key] = row['decision']
    h.need(actual == exclusions and len(held) == plan['heldExcludedPairs'] == 79 and
           len(additional) == plan['supplementalHeldExcludedPairs'] and len(published) == plan['baselineExcludedPairs'] == 392 and
           len(blocked) == plan['blockedExcludedPairs'], 'every_current_excluded_pair_independently_accounted')
    previous, groups, pairs, read_bytes = '', 0, 0, 0
    selected = None
    for number, leaf in enumerate(plan['leaves'], 1):
        h.need(set(leaf) == {'sliceNumber', 'fileName', 'bytes', 'sha256', 'groups', 'pairs', 'firstTextHash', 'lastTextHash'}
               and leaf['sliceNumber'] == number and type(leaf['groups']) is int and type(leaf['pairs']) is int and
               1 <= leaf['groups'] <= (256 if number == 1 else 1000) and
               leaf['groups'] <= leaf['pairs'] <= 2 * leaf['groups'] and
               (number == len(plan['leaves']) or leaf['groups'] == (256 if number == 1 else 1000)) and
               previous < leaf['firstTextHash'] <= leaf['lastTextHash'], 'ordered_disjoint_fixed_selection_leaves')
        pin = {k: leaf[k] for k in ('fileName', 'bytes', 'sha256')}
        rows = inputs.pin(pin, 8 * MIB)
        read_bytes += pin['bytes']
        h.need(read_bytes <= 512 * MIB and isinstance(rows, list) and len(rows) == leaf['groups'] and
               rows[0]['textHash'] == leaf['firstTextHash'] and rows[-1]['textHash'] == leaf['lastTextHash'], 'bounded_whole_selection_leaf')
        local_pairs = 0
        for target in rows:
            key = target['textHash']
            h.need(set(target) == {'textHash', 'text', 'references', 'accents'} and previous < key and key in public and
                   h.normalize(target['text']) == target['text'] and h.sha(target['text']) == key and
                   target['accents'] in (['US'], ['UK'], ['US', 'UK']), 'all_selection_current_unique_target')
            current_selection_references(h, target, public, key in base)
            if key in controls:
                h.need(target['text'] == controls[key]['text'] and target['references'] == controls[key]['references'],
                       'all_selected_reviewed_full_context_references')
            h.need(all((key, a) not in exclusions for a in target['accents']), 'excluded_pair_never_generated')
            previous = key
            local_pairs += len(target['accents'])
        h.need(local_pairs == leaf['pairs'], 'whole_leaf_accent_pair_count')
        groups += len(rows)
        pairs += local_pairs
        if number == approval['sliceNumber']:
            h.need(pin == approval['selectionLeaf'] and rows == request['targets'], 'actual_whole_approved_batch_leaf')
            selected = leaf
    h.need(selected is not None and groups == plan['generatedGroups'] and pairs == plan['generatedPairs'] and
           pairs + len(exclusions) == 199880, 'complete_current_pair_universe_no_opaque_summary')
    return plan, exclusions, selected


def expected_targets(h, request, controls, base, voices, exclusions):
    h.need(set(request) == {'kind', 'mode', 'packId', 'portableControls', 'voicesManifest', 'publicRootSha256',
           'finalPolicySha256', 'targets', 'holdChecks', 'batchApproval'} and
           request['kind'] == 'nightstudy-ci-sentence-audio-request-v1' and request['mode'] == 'batch' and
           request['publicRootSha256'] == h.PUBLIC_SHA and request['finalPolicySha256'] == h.FINAL_SHA and
           re.fullmatch('sentence-audio-v4-[0-9]{4}', request['packId']) and not request['packId'].endswith('-0000') and
           1 <= len(request['targets']) <= 1000 and 1 <= len(request['holdChecks']) <= 79, 'exact_bounded_batch_request')
    expected, identities, denials, previous = {}, [], [], ''
    for target in request['targets']:
        key, text = target['textHash'], target['text']
        h.need(previous < key and 15 <= len(text) <= 4000 and h.sha(text) == key and h.normalize(text) == text and
               target['accents'] in (['US'], ['UK'], ['US', 'UK']), 'ordered_current_batch_target')
        previous = key
        group = controls.get(key)
        h.references(target['references'], key in base)
        for accent in target['accents']:
            h.need((key, accent) not in exclusions, 'no_held_blocked_or_published_baseline_generation')
            control = group['accents'][accent] if group else None
            h.need(control is None or control['state'] != 'hold', 'active_hold_before_identity')
            correction = control['correction'] if control else None
            voice = voices['voices'][accent]
            identity = h.sha(h.canonical(dict(text=text, accent=accent, engine='1.8.0', generator='audio-v1',
                         model=voice['model']['sha256'], config=voice['config']['sha256']), True))
            corrected = dict(baseSynthesisIdentity=identity, pronunciationCorrectionSha256=correction['sha256']) if correction else None
            if correction and len(correction['correctedPhonemes']) > 1:
                corrected['renderPolicy'] = 'piper-raw-per-sentence-wav-v1'
            row = dict(textHash=key, accent=accent, baseSynthesisIdentity=identity,
                       cacheKey=h.sha(h.canonical(corrected)) if corrected else identity,
                       route='frozen-reviewed-raw-per-sentence' if group else 'linux-original-text',
                       correctionSha256=correction['sha256'] if correction else None,
                       referencesSha256=h.sha(h.canonical(target['references'])))
            identities.append(row)
            expected[key, accent] = dict(identity=row, target=target, group=group, correction=correction)
    seen = set()
    for row in request['holdChecks']:
        key = row['textHash'], row['accent']
        h.need(set(row) == {'textHash', 'accent'} and key not in seen and key not in expected and
               key[0] in controls and controls[key[0]]['accents'][key[1]]['state'] == 'hold', 'exact_batch_active_hold_denial')
        seen.add(key)
        denials.append(dict(textHash=key[0], accent=key[1], decision='hold', hold=controls[key[0]]['accents'][key[1]]['hold'],
                            modelLoaded=False, mediaGenerated=False))
    h.need(1 <= len(expected) <= 2000, 'batch_pair_cap')
    return expected, identities, denials


def execution_metadata(h, expected, workers):
    tasks, subsets = [], {}
    for accent in h.ACCENTS:
        hashes = sorted(key for key, a in expected if a == accent)
        for ordinal, start in enumerate(range(0, len(hashes), 128)):
            keys = hashes[start:start + 128]
            task = 'bounded-v1-' + accent + '-%06d-' % ordinal + h.sha(h.canonical(
                dict(policy='bounded-spawn-tasks-v1', accent=accent, textHashes=keys), True))
            tasks.append(dict(id=task, accent=accent, sentenceCount=len(keys)))
            subsets[task] = {(key, accent): expected[key, accent] for key in keys}
    return dict(policy='bounded-spawn-tasks-v1', workerBatchSize=128, maxTasksPerChild=1, maxWorkers=workers,
                maximumInFlightTasks=min(workers, len(tasks)), poolLifecycle='new-spawn-pool-per-wave; join-before-next-wave',
                taskOrder='US-then-UK-textHash-contiguous-v1', taskIdentity='sha256-of-policy-accent-ordered-textHashes-v1',
                taskCount=len(tasks), tasks=tasks), subsets


def cloud_admission(h, admission, workers):
    h.need(set(admission) == {'cpuCount', 'memAvailableBytes', 'workers', 'threadsPerVoice', 'fourWorkersRequireAvailableBytes'}
           and type(admission['cpuCount']) is int and admission['cpuCount'] >= workers and
           type(admission['memAvailableBytes']) is int and admission['memAvailableBytes'] > 0 and
           admission['workers'] == workers and admission['threadsPerVoice'] == 1 and
           admission['fourWorkersRequireAvailableBytes'] == 8 * 1024 ** 3 and
           (workers != 4 or admission['memAvailableBytes'] >= 8 * 1024 ** 3), 'actual_explicit_cloud_resource_admission')


def verify(args):
    h, helper_identity = load_helpers()
    inputs = h.Inputs()
    inputs.identities[HELPER] = helper_identity
    request = inputs.json(args.request.absolute(), 8 * MIB, args.request_sha256)
    h.need(request['mode'] == 'batch' and request['voicesManifest']['fileName'] == 'data/audio-voices.manifest.json' and
           request['voicesManifest']['sha256'] == h.VOICES_SHA and request['portableControls']['bytes'] == 8216309 and
           request['portableControls']['sha256'] == BASE_CONTROLS_SHA, 'actual_unchanged_base_controls_and_voices')
    voices = inputs.pin(request['voicesManifest'], 65536)
    base = h.controls_index(inputs.pin(request['portableControls'], 64 * MIB))
    controls, observation = supplement(h, inputs, request['batchApproval']['supplementalControls'], base, voices)
    _, public, baseline = public_scope(h, inputs, request['targets'], controls, base, observation)
    plan, exclusions, leaf = selection(h, inputs, request, controls, base, public, baseline)
    expected, identities, denials = expected_targets(h, request, controls, base, voices, exclusions)
    workers = request['batchApproval']['workers']
    execution, subsets = execution_metadata(h, expected, workers)
    root = args.output.absolute()
    h.need(root.resolve() == root and root.is_dir(), 'real_generated_batch_output')
    read = lambda name, cap=16 * MIB: inputs.json(h.relative(root, name), cap)
    build = read('build-receipt.json')
    h.need(build['kind'] == 'nightstudy-ci-audio-generated-v1' and build['state'] == 'GENERATED_REQUIRES_INDEPENDENT_CHECK' and
           build['requestSha256'] == args.request_sha256 and build['workerSourceSha256'] == WORKER_SHA and
           build['publicRootSha256'] == h.PUBLIC_SHA and build['finalPolicySha256'] == h.FINAL_SHA and
           build['generatedPairs'] == len(expected) and build['holdDenials'] == len(denials) and
           build['independentFullDecodePassed'] is False and build['publicationAuthorized'] is False, 'actual_unapproved_batch_result')
    inputs.read(REPO / 'scripts/ci-sentence-audio-batch.py', 128 * 1024, WORKER_SHA)
    inputs.read(REPO / 'scripts/prepare-ci-sentence-audio-batch.py', 128 * 1024, PLANNER_SHA)
    pins = {}
    h.need(isinstance(build['files'], list) and len(build['files']) <= 5000, 'bounded_batch_artifact_count')
    for pin in build['files']:
        h.need(set(pin) == {'fileName', 'bytes', 'sha256'} and pin['fileName'] not in pins and
               type(pin['bytes']) is int and 0 < pin['bytes'] <= 16 * MIB and h.digest(pin['sha256']), 'exact_unique_batch_artifact_pin')
        fd, _, _ = inputs.checked_fd(h.relative(root, pin['fileName']), 16 * MIB, pin['sha256'], pin['bytes'])
        os.close(fd)
        pins[pin['fileName']] = pin
    h.need(read('request.json') == request and read('expected-identities.json') == identities and read('held-denials.json') == denials,
           'whole_batch_request_identity_and_denials')
    start, sources, manifest = read('build-start.json'), read('sources.manifest.json'), read('manifest.json')
    admission = start['cloudResourceAdmission']
    cloud_admission(h, admission, workers)
    h.need(start['kind'] == 'nightstudy-ci-audio-start-v1' and start['requestSha256'] == args.request_sha256 and
           type(start['parentPid']) is int and start['parentPid'] > 1 and type(start['parentPgid']) is int and start['parentPgid'] > 1 and
           start['buildExecution'] == execution and start['threadsPerVoice'] == 1 and start['modelsDownloaded'] is False and
           start['heldDenialCount'] == len(denials) and start['publicationAuthorized'] is False and
           start['journalReusePolicy'] == JOURNAL_POLICY, 'actual_bounded_batch_start')
    h.need(sources['schemaVersion'] == 2 and sources['version'] == request['packId'] and sources['meaningPackId'] == 'learning-senses-collection-v2'
           and sources['meaningPackSha256'] == h.PUBLIC_SHA and sources['meaningPackIdentityKind'] == 'collection-manifest-sha256' and
           sources['engineSource'] == voices and sources['portableControls'] == request['portableControls'] and
           sources['finalPolicySha256'] == h.FINAL_SHA and sources['requestedSentences'] == request['targets'] and
           sources['baselinePacks'] == [] and sources['reusedMediaReferences'] == [] and sources['buildExecution'] == execution and
           sources['frozenRetainedRawUsesBaseIdentity'] is True and sources['publicationAuthorized'] is False and
           sources['helperSha256'] == h.HELPERS and sources['batchApproval'] == request['batchApproval'] and
           sources['pilotWorkerSourceSha256'] == PILOT_WORKER_SHA and sources['oldUnapprovedCandidateSelection'] == 'NOT_SELECTED' and
           sources['journalReusePolicy'] == JOURNAL_POLICY and
           sources['buildRuntime']['packages']['piper-tts'] == '1.8.0', 'entire_batch_sources_no_old_media_selected')
    for name, checksum in h.HELPERS.items():
        inputs.read(h.relative(REPO / 'scripts', name), 128 * 1024, checksum)
    ffmpeg = args.ffmpeg.absolute()
    fd, ffmpeg_sha, _ = inputs.checked_fd(ffmpeg, 128 * MIB)
    os.close(fd)
    h.need(sources['transcodingTool']['executableSha256'] == ffmpeg_sha and
           sources['transcodingTool']['executableSizeBytes'] == ffmpeg.stat().st_size, 'actual_recorded_fd_decoder_binary')
    h.need(manifest['schemaVersion'] == 2 and manifest['version'] == request['packId'] and manifest['status'] == 'ready' and
           manifest['sourceManifestSha256'] == pins['sources.manifest.json']['sha256'] and manifest['statistics'] ==
           dict(lemmaCount=len(request['targets']), entryCount=len(expected), recordedCount=0, synthesizedCount=len(expected), failedCount=0),
           'whole_batch_manifest')
    entries = manifest['entries']
    h.need(len(entries) == len(expected) and entries == sorted(entries, key=lambda e: (e['textHash'], e['accent'])) and
           {(e['textHash'], e['accent']) for e in entries} == set(expected), 'all_batch_pairs_no_held_or_baseline_extra')
    task_names, progress_names, pids = set(), set(), set()
    for task in execution['tasks']:
        name = 'routes/' + task['id'] + '.jsonl'
        raw = inputs.read(h.relative(root, name), 16 * MIB)
        lines = raw.splitlines()
        h.need(raw.endswith(b'\n') and 1 <= len(lines) <= 1280 and all(0 < len(line) <= 256 * 1024 for line in lines), 'complete_bounded_task_routes')
        pid = h.validate_routes([h.decode(line) for line in lines], subsets[task['id']], task, start['parentPgid'])
        h.need(pid not in pids and pid != start['parentPid'], 'fresh_task_worker_pid')
        pids.add(pid)
        task_names.add(name)
        journal = 'progress/' + task['accent'] + '-' + task['id'] + '.jsonl'
        records = [h.decode(line) for line in inputs.read(h.relative(root, journal), 16 * MIB).splitlines()]
        keys = set(subsets[task['id']])
        h.need(records == [e for e in entries if (e['textHash'], e['accent']) in keys], 'whole_task_progress_exact_entries')
        progress_names.add(journal)
    media, files = [], set()
    for entry in entries:
        key = entry['textHash'], entry['accent']
        selected, voice = expected[key], voices['voices'][key[1]]
        correction = selected['correction']
        h.need(entry['text'] == entry['lemma'] == selected['target']['text'] and entry['cacheKey'] == selected['identity']['cacheKey'] and
               entry['kind'] == 'synthesized' and entry['engineVersion'] == '1.8.0' and entry['inferenceBackend'] == 'CPUExecutionProvider' and
               entry['voiceModelSha256'] == voice['model']['sha256'] and entry['voiceConfigSha256'] == voice['config']['sha256'] and
               all(entry[k] == voice[k] for k in ('sourceName', 'sourceUrl', 'license', 'attribution')), 'batch_entry_current_voice_and_cache_identity')
        if correction:
            h.need(entry['pronunciationCorrectionSha256'] == correction['sha256'] and entry['pronunciationCorrectionId'] == correction['record']['id'],
                   'batch_whole_correction_identity')
        else:
            h.need('pronunciationCorrectionSha256' not in entry and 'pronunciationCorrectionId' not in entry, 'no_base_or_retain_invented_correction')
        h.need(h.digest(entry['fileSha256']) and h.digest(entry['originalFileSha256']) and
               entry['fileKey'] == 'files/' + entry['fileSha256'] + '.mp3' and entry['mimeType'] == 'audio/mpeg' and
               entry['originalMimeType'] == 'audio/wav' and entry['sampleRate'] == 22050 and entry['channels'] == 1 and
               entry['sampleWidthBytes'] == 2, 'content_addressed_native_batch_assets')
        original = 'files/' + entry['originalFileSha256'] + '.wav'
        files.update((original, entry['fileKey']))
        fd, _, _ = inputs.checked_fd(h.relative(root, original), 2 * MIB, entry['originalFileSha256'])
        try:
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                pcm = h.complete_wav(stream)
        finally:
            os.close(fd)
        h.need(abs(len(pcm) / 44100 - entry['durationSeconds']) <= .000001, 'whole_batch_original_wav_duration')
        original_metrics = h.pcm_metrics(pcm)
        del pcm
        metrics = h.decode_mp3(inputs, h.relative(root, entry['fileKey']), entry['fileSha256'], entry['sizeBytes'], ffmpeg, root)
        h.need(abs(metrics['decodedDurationSeconds'] - entry['decodedDurationSeconds']) <= .000001 and
               abs(metrics['decodedDurationSeconds'] - entry['durationSeconds']) <= .2, 'whole_batch_decoded_duration')
        for name, value in metrics.items():
            h.need(abs(value - entry['qualityMetrics'][name]) <= (.002 if name == 'rmsDbfs' else .000001), 'batch_full_decode_metric:' + name)
        quality = entry['qualityMetrics']
        h.need(quality['policyVersion'] == 1 and quality['sampleRate'] == 22050 and quality['channels'] == 1 and
               quality['timeStretchApplied'] is False and quality['silenceTrimApplied'] is False, 'batch_independent_quality_policy')
        media.append(dict(textHash=key[0], accent=key[1], fileSha256=entry['fileSha256'], originalWavSha256=entry['originalFileSha256'],
                          cacheKey=entry['cacheKey'], originalWavMetrics=original_metrics, metrics=metrics))
    fixed = {'request.json', 'expected-identities.json', 'held-denials.json', 'build-start.json', 'sources.manifest.json', 'manifest.json'}
    h.need(set(pins) == fixed | files | task_names and {p.relative_to(root).as_posix() for p in (root / 'files').iterdir()} == files and
           {p.relative_to(root).as_posix() for p in (root / 'routes').iterdir()} == task_names and
           {p.relative_to(root).as_posix() for p in (root / 'progress').iterdir()} == progress_names and
           {p.name for p in root.iterdir()} == fixed | {'files', 'routes', 'progress', 'build-receipt.json'}, 'entire_batch_artifact_closure')
    build_raw = inputs.read(root / 'build-receipt.json', 16 * MIB)
    checker_sha = h.sha(inputs.read(Path(__file__).absolute(), 128 * 1024))
    inputs.unchanged()
    return dict(kind='nightstudy-ci-sentence-audio-batch-independent-check-v1', state='VERIFIED_SELECTED_BATCH_ONLY',
                requestSha256=args.request_sha256, publicRootSha256=h.PUBLIC_SHA, finalPolicySha256=h.FINAL_SHA,
                batchApproval=request['batchApproval'], selectedLeafGroups=leaf['groups'], generatedPairs=len(expected), heldDenials=len(denials),
                generatedManifest=pins['manifest.json'], generatedSources=pins['sources.manifest.json'],
                generationReceipt=dict(fileName='build-receipt.json', bytes=len(build_raw), sha256=h.sha(build_raw)),
                batchWorkerSha256=WORKER_SHA, checkerSourceSha256=checker_sha, purePilotHelperSha256=HELPER_SHA,
                journalReusePolicy=JOURNAL_POLICY,
                allCurrentReferencesBound=True, selectionPairUnionVerified=True, oldUnapprovedCandidateSelection='NOT_SELECTED',
                oldUnapprovedCandidates=89880, excludedBaselinePairs=392, taskSentenceCap=128, workers=workers, threadsPerVoice=1,
                completeMp3EofDecodes=len(media), originalWavsFullyRead=len(media), decoderThreads=1, decoderBinarySha256=ffmpeg_sha,
                decoderInputProtocol='fd', seekablePinnedInput=True, reviewedFrozenRawCallsVerified=True,
                baseFrontendObservationsArePrechecksOnly=True, media=media, expertCertified=False, listened=False, publicationAuthorized=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('request', 'output', 'ffmpeg', 'receipt'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--request-sha256', required=True)
    args = parser.parse_args()
    if not sys.platform.startswith('linux') or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('cloud_linux_batch_checker_only')
    h, _ = load_helpers()
    original = __import__
    import builtins
    def safe_import(name, *rest, **kwargs):
        h.need(not any(name == p or name.startswith(p + '.') for p in h.FORBIDDEN), 'no_batch_model_or_network_import')
        return original(name, *rest, **kwargs)
    h.need(not any(any(n == p or n.startswith(p + '.') for p in h.FORBIDDEN) for n in sys.modules), 'no_preloaded_batch_model_or_network')
    builtins.__import__ = safe_import
    def audit(event, values):
        h.need(not event.startswith('socket.'), 'no_batch_checker_network')
        if event == 'open' and values and isinstance(values[0], (str, bytes, os.PathLike)):
            h.need(not os.fsdecode(values[0]).lower().endswith(('.onnx', '.onnx.json', '.pt', '.pth', '.gguf', '.safetensors')),
                   'no_batch_checker_model_config_or_weights')
    sys.addaudithook(audit)
    sys.dont_write_bytecode = True
    receipt = args.receipt.absolute()
    h.need(h.digest(args.request_sha256) and not os.path.lexists(receipt) and receipt.parent.resolve() == receipt.parent, 'fresh_batch_check_receipt')
    result = verify(args)
    raw = (h.canonical(result) + '\n').encode()
    h.need(len(raw) <= 16 * MIB, 'bounded_batch_check_receipt')
    fd = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    print(h.canonical(dict(state=result['state'], generatedPairs=result['generatedPairs'],
                           completeMp3EofDecodes=result['completeMp3EofDecodes'], publicationAuthorized=False)))


if __name__ == '__main__':
    main()
