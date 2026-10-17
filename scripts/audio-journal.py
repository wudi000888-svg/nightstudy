"""Bounded offline audio journals; never load accumulated logs into memory.

Compaction writes a new cache directory with an on-disk SQLite index. Source
journals and published media are never modified. Consumers keep only the exact
identities needed by the current shard, with the same last-record-wins policy.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import sqlite3

MAX_LINE_BYTES = 256 * 1024
MAX_MANIFEST_BYTES = 32 * 1024 * 1024
HEX = re.compile(r'[a-f0-9]{64}')


def records(path, stats=None):
    """Skip incomplete/corrupt/oversized records without allocating long lines."""
    with Path(path).open('rb') as handle:
        while True:
            line = handle.readline(MAX_LINE_BYTES + 1)
            if not line:
                break
            if len(line) > MAX_LINE_BYTES:
                while line and not line.endswith(b'\n'):
                    line = handle.readline(MAX_LINE_BYTES + 1)
                if stats is not None:
                    stats['rejected'] += 1
                continue
            try:
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise ValueError('journal_record_not_object')
            except (ValueError, UnicodeError):
                if stats is not None:
                    stats['rejected'] += 1
                continue
            if stats is not None:
                stats['read'] += 1
            yield value


def entry_key(row):
    values = row.get('textHash'), row.get('cacheKey')
    if all(isinstance(v, str) and HEX.fullmatch(v) for v in values):
        return values
    return None


def select_entries(paths, wanted, accent):
    selected = {}
    for path in sorted(paths):
        for row in records(path):
            key = entry_key(row)
            if key in wanted and row.get('accent') == accent:
                selected[key] = row
    return selected


def select_quality(path, wanted, policy_version):
    selected = {}
    if path.exists():
        for row in records(path):
            digest, metrics = row.get('fileSha256'), row.get('qualityMetrics')
            if (isinstance(digest, str) and digest in wanted and isinstance(metrics, dict)
                    and metrics.get('policyVersion') == policy_version):
                selected[digest] = metrics
    return selected


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def manifest_records(path, expected_sha256):
    """Prime from a bounded, pinned completed manifest, never copied history."""
    if (path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_MANIFEST_BYTES
            or digest(path) != expected_sha256):
        raise ValueError('unsafe_or_unpinned_cache_manifest')
    with path.open(encoding='utf-8') as handle:
        value = json.load(handle)
    if value.get('status') != 'ready' or not isinstance(value.get('entries'), list):
        raise ValueError('cache_manifest_not_completed')
    for row in value['entries']:
        if not isinstance(row, dict):
            raise ValueError('invalid_cache_manifest_entry')
        yield row.get('accent'), row
        if isinstance(row.get('qualityMetrics'), dict):
            yield 'quality-v1', {'fileSha256': row.get('fileSha256'), 'qualityMetrics': row['qualityMetrics']}


def compact(directories, output, manifests=()):
    """Deduplicate once on disk, rather than concatenating cumulative caches."""
    output = Path(output)
    if output.exists():
        raise ValueError('compact_output_must_be_new')
    inputs = []
    for directory in directories:
        directory = Path(directory)
        if not directory.is_dir() or directory.is_symlink():
            raise ValueError('invalid_journal_directory')
        for path in sorted(directory.glob('*.jsonl')):
            if path.name == 'quality-v1.jsonl' or re.fullmatch(r'(US|UK)-[a-zA-Z0-9-]+\.jsonl', path.name):
                if not path.is_file() or path.is_symlink():
                    raise ValueError('unsafe_journal_file')
                inputs.append((path, None))
    for path, expected_sha256 in manifests:
        inputs.append((Path(path), expected_sha256))
    output.mkdir()
    db = output/'index.sqlite3'
    stats = {'read': 0, 'rejected': 0, 'kept': {}, 'inputs': []}
    with sqlite3.connect(db) as connection:
        connection.execute('PRAGMA cache_size=-4096')
        connection.execute('PRAGMA temp_store=FILE')
        connection.execute('CREATE TABLE records (kind TEXT, identity TEXT, payload TEXT, PRIMARY KEY(kind,identity)) WITHOUT ROWID')
        for path, expected_sha256 in inputs:
            before = path.stat()
            if expected_sha256 is not None:
                rows = manifest_records(path, expected_sha256)
            else:
                rows = (('quality-v1' if path.name == 'quality-v1.jsonl' else path.name.split('-')[0], row)
                        for row in records(path, stats))
            for kind, row in rows:
                if kind == 'quality-v1':
                    metrics, identity = row.get('qualityMetrics'), row.get('fileSha256')
                    if (not isinstance(identity, str) or not HEX.fullmatch(identity)
                            or not isinstance(metrics, dict) or metrics.get('policyVersion') != 1):
                        stats['rejected'] += 1
                        continue
                else:
                    key = entry_key(row)
                    if key is None or kind not in ('US', 'UK') or row.get('accent') != kind:
                        stats['rejected'] += 1
                        continue
                    identity = ':'.join(key)
                connection.execute('INSERT OR REPLACE INTO records VALUES(?,?,?)',
                                   (kind, identity, json.dumps(row, ensure_ascii=False, separators=(',', ':'))))
            connection.commit()
            if path.stat().st_size != before.st_size or path.stat().st_mtime_ns != before.st_mtime_ns:
                raise ValueError('journal_changed_during_compaction')
            stats['inputs'].append({'fileName': path.name, 'bytes': before.st_size, 'sha256': digest(path),
                                    'kind': 'completed-manifest' if expected_sha256 is not None else 'journal'})
        for kind, name in [('US', 'US-compact.jsonl'), ('UK', 'UK-compact.jsonl'), ('quality-v1', 'quality-v1.jsonl')]:
            file = output/name
            with file.open('w', encoding='utf-8') as handle:
                for payload, in connection.execute('SELECT payload FROM records WHERE kind=? ORDER BY identity', (kind,)):
                    handle.write(payload+'\n')
            stats['kept'][kind] = {'records': connection.execute('SELECT count(*) FROM records WHERE kind=?', (kind,)).fetchone()[0],
                                   'bytes': file.stat().st_size, 'sha256': digest(file)}
    db.unlink()
    (output/'receipt.json').write_text(json.dumps(stats, indent=2)+'\n')
    return stats


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', action='append', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(compact(args.input, args.output)), flush=True)
