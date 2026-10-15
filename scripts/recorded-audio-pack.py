#!/usr/bin/env python3
"""Collect existing Commons human recordings; never synthesize or infer an accent.

The Commons category or description must independently confirm US or British
English, in addition to the conventional filename. Original bytes and complete
API metadata are retained with per-entry attribution. An unavailable accent is
left absent. Run on a mounted data volume, then publish the deterministic pack.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import csv
import datetime
import hashlib
import html
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = "NightStudyRecordedAudio/2 (https://github.com/wudi000888-svg/nightstudy; educational open source content pack)"
ALLOWED_LICENSES = {"cc-by-3.0-us", "cc-by-sa-3.0", "cc-by-sa-4.0", "cc-by-4.0", "cc0", "pd", "cc-by-3.0", "cc-by-sa-2.5", "cc-by-2.5"}
METADATA_BY_TITLE = None


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic_json(filename, value):
    raw = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    temporary = filename.with_suffix(filename.suffix + ".part")
    temporary.write_bytes(raw)
    temporary.replace(filename)
    return raw


def request(url):
    error = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=15) as response:
                if not response.geturl().startswith("https://"):
                    raise ValueError("insecure_redirect")
                return response.read(2 * 1024 * 1024 + 1)
        except urllib.error.HTTPError as caught:
            error = caught
            if caught.code not in (429, 500, 502, 503, 504):
                raise
            pause = min(float(caught.headers.get('Retry-After', 2 ** attempt)), 15)
            time.sleep(pause)
        except (OSError, urllib.error.URLError) as caught:
            error = caught
            time.sleep(min(2 ** attempt, 15))
    raise error


def api(parameters):
    data = json.loads(request(API + "?" + urllib.parse.urlencode({"action": "query", "format": "json", "maxlag": 5, **parameters})))
    if "error" in data:
        raise ValueError(str(data["error"]))
    return data


def clean(value):
    return html.unescape(re.sub(r"<[^>]*>", "", value)).strip()


def index_accent(accent, cache):
    filename = cache / f"index-{accent}.json"
    if filename.exists():
        return json.loads(filename.read_text())
    output, continuation = [], {}
    while True:
        data = api({"list": "allimages", "aiprefix": f"En-{accent.lower()}-", "ailimit": 500, "aiprop": "url|size|mime", **continuation})
        output.extend(data.get("query", {}).get("allimages", []))
        print(json.dumps({"phase": "index", "accent": accent, "files": len(output)}), flush=True)
        if "continue" not in data:
            break
        continuation = data["continue"]
        time.sleep(.2)
    atomic_json(filename, output)
    return output


def metadata_batch(batch, cache):
    global METADATA_BY_TITLE
    titles = [item["title"] for item in batch]
    if METADATA_BY_TITLE is None:
        METADATA_BY_TITLE = {}
        for cached in cache.glob('metadata-*.json'):
            for page in json.loads(cached.read_text()).get('query',{}).get('pages',{}).values():
                METADATA_BY_TITLE[page['title']]=page
    if all(title in METADATA_BY_TITLE for title in titles):
        return {'query':{'pages':{str(index):METADATA_BY_TITLE[title]for index,title in enumerate(titles)}}}
    key = digest("|".join(titles).encode())
    filename = cache / f"metadata-{key}.json"
    if filename.exists():
        return json.loads(filename.read_text())
    data = api({"titles": "|".join(titles), "prop": "imageinfo", "iiprop": "url|size|sha1|timestamp|extmetadata"})
    atomic_json(filename, data)
    return data


def entry_from_page(page, accent):
    info = page.get("imageinfo", [{}])[0]
    metadata = info.get("extmetadata", {})
    value = lambda key: clean(str(metadata.get(key, {}).get("value", "")))
    license_id = value("License").lower()
    if license_id not in ALLOWED_LICENSES:
        return None
    description = value("ImageDescription")
    categories = value("Categories")
    evidence = categories + " | " + description
    if re.search(r"synthesi[sz]|text.to.speech|computer.generated", evidence, re.I):
        return None
    patterns = {"US": r"(?:U\.S\.|US|American) English pronunciation|pronunciation.*(?:US|American) English|United States", "UK": r"British English pronunciation|Speaker from (?:London|England)|(?:British|UK) English pronunciation|Received Pronunciation"}
    if not re.search(patterns[accent], evidence, re.I):
        return None
    title = page["title"]
    prefix = f"File:En-{accent.lower()}-"
    if not title.startswith(prefix) or not title.lower().endswith(".ogg"):
        return None
    lemma = title[len(prefix):-4].replace("_", " ").lower()
    if not re.fullmatch(r"[a-z]+(?:[ '\-][a-z]+)*", lemma):
        return None
    url = info.get("url", "").split("?")[0]
    if not url.startswith("https://upload.wikimedia.org/wikipedia/commons/") or not value("Artist"):
        return None
    return {"lemma": lemma, "accent": accent, "kind": "recorded", "sourceName": "Wikimedia Commons / " + value("Artist"), "sourceUrl": info["descriptionurl"], "license": value("LicenseShortName"), "attribution": value("Artist") + "; " + title + "; " + value("LicenseUrl") + "; original unmodified recording.", "mimeType": "audio/ogg", "accentEvidence": evidence, "downloadUrl": url, "sourceTimestamp": info.get("timestamp"), "sourceSha1": info.get("sha1"), "sourceSizeBytes": info.get("size")}


def download(entry, output):
    identity = digest(entry["downloadUrl"].encode())
    marker = output / "downloads" / (identity + ".json")
    if marker.exists():
        saved = json.loads(marker.read_text())
        filename = output / saved["fileKey"]
        if filename.is_file() and digest(filename.read_bytes()) == saved["fileSha256"] and hashlib.sha1(filename.read_bytes()).hexdigest() == entry['sourceSha1']:
            return saved
    raw = request(entry["downloadUrl"])
    if len(raw) > 2 * 1024 * 1024 or len(raw) < 32 or raw[:4] != b"OggS":
        raise ValueError("recording_invalid")
    if len(raw) != entry["sourceSizeBytes"]:
        raise ValueError("recording_source_size_mismatch")
    if hashlib.sha1(raw).hexdigest() != entry["sourceSha1"]:
        raise ValueError("recording_source_sha1_mismatch")
    sha = digest(raw)
    entry = {**entry, "fileKey": f"files/{sha}.ogg", "fileSha256": sha}
    (output / entry["fileKey"]).write_bytes(raw)
    atomic_json(marker, entry)
    return entry


def curl_downloads(candidates, output, workers):
    entries, failures, pending = [], [], []
    for entry in candidates:
        marker=output/'downloads'/(digest(entry['downloadUrl'].encode())+'.json')
        if marker.exists():
            saved=json.loads(marker.read_text());filename=output/saved['fileKey']
            if filename.is_file():
                raw=filename.read_bytes()
                if digest(raw)==saved['fileSha256'] and hashlib.sha1(raw).hexdigest()==entry['sourceSha1']:
                    entries.append(saved);continue
        pending.append(entry)
    config=output/'research/curl-downloads.conf'
    lines=[];by_url={}
    report='{"httpStatus":%{http_code},"bytes":%{size_download},"seconds":%{time_total},"url":"%{url_effective}","exitCode":%{exitcode}}\\n'
    for entry in pending:
        key=digest(entry['downloadUrl'].encode());target=output/'downloads'/(key+'.part')
        by_url[entry['downloadUrl']]=(entry,target)
        lines.extend(['url = '+json.dumps(entry['downloadUrl']),'output = '+json.dumps(str(target)), 'location', 'proto = "=https"', 'proto-redir = "=https"', 'connect-timeout = 10', 'max-time = 15', 'retry = 2', 'retry-delay = 1', 'retry-max-time = 45', 'user-agent = '+json.dumps(USER_AGENT), 'write-out = '+json.dumps(report), 'next'])
    config.write_text('\n'.join(lines[:-1])+'\n')
    if not pending:return entries,failures
    # curl's bounded parallel transfers reuse TLS/HTTP connections; Python
    # urllib opens a fresh connection for every clip. No shell interpolation.
    arguments=['curl','--silent','--show-error','--location','--proto','=https','--proto-redir','=https','--parallel','--parallel-max',str(workers),'--connect-timeout','10','--max-time','15','--retry','2','--retry-delay','1','--retry-max-time','45','--user-agent',USER_AGENT,'--write-out',report,'--config',str(config)]
    with (output/'research/curl-media-errors.log').open('w')as errors:
        process=subprocess.Popen(arguments,stdout=subprocess.PIPE,stderr=errors,text=True)
        for line in process.stdout:
            result=json.loads(line);entry,target=by_url[result['url']]
            try:
                if result['httpStatus']!=200 or result['exitCode']!=0:
                    raise ValueError('http_download_failed')
                raw=target.read_bytes()
                if len(raw)!=entry['sourceSizeBytes'] or not 32<=len(raw)<=2*1024*1024 or raw[:4]!=b'OggS':
                    raise ValueError('recording_invalid')
                if hashlib.sha1(raw).hexdigest()!=entry['sourceSha1']:raise ValueError('recording_source_sha1_mismatch')
                sha=digest(raw);saved={**entry,'fileKey':f'files/{sha}.ogg','fileSha256':sha}
                target.replace(output/saved['fileKey'])
                atomic_json(output/'downloads'/(digest(entry['downloadUrl'].encode())+'.json'),saved)
                entries.append(saved)
            except (OSError,ValueError)as error:
                failure={**{key:entry[key]for key in ['lemma','accent']},**{key:result[key]for key in ['httpStatus','exitCode','seconds']},'error':str(error)}
                failures.append(failure)
                with (output/'research/download-failures.jsonl').open('a')as handle:handle.write(json.dumps(failure)+'\n')
            finally:
                target.unlink(missing_ok=True)
            if (len(entries)+len(failures))%25==0:print(json.dumps({'phase':'download','backend':'curl','recordings':len(entries),'failed':len(failures),'total':len(candidates)}),flush=True)
        process.wait()
    if len(entries)+len(failures)!=len(candidates):raise ValueError('media_download_accounting_incomplete')
    return entries,failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ecdict", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--license-dir", required=True)
    parser.add_argument("--lemmas-file", type=Path)
    parser.add_argument("--download-workers", type=int, choices=(4, 6, 8), default=6)
    parser.add_argument("--media-backend", choices=('urllib','curl'), default='curl')
    args = parser.parse_args()
    output = Path(args.output).resolve()
    for folder in (output, output / "research", output / "files", output / "licenses", output / "downloads"):
        folder.mkdir(parents=True, exist_ok=True)
    with open(args.ecdict, encoding="utf-8-sig", newline="") as handle:
        canonical = {row["word"].strip().lower() for row in csv.DictReader(handle)}
    if args.lemmas_file:
        canonical &= set(json.loads(args.lemmas_file.read_text()))
    indexes = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(index_accent, accent, output / "research"): accent for accent in ("US", "UK")}
        for future in concurrent.futures.as_completed(futures):
            indexes[futures[future]] = future.result()
    candidates = []
    for accent, index in indexes.items():
        prefix = f"En-{accent.lower()}-"
        chosen = [item for item in index if item["name"].lower().endswith(".ogg") and item["name"][len(prefix):-4].replace("_", " ").lower() in canonical]
        for start in range(0, len(chosen), 50):
            data = metadata_batch(chosen[start:start + 50], output / "research")
            for page in data.get("query", {}).get("pages", {}).values():
                entry = entry_from_page(page, accent)
                if entry:
                    candidates.append(entry)
            print(json.dumps({"phase": "metadata", "accent": accent, "processed": min(start + 50, len(chosen)), "total": len(chosen), "accepted": len(candidates)}), flush=True)
    candidates = list({(entry['lemma'],entry['accent']):entry for entry in candidates}.values())
    qc = set(['rain','water','claim','record','academic','though','through','ielts','tomato','schedule','read','lead','present','comfortable','opportunity','quiet','window','abandon','a','the'])
    candidates.sort(key=lambda entry:(entry['lemma'] not in qc,entry['lemma'],entry['accent']))
    atomic_json(output / "research/candidates.json", candidates)
    print(json.dumps({'phase':'download-scope','targetLemmas':len(canonical),'candidates':len(candidates),'us':sum(e['accent']=='US' for e in candidates),'uk':sum(e['accent']=='UK' for e in candidates)}),flush=True)
    entries, failures = [], []
    if args.media_backend=='curl':
        entries,failures=curl_downloads(candidates,output,args.download_workers)
    else:
      with concurrent.futures.ThreadPoolExecutor(max_workers=args.download_workers) as pool:
        futures = {pool.submit(download, entry, output): entry for entry in candidates}
        for future in concurrent.futures.as_completed(futures):
            try:
                entries.append(future.result())
            except Exception as error:
                failure={"lemma": futures[future]["lemma"], "accent": futures[future]["accent"], "error": type(error).__name__,"detail":str(error)[:200],"httpStatus":getattr(error,'code',None)}
                failures.append(failure)
                with (output/'research/download-failures.jsonl').open('a') as handle:handle.write(json.dumps(failure)+'\n')
            if (len(entries) + len(failures)) % 25 == 0:
                print(json.dumps({"phase": "download", "recordings": len(entries), "failed": len(failures), "total": len(candidates)}), flush=True)
    entries.sort(key=lambda entry: (entry["lemma"], entry["accent"]))
    source = {"schemaVersion": 2, "version": "recorded-audio-v2", "policy": "Existing human recordings only; unknown or missing accents remain absent. No synthesized audio, browser speech, audio normalization or transcoding.", "api": API, "retrievedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "entries": [{key: value for key, value in entry.items() if key not in ("fileKey", "fileSha256", "mimeType")} for entry in entries]}
    # The sources manifest contains complete per-entry license and accent evidence.
    # It is intentionally separate from app-facing metadata.
    source_raw = atomic_json(output / "sources.manifest.json", source)
    statistics = {"lemmaCount": len({entry["lemma"] for entry in entries}), "entryCount": len(entries), "recordedCount": len(entries), "synthesizedCount": 0, "failedCount": 0, "downloadFailureCount": len(failures), "usCount": sum(entry["accent"] == "US" for entry in entries), "ukCount": sum(entry["accent"] == "UK" for entry in entries)}
    manifest = {"schemaVersion": 2, "version": "recorded-audio-v2", "status": "ready", "sourceManifestSha256": digest(source_raw), "statistics": statistics, "entries": entries}
    raw = atomic_json(output / "manifest.json", manifest)
    atomic_json(output / "research/download-failures.json", failures)
    for item in Path(args.license_dir).glob("COMMONS-*.txt"):
        shutil.copyfile(item, output / "licenses" / item.name)
    (output / "licenses/NOTICE.txt").write_text("Original unmodified human recordings from Wikimedia Commons. Per-file authors, source descriptions, license URLs and accent evidence are in sources.manifest.json. Creative Commons terms apply to each audio file, separately from application code. No synthesized audio is included.\n")
    archive_path = output.parent / "nightstudy-recorded-audio-v2.tar.gz"
    with archive_path.open("wb") as target:
        import gzip
        with gzip.GzipFile(filename="", fileobj=target, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.USTAR_FORMAT) as archive:
                files = [output / "manifest.json", output / "sources.manifest.json", *sorted((output / "licenses").glob("*")), *sorted((output / "files").glob("*"))]
                for filename in files:
                    info = archive.gettarinfo(str(filename), arcname=filename.relative_to(output).as_posix())
                    info.mtime = 0
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    info.mode = 0o644
                    with filename.open("rb") as handle:
                        archive.addfile(info, handle)
    pin = {"id": "recorded-audio-v2", "status": "ready", "version": "recorded-audio-v2", "source": {"url": "https://github.com/wudi000888-svg/nightstudy/releases/download/v0.9.0-alpha.1/" + archive_path.name, "sizeBytes": archive_path.stat().st_size, "sha256": digest(archive_path.read_bytes())}, **statistics, "sourceManifestSha256": digest(source_raw), "manifestSha256": digest(raw), "note": "Human recordings only. Each accent requires independent Commons category/description evidence and a redistributable license. Missing accents remain unavailable; no synthetic speech is installed or served."}
    atomic_json(output.parent / "recorded-audio-v2.pin.json", pin)
    print(json.dumps({"phase": "ready", **pin}), flush=True)


if __name__ == "__main__":
    main()
