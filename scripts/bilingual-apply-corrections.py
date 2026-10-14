#!/usr/bin/env python3
"""Apply attributed translation corrections against an immutable lexical snapshot.

No inference, database or network. Unchanged JSONL lines retain their exact bytes.
New usage examples need --candidates and copied original English provenance.
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
from pathlib import Path
import re
import sys

SPEC = importlib.util.spec_from_file_location("nightstudy_bilingual_compile", Path(__file__).with_name("bilingual-compile.py"))
COMPILER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COMPILER)
ROOT = Path(__file__).resolve().parents[1]
AUTHOR = "NightStudy contributors"
METHOD = "Codex-assisted bilingual correction"
FIELDS = COMPILER.FIELDS
ALLOWED_KEYS = {"normalizedLemma", "senseId", "field", "sourceTextSha256", "sourceText", "value", "author",
                "authoringMethod", "reason", "exampleEn", "exampleSource"}


def history_of(value, metadata):
    if value is None:
        return None
    COMPILER.text_field(value, "existing_raw_translation_must_be_nonempty")
    COMPILER.require(isinstance(metadata, dict), "existing_raw_translation_metadata_required")
    history = {"outputSha256": COMPILER.digest(value), "kind": metadata.get("kind", "unattributed-input")}
    for key in ("model", "modelRevision", "promptVersion", "author", "authoringMethod", "correctionOf"):
        if key in metadata:
            history[key] = copy.deepcopy(metadata[key])
    return history


def correction_metadata(entry, source, language, license_name, history=None):
    COMPILER.require(entry["sourceTextSha256"] == COMPILER.digest(source), "correction_source_hash_mismatch")
    if "sourceText" in entry:
        COMPILER.require(entry["sourceText"] == source, "correction_source_text_mismatch")
    metadata = {"kind": "original-authoring", "review": "pending", "sourceLanguage": language,
                "sourceTextSha256": COMPILER.digest(source), "author": entry["author"], "license": license_name,
                "authoringMethod": entry["authoringMethod"], "reason": entry["reason"]}
    if history:
        metadata["correctionOf"] = history
    return metadata


def validate_entries(entries):
    COMPILER.require(isinstance(entries, list), "corrections_array_required")
    targets = set()
    for entry in entries:
        COMPILER.require(isinstance(entry, dict) and set(entry) <= ALLOWED_KEYS, "unknown_correction_field")
        lemma = entry.get("normalizedLemma")
        COMPILER.require(isinstance(lemma, str) and lemma and COMPILER.normalize_lemma(lemma) == lemma,
                         "correction_normalized_lemma_required")
        COMPILER.require(entry.get("field") in FIELDS, "unsupported_correction_target_field")
        COMPILER.require(isinstance(entry.get("sourceTextSha256"), str)
                         and re.fullmatch(r"[a-f0-9]{64}", entry["sourceTextSha256"]), "correction_source_hash_required")
        COMPILER.text_field(entry.get("value"), "correction_nonempty_value_required")
        COMPILER.text_field(entry.get("reason"), "correction_reason_required", 1000)
        COMPILER.require(entry.get("author") == AUTHOR and entry.get("authoringMethod") == METHOD,
                         "correction_explicit_contributor_and_method_required")
        if "sourceText" in entry:
            COMPILER.require(isinstance(entry["sourceText"], str), "correction_source_text_must_be_string")
        if "senseId" in entry:
            COMPILER.text_field(entry["senseId"], "correction_sense_id_required", 200)
            COMPILER.require("exampleEn" not in entry and "exampleSource" not in entry, "sense_correction_cannot_select_word_example")
            key = (lemma, entry["senseId"], entry["field"])
        else:
            COMPILER.require(entry["field"] == "exampleZh", "word_example_correction_only_chinese")
            COMPILER.text_field(entry.get("exampleEn"), "word_example_original_english_required")
            COMPILER.require(COMPILER.exact_lemma(entry["exampleEn"], lemma), "correction_example_missing_exact_lemma")
            key = (lemma, entry["exampleEn"], entry["field"])
        COMPILER.require(key not in targets, "duplicate_correction_target")
        targets.add(key)


def validate_input(rows, lexical):
    indexed = COMPILER.index_words(rows, "input")
    COMPILER.require(set(indexed) <= set(lexical), "input_word_missing_from_lexical")
    for lemma, row in indexed.items():
        COMPILER.require(isinstance(row.get("senses"), list) and isinstance(row.get("examples"), list), "input_senses_and_examples_required")
        sense_ids = set()
        for patch in row["senses"]:
            COMPILER.require(isinstance(patch, dict) and isinstance(patch.get("id"), str) and patch["id"] not in sense_ids,
                             "duplicate_or_invalid_input_sense_patch")
            sense_ids.add(patch["id"])
            COMPILER.require(isinstance(patch.get("contentMetadata"), dict), "input_sense_metadata_required")
        for example in row["examples"]:
            COMPILER.require(isinstance(example, dict) and isinstance(example.get("exampleEn"), str)
                             and isinstance(example.get("contentMetadata"), dict), "input_example_structure_required")
    return indexed


def apply_corrections(rows, lexical_rows, entries, source_manifest, candidate_rows=None):
    validate_entries(entries)
    lexical = COMPILER.index_words(lexical_rows, "lexical")
    result = copy.deepcopy(rows)
    indexed = validate_input(result, lexical)
    candidates = COMPILER.index_words(candidate_rows, "candidate") if candidate_rows is not None else None
    changed = set()
    counts = {"senseFieldsCorrected": 0, "wordExampleTranslationsCorrected": 0, "wordExamplesRestored": 0}
    model = None  # Corrections are authored text; no downloaded model is required.
    for entry in entries:
        lemma, field = entry["normalizedLemma"], entry["field"]
        COMPILER.require(lemma in indexed and lemma in lexical, "correction_word_not_in_input_and_lexical")
        row = indexed[lemma]
        if "senseId" in entry:
            sid = entry["senseId"]
            originals = [s for s in lexical[lemma].get("senses", []) if s.get("id") == sid]
            COMPILER.require(len(originals) == 1, "correction_sense_not_in_same_lexical_word")
            original = originals[0]
            COMPILER.require(original.get(field, "") == "", "correction_original_target_not_exactly_empty")
            source_field = field[:-2] + ("En" if field.endswith("Zh") else "Zh")
            source = original.get(source_field)
            COMPILER.text_field(source, "correction_original_opposite_language_missing")
            patches = [p for p in row["senses"] if p["id"] == sid]
            COMPILER.require(len(patches) <= 1, "ambiguous_raw_sense_patch")
            patch = patches[0] if patches else {"id": sid, "contentMetadata": {}}
            previous = patch.get(field)
            if previous == "":
                previous = None
            metadata = correction_metadata(entry, source, "en" if field.endswith("Zh") else "zh", "MIT",
                                           history_of(previous, patch["contentMetadata"].get(field)))
            COMPILER.authoring_metadata(metadata, source, metadata["sourceLanguage"], "MIT", lemma + "/" + field)
            if not patches:
                row["senses"].append(patch)
            patch[field] = entry["value"]
            patch["contentMetadata"][field] = metadata
            counts["senseFieldsCorrected"] += 1
        else:
            english = entry["exampleEn"]
            matches = [e for e in row["examples"] if e["exampleEn"] == english]
            COMPILER.require(len(matches) <= 1, "ambiguous_raw_word_example")
            if matches:
                example = matches[0]
                source_meta = example["contentMetadata"].get("exampleEn")
                if "exampleSource" in entry:
                    COMPILER.require(entry["exampleSource"] == source_meta, "correction_example_source_metadata_mismatch")
            else:
                COMPILER.require(candidates is not None and isinstance(entry.get("exampleSource"), dict),
                                 "new_word_example_requires_candidates_and_original_metadata")
                originals = [e for e in (candidates.get(lemma) or {}).get("examples", []) if e.get("exampleEn") == english]
                COMPILER.require(len(originals) == 1, "correction_candidate_example_not_unique")
                source_meta = originals[0].get("contentMetadata", {}).get("exampleEn")
                COMPILER.require(entry["exampleSource"] == source_meta, "correction_candidate_metadata_mismatch")
                example = {"exampleEn": english, "exampleZh": "", "contentMetadata": {"exampleEn": copy.deepcopy(source_meta)}}
            COMPILER.require(isinstance(source_meta, dict), "correction_example_original_metadata_required")
            previous = example.get("exampleZh") or None
            metadata = correction_metadata(entry, english, "en", source_meta.get("license"),
                                           history_of(previous, example["contentMetadata"].get("exampleZh")))
            for key in ("author", "license", "licenseUrl", "sourceSentenceId", "sourceUrl", "sourceName", "snapshot"):
                if key in source_meta:
                    metadata[key] = copy.deepcopy(source_meta[key])
            metadata["translationAuthor"] = entry["author"]
            metadata["adaptation"] = "AI-assisted original Chinese translation correction; original English sentence retained."
            example["exampleZh"] = entry["value"]
            example["contentMetadata"]["exampleZh"] = metadata
            COMPILER.validate_example(example, lemma, model, source_manifest["datasets"])
            if not matches:
                row["examples"].append(example)
                counts["wordExamplesRestored"] += 1
            counts["wordExampleTranslationsCorrected"] += 1
        changed.add(lemma)
    return result, changed, counts


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("input", "lexical", "corrections", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--candidates", type=Path, help="Required only to restore a dropped usage example; source JSONL, never inferred provenance")
    parser.add_argument("--source-manifest", type=Path, default=ROOT / "data/bilingual-source.manifest.json")
    args = parser.parse_args(argv)
    sources = [args.input, args.lexical, args.corrections, args.source_manifest] + ([args.candidates] if args.candidates else [])
    COMPILER.require(args.output.resolve() not in {p.resolve() for p in sources}, "correction_output_must_not_replace_input_sources")
    raw = args.input.read_bytes().decode("utf-8")
    lines = raw.splitlines(keepends=True)
    rows = [COMPILER.parse_json(line) for line in lines if line.strip()]
    corrected, changed, counts = apply_corrections(rows, COMPILER.read_jsonl(args.lexical),
        COMPILER.parse_json(args.corrections.read_text(encoding="utf-8")),
        COMPILER.parse_json(args.source_manifest.read_text(encoding="utf-8")),
        COMPILER.read_jsonl(args.candidates) if args.candidates else None)
    by_lemma = COMPILER.index_words(corrected, "corrected")
    output = []
    for line in lines:
        if not line.strip():
            output.append(line)
            continue
        row = COMPILER.parse_json(line)
        if row["normalizedLemma"] not in changed:
            output.append(line)
        else:
            ending = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
            output.append(COMPILER.canonical(by_lemma[row["normalizedLemma"]]) + ending)
    COMPILER.atomic_write(args.output, "".join(output).encode("utf-8"))
    print(COMPILER.canonical({"action": "bilingual.apply-corrections", "changedWords": len(changed), **counts,
                             "qualityReview": "pending"}))
    return corrected


if __name__ == "__main__":
    try:
        main()
    except (COMPILER.CompileError, OSError, UnicodeError, json.JSONDecodeError) as error:
        print(COMPILER.canonical({"action": "bilingual.apply-corrections.failed", "reason": str(error)}), file=sys.stderr)
        raise SystemExit(1)
