#!/usr/bin/env python3
"""Collect public, directly linked English/Hans examples. No model, database or write API."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import email.utils
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import signal
import ssl
import time
import urllib.parse
import uuid

ORIGIN = 'https://api.tatoeba.org'
PATH = '/v1/sentences'
OUTPUT = Path('/Volumes/XXX/Codex/work/nightstudy/tatoeba-direct-pairs')
FILTERS = {
    'lang': 'eng', 'sort': 'created', 'limit': '500',
    'trans:lang': 'cmn', 'trans:is_direct': 'yes', 'trans:is_unapproved': 'no',
    'trans:is_orphan': 'no', 'is_unapproved': 'no', 'is_orphan': 'no',
    'showtrans:lang': 'cmn', 'showtrans:is_direct': 'yes',
    'showtrans:is_unapproved': 'no', 'showtrans:is_orphan': 'no',
}
FIRST_URL = ORIGIN + PATH + '?' + urllib.parse.urlencode(FILTERS)
LICENSES = {
    'CC BY 2.0 FR': 'https://creativecommons.org/licenses/by/2.0/fr/',
    'CC0 1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
}
MAX_RESPONSE = 8 * 1024 * 1024
MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024
STOP = False


class SourceError(Exception):
    pass


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def validate_url(url, allow_first=False):
    if not isinstance(url, str) or len(url) > 8000:
        raise SourceError('invalid_next_url')
    p = urllib.parse.urlsplit(url)
    if p.scheme != 'https' or p.netloc != 'api.tatoeba.org' or p.path != PATH or p.fragment:
        raise SourceError('next_origin_or_path_changed')
    try:
        items = urllib.parse.parse_qsl(p.query, keep_blank_values=True, strict_parsing=True)
    except ValueError as error:
        raise SourceError('invalid_next_query') from error
    query = dict(items)
    if len(query) != len(items) or set(query) - set(FILTERS) - {'after'}:
        raise SourceError('unexpected_next_parameter')
    if any(query.get(key) != value for key, value in FILTERS.items()):
        raise SourceError('next_filters_changed')
    if not allow_first and not query.get('after'):
        raise SourceError('next_cursor_missing')
    if 'after' in query and (not query['after'] or len(query['after']) > 2048):
        raise SourceError('invalid_next_cursor')
    return url


def retry_after(value, now=None):
    now = now or datetime.now(timezone.utc)
    if value is None:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        at = email.utils.parsedate_to_datetime(value)
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        return max(0.0, (at - now).total_seconds())
    except (ValueError, TypeError, OverflowError):
        return None


def sentence_reason(value, lang):
    if not isinstance(value, dict) or type(value.get('id')) is not int or value['id'] <= 0:
        return 'invalid_sentence'
    if value.get('lang') != lang:
        return 'wrong_language'
    if not isinstance(value.get('text'), str) or not value['text'].strip() or len(value['text']) > 20000:
        return 'invalid_text'
    if value.get('license') not in LICENSES:
        return 'unsupported_license'
    if not isinstance(value.get('owner'), str) or not value['owner'].strip() or len(value['owner']) > 200:
        return 'missing_owner'
    if value.get('is_unapproved') is not False:
        return 'unapproved_or_unknown'
    if lang == 'cmn' and value.get('script') != 'Hans':
        return 'not_hans'
    return None


def endpoint(value):
    keys = ['id', 'text', 'lang', 'script', 'license', 'owner', 'is_unapproved']
    result = {key: value.get(key) for key in keys}
    if 'is_direct' in value:
        result['is_direct'] = value['is_direct']
    return result


def field_metadata(sentence, observed_at):
    source_url = f'https://tatoeba.org/en/sentences/show/{sentence["id"]}'
    return {
        'kind': 'corpus', 'review': 'pending',
        'sourceSentenceId': str(sentence['id']), 'sourceUrl': source_url,
        'sourceTextSha256': sha(sentence['text'].encode('utf-8')),
        'license': sentence['license'], 'licenseUrl': LICENSES[sentence['license']],
        'owner': sentence['owner'], 'ownerRole': 'current-owner',
        'attribution': f'Tatoeba sentence #{sentence["id"]}; current owner: {sentence["owner"]}; {source_url}',
        'observedAt': observed_at,
    }


def parse_page(raw, request_url, observed_at):
    validate_url(request_url, allow_first=True)
    if len(raw) > MAX_RESPONSE:
        raise SourceError('response_too_large')
    try:
        page = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SourceError('invalid_json_response') from error
    if not isinstance(page, dict) or not isinstance(page.get('data'), list) or len(page['data']) > 500:
        raise SourceError('invalid_response_schema')
    paging = page.get('paging')
    if not isinstance(paging, dict) or type(paging.get('total')) is not int or paging['total'] < 0 or type(paging.get('has_next')) is not bool:
        raise SourceError('invalid_paging_schema')
    if paging['has_next']:
        validate_url(paging.get('next'))
        if paging['next'] == request_url:
            raise SourceError('cursor_did_not_advance')
    elif paging.get('next') not in (None, ''):
        raise SourceError('unexpected_terminal_cursor')
    pairs, rejected, seen = [], Counter(), set()
    for english in page['data']:
        reason = sentence_reason(english, 'eng')
        if reason:
            rejected['english_' + reason] += 1
            continue
        translations = english.get('translations')
        if not isinstance(translations, list):
            rejected['invalid_translations'] += 1
            continue
        for chinese in translations:
            reason = sentence_reason(chinese, 'cmn')
            if reason:
                rejected['chinese_' + reason] += 1
                continue
            if chinese.get('is_direct') is not True:
                rejected['not_direct'] += 1
                continue
            identity = (english['id'], chinese['id'])
            if identity in seen:
                rejected['duplicate_pair_in_page'] += 1
                continue
            seen.add(identity)
            pairs.append({
                'english': endpoint(english), 'chinese': endpoint(chinese),
                'relationship': {'sourceSentenceId': english['id'], 'translationSentenceId': chinese['id'], 'isDirect': True, 'observedAt': observed_at},
                'sourceApiUrl': request_url, 'rawResponseSha256': sha(raw),
                'contentMetadata': {'exampleEn': field_metadata(english, observed_at), 'exampleZh': field_metadata(chinese, observed_at)},
            })
    return page, pairs, dict(rejected)


def check_storage(root):
    parent = Path('/Volumes/XXX/Codex/work/nightstudy')
    if not os.path.ismount('/Volumes/XXX') or parent.resolve() != parent or not os.access(parent, os.W_OK):
        raise SourceError('real_writable_external_mount_required')
    if root.resolve() != root or not root.is_relative_to(parent):
        raise SourceError('real_external_output_path_required')
    root.mkdir(exist_ok=True)
    if not os.access(root, os.W_OK):
        raise SourceError('output_not_writable')


def atomic_write(root, target, data):
    check_storage(root)
    if target.is_symlink() or target.parent.resolve() != target.parent or not target.is_relative_to(root):
        raise SourceError('unsafe_output_leaf')
    target.parent.mkdir(exist_ok=True)
    temporary = target.with_name(target.name + '.tmp-' + uuid.uuid4().hex)
    with temporary.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(target)


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


class Fetcher:
    def __init__(self):
        self.connection = None
        self.last_start = 0.0

    def close(self):
        if self.connection:
            self.connection.close()
        self.connection = None

    def request(self, url):
        validate_url(url, allow_first=True)
        for attempt in range(6):
            if STOP:
                raise SourceError('interrupted')
            delay = max(0.0, .5 - (time.monotonic() - self.last_start))
            if delay:
                time.sleep(delay)
            self.last_start = time.monotonic()
            status, headers, body = None, {}, b''
            started = time.monotonic()
            try:
                if self.connection is None:
                    self.connection = http.client.HTTPSConnection('api.tatoeba.org', timeout=60, context=ssl.create_default_context())
                p = urllib.parse.urlsplit(url)
                self.connection.request('GET', p.path + '?' + p.query, headers={'Accept': 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'NightStudy-public-corpus-source/1'})
                response = self.connection.getresponse()
                status = response.status
                headers = {key.lower(): value for key, value in response.getheaders()}
                if headers.get('content-encoding', 'identity').lower() != 'identity':
                    raise SourceError('unexpected_content_encoding')
                length = headers.get('content-length')
                if length and (not length.isdigit() or int(length) > MAX_RESPONSE):
                    raise SourceError('response_too_large')
                body = response.read(MAX_RESPONSE + 1)
                if len(body) > MAX_RESPONSE:
                    raise SourceError('response_too_large')
                if response.will_close:
                    self.close()
                if status == 200:
                    return body, utc_now(), round(time.monotonic() - started, 3), {key: headers[key] for key in ['date', 'content-type', 'content-length', 'etag'] if key in headers}
                if status != 429 and status < 500:
                    raise SourceError('http_' + str(status))
            except (OSError, http.client.HTTPException):
                self.close()
            if attempt == 5:
                raise SourceError('request_retries_exhausted')
            waiting = retry_after(headers.get('retry-after')) if status == 429 else None
            waiting = waiting if waiting is not None else min(30, 2 ** (attempt + 1))
            emit({'action': 'retry', 'attempt': attempt + 1, 'httpStatus': status, 'waitSeconds': waiting, 'responseSha256': sha(body) if body else None})
            while waiting > 0 and not STOP:
                step = min(30, waiting)
                time.sleep(step)
                waiting -= step
        raise SourceError('request_retries_exhausted')


def load_state(root):
    file = root / 'state.json'
    if not file.exists():
        return {'schemaVersion': 1, 'filters': FILTERS, 'pageCount': 0, 'englishSentenceCount': 0, 'eligiblePairCount': 0, 'responseBytes': 0, 'rejections': {}, 'nextUrl': FIRST_URL, 'startedAt': utc_now(), 'status': 'in-progress', 'pages': []}
    state = json.loads(file.read_text(encoding='utf-8'))
    if state.get('schemaVersion') != 1 or state.get('filters') != FILTERS:
        raise SourceError('checkpoint_config_changed')
    for record in state['pages']:
        for key, digest in [('rawFile', 'responseSha256'), ('pairsFile', 'pairsSha256')]:
            relative = Path(record[key])
            if relative.is_absolute() or '..' in relative.parts:
                raise SourceError('invalid_checkpoint_path')
            file = root / relative
            if file.is_symlink() or file.resolve() != file or sha(file.read_bytes()) != record[digest]:
                raise SourceError('checkpoint_file_hash_mismatch')
    if state['nextUrl']:
        validate_url(state['nextUrl'], allow_first=state['pageCount'] == 0)
    return state


def commit_page(root, state, raw, url, observed_at, seconds, headers):
    page, pairs, rejected = parse_page(raw, url, observed_at)
    number, digest = state['pageCount'] + 1, sha(raw)
    stem = f'page-{number:06d}-{digest[:16]}'
    raw_file, pair_file = f'responses/{stem}.json', f'selected-pairs/{stem}.jsonl'
    pair_bytes = ''.join(json.dumps(pair, ensure_ascii=False, separators=(',', ':')) + '\n' for pair in pairs).encode('utf-8')
    if len(pair_bytes) > 64 * 1024 * 1024 or state['responseBytes'] + len(raw) > MAX_CAPTURE_BYTES:
        raise SourceError('bounded_capture_limit')
    metadata = {'page': number, 'requestUrl': url, 'observedAt': observed_at, 'seconds': seconds, 'responseBytes': len(raw), 'responseSha256': digest, 'rawFile': raw_file, 'pairsFile': pair_file, 'pairsSha256': sha(pair_bytes), 'englishSentenceCount': len(page['data']), 'eligiblePairCount': len(pairs), 'rejections': rejected, 'paging': page['paging'], 'responseHeaders': headers}
    atomic_write(root, root / raw_file, raw)
    atomic_write(root, root / pair_file, pair_bytes)
    atomic_write(root, root / ('responses/' + stem + '.metadata.json'), (json.dumps(metadata, ensure_ascii=False, indent=2) + '\n').encode())
    state['pages'].append(metadata)
    state['pageCount'] = number
    for key in ['englishSentenceCount', 'eligiblePairCount', 'responseBytes']:
        state[key] += metadata[key]
    state['rejections'] = dict(Counter(state['rejections']) + Counter(rejected))
    state.setdefault('firstApiTotal', page['paging']['total'])
    state['lastApiTotal'] = page['paging']['total']
    state['nextUrl'] = page['paging'].get('next') if page['paging']['has_next'] else None
    state['status'] = 'in-progress' if state['nextUrl'] else 'complete'
    state['updatedAt'] = utc_now()
    state['observationNote'] = 'Current live API pages; not an October 10 translation-link snapshot; owners are current owners, not proven original authors; linguistic review remains pending.'
    atomic_write(root, root / 'state.json', (json.dumps(state, ensure_ascii=False, indent=2) + '\n').encode())
    emit({key: metadata[key] for key in ['page', 'seconds', 'responseBytes', 'englishSentenceCount', 'eligiblePairCount', 'responseSha256']} | {'apiTotal': page['paging']['total'], 'totalEligiblePairs': state['eligiblePairCount'], 'hasNext': bool(state['nextUrl'])})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fetch', action='store_true', help='Explicitly allow read-only public network acquisition; otherwise dry-run.')
    parser.add_argument('--max-pages', type=int, default=0, help='New pages per run; 0 continues until official paging ends.')
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--adopt-first-page', action='store_true', help='Reuse this task first-page probe only after its request URL/hash/date are verified.')
    args = parser.parse_args()
    if args.max_pages < 0:
        parser.error('--max-pages must be nonnegative')
    if not args.fetch:
        emit({'dryRun': True, 'firstUrl': FIRST_URL, 'output': str(args.output), 'requestedPageLimit': 500, 'observedCurrentServerPageCap': 50, 'maximumRequestsPerSecond': 2, 'maximumRetries': 5, 'licenseAllowlist': list(LICENSES), 'chineseScriptRequired': 'Hans'})
        return
    root = args.output
    check_storage(root)
    with (root / '.collector.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise SourceError('collector_already_running') from error
        state, fetcher, done = load_state(root), Fetcher(), 0
        try:
            if args.adopt_first_page and state['pageCount'] == 0:
                metadata = json.loads((root / 'first-page-probe-metadata.json').read_text())
                raw = (root / 'first-page-probe.json').read_bytes()
                if metadata['requestUrl'] != FIRST_URL or metadata['httpStatus'] != '200' or metadata['sha256'] != sha(raw):
                    raise SourceError('first_page_probe_mismatch')
                commit_page(root, state, raw, FIRST_URL, metadata['fetchedAt'], metadata['seconds'], {})
                done += 1
            while state['nextUrl'] and not STOP and (not args.max_pages or done < args.max_pages):
                url = state['nextUrl']
                if any(record['requestUrl'] == url for record in state['pages']):
                    raise SourceError('repeated_cursor')
                raw, observed_at, seconds, headers = fetcher.request(url)
                commit_page(root, state, raw, url, observed_at, seconds, headers)
                done += 1
            if state['nextUrl']:
                state['status'] = 'paused'
                state['updatedAt'] = utc_now()
                atomic_write(root, root / 'state.json', (json.dumps(state, ensure_ascii=False, indent=2) + '\n').encode())
            emit({'status': state['status'], 'pageCount': state['pageCount'], 'englishSentenceCount': state['englishSentenceCount'], 'eligiblePairCount': state['eligiblePairCount'], 'responseBytes': state['responseBytes'], 'firstApiTotal': state.get('firstApiTotal'), 'lastApiTotal': state.get('lastApiTotal'), 'output': str(root)})
        finally:
            fetcher.close()


def interrupted(signum, frame):
    global STOP
    STOP = True


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        main()
    except (SourceError, OSError, ValueError, KeyError) as error:
        emit({'status': 'failed', 'code': str(error) if isinstance(error, SourceError) else type(error).__name__})
        raise SystemExit(1)
