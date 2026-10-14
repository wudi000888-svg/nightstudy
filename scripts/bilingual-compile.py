#!/usr/bin/env python3
"""Validate lexical translation identity, then compile a deterministic content pack.

Pure standard library. No database, model inference, network or source-text repair.
This verifies structure/provenance/coverage, not the correctness of a translation.
"""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
FIELDS = ("definitionZh", "definitionEn", "exampleZh", "exampleEn")
MAX_JSONL_BYTES = 64 * 1024 * 1024


class CompileError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise CompileError(code)


def digest(value):
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate_json_key:" + key)
        result[key] = value
    return result


def parse_json(text):
    def invalid_constant(value):
        raise CompileError("invalid_json_constant:" + value)
    return json.loads(text, object_pairs_hook=unique_object, parse_constant=invalid_constant)


def read_jsonl(path):
    result = []
    with Path(path).open(encoding="utf-8", errors="strict") as stream:
        for line in stream:
            if line.strip():
                row = parse_json(line)
                require(isinstance(row, dict), "jsonl_row_object_required")
                result.append(row)
    return result


def normalize_lemma(value):
    return " ".join(unicodedata.normalize("NFKC", value).strip().lower().replace("’", "'").replace("‘", "'").split())


def exact_lemma(text, lemma):
    # Match the JS installer boundary (Unicode Letter/Mark, not Python \w).
    for match in re.finditer(re.escape(lemma), text, re.IGNORECASE):
        # Reject Python's extra Turkish-I match; do not shift Unicode offsets
        # by lowercasing an entire string (some characters expand).
        if match.group(0).casefold() != lemma.casefold():
            continue
        position, end = match.span()
        before = text[position - 1] if position else ""
        after = text[end] if end < len(text) else ""
        if not any(c and unicodedata.category(c)[0] in ("L", "M") for c in (before, after)):
            return True
    return False


def text_field(value, code, maximum=4000):
    require(isinstance(value, str) and bool(value.strip()) and len(value) <= maximum, code)


def index_words(rows, kind):
    result = {}
    for row in rows:
        lemma = row.get("normalizedLemma")
        require(isinstance(lemma, str) and 0 < len(lemma) <= 500 and normalize_lemma(lemma) == lemma,
                kind + "_unnormalized_lemma")
        require(lemma not in result, kind + "_duplicate_lemma:" + lemma)
        result[lemma] = row
    return result


def selected_model(source_manifest):
    models = source_manifest.get("translationModels", {})
    key = source_manifest.get("selectedTranslationModel")
    require(key in models and not models[key].get("candidateRejected"), "selected_model_required")
    return models[key]


def translation_metadata(metadata, source, language, model, context):
    require(isinstance(metadata, dict), "translation_metadata_required:" + context)
    require(metadata.get("kind") == "machine-translation", "translation_kind_required:" + context)
    require(isinstance(model, dict), "selected_model_required")
    require(metadata.get("sourceLanguage") == language, "translation_source_language_mismatch:" + context)
    # Intentionally hash the exact lexical bytes, never source.strip().
    require(metadata.get("sourceTextSha256") == digest(source), "translation_source_hash_mismatch:" + context)
    require(metadata.get("model") == model["repository"] and metadata.get("modelRevision") == model["revision"]
            and metadata.get("modelWeightSha256") == model["weights"]["sha256"],
            "unapproved_translation_model:" + context)
    require(metadata.get("modelLicense") == model["license"], "translation_model_license_mismatch:" + context)
    if model["weights"].get("digestKind"):
        require(metadata.get("modelWeightDigestKind") == model["weights"]["digestKind"],
                "translation_weight_digest_kind_mismatch:" + context)
    require(metadata.get("review") == "pending", "translation_pending_review_required:" + context)
    require(metadata.get("promptVersion") in model.get("approvedPromptVersions", []),
            "unapproved_translation_prompt:" + context)


def authoring_metadata(metadata, source, language, license_name, context):
    require(isinstance(metadata, dict) and metadata.get("kind") == "original-authoring",
            "original_authoring_metadata_required:" + context)
    require(metadata.get("sourceLanguage") == language and metadata.get("sourceTextSha256") == digest(source),
            "original_authoring_source_identity_mismatch:" + context)
    require(metadata.get("review") == "pending" and metadata.get("license") == license_name,
            "original_authoring_license_or_review_mismatch:" + context)
    text_field(metadata.get("author"), "original_authoring_author_required:" + context, 500)
    text_field(metadata.get("authoringMethod"), "original_authoring_method_required:" + context, 1000)
    require(not set(metadata) & {"model", "modelRevision", "modelWeightSha256", "modelLicense", "modelAuthor", "modelUrl",
                                 "runtime", "runtimeVersion", "promptVersion"},
            "original_authoring_must_not_claim_model_output:" + context)
    if "correctionOf" in metadata:
        history = metadata["correctionOf"]
        require(isinstance(history, dict) and isinstance(history.get("outputSha256"), str)
                and re.fullmatch(r"[0-9a-f]{64}", history["outputSha256"]),
                "correction_history_output_hash_required:" + context)


def has_machine_fields(rows):
    # Historical correctionOf metadata is provenance, not current machine output.
    for row in rows:
        if not isinstance(row, dict): continue
        entries = []
        for field in ("senses", "examples"):
            if isinstance(row.get(field), list): entries.extend(row[field])
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("contentMetadata"), dict): continue
            for item in entry["contentMetadata"].values():
                if isinstance(item, dict) and item.get("kind") == "machine-translation":
                    return True
    return False


def corpus_metadata(item, content, language, datasets, context):
    require(isinstance(datasets, dict), "corpus_dataset_map_required:" + context)
    source_id = str(item.get("sourceSentenceId", ""))
    require(source_id.isdecimal() and int(source_id) > 0 and item.get("license") == "CC-BY-2.0-FR"
            and item.get("sourceUrl") == "https://tatoeba.org/en/sentences/show/" + source_id,
            "tatoeba_attribution_required:" + context)
    key = item.get("sourceDataset", "tatoebaEnglish" if language == "en" else "tatoebaChinese")
    dataset = datasets.get(key)
    require(isinstance(dataset, dict), "corpus_pinned_dataset_required:" + context)
    require(item.get("sourceSha256") == dataset.get("sha256") and isinstance(dataset.get("sha256"), str)
            and re.fullmatch(r"[0-9a-f]{64}", dataset["sha256"])
            and item.get("snapshot") == dataset.get("snapshot") and bool(dataset.get("snapshot")),
            "corpus_source_snapshot_mismatch:" + context)
    if key == "manyThingsEnglishChinese":
        require(item.get("sourceName") == "Tatoeba / ManyThings selection"
                and item.get("sourceExportUrl") == dataset.get("sourceUrl") and bool(dataset.get("sourceUrl")),
                "manythings_source_export_mismatch:" + context)
        text_field(item.get("sourceOwner"), "corpus_source_owner_required:" + context, 500)
        require(item.get("sourceOwnerRole") == "export-attributed-owner",
                "corpus_source_owner_role_required:" + context)
        text_field(item.get("attribution"), "corpus_raw_attribution_required:" + context, 4000)
        credits = re.findall(r"#\s*(\d+)\s*\(([^)]*)\)", item["attribution"])
        require(any(sid == source_id and owner == item["sourceOwner"] for sid, owner in credits),
                "corpus_source_owner_credit_mismatch:" + context)
        if "author" in item:
            require(item["author"] == item["sourceOwner"] and item.get("authorRole") == "attributed-owner",
                    "corpus_author_must_match_attributed_owner:" + context)
        require(item.get("sourceLanguage") in (("en", "eng") if language == "en" else ("zh", "cmn")),
                "example_source_language_mismatch:" + context)
        require(item.get("sourceTextSha256") == digest(content), "corpus_text_hash_mismatch:" + context)
        require(isinstance(item.get("relationship"), dict) and item["relationship"].get("kind") == "source-export-pair",
                "corpus_export_pair_relationship_required:" + context)
    else:
        require(key in ("tatoebaEnglish", "tatoebaChinese") and item.get("sourceName") == "Tatoeba",
                "unsupported_corpus_dataset:" + context)
        require(item.get("sourceLanguage") in (("en", "eng") if language == "en" else ("zh", "cmn")),
                "example_source_language_mismatch:" + context)
        text_field(item.get("author"), "example_author_required:" + context, 500)
        if "sourceTextSha256" in item:
            require(item["sourceTextSha256"] == digest(content), "corpus_text_hash_mismatch:" + context)
    return key


def validate_example(example, lemma, model, datasets, definition_policy="strict-sense-pairs"):
    require(isinstance(example, dict) and set(example) == {"exampleEn", "exampleZh", "contentMetadata"},
            "invalid_example_structure:" + lemma)
    for field in ("exampleEn", "exampleZh"):
        text_field(example.get(field), "example_pair_required:" + lemma)
    require(exact_lemma(example["exampleEn"], lemma), "example_missing_exact_lemma:" + lemma)
    metadata = example["contentMetadata"]
    require(isinstance(metadata, dict), "example_metadata_required:" + lemma)
    for field in ("exampleEn", "exampleZh"):
        item = metadata.get(field)
        require(isinstance(item, dict) and item.get("kind") in ("corpus", "generated", "original", "machine-translation", "original-authoring"),
                "example_field_provenance_required:" + lemma)
        text_field(item.get("license"), "example_license_required:" + lemma, 200)
        if item["kind"] != "corpus":
            text_field(item.get("author"), "example_author_required:" + lemma, 500)
        require(item.get("review") in ("pending", "reviewed"), "example_review_status_required:" + lemma)
        if item["kind"] in ("original", "generated"):
            require(item["license"] == "MIT", "original_example_license_mismatch:" + lemma)
    english, chinese = metadata["exampleEn"], metadata["exampleZh"]
    require(english["kind"] not in ("machine-translation", "original-authoring"),
            "word_example_requires_attributed_original_english:" + lemma)
    english_dataset = None
    if english["kind"] == "corpus":
        english_dataset = corpus_metadata(english, example["exampleEn"], "en", datasets, lemma + "/exampleEn")
    elif definition_policy == "word-source-languages":
        require(len(re.findall(r"[A-Za-z]+(?:['-][A-Za-z]+)*", example["exampleEn"])) >= 5,
                "original_example_requires_context:" + lemma)
        require(not re.fullmatch(r"(?:this|that|it) is (?:an? )?" + re.escape(lemma) + r"[.!]?", example["exampleEn"].strip(), re.I),
                "generic_original_example_rejected:" + lemma)
    if chinese["kind"] in ("machine-translation", "original-authoring"):
        if chinese["kind"] == "machine-translation":
            translation_metadata(chinese, example["exampleEn"], "en", model, lemma + "/exampleZh")
        else:
            authoring_metadata(chinese, example["exampleEn"], "en", english["license"], lemma + "/exampleZh")
            text_field(chinese.get("translationAuthor"), "original_example_translation_author_required:" + lemma, 500)
        for field in ("license", "author", "sourceSentenceId", "sourceUrl", "sourceName", "snapshot"):
            if field in english:
                require(chinese.get(field) == english[field], "example_adaptation_attribution_mismatch:" + lemma)
        text_field(chinese.get("adaptation"), "example_adaptation_notice_required:" + lemma)
    elif english["kind"] == "corpus":
        require(chinese.get("kind") == "corpus" and str(chinese.get("translationOfSentenceId")) == str(english.get("sourceSentenceId")),
                "unverified_corpus_translation_pair:" + lemma)
        chinese_dataset = corpus_metadata(chinese, example["exampleZh"], "zh", datasets, lemma + "/exampleZh")
        require(str(chinese["sourceSentenceId"]) != str(english["sourceSentenceId"]), "corpus_pair_sentence_ids_must_differ:" + lemma)
        if english_dataset == "manyThingsEnglishChinese":
            require(chinese_dataset == english_dataset and str(english.get("translationSentenceId")) == str(chinese["sourceSentenceId"])
                    and chinese["attribution"] == english["attribution"], "manythings_pair_identity_mismatch:" + lemma)
    elif definition_policy == "word-source-languages":
        require(chinese.get("kind") in ("original", "generated") and chinese.get("sourceLanguage") == "en"
                and chinese.get("sourceTextSha256") == digest(example["exampleEn"]),
                "original_chinese_example_source_identity_required:" + lemma)
    return english["kind"]


def compile_rows(input_rows, lexical_rows, warning_rows, source_manifest, expected_word_count=8798, allow_missing=False, definition_policy="strict-sense-pairs"):
    lexical = index_words(lexical_rows, "lexical")
    translated = index_words(input_rows, "input")
    require(len(lexical) == expected_word_count and expected_word_count > 0, "lexical_word_count_mismatch")
    require(set(translated) == set(lexical), "input_lexical_word_set_mismatch")
    require(definition_policy in ("strict-sense-pairs", "word-source-languages"), "unsupported_definition_policy")
    model = selected_model(source_manifest) if has_machine_fields(input_rows) else None
    warning_map = index_words(warning_rows, "warning")
    require(set(warning_map) <= set(lexical), "warning_word_not_in_lexical")
    require(len(warning_map) <= 12, "source_warning_word_cap_exceeded")
    output, queue = [], []
    missing_definition, missing_primary, missing_examples, warned_missing, missing_senses = [], [], [], [], []
    stats = {"wordCount": len(lexical), "bilingualDefinitionWordCount": 0, "primaryChineseFocusWordCount": 0,
             "primaryBilingualFocusWordCount": 0, "wordUsageExampleWordCount": 0,
             "bilingualSenseExampleWordCount": 0, "bilingualExampleWordCount": 0,
             "translatedFields": 0, "machineTranslatedFields": 0, "originalAuthoredFields": 0,
             "machineTranslatedExampleFields": 0, "originalAuthoredExampleFields": 0,
             "generatedExamples": 0, "corpusExamples": 0, "originalExamples": 0,
             "warningWordCount": 0, "warningCount": 0, "knownWarningExampleGapWordCount": 0,
             "definitionSenseCount": 0, "bilingualDefinitionSenseCount": 0, "nativeEnglishDefinitionWordCount": 0,
             "nativeChineseDefinitionWordCount": 0, "nativeWordSourceLanguagesWordCount": 0, "wordSourceEnglishDefinitionWordCount": 0,
             "wordSourceChineseDefinitionWordCount": 0, "wordSourceLanguagesWordCount": 0}
    missing_word_en, missing_word_zh = [], []
    all_sense_ids = set()
    for lemma in sorted(lexical):
        original, row = lexical[lemma], translated[lemma]
        require(set(row) == {"normalizedLemma", "senses", "examples"}, "invalid_input_row_structure:" + lemma)
        require(isinstance(original.get("senses"), list) and original["senses"], "lexical_senses_required:" + lemma)
        originals, merged = {}, {}
        for sense in original["senses"]:
            sid = sense.get("id")
            require(isinstance(sid, str) and 0 < len(sid) <= 200 and sid not in all_sense_ids,
                    "duplicate_or_invalid_lexical_sense_id:" + lemma)
            all_sense_ids.add(sid)
            for field in FIELDS:
                require(isinstance(sense.get(field, ""), str), "lexical_text_required:" + lemma)
            originals[sid] = sense
            merged[sid] = {field: sense.get(field, "") for field in FIELDS}
        primary = next((s for s in original["senses"] if s.get("definitionZh", "").strip()), None)
        patches = row["senses"]
        require(isinstance(patches, list) and len(patches) <= 200, "bounded_sense_patches_required:" + lemma)
        seen = set()
        for patch in patches:
            require(isinstance(patch, dict) and set(patch) <= {"id", "contentMetadata", *FIELDS},
                    "invalid_sense_patch_structure:" + lemma)
            sid = patch.get("id")
            require(sid in originals and sid not in seen, "unknown_or_duplicate_sense_patch:" + lemma)
            seen.add(sid)
            fields = set(patch) & set(FIELDS)
            metadata = patch.get("contentMetadata")
            require(fields and isinstance(metadata, dict) and set(metadata) == fields,
                    "sense_field_metadata_mismatch:" + lemma)
            for field in fields:
                text_field(patch[field], "empty_translation_patch:" + lemma)
                require(originals[sid].get(field, "") == "", "nonempty_target_field:" + lemma + "/" + field)
                source_field = field[:-2] + ("En" if field.endswith("Zh") else "Zh")
                source = originals[sid].get(source_field, "")
                text_field(source, "missing_original_source_text:" + lemma)
                language, context = ("en" if field.endswith("Zh") else "zh"), lemma + "/" + field
                require(isinstance(metadata[field], dict), "translation_metadata_required:" + context)
                if metadata[field].get("kind") == "original-authoring":
                    authoring_metadata(metadata[field], source, language, "MIT", context)
                    stats["originalAuthoredFields"] += 1
                else:
                    translation_metadata(metadata[field], source, language, model, context)
                    stats["machineTranslatedFields"] += 1
                merged[sid][field] = patch[field]
                stats["translatedFields"] += 1
        examples = row["examples"]
        require(isinstance(examples, list) and len(examples) <= 10, "bounded_word_examples_required:" + lemma)
        example_pairs = set()
        for example in examples:
            kind = validate_example(example, lemma, model, source_manifest.get("datasets", {}), definition_policy)
            pair = (example["exampleEn"], example["exampleZh"])
            require(pair not in example_pairs, "duplicate_word_example:" + lemma)
            example_pairs.add(pair)
            stats[{"generated": "generatedExamples", "corpus": "corpusExamples", "original": "originalExamples"}[kind]] += 1
            target_kind = example["contentMetadata"]["exampleZh"]["kind"]
            stats["machineTranslatedExampleFields"] += int(target_kind == "machine-translation")
            stats["originalAuthoredExampleFields"] += int(target_kind == "original-authoring")
        result = copy.deepcopy(row)
        warnings = []
        if lemma in warning_map:
            declared = warning_map[lemma].get("warnings")
            require(isinstance(declared, list) and 0 < len(declared) <= 20 and primary,
                    "warning_requires_primary_chinese_sense:" + lemma)
            seen_warning = set()
            for warning in declared:
                require(isinstance(warning, dict) and set(warning) == {"code", "message"}, "invalid_source_warning:" + lemma)
                text_field(warning["code"], "invalid_warning_code:" + lemma, 80)
                text_field(warning["message"], "invalid_warning_message:" + lemma, 1000)
                require(warning["code"] not in seen_warning, "duplicate_warning_code:" + lemma)
                seen_warning.add(warning["code"])
                warnings.append({**warning, "senseId": primary["id"], "sourceTextSha256": digest(primary["definitionZh"])})
            result["warnings"] = warnings
            stats["warningWordCount"] += 1
            stats["warningCount"] += len(warnings)
        native_en = any(s.get("definitionEn", "").strip() for s in originals.values())
        native_zh = any(s.get("definitionZh", "").strip() for s in originals.values())
        word_en = any(s["definitionEn"].strip() for s in merged.values())
        word_zh = any(s["definitionZh"].strip() for s in merged.values())
        stats["nativeEnglishDefinitionWordCount"] += int(native_en)
        stats["nativeChineseDefinitionWordCount"] += int(native_zh)
        stats["nativeWordSourceLanguagesWordCount"] += int(native_en and native_zh)
        stats["wordSourceEnglishDefinitionWordCount"] += int(word_en)
        stats["wordSourceChineseDefinitionWordCount"] += int(word_zh)
        stats["wordSourceLanguagesWordCount"] += int(word_en and word_zh)
        if not word_en: missing_word_en.append(lemma)
        if not word_zh: missing_word_zh.append(lemma)
        bilingual = any(s["definitionZh"].strip() and s["definitionEn"].strip() for s in merged.values())
        word_missing_senses = []
        for sid, sense in merged.items():
            if sense['definitionZh'].strip() or sense['definitionEn'].strip():
                stats['definitionSenseCount'] += 1
                if sense['definitionZh'].strip() and sense['definitionEn'].strip():
                    stats['bilingualDefinitionSenseCount'] += 1
                else:
                    word_missing_senses.append({'normalizedLemma': lemma, 'senseId': sid,
                                                'missingLanguage': 'en' if sense['definitionZh'].strip() else 'zh'})
        missing_senses.extend(word_missing_senses)
        primary_bilingual = bool(primary and merged[primary["id"]]["definitionEn"].strip())
        sense_examples = any(s["exampleEn"].strip() and s["exampleZh"].strip() and exact_lemma(s["exampleEn"], lemma)
                             for s in merged.values())
        stats["bilingualDefinitionWordCount"] += int(bilingual)
        stats["primaryChineseFocusWordCount"] += int(primary is not None)
        stats["primaryBilingualFocusWordCount"] += int(primary_bilingual)
        stats["wordUsageExampleWordCount"] += int(bool(examples))
        stats["bilingualSenseExampleWordCount"] += int(sense_examples)
        stats["bilingualExampleWordCount"] += int(bool(examples) or sense_examples)
        reasons = []
        if definition_policy == "word-source-languages" and word_en and word_zh and not bilingual:
            reasons.append("independent-word-source-languages-not-sense-paired")
        if word_missing_senses:
            reasons.append('missing-sense-bilingual-definition')
        if not bilingual:
            missing_definition.append(lemma)
            reasons.append("missing-bilingual-definition")
        if not primary_bilingual:
            missing_primary.append(lemma)
            reasons.append("missing-primary-focus-english")
        if not examples and not sense_examples:
            if any(w["code"] == "source-spelling-unverified" for w in warnings):
                warned_missing.append(lemma)
                reasons.append("example-held-for-source-quality")
            else:
                missing_examples.append(lemma)
                reasons.append("missing-bilingual-example")
        if any(meta.get("kind") == "machine-translation" for patch in patches for meta in patch["contentMetadata"].values()) \
                or any(e["contentMetadata"]["exampleZh"].get("kind") == "machine-translation" for e in examples):
            reasons.append("machine-translation-pending-review")
        if any(meta.get("kind") == "original-authoring" for patch in patches for meta in patch["contentMetadata"].values()) \
                or any(e["contentMetadata"]["exampleZh"].get("kind") == "original-authoring" for e in examples):
            reasons.append("original-authoring-pending-review")
        if examples:
            reasons.append("word-level-usage-pending-review")
        if warnings:
            reasons.append("source-quality-warning")
        if reasons:
            queue.append({"normalizedLemma": lemma, "reasons": reasons, "warnings": warnings})
        output.append(result)
    stats["knownWarningExampleGapWordCount"] = len(warned_missing)
    stats["missingBilingualDefinitionWordCount"] = len(missing_definition)
    stats["missingPrimaryFocusEnglishWordCount"] = len(missing_primary)
    stats["missingExampleWordCount"] = len(missing_examples)
    stats['missingBilingualDefinitionSenseCount'] = len(missing_senses)
    stats["pairedDefinitionSenseCount"] = stats["bilingualDefinitionSenseCount"]
    stats["pairedDefinitionWordCount"] = stats["bilingualDefinitionWordCount"]
    report = {"definitionPolicy": definition_policy, "languagePairing": "independent-per-word" if definition_policy == "word-source-languages" else "same-sense-pairs", "formatVersion": 1, "qualityReview": "pending", "validation": "structural-and-source-identity; not semantic certification",
              "allowMissingExamples": allow_missing, "statistics": stats,
              "missing": {"bilingualDefinitions": missing_definition, "primaryFocusEnglish": missing_primary,
                          "examples": missing_examples, "sourceQualityHeldExamples": warned_missing,
                          "wordSourceEnglish": missing_word_en, "wordSourceChinese": missing_word_zh,
                          'senseDefinitions': missing_senses}, "entries": queue}
    if definition_policy == "word-source-languages":
        complete = not missing_word_en and not missing_word_zh and (allow_missing or (not missing_examples and not warned_missing))
    else:
        complete = not missing_definition and not missing_primary and not missing_senses and (allow_missing or not missing_examples)
    return output, report, complete


def gzip_bytes(raw):
    buffer = io.BytesIO()
    with gzip.GzipFile(filename="", fileobj=buffer, mode="wb", compresslevel=9, mtime=0) as stream:
        stream.write(raw)
    return buffer.getvalue()


def atomic_write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix="." + path.name + ".", delete=False) as stream:
        temp = Path(stream.name)
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("input", "lexical", "warnings", "output", "manifest", "review-queue"):
        parser.add_argument("--" + option, type=Path, required=True)
    parser.add_argument("--source-manifest", type=Path, default=ROOT / "data/bilingual-source.manifest.json")
    parser.add_argument("--expected-word-count", type=int, default=8798,
                        help="Explicit smaller lexical scope for diagnostics only; input and lexical must contain exactly this count")
    parser.add_argument("--allow-missing", action="store_true", help="Allow explicitly reported ordinary example gaps; never missing primary definitions")
    parser.add_argument("--version", default="bilingual-v1")
    parser.add_argument("--definition-policy", choices=("strict-sense-pairs", "word-source-languages"), default="strict-sense-pairs", help="Word-source-languages preserves independent same-word English and Chinese senses without claiming equivalence; strict is the default.")
    args = parser.parse_args(argv)
    sources = [args.input, args.lexical, args.warnings, args.source_manifest]
    outputs = [args.output, args.manifest, args.review_queue]
    require(len({p.resolve() for p in outputs}) == 3 and not {p.resolve() for p in sources} & {p.resolve() for p in outputs},
            "output_paths_must_be_distinct_from_sources")
    require(re.fullmatch(r"[\w.-]+\.jsonl\.gz", args.output.name) is not None, "output_filename_must_be_jsonl_gz")
    warning_rows = parse_json(args.warnings.read_text(encoding="utf-8"))
    require(isinstance(warning_rows, list), "source_warning_array_required")
    source = parse_json(args.source_manifest.read_text(encoding="utf-8"))
    rows, report, complete = compile_rows(read_jsonl(args.input), read_jsonl(args.lexical), warning_rows,
                                          source, args.expected_word_count, args.allow_missing, args.definition_policy)
    scope = ("Built-in five-book lexical union" if args.expected_word_count == 8798 else "Explicit diagnostic lexical sample")
    if args.definition_policy == "word-source-languages":
        scope += "; independent word-level source languages, not paired dictionary senses"
    if args.allow_missing:
        scope += "; ordinary example gaps explicitly allowed and reported"
    report["scope"] = scope
    report["complete"] = complete
    report["version"] = args.version
    atomic_write(args.review_queue, (canonical(report) + "\n").encode("utf-8"))
    require(complete, "bilingual_coverage_incomplete; see review queue")
    raw = ("".join(canonical(row) + "\n" for row in rows)).encode("utf-8")
    require(len(raw) <= MAX_JSONL_BYTES, "jsonl_exceeds_installer_64mib_limit")
    compressed = gzip_bytes(raw)
    manifest = {"formatVersion": 1, "id": "bilingual-v1", "version": args.version, "fileName": args.output.name,
                "bytes": len(compressed), "sha256": digest(compressed), "jsonlSha256": digest(raw),
                "sourceUrl": "https://github.com/wudi000888-svg/nightstudy/blob/main/data/" + args.output.name,
                "license": "MIT AND CC-BY-2.0-FR", "wordCount": len(rows), "scope": scope,
                "sourceManifestSha256": digest(args.source_manifest.read_bytes()), "statistics": report["statistics"],
                "definitionPolicy": args.definition_policy, "qualityReview": "pending", "semanticQualityCertified": False}
    atomic_write(args.output, compressed)
    atomic_write(args.manifest, (canonical(manifest) + "\n").encode("utf-8"))
    print(canonical({"action": "bilingual.compile", "manifestSha256": digest((canonical(manifest) + "\n").encode("utf-8")),
                     **manifest}))
    return manifest


if __name__ == "__main__":
    try:
        main()
    except (CompileError, OSError, UnicodeError, json.JSONDecodeError) as error:
        print(canonical({"action": "bilingual.compile.failed", "reason": str(error)}), file=sys.stderr)
        raise SystemExit(1)
