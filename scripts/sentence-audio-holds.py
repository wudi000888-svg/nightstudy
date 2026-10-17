"""Pinned exact sentence/accent publication holds; no audio or model imports.

A hold means leave this clip unavailable while its reading is reviewed. It does
not remove text, reject a whole lemma/accent, or declare every uncertainty wrong.
The caller supplies an explicit SHA, validates the entire policy, then binds
only records in its current text shard to the actual meaning/example references.
"""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import re
import unicodedata

MAX_BYTES = 4 * 1024 * 1024
MAX_HOLDS = 5000
POLICY_ID = 'sentence-audio-holds-v1'
RISK_CATEGORIES = frozenset(('wrong-lexeme', 'insufficient-regional-evidence',
                             'insufficient-reading-evidence'))


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def sha(value):
    return hashlib.sha256(value.encode('utf-8') if isinstance(value, str) else value).hexdigest()


def normalize(value):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', value).translate(
        str.maketrans({'‘': "'", '’': "'", '“': '"', '”': '"'}))).strip()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'pronunciation_holds_duplicate_json_key')
        result[key] = value
    return result


def validate_hold(entry):
    require(isinstance(entry, dict) and set(entry) == {
        'id', 'text', 'textHash', 'accent', 'learningSenseId', 'exampleId',
        'riskCategory', 'review'}, 'pronunciation_hold_fields')
    text = entry['text']
    require(isinstance(text, str) and 15 <= len(text) <= 4000 and normalize(text) == text
            and re.fullmatch(r'[a-f0-9]{64}', str(entry['textHash']))
            and sha(text) == entry['textHash'], 'pronunciation_hold_text')
    require(entry['accent'] in ('US', 'UK') and entry['id'] ==
            'sentence-audio-hold-' + sha(entry['textHash'] + '\0' + entry['accent']),
            'pronunciation_hold_identity')
    require(isinstance(entry['learningSenseId'], str) and re.fullmatch(
        r'learning-sense-[a-f0-9]{64}', entry['learningSenseId']) and
        isinstance(entry['exampleId'], str) and re.fullmatch(
            r'sense-example-[a-f0-9]{64}', entry['exampleId']), 'pronunciation_hold_reference')
    require(isinstance(entry['riskCategory'], str) and entry['riskCategory'] in RISK_CATEGORIES,
            'pronunciation_hold_risk_category')
    review = entry['review']
    require(isinstance(review, dict) and set(review) == {
        'reviewer', 'decision', 'expertCertified', 'reason'} and
        review['reviewer'] == 'Codex' and review['decision'] == 'hold' and
        review['expertCertified'] is False and isinstance(review['reason'], str) and
        len(review['reason']) <= 4000 and len(review['reason'].strip()) >= 15 and
        not re.search(r'[\x00-\x1f]', review['reason']), 'pronunciation_hold_review')
    return entry


def load_holds(file, expected_sha, rows):
    """Return only current-shard holds plus a pin for the complete policy.

    Absence is explicit: both arguments must be absent. Every record, including
    another shard's records, receives structural/identity validation. A matching
    hash must have the exact text and an actual sense/example pair; it cannot be
    silently treated as out of scope after a reference mismatch.
    """
    require(bool(file) == bool(expected_sha), 'pronunciation_holds_pin_required')
    if file is None:
        return {}, None
    require(isinstance(expected_sha, str) and re.fullmatch(r'[a-f0-9]{64}', expected_sha),
            'pronunciation_holds_pin_required')
    file = Path(file)
    require(not file.is_symlink() and file.is_file() and
            0 < file.stat().st_size <= MAX_BYTES, 'pronunciation_holds_file')
    with file.open('rb') as handle:
        raw = handle.read(MAX_BYTES + 1)
    require(0 < len(raw) <= MAX_BYTES, 'pronunciation_holds_file')
    require(sha(raw) == expected_sha, 'pronunciation_holds_checksum')
    value = json.loads(raw, object_pairs_hook=unique_object)
    require(isinstance(value, dict) and set(value) == {'formatVersion', 'id', 'entries'} and
            type(value['formatVersion']) is int and value['formatVersion'] == 1 and
            value['id'] == POLICY_ID and isinstance(value['entries'], list) and
            0 <= len(value['entries']) <= MAX_HOLDS, 'pronunciation_holds_manifest')
    # First validate the complete file. No out-of-scope record is trusted merely
    # because its text is not in this content shard.
    records = {}
    for raw_entry in value['entries']:
        entry = validate_hold(raw_entry)
        key = (entry['textHash'], entry['accent'])
        require(key not in records, 'pronunciation_holds_duplicate')
        records[key] = entry
    requested = {}
    for row in rows:
        require(isinstance(row, dict) and isinstance(row.get('text'), str) and
                normalize(row['text']) == row['text'] and sha(row['text']) == row.get('textHash')
                and isinstance(row.get('references'), list), 'pronunciation_holds_requested_text')
        require(row['textHash'] not in requested, 'pronunciation_holds_requested_duplicate')
        requested[row['textHash']] = row
    result = {}
    for key, entry in records.items():
        row = requested.get(entry['textHash'])
        if row is None:
            continue
        require(entry['text'] == row['text'] and any(
            isinstance(ref, dict) and ref.get('learningSenseId') == entry['learningSenseId'] and
            ref.get('exampleId') == entry['exampleId'] for ref in row['references']),
            'pronunciation_holds_meaning_mismatch')
        result[key] = entry
    return result, {'fileName': file.name, 'bytes': len(raw), 'sha256': sha(raw),
                    'holdCount': len(records), 'appliedClipCount': len(result)}
