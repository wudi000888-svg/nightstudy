#!/usr/bin/env python3
"""Offline missing-word supplement; existing and verified recorded audio wins.

This developer-only builder reuses already cached voice models and never starts
a download. It emits only missing word/accent pairs, retaining source hashes.
"""
from __future__ import annotations
import argparse
import concurrent.futures
import gzip
import hashlib
import importlib.util
import json
import multiprocessing
from pathlib import Path
import shutil
import tarfile

SPEC = importlib.util.spec_from_file_location("word_audio_pack", Path(__file__).with_name("audio-pack.py"))
pack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pack)
CODEC_SPEC = importlib.util.spec_from_file_location("offline_audio_codec", Path(__file__).with_name("offline-audio-codec.py"))
codec = importlib.util.module_from_spec(CODEC_SPEC)
CODEC_SPEC.loader.exec_module(codec)


def worker(accent, lemmas, output_string, model_string, shard):
    output = Path(output_string)
    sources = pack.load_sources(pack.DEFAULT_VOICES_MANIFEST)
    source = sources["voices"][accent]
    voice = pack.make_voice(source, Path(model_string), 1, False)
    phonemizer = pack.make_phonemizer()
    journal = output / "progress" / f"{accent}-{shard}.jsonl"
    cached = {}
    for filename in (output / "progress").glob(f"{accent}-*.jsonl"):
        for line in filename.read_text().splitlines():
            try:
                entry = json.loads(line)
                cached[entry["lemma"]] = entry
            except (ValueError, KeyError):
                continue
    entries = []
    with journal.open("a", encoding="utf-8") as handle:
        for index, lemma in enumerate(lemmas):
            entry = cached.get(lemma)
            identity = pack.synthesis_identity(lemma, accent, source)
            if not entry or not pack.validate_entry(entry, output, identity):
                entry = pack.synthesize_entry(lemma, accent, source, voice, output)
                entry.update(pack.algorithmic_phonetic(lemma, accent, phonemizer))
            if entry.get("mimeType") != "audio/mpeg":
                entry = codec.encode_mp3(entry, output)
                handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
                handle.flush()
            entries.append(entry)
            if (index + 1) % 100 == 0:
                print(json.dumps({"phase": "word-build", "accent": accent, "shard": shard, "ready": index + 1, "total": len(lemmas)}), flush=True)
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lemmas-file", type=Path, required=True)
    parser.add_argument("--existing-manifest", type=Path, action="append", default=[])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--workers", type=int, choices=(2, 4, 6), default=6)
    args = parser.parse_args()
    lemmas = sorted({pack.normalize_lemma(lemma) for lemma in json.loads(args.lemmas_file.read_text())})
    existing = set()
    for filename in args.existing_manifest:
        data = json.loads(filename.read_text())
        existing.update((entry["lemma"], entry["accent"]) for entry in data["entries"])
    missing = {accent: [lemma for lemma in lemmas if (lemma, accent) not in existing] for accent in ("US", "UK")}
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    (output / "progress").mkdir(exist_ok=True)
    source = {"schemaVersion": 2, "version": "word-audio-v2", "policy": "Offline synthetic supplement only for missing word/accent pairs. Existing recorded audio is preferred by installation. No runtime generation.", "engineSource": json.loads(pack.DEFAULT_VOICES_MANIFEST.read_text()), "targetLemmas": lemmas, "excludedExistingManifestSha256": {filename.name: pack.sha_file(filename) for filename in args.existing_manifest}}
    pack.atomic_json(output / "sources.manifest.json", source)
    print(json.dumps({"phase": "scope", "lemmas": len(lemmas), "usMissing": len(missing["US"]), "ukMissing": len(missing["UK"])}), flush=True)
    shards = args.workers // 2
    with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers, mp_context=multiprocessing.get_context("spawn")) as pool:
        futures = [pool.submit(worker, accent, missing[accent][shard::shards], str(output), str(args.model_dir.resolve()), shard) for accent in ("US", "UK") for shard in range(shards)]
        entries = [entry for future in futures for entry in future.result()]
    entries.sort(key=lambda entry: (entry["lemma"], entry["accent"]))
    for entry in entries:
        if not pack.validate_entry(entry, output, entry["cacheKey"]):
            raise ValueError("word_supplement_validation_failed")
    stats = {"lemmaCount": len({entry["lemma"] for entry in entries}), "entryCount": len(entries), "recordedCount": 0, "synthesizedCount": len(entries), "failedCount": 0}
    manifest = {"schemaVersion": 2, "version": "word-audio-v2", "status": "ready", "sourceManifestSha256": pack.sha_file(output / "sources.manifest.json"), "statistics": stats, "entries": entries}
    pack.atomic_json(output / "manifest.json", manifest)
    licenses = output / "licenses"
    licenses.mkdir(exist_ok=True)
    for name in source["engineSource"]["licenseNotices"]:
        shutil.copyfile(pack.DEFAULT_VOICES_MANIFEST.parent / name, licenses / Path(name).name)
    archive_path = output.parent / "nightstudy-word-audio-v2.tar.gz"
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
    pin = {"id": "word-audio-v2", "status": "ready", "version": "word-audio-v2", "source": {"url": "https://github.com/wudi000888-svg/nightstudy/releases/download/v0.9.0-alpha.1/" + archive_path.name, "sha256": pack.sha_file(archive_path), "sizeBytes": archive_path.stat().st_size}, **stats, "manifestSha256": pack.sha_file(output / "manifest.json"), "sourceManifestSha256": pack.sha_file(output / "sources.manifest.json"), "note": "Offline prebuilt US/UK missing-word supplement. Existing human recordings always win; no runtime generation."}
    pack.atomic_json(output.parent / "word-audio-v2.pin.json", pin)
    print(json.dumps({"phase": "ready", **pin}), flush=True)


if __name__ == "__main__":
    main()
