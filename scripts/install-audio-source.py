"""Retain the pinned engine source alongside its license in redistributed images."""
import hashlib
import json
import pathlib
import shutil
import urllib.request

manifest = json.loads(pathlib.Path('data/audio-voices.manifest.json').read_text())
source = next(item for item in manifest['engine']['officialPackages'] if item['filename'].endswith('.tar.gz'))
destination = pathlib.Path('/opt/nightstudy-audio/source')
destination.mkdir(parents=True, exist_ok=True)
target = destination / source['filename']
digest = hashlib.sha256()
length = 0
with urllib.request.urlopen(source['url'], timeout=120) as response, target.open('wb') as output:
    while chunk := response.read(1024 * 1024):
        length += len(chunk)
        if length > source['size']:
            raise ValueError('engine source exceeds pinned size')
        digest.update(chunk)
        output.write(chunk)
if length != source['size'] or digest.hexdigest() != source['digests']['sha256']:
    raise ValueError('engine source does not match pinned checksum')
for notice in manifest['licenseNotices']:
    filename = pathlib.Path('data') / notice
    shutil.copyfile(filename, destination / filename.name)
shutil.copyfile('data/audio-voices.manifest.json', destination / 'sources.manifest.json')
