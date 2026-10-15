#!/usr/bin/env python3
"""Create a pinned, attributed audio pack or one bounded pronunciation asset.

Install piper-tts==1.8.0 in an isolated environment. Batch mode loads each voice
once. Request mode reads {"word": "rain", "accent": "US"} from stdin and prints
only one JSON metadata object; it never changes the full pack manifest.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime
import hashlib
import importlib.metadata
import json
import multiprocessing
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import time
import unicodedata
import urllib.request
import wave


ENGINE_VERSION = "1.8.0"
USER_AGENT = "NightStudyAudioPack/1 (https://github.com/wudi000888-svg/nightstudy)"
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VOICES_MANIFEST = REPO_ROOT / "data/audio-voices.manifest.json"


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def normalize_lemma(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("word_must_be_string")
    value = unicodedata.normalize("NFKC", value).strip().lower()
    value = re.sub(r"[’‘]", "'", value)
    value = re.sub(r"\s+", " ", value)
    if not value or len(value) > 160:
        raise ValueError("word_length_out_of_range")
    if any(unicodedata.category(char).startswith("C") for char in value):
        raise ValueError("word_contains_control_character")
    if "[[" in value or "]]" in value:
        raise ValueError("raw_phonemes_not_accepted")
    return value


def sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf-8") as handle:
        temporary = Path(handle.name)
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def load_sources(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schemaVersion") != 1 or data.get("version") != "audio-v1":
        raise ValueError("unsupported_voices_manifest")
    if data["engine"]["version"] != ENGINE_VERSION:
        raise ValueError("unsupported_engine_version")
    for accent in ("US", "UK"):
        for kind in ("model", "config"):
            item = data["voices"][accent][kind]
            if not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]):
                raise ValueError("invalid_source_digest")
            if Path(item["fileName"]).name != item["fileName"]:
                raise ValueError("invalid_source_filename")
    return data


def ensure_source(item: dict, directory: Path, allow_download: bool) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / item["fileName"]
    expected_size = item["sizeBytes"]
    if target.exists():
        if target.stat().st_size == expected_size and sha_file(target) == item["sha256"]:
            return target
        raise ValueError("cached_source_checksum_mismatch:" + target.name)
    # An explicitly staged download is accepted only after complete verification.
    staged = directory / (item["fileName"] + ".part")
    if staged.exists() and staged.stat().st_size == expected_size:
        if sha_file(staged) != item["sha256"]:
            raise ValueError("staged_source_checksum_mismatch:" + target.name)
        os.replace(staged, target)
        return target
    if not allow_download:
        raise ValueError("source_not_cached:" + target.name)
    if not item["url"].startswith("https://"):
        raise ValueError("source_requires_https")
    for attempt in range(3):
        temporary = None
        try:
            request = urllib.request.Request(item["url"], headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=90) as response:
                with tempfile.NamedTemporaryFile("wb", dir=directory, delete=False) as handle:
                    temporary = Path(handle.name)
                    size = 0
                    digest = hashlib.sha256()
                    while chunk := response.read(1024 * 1024):
                        size += len(chunk)
                        if size > expected_size:
                            raise ValueError("source_size_exceeded")
                        digest.update(chunk)
                        handle.write(chunk)
                    handle.flush()
                    os.fsync(handle.fileno())
            if size != expected_size or digest.hexdigest() != item["sha256"]:
                raise ValueError("download_source_checksum_mismatch")
            os.replace(temporary, target)
            return target
        except Exception:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError("source_download_failed")


def make_voice(source: dict, model_dir: Path, threads: int, allow_download: bool):
    if importlib.metadata.version("piper-tts") != ENGINE_VERSION:
        raise ValueError("piper_version_mismatch")
    # Use the public constructor to bound ONNX CPU threads, leaving the original
    # phonemizer/config intact. No upstream engine implementation is copied.
    import onnxruntime as ort
    from piper.config import PiperConfig
    from piper.voice import PiperVoice

    model = ensure_source(source["model"], model_dir, allow_download)
    config_path = ensure_source(source["config"], model_dir, allow_download)
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    return PiperVoice(
        session=ort.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"]),
        config=PiperConfig.from_dict(json.loads(config_path.read_text(encoding="utf-8"))),
    )


def synthesis_identity(lemma: str, accent: str, source: dict) -> str:
    identity = {
        "text": lemma,
        "accent": accent,
        "engine": ENGINE_VERSION,
        "model": source["model"]["sha256"],
        "config": source["config"]["sha256"],
        "generator": "audio-v1",
    }
    return hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def make_phonemizer():
    if importlib.metadata.version('piper-tts') != ENGINE_VERSION:
        raise ValueError('unsupported_offline_phonemizer_engine_version')
    from piper.phonemize_espeak import EspeakPhonemizer

    return EspeakPhonemizer()


def algorithmic_phonetic(lemma: str, accent: str, phonemizer) -> dict:
    variant = "en-us" if accent == "US" else "en-gb-x-rp"
    sentences = phonemizer.phonemize(variant, lemma)
    # The public phonemizer returns actual Unicode eSpeak IPA tokens, without
    # model BOS/EOS/PAD. Remove only control markers/terminal punctuation, never
    # synthesize an IPA spelling from letters or copy one accent into the other.
    chunks = []
    for sentence in sentences:
        text = "".join(token for token in sentence if token not in ("^", "$", "_") and not unicodedata.category(token[0]).startswith("C"))
        text = text.strip().rstrip(".,!?;:").strip()
        if text:
            chunks.append(text)
    ipa = unicodedata.normalize("NFC", " ".join(chunks)).strip()
    if not ipa:
        raise ValueError("empty_algorithmic_ipa")
    return {
        "phonetic": "/" + ipa + "/",
        "phoneticSource": "piper-tts@1.8.0 bundled eSpeak-NG; " + variant + "; algorithmic",
        "phoneticMethod": "algorithmic",
        "phoneticVoice": variant,
        "phoneticSourceUrl": "https://github.com/OHF-Voice/piper1-gpl/blob/639388b6317fc4731e91d53da42aea68fd4166ff/src/piper/phonemize_espeak.py",
        "phoneticExpertValidated": False,
    }


def check_wav(path: Path) -> dict:
    import numpy as np

    with wave.open(str(path), "rb") as handle:
        rate, channels, width, frames = handle.getframerate(), handle.getnchannels(), handle.getsampwidth(), handle.getnframes()
        if channels != 1 or width != 2 or rate != 22050 or handle.getcomptype() != "NONE":
            raise ValueError("unsupported_wav_format")
        duration = frames / rate
        if not 0.05 <= duration <= 20:
            raise ValueError("wav_duration_out_of_range")
        samples = np.frombuffer(handle.readframes(frames), dtype="<i2")
        if samples.size != frames or not samples.size or np.max(np.abs(samples.astype(np.int32))) < 10:
            raise ValueError("empty_or_silent_wav")
        rms = float(np.sqrt(np.mean(samples.astype(np.float32) ** 2)))
        if not np.isfinite(rms) or rms < 1:
            raise ValueError("empty_or_silent_wav")
    return {"sampleRate": rate, "channels": channels, "sampleWidthBytes": width, "durationSeconds": round(duration, 6)}


def validate_entry(entry: dict, output: Path, identity: str | None = None) -> bool:
    try:
        if identity is not None and entry.get("cacheKey") != identity:
            return False
        key = entry["fileKey"]
        if not re.fullmatch(r"files/[a-f0-9]{64}\.(wav|ogg|mp3)", key):
            return False
        asset = output / key
        if not asset.is_file() or asset.stat().st_size != entry["sizeBytes"]:
            return False
        if sha_file(asset) != entry["fileSha256"]:
            return False
        if entry["mimeType"] == "audio/mpeg":
            raw = asset.read_bytes()
            if not (raw[:3] == b"ID3" or (raw[0] == 255 and raw[1] & 224 == 224)):
                return False
        elif entry["kind"] == "synthesized":
            check_wav(asset)
        else:
            with asset.open("rb") as handle:
                if handle.read(4) != b"OggS":
                    return False
        return True
    except (KeyError, OSError, ValueError, wave.Error):
        return False


def install_asset(temporary: Path, output: Path, extension: str) -> tuple[str, str, int]:
    digest = sha_file(temporary)
    key = "files/" + digest + extension
    final = output / key
    final.parent.mkdir(parents=True, exist_ok=True)
    if final.exists():
        if sha_file(final) != digest:
            raise ValueError("content_address_collision")
        temporary.unlink()
    else:
        os.replace(temporary, final)
    return key, digest, final.stat().st_size


def recorded_entry(recording: dict, output: Path, model_dir: Path, allow_download: bool) -> dict:
    item = {**recording, "url": recording["downloadUrl"]}
    original = ensure_source(item, model_dir / "recorded", allow_download)
    if original.read_bytes()[:4] != b"OggS":
        raise ValueError("recording_not_ogg")
    key = "files/" + recording["sha256"] + ".ogg"
    final = output / key
    final.parent.mkdir(parents=True, exist_ok=True)
    if final.exists():
        if sha_file(final) != recording["sha256"]:
            raise ValueError("recording_cache_checksum_mismatch")
    else:
        with tempfile.NamedTemporaryFile("wb", dir=final.parent, delete=False) as handle:
            temporary = Path(handle.name)
            with original.open("rb") as source:
                shutil.copyfileobj(source, handle)
        install_asset(temporary, output, ".ogg")
    return {
        "lemma": recording["lemma"], "accent": recording["accent"], "kind": "recorded",
        "sourceName": recording["sourceName"], "sourceUrl": recording["sourceUrl"],
        "license": recording["license"], "attribution": recording["attribution"],
        "fileKey": key, "fileSha256": recording["sha256"], "mimeType": recording["mimeType"],
        "sizeBytes": recording["sizeBytes"], "commonsSha1": recording["commonsSha1"],
    }


def synthesize_entry(lemma: str, accent: str, source: dict, voice, output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", dir=output, suffix=".wav", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        with wave.open(str(temporary), "wb") as wav_file:
            voice.synthesize_wav(lemma, wav_file)
        metrics = check_wav(temporary)
        key, digest, size = install_asset(temporary, output, ".wav")
        return {
            "lemma": lemma, "accent": accent, "kind": "synthesized",
            "sourceName": source["sourceName"], "sourceUrl": source["sourceUrl"],
            "license": source["license"], "attribution": source["attribution"],
            "fileKey": key, "fileSha256": digest, "mimeType": "audio/wav", "sizeBytes": size,
            "cacheKey": synthesis_identity(lemma, accent, source),
            "engineVersion": ENGINE_VERSION, "voiceModelSha256": source["model"]["sha256"],
            "inferenceBackend": "CPUExecutionProvider",
            "voiceConfigSha256": source["config"]["sha256"], **metrics,
        }
    finally:
        temporary.unlink(missing_ok=True)


def read_cached_entries(output: Path, accent: str) -> dict:
    entries = {}
    manifest = output / "manifest.json"
    if manifest.exists():
        existing = json.loads(manifest.read_text(encoding="utf-8"))
        for entry in existing.get("entries", []):
            if entry.get("accent") == accent:
                entries[entry["lemma"]] = entry
    for journal in sorted((output / ".build-progress").glob(accent + "*.jsonl")):
        with journal.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    entry = json.loads(line)
                    entries[entry["lemma"]] = entry
                except (ValueError, KeyError):
                    continue  # A killed process may leave its last line incomplete.
    return entries


def accent_worker(accent: str, lemmas: list[str], sources: dict, output_string: str, model_string: str, threads: int, allow_download: bool, shard: int = 0) -> dict:
    started = time.monotonic()
    output, model_dir = Path(output_string), Path(model_string)
    source = sources["voices"][accent]
    recorded = {(item["lemma"], item["accent"]): item for item in sources["recordings"]}
    cached = read_cached_entries(output, accent)
    voice = make_voice(source, model_dir, threads, allow_download)
    phonemizer = make_phonemizer()
    # Fail early on a missing packaged voice, not after 8,798 repeated retries.
    algorithmic_phonetic("rain", accent, phonemizer)
    entries, failures = [], []
    reused, synthesized, recorded_count = 0, 0, 0
    label = accent + ".shard" + str(shard)
    progress = output / ".build-progress" / (label + ".jsonl")
    progress.parent.mkdir(parents=True, exist_ok=True)
    with progress.open("a", encoding="utf-8") as journal:
        for position, lemma in enumerate(lemmas, 1):
            try:
                recording = recorded.get((lemma, accent))
                if recording is not None:
                    entry = recorded_entry(recording, output, model_dir, allow_download)
                    recorded_count += 1
                else:
                    identity = synthesis_identity(lemma, accent, source)
                    candidate = cached.get(lemma)
                    if candidate and candidate.get("kind") == "synthesized" and validate_entry(candidate, output, identity):
                        entry = {**candidate, "sourceName": source["sourceName"], "sourceUrl": source["sourceUrl"], "license": source["license"], "attribution": source["attribution"]}
                        reused += 1
                    else:
                        entry = synthesize_entry(lemma, accent, source, voice, output)
                        synthesized += 1
                entry.update(algorithmic_phonetic(lemma, accent, phonemizer))
                entries.append(entry)
                journal.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
                journal.flush()
                if position % 100 == 0:
                    os.fsync(journal.fileno())
            except Exception as error:
                failures.append({"lemma": lemma, "accent": accent, "error": str(error)[:240]})
            if position % 100 == 0 or position == len(lemmas):
                log(f"{label}: {position}/{len(lemmas)} checked; ready={len(entries)} failed={len(failures)} elapsed={time.monotonic()-started:.1f}s")
        os.fsync(journal.fileno())
    return {"accent": accent, "entries": entries, "failures": failures, "reused": reused, "synthesized": synthesized, "recorded": recorded_count, "elapsedSeconds": round(time.monotonic() - started, 3)}


def copy_notices(sources: dict, manifest_path: Path, output: Path) -> None:
    destination = output / "licenses"
    destination.mkdir(parents=True, exist_ok=True)
    for name in sources["licenseNotices"]:
        source = manifest_path.parent / name
        if not source.is_file():
            raise ValueError("missing_license_notice:" + source.name)
        shutil.copyfile(source, destination / source.name)
    shutil.copyfile(manifest_path, output / "sources.manifest.json")


def request_mode(args, sources: dict) -> None:
    raw = sys.stdin.buffer.read(4097)
    if len(raw) > 4096:
        raise ValueError("request_too_large")
    request = json.loads(raw)
    if not isinstance(request, dict) or set(request) != {"word", "accent"}:
        raise ValueError("invalid_request_shape")
    lemma = normalize_lemma(request["word"])
    accent = request["accent"]
    if accent not in ("US", "UK"):
        raise ValueError("invalid_accent")
    source = sources["voices"][accent]
    identity = synthesis_identity(lemma, accent, source)
    output = args.output.resolve()
    cache = output / ".request-cache" / (identity + ".json")
    if cache.exists():
        candidate = json.loads(cache.read_text(encoding="utf-8"))
        if validate_entry(candidate, output, identity):
            print(json.dumps(candidate, ensure_ascii=False, separators=(",", ":")))
            return
    # Request mode requires verified pre-cached sources and never starts a model
    # download on a user request. It does not update manifest.json or recordings.
    voice = make_voice(source, args.model_dir.resolve(), args.cpu_threads, False)
    entry = synthesize_entry(lemma, accent, source, voice, output)
    entry.update(algorithmic_phonetic(lemma, accent, make_phonemizer()))
    atomic_json(cache, entry)
    print(json.dumps(entry, ensure_ascii=False, separators=(",", ":")))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lemmas-file", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--voices-manifest", type=Path, default=DEFAULT_VOICES_MANIFEST)
    parser.add_argument("--cpu-threads", type=int, choices=(1, 2, 3, 4), default=2)
    parser.add_argument("--workers", type=int, choices=(2, 4), default=2)
    parser.add_argument("--request-json", action="store_true")
    parser.add_argument("--no-download", action="store_true")
    args = parser.parse_args()
    if not args.request_json and args.cpu_threads * args.workers > 8:
        parser.error("batch CPU thread budget must not exceed 8")
    sources = load_sources(args.voices_manifest)
    if args.request_json:
        request_mode(args, sources)
        return 0
    if args.lemmas_file is None:
        parser.error("--lemmas-file is required in batch mode")
    lemmas_raw = json.loads(args.lemmas_file.read_text(encoding="utf-8"))
    if not isinstance(lemmas_raw, list) or not lemmas_raw:
        raise ValueError("lemmas_file_must_be_nonempty_json_array")
    lemmas = sorted({normalize_lemma(lemma) for lemma in lemmas_raw})
    output, model_dir = args.output.resolve(), args.model_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    copy_notices(sources, args.voices_manifest.resolve(), output)
    log(f"audio-v1: {len(lemmas)} lemmas, {len(lemmas)*2} requested assets; {args.workers} CPU workers, {args.cpu_threads} threads each")
    context = multiprocessing.get_context("spawn")
    shards = args.workers // 2
    with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers, mp_context=context) as pool:
        futures = [pool.submit(accent_worker, accent, lemmas[shard::shards], sources, str(output), str(model_dir), args.cpu_threads, not args.no_download, shard) for accent in ("US", "UK") for shard in range(shards)]
        results = [future.result() for future in futures]
    failures = [failure for result in results for failure in result["failures"]]
    entries = sorted([entry for result in results for entry in result["entries"]], key=lambda item: (item["lemma"], item["accent"]))
    if failures or len(entries) != len(lemmas) * 2:
        atomic_json(output / "failures.json", {"version": "audio-v1", "readyEntries": len(entries), "failures": failures})
        log(f"INCOMPLETE: ready={len(entries)}, failed={len(failures)}; no completed pack manifest published")
        return 1
    # Only publish completion after every file has been checked, never merely
    # because an inference process returned successfully.
    for entry in entries:
        if not validate_entry(entry, output, entry.get("cacheKey")):
            raise ValueError("final_asset_validation_failed:" + entry["fileKey"])
    stats = {"lemmaCount": len(lemmas), "entryCount": len(entries), "recordedCount": sum(entry["kind"] == "recorded" for entry in entries), "synthesizedCount": sum(entry["kind"] == "synthesized" for entry in entries), "failedCount": 0, "uniqueFileCount": len({entry["fileKey"] for entry in entries}), "fileBytes": sum({entry["fileKey"]: entry["sizeBytes"] for entry in entries}.values()), "elapsedSeconds": round(time.monotonic() - started, 3), "cpuThreadsPerWorker": args.cpu_threads, "workers": args.workers}
    manifest = {"schemaVersion": 1, "version": "audio-v1", "status": "ready", "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "engineVersion": ENGINE_VERSION, "sourceManifestSha256": sha_file(args.voices_manifest), "lemmaListSha256": hashlib.sha256(json.dumps(lemmas, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest(), "voiceRevision": sources["voiceRevision"], "statistics": stats, "entries": entries, "limitations": ["Piper entries are synthesized, not human word recordings or expert-certified standard pronunciation.", "Homographs, stress, names, acronyms and inflections may be pronounced incorrectly.", "Recorded files retain their individual source license and attribution."]}
    atomic_json(output / "manifest.json", manifest)
    shutil.rmtree(output / ".build-progress", ignore_errors=True)
    (output / "failures.json").unlink(missing_ok=True)
    print(json.dumps({"version": "audio-v1", "manifest": str(output / "manifest.json"), "statistics": stats}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        log("audio-pack error: " + str(error)[:300])
        raise SystemExit(1)
