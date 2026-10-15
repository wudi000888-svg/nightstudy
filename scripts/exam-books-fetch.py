#!/usr/bin/env python3
"""Fetch the exact, checksum-pinned book sources into an explicitly chosen directory."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    sources = json.loads((ROOT / 'data/exam-books.sources.json').read_text())['sources']
    args.destination.mkdir(parents=True, exist_ok=True)
    for source in sources:
        target = args.destination / (source['id'] + Path(source['path']).suffix)
        temporary = target.with_name(target.name + '.part')
        if not target.exists():
            try:
                request = urllib.request.Request(source['sourceUrl'], headers={'User-Agent': 'NightStudy-pinned-books/1'})
                with urllib.request.urlopen(request, timeout=90) as response, temporary.open('xb') as output:
                    if response.status != 200:
                        raise ValueError('book_source_http_error')
                    output.write(response.read(source['bytes'] + 1))
                data = temporary.read_bytes()
                if len(data) != source['bytes'] or hashlib.sha256(data).hexdigest() != source['sha256']:
                    raise ValueError('book_source_checksum_mismatch:' + source['id'])
                temporary.rename(target)
            finally:
                temporary.unlink(missing_ok=True)
        data = target.read_bytes()
        if len(data) != source['bytes'] or hashlib.sha256(data).hexdigest() != source['sha256']:
            raise ValueError('book_source_checksum_mismatch:' + source['id'])
        print(json.dumps({'source': source['id'], 'bytes': len(data), 'verified': True}))


if __name__ == '__main__':
    main()
