#!/usr/bin/env python3
"""Close explicit completed media evidence and stage a complete v4 collection.

Only small JSON entities and the current public text are read. Original WAV
archives, generation manifests/sources and installer archives are not reopened:
their declarations are bound through the actual independent check receipts.
Output is fresh staging outside data, never an installation or publication.
"""
from pathlib import Path
import argparse
import hashlib
import math
import os
import re
import stat
import struct
import sys
import types

REPO = Path(__file__).resolve().parent.parent
MIB = 1048576
PURE = ('scripts/check-ci-sentence-audio-batch.py', 44043,
        '16fbaf7f522a0f26382a923df7670b623fa49df4f82a8b6b225f1e2af71913d8')
QUALIFIER = ('scripts/qualify-ci-legacy-sentence-reuse.py', 17406,
             '2cd9ac702dff5c3023909e80452098ef395cde3d0286085641d0aa37b0eb75d3')
FRESH_INSTALLER_SHA = '53112b8094452a3a4db53fb6920b1fc70fbffdbe141bd996af454d470b5652f1'
CONVERTER_SHA = '4d2cac9b8ff5bf6d07fed7b033ebb02834e4d8b5eaa30ed31319c101651e6715'
# Actual formatted source from successful model-free cloud run 39239400533.
SELECTED_INSTALLER_SHA = '8fc66e9eba8356ccf2035f0215d986c385b997b0db6456ffe55b18be981b0c01'
HOLD_SHA = '138e3923cccc0a2b77f4dc0d2da38e9d24c5fd336e26a4b83bfa274c679129e3'
HOLD_MANIFEST_SHA = 'f61bdf164dbeb594c8ee45d91e3996a97e2aee8537ef297ddafd0f3b6344e956'
OVERLAP_SHA = '48425b09c5837edd2c9be3bf19fa438570adf830cd3c1302e9807db54356ef5c'
ENTRY_HASH_RECIPE = 'typed-json-ieee754be-v1'
INSTALLER_HELPERS = {
    'check-audio-install.mjs': '632099b70041c27201c88abf6a14bd77d8723fcfdb471b92b9af1f43da6f8fec',
    'check-sentence-audio-policy.mjs': 'f095bce8ed7c5bb7687e1b85576de559f1713b1ec7435b022ea55e1832c53165',
    'audio-extract.py': 'ccfe7e54a54882d15429d10e1aa21d00713f5e53a703a35858628701c24098fa',
}


def full_entry_sha(h, entry):
    """Hash complete JSON values consistently across Python and JavaScript."""
    def typed(value, depth=0):
        h.need(depth <= 128, 'entry_hash_json_depth')
        if value is None:
            return ['null']
        if type(value) is bool:
            return ['boolean', value]
        if isinstance(value, str):
            value.encode('utf-8')
            return ['string', value]
        if type(value) in (int, float):
            h.need(math.isfinite(value) and abs(value) <= 2 ** 53 - 1, 'entry_hash_finite_safe_number')
            return ['number', struct.pack('>d', float(value)).hex()]
        if isinstance(value, list):
            return ['array', [typed(item, depth + 1) for item in value]]
        h.need(isinstance(value, dict) and all(isinstance(key, str) for key in value), 'entry_hash_json_type')
        return ['object', [[key, typed(value[key], depth + 1)] for key in sorted(value, key=lambda key: key.encode('utf-8'))]]
    return h.sha(h.canonical(typed(entry)))


def load_source(spec):
    path, size, expected = spec
    file = REPO / path
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    sig = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    try:
        before = os.fstat(fd)
        if file.resolve() != file or not stat.S_ISREG(before.st_mode) or before.st_size != size:
            raise ValueError('fixed_global_helper_size')
        raw = os.read(fd, 128 * 1024 + 1)
        if len(raw) != size or os.read(fd, 1) or hashlib.sha256(raw).hexdigest() != expected or \
                sig(before) != sig(os.fstat(fd)) or sig(before) != sig(os.lstat(file)):
            raise ValueError('fixed_global_helper_hash_identity')
        module = types.ModuleType('_global_' + file.stem.replace('-', '_'))
        module.__file__ = str(file)
        exec(compile(raw, str(file), 'exec'), module.__dict__)
        return module, file, sig(before)
    finally:
        os.close(fd)


def valid_pin(h, value, cap=16 * MIB):
    h.need(isinstance(value, dict) and set(value) == {'fileName', 'bytes', 'sha256'} and
           isinstance(value['fileName'], str) and type(value['bytes']) is int and 0 < value['bytes'] <= cap and
           h.digest(value['sha256']), 'global_exact_pin')
    h.relative(REPO, value['fileName'])
    return value


def same_bytes(h, left, right, reason):
    valid_pin(h, left, 2 * 1024 ** 3)
    valid_pin(h, right, 2 * 1024 ** 3)
    h.need(left['bytes'] == right['bytes'] and left['sha256'] == right['sha256'], reason)


def entity(h, inputs, pin, cap=16 * MIB):
    valid_pin(h, pin, cap)
    raw = inputs.read(h.relative(REPO, pin['fileName']), cap, pin['sha256'], pin['bytes'])
    return h.decode(raw), raw


def pair(row):
    return row['textHash'], row['accent']


def unique_rows(h, rows, reason):
    h.need(isinstance(rows, list), reason)
    result = {}
    for row in rows:
        key = pair(row)
        h.need(key not in result and h.digest(key[0]) and key[1] in h.ACCENTS, reason)
        result[key] = row
    return result


def policy(h, inputs, pins, controls):
    h.need(set(pins) == {'manifest', 'payload'}, 'global_hold_input_fields')
    manifest, raw_manifest = entity(h, inputs, pins['manifest'], MIB)
    value, raw = entity(h, inputs, pins['payload'], 4 * MIB)
    h.need(h.sha(raw_manifest) == HOLD_MANIFEST_SHA and len(raw_manifest) == 375 and h.sha(raw) == HOLD_SHA and len(raw) == 80987 and
           manifest == dict(formatVersion=1, id='sentence-audio-holds-v1', fileName='sentence-audio-holds-v1.json',
               bytes=80987, sha256=HOLD_SHA, holdCount=79, learningSensesManifestFileName='learning-senses-collection-v2.manifest.json',
               learningSensesManifestSha256=h.PUBLIC_SHA) and set(value) == {'formatVersion', 'id', 'entries'} and
           value['formatVersion'] == 1 and value['id'] == 'sentence-audio-holds-v1', 'unchanged_whole_global79_policy')
    held = unique_rows(h, value['entries'], 'unique_global_holds')
    expected = {(key, a): c['hold'] for key, group in controls.items() for a, c in group['accents'].items() if c['state'] == 'hold'}
    h.need(held == expected and len(held) == 79, 'exact_all_current79_holds_not_pack_subsets')
    by_text = {}
    for key, record in held.items():
        h.policy_record(record, 'sentence-audio-hold-', 'hold')
        by_text[key[0]] = by_text.get(key[0], 0) + 1
    h.need(sum(n == 2 for n in by_text.values()) == 18 and sum(n == 1 for n in by_text.values()) == 43,
           'actual18_fully_held_and43_partial_texts')
    return held, raw_manifest, raw


def read_legacy(h, inputs, inventory, voices):
    h.need(isinstance(inventory, list) and len(inventory) == 3, 'all3_immutable_legacy_manifests')
    old, descriptors = {}, {}
    for number, item in enumerate(inventory, 1):
        pack = 'sentence-audio-v%d' % number
        h.need(set(item) == {'packId', 'descriptor', 'manifest', 'sources'} and item['packId'] == pack, 'explicit_legacy_pack_order')
        descriptor, _ = entity(h, inputs, item['descriptor'], MIB)
        manifest, _ = entity(h, inputs, item['manifest'], 64 * MIB)
        sources, _ = entity(h, inputs, item['sources'], 32 * MIB)
        h.need(descriptor['id'] == descriptor['version'] == manifest['version'] == sources['version'] == pack and
               descriptor['status'] == manifest['status'] == 'ready' and
               descriptor['manifestSha256'] == item['manifest']['sha256'] and
               descriptor['sourceManifestSha256'] == item['sources']['sha256'] == manifest['sourceManifestSha256'] and
               len(manifest['entries']) == descriptor['entryCount'] and sources['engineSource'] == voices,
               'whole_immutable_legacy_source_identity')
        fixed_name = 'sentence-audio.manifest.json' if number == 1 else pack + '.manifest.json'
        fixed = inputs.json(REPO / 'data' / fixed_name, MIB)
        h.need(fixed == descriptor, 'same_committed_legacy_descriptor')
        descriptors[pack] = descriptor
        local = unique_rows(h, manifest['entries'], 'unique_legacy_manifest_entries')
        h.need(not set(old) & set(local), 'legacy_packs_must_stay_disjoint')
        for key, entry in local.items():
            h.need(h.normalize(entry['text']) == entry['text'] and h.sha(entry['text']) == key[0], 'legacy_exact_text')
            old[key] = dict(entry=entry, baseline=dict(id=pack, manifestSha256=descriptor['manifestSha256'],
                sourceManifestSha256=descriptor['sourceManifestSha256']))
    return old, descriptors


def qualified_reuse(m, q, h, inputs, inv, public, controls, voices, old, actual_selection):
    overlap, _ = entity(h, inputs, inv['legacyOverlap'], 8 * MIB)
    h.need(inv['legacyOverlap']['sha256'] == OVERLAP_SHA and inv['legacyOverlap']['bytes'] == 3387333, 'fixed_actual424_overlap')
    rows = q.report_scope(h, overlap)
    targets, _ = q.current_rows(h, rows, controls, voices)
    for target in targets:
        m.current_selection_references(h, target, public, False)
    h.need(set(inv['legacyQualification']) == {'receipt', 'selection'}, 'global_reuse_inputs')
    qual, _ = entity(h, inputs, inv['legacyQualification']['receipt'], 8 * MIB)
    selected, _ = entity(h, inputs, inv['legacyQualification']['selection'], 8 * MIB)
    h.need(qual['kind'] == 'nightstudy-ci-official-legacy-reuse-qualification-v1' and qual['state'] == 'VERIFIED_OFFICIAL32_MP3_REUSE_ONLY' and
           qual['checkerSourceSha256'] == QUALIFIER[2] and qual['pureBatchHelperSha256'] == PURE[2] and qual['pureDecoderHelperSha256'] == m.HELPER_SHA and
           qual['publicRootSha256'] == h.PUBLIC_SHA and qual['finalPolicySha256'] == h.FINAL_SHA and qual['actualSelection'] == actual_selection and
           qual['groups'] == 16 and qual['pairs'] == qual['completeMp3EofDecodes'] == 32 and qual['decoderThreads'] == 1 and
           qual['decoderInputProtocol'] == 'fd' and qual['seekablePinnedInput'] is True and qual['all32Passed'] is True and
           qual['originalWavsRevalidated'] == 0 and qual['authorizedForReuse'] is True and qual['publicationAuthorized'] is False and
           qual['currentIdentityMatchesEveryOldEntry'] is True and qual['activeHoldOverlapPairs'] == 0 and qual['modelsUsed'] is False,
           'actual_all32_full_eof_qualification')
    h.need(selected['kind'] == 'nightstudy-ci-official-legacy-reuse-selection-v1' and selected['state'] == 'APPROVED_EXACT32_OFFICIAL_REUSE_ONLY' and
           selected['publicRootSha256'] == h.PUBLIC_SHA and selected['finalPolicySha256'] == h.FINAL_SHA and selected['actualSelection'] == actual_selection and
           selected['groups'] == 16 and selected['pairs'] == 32 and selected['entries'] == qual['entries'] and
           selected['authorizedForReuse'] is True and selected['publicationAuthorized'] is False and selected['newGenerationProofUnchanged'] is True,
           'explicit32_selection_binds_whole_qualification')
    same_bytes(h, selected['qualification'], inv['legacyQualification']['receipt'], 'selected_qualification_exact_pin')
    same_bytes(h, selected['report'], inv['legacyOverlap'], 'selected_actual_overlap_exact_pin')
    same_bytes(h, qual['report'], inv['legacyOverlap'], 'qualification_actual_overlap_exact_pin')
    q.complete_qualification(h, selected['entries'])
    approved = unique_rows(h, selected['entries'], 'approved32_unique_entries')
    h.need(set(approved) == {pair(row) for row in rows}, 'approved32_exact_inventory_scope')
    for key, row in approved.items():
        h.need(key in old and row['entry'] == old[key]['entry'] and row['baseline'] == old[key]['baseline'], 'approved_original_entry_and_baseline_unchanged')
        q.quality(h, row['entry'], row['metrics'])
    return approved


def expected_reuse(row):
    entry = row['entry']
    return {**{key: entry[key] for key in ('textHash', 'accent', 'fileKey', 'fileSha256', 'mimeType', 'sizeBytes', 'kind', 'cacheKey')},
            'baseline': row['baseline']}


def coverage(request, built, reused, holds):
    hashes = {target['textHash'] for target in request['targets']}
    active = {key: value for key, value in holds.items() if key[0] in hashes}
    old_counts, hold_counts = {}, {}
    for key in reused:
        old_counts[key[0]] = old_counts.get(key[0], 0) + 1
    for key in active:
        hold_counts[key[0]] = hold_counts.get(key[0], 0) + 1
    return dict(requestedSentenceCount=len(hashes), requestedClipCount=len(hashes) * 2, generatedClipCount=len(built), reusedClipCount=len(reused),
        fullyReusedSentenceCount=sum(n == 2 for n in old_counts.values()), partiallyReusedSentenceCount=sum(n == 1 for n in old_counts.values()),
        heldClipCount=len(active), heldSentenceCount=len(hold_counts), fullyHeldSentenceCount=sum(n == 2 for n in hold_counts.values()),
        eligibleClipCount=len(hashes) * 2 - len(active))


def candidate(h, inputs, frame, request_pin, request, check_pin, check, expected, holds, voices, controls):
    h.need(set(frame) == {'descriptor', 'archive', 'manifest', 'sources', 'assembly', 'installerCheck'}, 'candidate_entity_fields')
    descriptor, descriptor_raw = entity(h, inputs, frame['descriptor'], MIB)
    manifest, _ = entity(h, inputs, frame['manifest'])
    source, _ = entity(h, inputs, frame['sources'])
    assembly, _ = entity(h, inputs, frame['assembly'], MIB)
    installer, _ = entity(h, inputs, frame['installerCheck'], MIB)
    validate_pack(h, frame, descriptor, manifest, source, request, check_pin, check)
    entries = unique_rows(h, manifest['entries'], 'complete_candidate_unique_pairs')
    h.need(set(entries) == set(expected), 'candidate_all_original_generated_pairs')
    for key, entry in entries.items():
        generated_entry(h, entry, expected[key], check, voices)
    h.need(source['reusedMediaReferences'] == [] and source['baselinePacks'] == [] and source['sentences'] == request['targets'] and
           source['engineSource'] == voices and descriptor['lemmaCount'] == len(request['targets']), 'original_candidate_has_no_reuse')
    unique_media = len({entry['fileKey'] for entry in entries.values()})
    proof_receipt(h, installer, FRESH_INSTALLER_SHA, descriptor, frame, request_pin, check_pin, len(entries), 0, unique_media)
    same_bytes(h, assembly['archive'], frame['archive'], 'actual_candidate_archive_declaration')
    h.need(assembly['kind'] == 'nightstudy-ci-audio-installer-assembly-v1' and assembly['requestSha256'] == request_pin['sha256'] and
           assembly['independentCheckSha256'] == check_pin['sha256'] and
           assembly['mp3Files'] == unique_media and assembly['globalHoldCount'] == 79 and assembly['publicationAuthorized'] is False,
           'original_candidate_assembly_and_archive')
    cov = coverage(request, entries, {}, holds)
    reviewed = review_sidecar(h, source, entries, controls)
    h.need(source['coverage'] == assembly['coverage'] == installer['coverage'] == cov and
           assembly['pronunciationReviewCount'] == installer['pronunciationReviewCount'] == reviewed and
           all(descriptor[name] == manifest['statistics'][name] == value for name, value in cov.items()),
           'original_candidate_independent_coverage_and_review_count')
    return descriptor, descriptor_raw, manifest, source, entries


def validate_pack(h, frame, descriptor, manifest, source, request, check_pin, check):
    archive = valid_pin(h, frame['archive'], 2 * 1024 ** 3 - 1)
    h.need(descriptor['id'] == descriptor['version'] == manifest['version'] == request['packId'] and descriptor['status'] == manifest['status'] == 'ready' and
           manifest['schemaVersion'] == 2 and descriptor['entryCount'] == len(manifest['entries']) and
           descriptor['manifestSha256'] == frame['manifest']['sha256'] and descriptor['sourceManifestSha256'] == frame['sources']['sha256'] == manifest['sourceManifestSha256'] and
           descriptor['source']['sha256'] == archive['sha256'] and descriptor['source']['sizeBytes'] == archive['bytes'] and
           Path(archive['fileName']).name == 'nightstudy-' + request['packId'] + '.tar.gz', 'publication_actual_metadata_archive_binding')
    h.need(all(descriptor[name] == manifest['statistics'][name] == value for name, value in
               dict(entryCount=len(manifest['entries']), recordedCount=0, synthesizedCount=len(manifest['entries']), failedCount=0).items()),
           'publication_basic_generated_statistics')
    h.need(source['requestedSentences'] == request['targets'] and source['batchApproval'] == request['batchApproval'] and source['meaningPackSha256'] == h.PUBLIC_SHA and
           source['finalPolicySha256'] == h.FINAL_SHA and source['cloudBuildEvidence'] == dict(requestSha256=check['requestSha256'],
               independentCheckSha256=check_pin['sha256'], generatedManifestSha256=check['generatedManifest']['sha256'],
               generatedSourcesSha256=check['generatedSources']['sha256'], buildReceiptSha256=check['generationReceipt']['sha256']),
           'publication_binds_actual_original_generation_declarations')


def generated_entry(h, entry, expected, check, voices):
    key = pair(entry)
    media = check['_media'][key]
    identity = expected['identity']
    voice = voices['voices'][key[1]]
    h.need(entry['text'] == entry['lemma'] == expected['target']['text'] and entry['cacheKey'] == media['cacheKey'] == identity['cacheKey'] and
           entry['fileSha256'] == media['fileSha256'] and entry['originalFileSha256'] == media['originalWavSha256'] and
           entry['mimeType'] == 'audio/mpeg' and entry['fileKey'] == 'files/' + entry['fileSha256'] + '.mp3' and
           entry.get('pronunciationCorrectionSha256') == identity['correctionSha256'], 'every_selected_generation_entry_is_actual_checked_media')
    h.need(entry['kind'] == 'synthesized' and entry['engineVersion'] == '1.8.0' and entry['voiceModelSha256'] == voice['model']['sha256'] and
           entry['voiceConfigSha256'] == voice['config']['sha256'] and all(entry[name] == voice[name] for name in
               ('sourceName', 'sourceUrl', 'license', 'attribution')), 'selected_generation_current_voice_attribution')
    if expected['correction']:
        h.need(entry['pronunciationCorrectionId'] == expected['correction']['record']['id'], 'selected_generation_whole_correction_id')
    else:
        h.need('pronunciationCorrectionId' not in entry and 'pronunciationCorrectionSha256' not in entry, 'base_generation_has_no_invented_correction')
    h.need(all(type(entry['qualityMetrics'][name]) in (int, float) and math.isfinite(entry['qualityMetrics'][name]) and
               abs(entry['qualityMetrics'][name] - value) <= (.002 if name == 'rmsDbfs' else .000001)
               for name, value in media['metrics'].items()), 'generation_metrics_match_original_independent_tolerances')


def review_sidecar(h, source, built, controls):
    records = []
    for key in sorted(built):
        group = controls.get(key[0])
        correction = group['accents'][key[1]]['correction'] if group else None
        if correction:
            records.append(correction['record'])
    if not records:
        h.need('pronunciationReviews' not in source, 'no_unexpected_pronunciation_review_sidecar')
        return 0
    raw = (h.canonical(dict(formatVersion=1, id='sentence-pronunciation-v1', engineVersion='1.8.0',
                          voicesManifestSha256=h.VOICES_SHA, entries=records)) + '\n').encode('utf-8')
    pin = source['pronunciationReviews']
    h.need(pin['fileName'] == pin['sourceFileName'] == 'pronunciation-reviews.json' and pin['bytes'] == len(raw) and
           pin['sha256'] == h.sha(raw) and pin['appliedClipCount'] == len(records) and pin['engineVersion'] == '1.8.0' and
           pin['expertCertified'] is False, 'reconstructed_complete_approved_review_sidecar_bytes')
    return len(records)


def proof_receipt(h, value, source_sha, descriptor, frame, request_pin, check_pin, built_count, reused_count, unique_count):
    h.need(source_sha is not None and value['checkerSourceSha256'] == source_sha and value['packId'] == descriptor['id'] and
           value['descriptorSha256'] == frame['descriptor']['sha256'] and value['archiveSha256'] == frame['archive']['sha256'] and value['archiveBytes'] == frame['archive']['bytes'] and
           value['manifestSha256'] == frame['manifest']['sha256'] and value['sourceManifestSha256'] == frame['sources']['sha256'] and
           value['globalHoldCount'] == 79 and value['globalHoldsSha256'] == HOLD_SHA and
           value['uniqueMp3Files'] == unique_count and
           value['matureHoldPackCheckPassed'] is True and value['exactMp3OnlyFileClosure'] is True and value['publicationAuthorized'] is False and
           value['databaseUsed'] is False and value['modelsUsed'] is False and value['audioDecodedHere'] is False,
           'actual_independent_installer_receipt_not_original_receipt_for_changed_archive')
    if reused_count:
        h.need(value['kind'] == 'nightstudy-ci-sentence-audio-selected-installer-check-v1' and value['state'] == 'VERIFIED_SELECTED_EXTRACTED_PACK_ONLY' and
               value['publicationMode'] == 'legacy-reuse-conversion' and value['entryHashRecipe'] == ENTRY_HASH_RECIPE and
               value['selectedFreshPairs'] == built_count and value['reusedOfficialPairs'] == value['generatedNotSelectedPairs'] == reused_count and
               value['originalGeneratedPairs'] == built_count + reused_count and value['matureSelectedFreshEntryCheckPassed'] is True and
               value['generationProofUnchanged'] is True and value['originalReuseQualificationAll32Passed'] is True,
               'selected_installer_explicit_partition')
        same_bytes(h, value['request'], request_pin, 'selected_installer_actual_request')
        same_bytes(h, value['originalIndependentCheck'], check_pin, 'selected_installer_original_check')
        same_bytes(h, value['originalFreshInstallerCheck'], frame['candidate']['installerCheck'], 'selected_installer_original_archive_acceptance')
        same_bytes(h, value['publicationChoice'], frame['selectionProof'], 'selected_installer_actual_choice')
        h.need(value['helperSourceSha256'] == dict(INSTALLER_HELPERS, **{'check-ci-sentence-audio-installer.mjs': FRESH_INSTALLER_SHA}),
               'selected_installer_original_pinned_helpers')
    else:
        h.need(value['kind'] == 'nightstudy-ci-sentence-audio-installer-check-v1' and value['state'] == 'VERIFIED_EXTRACTED_PACK_ONLY' and
               value['requestSha256'] == request_pin['sha256'] and value['independentCheckSha256'] == check_pin['sha256'] and
               value['comparedEntries'] == built_count and value['maturePinnedEntryCheckPassed'] is True and
               value['helperSourceSha256'] == INSTALLER_HELPERS, 'fresh_installer_explicit_full_generated_scope')


def conversion_receipt(h, value, frame, request, check, built_count, reused_count, cov):
    h.need(value['kind'] == 'nightstudy-ci-sentence-publication-conversion-v1' and value['state'] == 'CONVERTED_REQUIRES_SELECTED_INSTALLER_CHECK' and
           value['packId'] == request['packId'] and value['mode'] == 'legacy-reuse-conversion' and value['converterSourceSha256'] == CONVERTER_SHA and
           value['originalGeneratedPairs'] == check['generatedPairs'] == built_count + reused_count and
           value['selectedFreshPairs'] == built_count and value['reusedOfficialPairs'] == value['generatedNotSelectedPairs'] == reused_count and
           value['generationProofUnchanged'] is True and value['originalArchivesModified'] is False and value['modelUsed'] is False and
           value['mediaDecodedHere'] is False and value['publicationAuthorized'] is False and value['coverage'] == cov,
           'actual_conversion_receipt_not_original_assembly')
    same_bytes(h, value['choiceProof'], frame['selectionProof'], 'conversion_actual_choice_proof')
    for name in ('descriptor', 'archive', 'manifest', 'sources'):
        same_bytes(h, value['selectedPublication'][name], frame[name], 'conversion_actual_selected_' + name)
        same_bytes(h, value['originalCandidate'][name], frame['candidate'][name], 'conversion_original_candidate_' + name)
    same_bytes(h, value['originalCandidate']['freshInstallerCheck'], frame['candidate']['installerCheck'], 'conversion_original_installer_acceptance')


def validate_choice(h, inputs, frame, item, request, request_pin, check_pin, check, approved, original):
    choice, _ = entity(h, inputs, frame['selectionProof'], 8 * MIB)
    fields = {'kind', 'state', 'packId', 'publicRootSha256', 'finalPolicySha256', 'request', 'independentCheck', 'candidate',
              'legacyQualification', 'legacySelection', 'selectedFreshPairs', 'reusedOfficialPairs', 'generatedNotSelectedPairs', 'generationProofUnchanged', 'publicationAuthorized', 'entryHashRecipe'}
    h.need(set(choice) == fields and choice['kind'] == 'nightstudy-ci-sentence-audio-publication-choice-v1' and
           choice['state'] == 'EXPLICIT_CURRENT_PUBLICATION_PARTITION' and choice['packId'] == request['packId'] and
           choice['publicRootSha256'] == h.PUBLIC_SHA and choice['finalPolicySha256'] == h.FINAL_SHA and
           choice['entryHashRecipe'] == ENTRY_HASH_RECIPE and
           choice['generationProofUnchanged'] is True and choice['publicationAuthorized'] is False, 'exact_explicit_publication_choice')
    same_bytes(h, choice['request'], request_pin, 'choice_actual_request')
    same_bytes(h, choice['independentCheck'], check_pin, 'choice_actual_independent_generation')
    same_bytes(h, choice['legacyQualification'], item['legacyQualification']['receipt'], 'choice_actual_qualification')
    same_bytes(h, choice['legacySelection'], item['legacyQualification']['selection'], 'choice_actual_approved32')
    for name in ('descriptor', 'archive', 'manifest', 'sources'):
        same_bytes(h, choice['candidate'][name], frame['candidate'][name], 'choice_original_candidate:' + name)
    same_bytes(h, choice['candidate']['freshInstallerCheck'], frame['candidate']['installerCheck'], 'choice_original_candidate_installer')
    planned = {key for key in original if key in approved}
    h.need(planned, 'conversion_requires_actual_authorized_overlap')
    fresh_rows = unique_rows(h, choice['selectedFreshPairs'], 'choice_fresh_unique')
    reused_rows = unique_rows(h, choice['reusedOfficialPairs'], 'choice_reused_unique')
    omitted = unique_rows(h, choice['generatedNotSelectedPairs'], 'choice_omitted_generation_unique')
    h.need(set(fresh_rows) == set(original) - planned and set(reused_rows) == set(omitted) == planned, 'explicit_complete_disjoint_choice_partition')
    for key, entry in original.items():
        row = (omitted if key in planned else fresh_rows)[key]
        h.need(set(row) == {'textHash', 'accent', 'originalGeneratedEntrySha256'} and row['originalGeneratedEntrySha256'] == full_entry_sha(h, entry),
               'choice_full_original_entry_digest_not_only_cache_fields')
    for key, row in reused_rows.items():
        h.need(set(row) == {'textHash', 'accent', 'officialEntrySha256'} and row['officialEntrySha256'] == full_entry_sha(h, approved[key]['entry']),
               'choice_complete_original_official_entry_digest')
    return planned


def write_bytes(h, file, raw):
    h.need(not os.path.lexists(file) and file.parent.resolve() == file.parent and 0 < len(raw) <= 16 * MIB, 'fresh_bounded_global_output')
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    return dict(fileName=file.name, bytes=len(raw), sha256=h.sha(raw))


def finalize(args):
    m, mf, mi = load_source(PURE)
    q, qf, qi = load_source(QUALIFIER)
    h, hi = m.load_helpers()
    inputs = h.Inputs()
    inputs.identities.update({mf: mi, qf: qi, m.HELPER: hi})
    inv = inputs.json(args.inventory.absolute(), 2 * MIB)
    top = {'kind', 'mediaReleaseUrl', 'planManifest', 'publicRoot', 'controls', 'globalHolds', 'legacyOverlap', 'legacyQualification', 'legacyManifests', 'batches'}
    h.need(set(inv) == top and inv['kind'] == 'nightstudy-ci-audio-global-publication-inventory-v1' and
           re.fullmatch('https://github.com/wudi000888-svg/nightstudy/releases/download/[A-Za-z0-9._-]+', inv['mediaReleaseUrl']) and
           len(inv['batches']) == 101 and inv['publicRoot']['sha256'] == h.PUBLIC_SHA, 'explicit_complete_actual_global_inventory')
    entity(h, inputs, inv['publicRoot'], MIB)
    prepared, _ = entity(h, inputs, inv['planManifest'], MIB)
    h.need(prepared == inputs.json(REPO / 'data/ci-audio-batch-plan.manifest.json', MIB), 'same_committed_actual_prepared_plan')
    configuration = inputs.json(REPO / 'data/ci-audio-batch-inputs.manifest.json', 65536)
    h.need(inv['controls']['base'] == configuration['portableControls'] and inv['controls']['supplement'] == configuration['supplementalControls'], 'global_current_control_pins')
    voices = inputs.json(REPO / 'data/audio-voices.manifest.json', 65536, h.VOICES_SHA)
    base = h.controls_index(inputs.pin(inv['controls']['base'], 64 * MIB))
    controls, observation = m.supplement(h, inputs, inv['controls']['supplement'], base, voices)
    h.need(inv['controls']['observation'] == inputs.pin(inv['controls']['supplement'], 2 * MIB)['observation'], 'actual_observer_control_pin')
    _, public, baseline = m.public_scope(h, inputs, [], controls, base, observation)
    held, hold_manifest_raw, hold_raw = policy(h, inputs, inv['globalHolds'], controls)
    jobs = inputs.pin(prepared['jobs'], MIB)
    first_request = inputs.pin({key: jobs['requests'][0][key] for key in ('fileName', 'bytes', 'sha256')}, 8 * MIB)
    plan, exclusions, _ = m.selection(h, inputs, first_request, controls, base, public, baseline)
    actual_selection = prepared['selection']
    h.need(first_request['batchApproval']['selectionManifest'] == actual_selection and len(plan['leaves']) == 101, 'same_actual101_plan')
    old, _ = read_legacy(h, inputs, inv['legacyManifests'], voices)
    approved = qualified_reuse(m, q, h, inputs, inv, public, controls, voices, old, actual_selection)
    h.need(set(old) & {(key, a) for key in public for a in h.ACCENTS} == set(approved) | {(key, a) for key in baseline for a in h.ACCENTS},
           'no_unhandled_legacy_current_conflict')
    output = args.output.absolute()
    h.need(output.resolve() == output and output.parent.is_dir() and not os.path.lexists(output) and
           not output.is_relative_to(REPO / 'data'), 'fresh_global_staging_outside_data')
    output.mkdir(mode=0o700)
    ledger = output / 'global-coverage.jsonl'
    catalog, closed, selected_old, fresh_total, fresh_hashes, applied_holds, generation_total, batch_sources = [], set(), set(), 0, set(), 0, 0, []
    review_total = 0
    ledger_digest, ledger_bytes = hashlib.sha256(), 0
    def close_row(handle, key, decision, evidence):
        nonlocal ledger_bytes
        h.need(key not in closed and key[0] in public and key[1] in h.ACCENTS, 'each_current_pair_closed_once')
        row = dict(textHash=key[0], accent=key[1], decision=decision,
            currentPublicReferenceFingerprintSha256=h.sha(h.canonical(sorted(public[key[0]]))), evidence=evidence)
        raw = (h.canonical(row) + '\n').encode('utf-8')
        handle.write(raw)
        ledger_digest.update(raw)
        ledger_bytes += len(raw)
        h.need(ledger_bytes <= 256 * MIB, 'bounded_global_streamed_ledger')
        closed.add(key)
    with ledger.open('xb') as handle:
        for number, batch in enumerate(inv['batches'], 1):
            h.need(set(batch) == {'sliceNumber', 'packId', 'request', 'check', 'generation', 'publication'} and batch['sliceNumber'] == number and
                   batch['packId'] == jobs['requests'][number - 1]['packId'] == 'sentence-audio-v4-%04d' % (100 + number), 'all101_explicit_batches_in_order')
            job = jobs['requests'][number - 1]
            same_bytes(h, batch['request'], {key: job[key] for key in ('fileName', 'bytes', 'sha256')}, 'actual_batch_request_pin')
            request, _ = entity(h, inputs, batch['request'], 8 * MIB)
            leaf = plan['leaves'][number - 1]
            h.need(request['batchApproval']['sliceNumber'] == number and request['batchApproval']['selectionManifest'] == actual_selection and
                   request['batchApproval']['selectionLeaf'] == {key: leaf[key] for key in ('fileName', 'bytes', 'sha256')} and
                   request['targets'] == inputs.pin(request['batchApproval']['selectionLeaf'], 8 * MIB), 'each_actual_request_is_its_complete_fixed_leaf')
            check, _ = entity(h, inputs, batch['check'])
            expected, _, denials = m.expected_targets(h, request, controls, base, voices, exclusions)
            h.need(check['kind'] == 'nightstudy-ci-sentence-audio-batch-independent-check-v1' and check['state'] == 'VERIFIED_SELECTED_BATCH_ONLY' and
                   check['checkerSourceSha256'] == PURE[2] and check['batchWorkerSha256'] == m.WORKER_SHA and check['purePilotHelperSha256'] == m.HELPER_SHA and
                   check['publicRootSha256'] == h.PUBLIC_SHA and check['finalPolicySha256'] == h.FINAL_SHA and
                   check['requestSha256'] == batch['request']['sha256'] and check['batchApproval'] == request['batchApproval'] and
                   check['generatedPairs'] == check['originalWavsFullyRead'] == check['completeMp3EofDecodes'] == len(expected) and
                   check['heldDenials'] == len(denials) and check['decoderInputProtocol'] == 'fd' and check['seekablePinnedInput'] is True and
                   check['allCurrentReferencesBound'] is True and check['selectionPairUnionVerified'] is True and check['reviewedFrozenRawCallsVerified'] is True and
                   check['workers'] == 4 and check['threadsPerVoice'] == check['decoderThreads'] == 1 and check['taskSentenceCap'] == 128 and
                   check['journalReusePolicy'] == 'disabled-fresh-generation-no-progress-inputs-v1' and
                   check['oldUnapprovedCandidateSelection'] == 'NOT_SELECTED' and check['oldUnapprovedCandidates'] == 89880 and check['publicationAuthorized'] is False,
                   'all101_actual_full_generation_checks')
            check['_media'] = unique_rows(h, check['media'], 'all_checked_original_media_unique')
            h.need(set(check['_media']) == set(expected), 'complete_checked_media_pair_set')
            h.need(set(batch['generation']) == {'build', 'manifest', 'sources'}, 'entity_build_and_declared_generation_metadata')
            h.need(batch['generation']['manifest'] == check['generatedManifest'] and batch['generation']['sources'] == check['generatedSources'],
                   'exact_original_generation_declarations_not_reopened')
            same_bytes(h, batch['generation']['build'], check['generationReceipt'], 'actual_small_build_receipt')
            build, _ = entity(h, inputs, batch['generation']['build'], 4 * MIB)
            h.need(build['state'] == 'GENERATED_REQUIRES_INDEPENDENT_CHECK' and build['requestSha256'] == batch['request']['sha256'] and
                   build['workerSourceSha256'] == m.WORKER_SHA and build['generatedPairs'] == len(expected) and build['publicationAuthorized'] is False,
                   'original_build_actual_request_and_worker')
            files = {pin['fileName']: pin for pin in build['files']}
            for name, declared in (('manifest.json', check['generatedManifest']), ('sources.manifest.json', check['generatedSources'])):
                same_bytes(h, files[name], declared, 'build_binds_original_small_metadata_declaration')
            frame = batch['publication']
            h.need(frame['mode'] in ('original-generation', 'legacy-reuse-conversion'), 'explicit_publication_mode')
            h.need(set(frame) == {'mode', 'selectionProof', 'descriptor', 'archive', 'manifest', 'sources', 'assembly', 'installerCheck'} |
                   ({'candidate'} if frame['mode'] == 'legacy-reuse-conversion' else set()), 'exact_explicit_publication_frame')
            original_frame = frame['candidate'] if frame['mode'] == 'legacy-reuse-conversion' else {key: frame[key] for key in
                ('descriptor', 'archive', 'manifest', 'sources', 'assembly', 'installerCheck')}
            _, _, _, _, original = candidate(h, inputs, original_frame, batch['request'], request, batch['check'], check, expected, held, voices, controls)
            descriptor, descriptor_raw = entity(h, inputs, frame['descriptor'], MIB)
            manifest, _ = entity(h, inputs, frame['manifest'])
            source, _ = entity(h, inputs, frame['sources'])
            validate_pack(h, frame, descriptor, manifest, source, request, batch['check'], check)
            h.need(descriptor['source']['url'] == inv['mediaReleaseUrl'] + '/nightstudy-' + batch['packId'] + '.tar.gz', 'one_fixed_public_media_release_namespace')
            built = unique_rows(h, manifest['entries'], 'selected_fresh_pairs_unique')
            planned_reuse = set(expected) & set(approved)
            if planned_reuse:
                h.need(frame['mode'] == 'legacy-reuse-conversion' and frame['selectionProof'] is not None, 'overlapping_old_media_requires_explicit_conversion')
                selected = validate_choice(h, inputs, frame, inv, request, batch['request'], batch['check'], check, approved, original)
                h.need(selected == planned_reuse and set(built) == set(original) - selected and all(built[key] == original[key] for key in built),
                       'selected_fresh_entries_unchanged_exact_partition')
                selection_frame = source['publicationSelection']
                h.need(selection_frame['kind'] == 'nightstudy-ci-sentence-audio-publication-choice-v1' and
                       selection_frame['legacySelectionSha256'] == inv['legacyQualification']['selection']['sha256'] and
                       selection_frame['qualificationSha256'] == inv['legacyQualification']['receipt']['sha256'], 'selected_sources_actual_reuse_authorization')
                same_bytes(h, selection_frame['choiceProof'], frame['selectionProof'], 'selected_sources_bind_acyclic_choice_proof')
            else:
                h.need(frame['mode'] == 'original-generation' and frame['selectionProof'] is None and set(built) == set(original) and
                       all(built[key] == original[key] for key in built), 'nonoverlap_uses_original_generation_only')
            reused = unique_rows(h, source['reusedMediaReferences'], 'selected_official_references_unique')
            h.need(set(reused) == planned_reuse and all(reused[key] == expected_reuse(approved[key]) for key in reused), 'every_reused_reference_is_the_exact_official_entry')
            expected_baselines = sorted({h.canonical(approved[key]['baseline']) for key in reused})
            h.need(sorted(h.canonical(row) for row in source['baselinePacks']) == expected_baselines, 'only_actual_official_baselines')
            expected_reused_sentences = []
            for target in request['targets']:
                retained = [reused[key] for key in sorted(reused) if key[0] == target['textHash']]
                if retained:
                    expected_reused_sentences.append({**{name: target[name] for name in ('textHash', 'text', 'references')}, 'pairs': retained})
            h.need(source['reusedSentences'] == expected_reused_sentences and source['engineSource'] == voices, 'mature_complete_reused_sentences_and_voice_source')
            fresh_groups = {key[0] for key in built}
            expected_sentences = [target for target in request['targets'] if target['textHash'] in fresh_groups]
            h.need(source['sentences'] == expected_sentences and descriptor['lemmaCount'] == manifest['statistics']['lemmaCount'] == len(fresh_groups) and
                   descriptor['entryCount'] == len(built), 'selected_fresh_sentence_scope')
            cov = coverage(request, built, reused, held)
            h.need(source['coverage'] == cov and all(descriptor[name] == manifest['statistics'][name] == value for name, value in cov.items()), 'exact_full_requested_generated_reused_held_coverage')
            applicable = {key: record for key, record in held.items() if key[0] in {target['textHash'] for target in request['targets']}}
            expected_held_refs = [dict(holdId=record['id'], **{name: record[name] for name in
                ('textHash', 'accent', 'learningSenseId', 'exampleId', 'riskCategory')}) for key, record in sorted(applicable.items())]
            h.need(source['heldMediaReferences'] == expected_held_refs, 'all_pack_hold_references_are_exact_current_policy_rows')
            hold_pin = source['pronunciationHolds']
            h.need(hold_pin == dict(fileName='pronunciation-holds.json', sourceFileName='sentence-audio-holds-v1.json', bytes=80987,
                sha256=HOLD_SHA, holdCount=79, appliedClipCount=cov['heldClipCount']), 'whole_global_sidecar_and_actual_pack_subset')
            installer, _ = entity(h, inputs, frame['installerCheck'], MIB)
            proof_receipt(h, installer, SELECTED_INSTALLER_SHA if planned_reuse else FRESH_INSTALLER_SHA, descriptor, frame,
                          batch['request'], batch['check'], len(built), len(reused), len({entry['fileKey'] for entry in built.values()}))
            if planned_reuse:
                same_bytes(h, installer['legacyQualification'], inv['legacyQualification']['receipt'], 'selected_installer_actual_qualification')
                same_bytes(h, installer['legacySelection'], inv['legacyQualification']['selection'], 'selected_installer_actual_approved32')
                operation, _ = entity(h, inputs, frame['assembly'], MIB)
                conversion_receipt(h, operation, frame, request, check, len(built), len(reused), cov)
            reviewed = review_sidecar(h, source, built, controls)
            h.need(installer['coverage'] == cov and installer['pronunciationReviewCount'] == reviewed,
                   'independent_selected_installer_coverage_and_review_count')
            review_total += reviewed
            for key, entry in built.items():
                generated_entry(h, entry, expected[key], check, voices)
                h.need(key not in old and key not in held, 'selected_new_asset_no_legacy_or_hold_collision')
                close_row(handle, key, 'new-built', dict(packId=batch['packId'], fileSha256=entry['fileSha256'], cacheKey=entry['cacheKey'], independentCheck=batch['check']))
            for key, row in reused.items():
                h.need(key not in selected_old and key not in held, 'official_reuse_selected_once_not_held')
                close_row(handle, key, 'official-legacy-reuse', dict(baseline=approved[key]['baseline'], fileSha256=row['fileSha256'],
                    cacheKey=row['cacheKey'], qualification=inv['legacyQualification']['receipt']))
                selected_old.add(key)
            out_pin = write_bytes(h, output / (batch['packId'] + '.manifest.json'), descriptor_raw)
            catalog.append(dict(id=batch['packId'], fileName=out_pin['fileName'], bytes=out_pin['bytes'], sha256=out_pin['sha256'],
                                lemmaCount=descriptor['lemmaCount'], entryCount=descriptor['entryCount']))
            fresh_total += len(built)
            fresh_hashes.update(fresh_groups)
            applied_holds += cov['heldClipCount']
            generation_total += len(expected)
            batch_sources.append(dict(sliceNumber=number, packId=batch['packId'], check=batch['check'], publicationInstaller=frame['installerCheck'],
                                      originalGenerationMetadataReopened=False, installerArchiveReopened=False))
        for key in sorted((key, accent) for key in baseline for accent in h.ACCENTS):
            h.need(key in old and old[key]['baseline']['id'] == 'sentence-audio-v3' and key not in held, 'preserved_v3_exact196_dual_baseline')
            close_row(handle, key, 'immutable-v3-baseline', dict(baseline=old[key]['baseline'], fileSha256=old[key]['entry']['fileSha256']))
        for key, record in sorted(held.items()):
            h.need((record['learningSenseId'], record['exampleId']) in {(row[0], row[1]) for row in public[key[0]]}, 'every_global_hold_anchor_bound_to_current_public_refs')
            close_row(handle, key, 'unavailable-hold', dict(holdId=record['id'], globalHoldPayloadSha256=HOLD_SHA))
        h.need(len(closed) == 199880 and {key for key, _ in closed} == set(public) and selected_old == set(approved) and
               fresh_total == 199377 and len(fresh_hashes) == 99710 and generation_total == 199409 and applied_holds == 43 and
               review_total == 1758 and sum(pin['entryCount'] for pin in catalog) == 199377, 'complete_current199880_partition')
        handle.flush()
        os.fsync(handle.fileno())
    hold_manifest_pin = write_bytes(h, output / 'sentence-audio-holds-v1.manifest.json', hold_manifest_raw)
    hold_payload_pin = write_bytes(h, output / 'sentence-audio-holds-v1.json', hold_raw)
    collection = dict(formatVersion=1, kind='sentence-audio-collection', id='sentence-audio-v4',
        learningSensesManifestFileName='learning-senses-collection-v2.manifest.json', learningSensesManifestSha256=h.PUBLIC_SHA,
        pronunciationHoldsManifestFileName='sentence-audio-holds-v1.manifest.json', pronunciationHoldsManifestSha256=HOLD_MANIFEST_SHA,
        entryCount=199377, packs=catalog)
    h.need(len(collection) == 9 and len(catalog) == 101, 'strict_existing_collection_schema')
    collection_pin = write_bytes(h, output / 'sentence-audio-v4.collection.json', (h.canonical(collection) + '\n').encode())
    self_raw = inputs.read(Path(__file__).absolute(), 128 * 1024)
    inputs.unchanged()
    receipt = dict(kind='nightstudy-ci-audio-global-publication-closure-v1', state='COMPLETE_METADATA_REQUIRES_ANONYMOUS_FETCH_AND_COLD_DB',
        checkerSourceSha256=h.sha(self_raw), publicRootSha256=h.PUBLIC_SHA, finalPolicySha256=h.FINAL_SHA,
        counts=dict(groups=99940, references=99984, pairs=199880, generationCandidates=199409, selectedNew=199377,
            officialReuse=32, immutableV3Baseline=392, held=79, readyWithinCurrentRoot=199801, fullyHeldGroups=18, partialHeldGroups=43,
            selectedNewGroups=99710, reusedGroups=16, baselineGroups=196, packAppliedHeldClips=43),
        correctedClipCount=dict(unchangedBase=1757, separateSupplement=1, selectedTotal=review_total),
        outputs=dict(collection=collection_pin, holdManifest=hold_manifest_pin, holdPayload=hold_payload_pin,
            ledger=dict(fileName=ledger.name, bytes=ledger_bytes, sha256=ledger_digest.hexdigest())), batchEvidence=batch_sources,
        originalGenerationMetadataReopened=False, installerArchivesReopened=False,
        archiveIntegrityBoundThroughActualInstallerChecks=True, mediaDecodedHere=False, databaseUsed=False, modelsUsed=False,
        anonymousPublicFetchExecuted=False, allLibraryDatabaseAcceptancePassed=False, publicationAuthorized=False)
    write_bytes(h, output / 'completion.json', (h.canonical(receipt) + '\n').encode())
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not sys.platform.startswith('linux') or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('cloud_global_closure_only')
    sys.dont_write_bytecode = True
    def guard(event, values):
        if event.startswith(('socket.', 'subprocess.', 'os.exec', 'os.spawn')) or event in ('os.system', 'os.fork', 'os.posix_spawn', 'sqlite3.connect'):
            raise PermissionError('global_no_network_children_or_database')
        if event == 'open' and values and isinstance(values[0], (str, bytes, os.PathLike)) and \
                os.fsdecode(values[0]).lower().endswith(('.onnx', '.onnx.json', '.mp3', '.wav', '.tar', '.tar.gz', '.gguf', '.pt', '.pth', '.safetensors')):
            raise PermissionError('global_does_not_open_archives_media_or_models')
    sys.addaudithook(guard)
    receipt = finalize(args)
    print('Global explicit101 evidence closed; publicationAuthorized=false; selectedNew=' + str(receipt['counts']['selectedNew']))


if __name__ == '__main__':
    main()
