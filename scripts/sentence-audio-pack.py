#!/usr/bin/env python3
"""Build static sentence audio offline from already verified cached Piper voices.

Only English examples in pinned public content bundles and original academy
lessons are included. No runtime process imports this module. Every sentence is
deduplicated by its canonical SHA-256; journaled work is resumable. Sources are
retained separately and no model download is permitted.
"""
from __future__ import annotations
import argparse
import ast
import concurrent.futures
import gzip
import hashlib
import importlib.util
import json
import multiprocessing
from pathlib import Path
import re
import shutil
import tarfile
import unicodedata

SPEC = importlib.util.spec_from_file_location("word_audio_pack", Path(__file__).with_name("audio-pack.py"))
pack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pack)
CODEC_SPEC = importlib.util.spec_from_file_location("offline_audio_codec", Path(__file__).with_name("offline-audio-codec.py"))
codec = importlib.util.module_from_spec(CODEC_SPEC)
CODEC_SPEC.loader.exec_module(codec)


def normalize(text):
    text = unicodedata.normalize("NFKC", text)
    return re.sub(r"\s+", " ", text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')).strip()


def text_hash(text):
    return hashlib.sha256(normalize(text).encode()).hexdigest()


def collect(repo):
    records = {}
    for relative in ("data/bilingual-v1.jsonl.gz", "data/phrase-books-v1.jsonl.gz"):
        with gzip.open(repo / relative, "rt", encoding="utf-8") as handle:
            for line in handle:
                row = json.loads(line)
                for example in [*row.get("examples", []), *row.get("senses", [])]:
                    text = normalize(example.get("exampleEn", ""))
                    if text:
                        records[text_hash(text)] = {"textHash": text_hash(text), "text": text, "source": example.get("contentMetadata", {}).get("exampleEn", {}), "bundle": relative}
    # The only [English, Chinese] string tuples in this original module are its
    # authored lesson lines. Decode JS single quoted strings, including escapes.
    academy = (repo / "apps/api/src/modules/academy-content.ts").read_text()
    for match in re.finditer(r"\[\s*'((?:\\.|[^'\\])*)'\s*,\s*'((?:\\.|[^'\\])*)'\s*[,]?\s*\]", academy):
        text = normalize(re.sub(r"\\(['\\])", r"\1", match.group(1)))
        if re.search(r"[\u3400-\u9fff]", match.group(2)) and re.search("[A-Za-z]", text):
            records[text_hash(text)] = {"textHash": text_hash(text), "text": text, "source": {"kind": "original", "license": "MIT", "author": "NightStudy contributors"}, "bundle": "apps/api/src/modules/academy-content.ts"}
    for section in academy.split("\n  lesson(")[1:]:
        lines = []
        for match in re.finditer(r"\[\s*'((?:\\.|[^'\\])*)'\s*,\s*'((?:\\.|[^'\\])*)'\s*[,]?\s*\]", section):
            if re.search(r"[\u3400-\u9fff]", match.group(2)):
                lines.append(normalize(re.sub(r"\\(['\\])", r"\1", match.group(1))))
        if lines:
            text = normalize(" ".join(lines))
            records[text_hash(text)] = {"textHash": text_hash(text), "text": text, "source": {"kind": "original", "license": "MIT", "author": "NightStudy contributors"}, "bundle": "apps/api/src/modules/academy-content.ts", "unit": "complete-lesson"}
    seed = (repo / 'scripts/seed.ts').read_text()
    seed_words = seed.split('const words = [', 1)[1].split('];', 1)[0]
    literal = r"('(?:\\.|[^'\\])*')"
    row_pattern = r"\[\s*" + r"\s*,\s*".join([literal] * 5) + r"\s*,?\s*\]"
    for match in re.finditer(row_pattern, seed_words):
        text = normalize(ast.literal_eval(match.group(5)))
        records[text_hash(text)] = {'textHash':text_hash(text),'text':text,'source':{'kind':'original','license':'MIT','author':'NightStudy contributors','sourceFileSha256':hashlib.sha256(seed.encode()).hexdigest()},'bundle':'scripts/seed.ts','unit':'original-seed-example'}
    return sorted(records.values(), key=lambda row: row["textHash"])


def worker(accent, rows, output_string, models_string, shard):
    output, models = Path(output_string), Path(models_string)
    sources = pack.load_sources(pack.DEFAULT_VOICES_MANIFEST)
    source = sources["voices"][accent]
    voice = pack.make_voice(source, models, 1, False)
    journal = output / "progress" / f"{accent}-{shard}.jsonl"
    saved = {}
    for filename in (output / "progress").glob(f"{accent}-*.jsonl"):
        for line in filename.read_text().splitlines():
            try:
                entry = json.loads(line)
                saved[entry["textHash"]] = entry
            except (ValueError, KeyError):
                continue
    entries = []
    with journal.open("a", encoding="utf-8") as handle:
        for index, row in enumerate(rows):
            entry = saved.get(row["textHash"])
            identity = pack.synthesis_identity(row["text"], accent, source)
            if not entry or entry.get("inferenceBackend") == "CoreML with CPU fallback" or not pack.validate_entry(entry, output, identity):
                entry = pack.synthesize_entry(row["text"], accent, source, voice, output)
                entry = {**entry, "textHash": row["textHash"], "text": row["text"]}
            attribution = {key: source[key] for key in ('sourceName', 'sourceUrl', 'license', 'attribution')}
            metadata_changed = any(entry.get(key) != value for key, value in attribution.items())
            entry = {**entry, **attribution}
            converted = entry.get("mimeType") != "audio/mpeg"
            if converted:
                entry = codec.encode_mp3(entry, output)
            if converted or metadata_changed:
                handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
                handle.flush()
            entries.append(entry)
            if (index + 1) % 100 == 0:
                print(json.dumps({"phase": "sentence-build", "accent": accent, "shard": shard, "ready": index + 1, "total": len(rows)}), flush=True)
    return entries


def audit_entries(entries, output, workers):
    """Decode every selected artifact once, with a resumable digest-keyed audit.

    Older completed journals predate the acoustic checks. They can be reused
    after this check without synthesizing the same public sentence again.
    """
    cached = {}
    journal = output / 'progress' / 'quality-v1.jsonl'
    if journal.exists():
        for line in journal.read_text().splitlines():
            try:
                row = json.loads(line)
                if row['qualityMetrics'].get('policyVersion') == codec.QUALITY_POLICY['version']:
                    cached[row['fileSha256']] = row['qualityMetrics']
            except (ValueError, KeyError, TypeError):
                continue
    unique = {entry['fileSha256']: entry for entry in entries}
    pending = [entry for digest, entry in unique.items() if digest not in cached]
    print(json.dumps({'phase': 'sentence-audit', 'cached': len(unique) - len(pending),
                      'pending': len(pending), 'uniqueFiles': len(unique)}), flush=True)
    with journal.open('a', encoding='utf-8') as handle:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, workers)) as pool:
            for index, (entry, metrics) in enumerate(pool.map(
                    lambda entry: (entry, codec.inspect_media(entry, output)), pending)):
                cached[entry['fileSha256']] = metrics
                handle.write(json.dumps({'fileSha256': entry['fileSha256'], 'qualityMetrics': metrics},
                                        separators=(',', ':')) + '\n')
                handle.flush()
                if (index + 1) % 1000 == 0:
                    print(json.dumps({'phase': 'sentence-audit', 'ready': index + 1,
                                      'total': len(pending)}), flush=True)
    return [{**entry, 'qualityMetrics': cached[entry['fileSha256']]} for entry in entries]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--workers", type=int, choices=(2, 4, 6, 8), default=6)
    parser.add_argument("--collect-only", action="store_true")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    (output / "progress").mkdir(exist_ok=True)
    rows = collect(Path(__file__).resolve().parent.parent)
    source = {"schemaVersion": 2, "version": "sentence-audio-v1", "normalization": "NFKC; curly quote to ASCII; collapse whitespace; preserve case", "engineSource": json.loads(pack.DEFAULT_VOICES_MANIFEST.read_text()), "sentences": rows, "policy": "Prebuilt locally; never generated by the API or browser. Synthetic pronunciation is not expert certified."}
    pack.atomic_json(output / "sources.manifest.json", source)
    print(json.dumps({"phase": "scope", "sentences": len(rows), "entries": len(rows) * 2}), flush=True)
    if args.collect_only:
        return
    shards = args.workers // 2
    with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers, mp_context=multiprocessing.get_context("spawn")) as pool:
        futures = [pool.submit(worker, accent, rows[shard::shards], str(output), str(args.model_dir.resolve()), shard) for accent in ("US", "UK") for shard in range(shards)]
        entries = [entry for future in futures for entry in future.result()]
    entries.sort(key=lambda entry: (entry["textHash"], entry["accent"]))
    for entry in entries:
        if not pack.validate_entry(entry, output, entry["cacheKey"]) or entry["textHash"] != text_hash(entry["text"]):
            raise ValueError("sentence_asset_validation_failed")
    entries = audit_entries(entries, output, args.workers)
    source.update({'acousticQualityPolicy': codec.QUALITY_POLICY, 'transcodingTool': codec.build_tool_identity()})
    pack.atomic_json(output / 'sources.manifest.json', source)
    stats = {"lemmaCount": len(rows), "entryCount": len(entries), "recordedCount": 0, "synthesizedCount": len(entries), "failedCount": 0}
    manifest = {"schemaVersion": 2, "version": "sentence-audio-v1", "status": "ready", "sourceManifestSha256": pack.sha_file(output / "sources.manifest.json"), "statistics": stats, "entries": entries}
    pack.atomic_json(output / "manifest.json", manifest)
    licenses = output / "licenses"
    licenses.mkdir(exist_ok=True)
    for name in source["engineSource"]["licenseNotices"]:
        shutil.copyfile(pack.DEFAULT_VOICES_MANIFEST.parent / name, licenses / Path(name).name)
    repo = Path(__file__).resolve().parent.parent
    for relative in ("data/bilingual-licenses/CC-BY-2.0-FR-legalcode.txt", "data/bilingual-licenses/CC-BY-4.0-legalcode.txt"):
        shutil.copyfile(repo / relative, licenses / Path(relative).name)
    archive_path = output.parent / "nightstudy-sentence-audio-v1.tar.gz"
    with archive_path.open("wb") as target:
        with gzip.GzipFile(filename="", fileobj=target, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.USTAR_FORMAT) as archive:
                files = [output / "manifest.json", output / "sources.manifest.json", *sorted(licenses.glob("*")), *sorted({output / entry["fileKey"] for entry in entries})]
                for filename in files:
                    info = archive.gettarinfo(str(filename), arcname=filename.relative_to(output).as_posix())
                    info.mtime = 0
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    info.mode = 0o644
                    with filename.open("rb") as handle:
                        archive.addfile(info, handle)
    pin = {"id": "sentence-audio-v1", "status": "ready", "version": "sentence-audio-v1", "source": {"url": "https://github.com/wudi000888-svg/nightstudy/releases/download/v0.9.0-alpha.1/" + archive_path.name, "sha256": pack.sha_file(archive_path), "sizeBytes": archive_path.stat().st_size}, **stats, "manifestSha256": pack.sha_file(output / "manifest.json"), "sourceManifestSha256": pack.sha_file(output / "sources.manifest.json"), "note": "Locally prebuilt synthetic US/UK recordings for deduplicated public examples and original academy lines; no server or browser generation."}
    pack.atomic_json(output.parent / "sentence-audio-v1.pin.json", pin)
    print(json.dumps({"phase": "ready", **pin}), flush=True)


if __name__ == "__main__":
    main()
