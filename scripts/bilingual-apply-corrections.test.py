#!/usr/bin/env python3
"""Isolated correction fixtures; no database, environment, network or inference."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("bilingual_apply_corrections", Path(__file__).with_name("bilingual-apply-corrections.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
C = MODULE.COMPILER


class CorrectionTests(unittest.TestCase):
    def setUp(self):
        model = {"repository": "fixture/Qwen", "revision": "a" * 40, "license": "Apache-2.0",
                 "weights": {"sha256": "b" * 64}, "approvedPromptVersions": ["fixture-v2"]}
        self.source = {"selectedTranslationModel": "fixture", "translationModels": {"fixture": model},
                       "datasets": {"tatoebaEnglish": {"snapshot": "fixture", "sha256": "c" * 64}}}
        self.lexical = [{"normalizedLemma": "rain", "senses": [{"id": "rain-primary", "definitionZh": "  雨\n",
                         "definitionEn": "", "exampleEn": "", "exampleZh": ""}]},
                        {"normalizedLemma": "quiet", "senses": [{"id": "quiet-primary", "definitionZh": "安静的",
                         "definitionEn": "", "exampleEn": "", "exampleZh": ""}]}]
        self.raw_meta = {"kind": "machine-translation", "review": "pending", "model": "fixture/Qwen",
                         "modelRevision": "a" * 40, "promptVersion": "fixture-v2", "sourceLanguage": "zh",
                         "sourceTextSha256": C.digest("  雨\n"), "modelWeightSha256": "b" * 64, "modelLicense": "Apache-2.0"}
        self.rows = [{"normalizedLemma": "rain", "senses": [{"id": "rain-primary", "definitionEn": "wrong output  \n",
                      "contentMetadata": {"definitionEn": copy.deepcopy(self.raw_meta)}}], "examples": []},
                     {"normalizedLemma": "quiet", "senses": [], "examples": []}]
        self.entry = {"normalizedLemma": "rain", "senseId": "rain-primary", "field": "definitionEn",
                      "sourceText": "  雨\n", "sourceTextSha256": C.digest("  雨\n"), "value": "rain; rainfall",
                      "author": MODULE.AUTHOR, "authoringMethod": MODULE.METHOD, "reason": "Fixture correction"}

    def apply(self, entries=None, rows=None, lexical=None, candidates=None):
        return MODULE.apply_corrections(rows if rows is not None else self.rows,
                                       lexical if lexical is not None else self.lexical,
                                       entries if entries is not None else [self.entry], self.source, candidates)

    def corpus_example(self):
        return {"exampleEn": "The rain stopped before we reached the station.", "exampleZh": "错误译文",
                "contentMetadata": {"exampleEn": {"kind": "corpus", "review": "pending", "sourceName": "Tatoeba",
                    "author": "Fixture creator", "sourceLanguage": "eng", "license": "CC-BY-2.0-FR",
                    "sourceSentenceId": "123", "sourceUrl": "https://tatoeba.org/en/sentences/show/123",
                    "snapshot": "fixture", "sourceSha256": "c" * 64},
                    "exampleZh": {**copy.deepcopy(self.raw_meta), "sourceLanguage": "en"}}}

    def example_entry(self, example):
        return {"normalizedLemma": "rain", "field": "exampleZh", "exampleEn": example["exampleEn"],
                "sourceText": example["exampleEn"], "sourceTextSha256": C.digest(example["exampleEn"]),
                "value": "我们到达车站前雨就停了。", "author": MODULE.AUTHOR,
                "authoringMethod": MODULE.METHOD, "reason": "Fixture sentence correction"}

    def test_sense_correction_records_actual_raw_output_and_leaves_others_unchanged(self):
        output, changed, counts = self.apply()
        self.assertEqual(self.rows[0]["senses"][0]["definitionEn"], "wrong output  \n")
        self.assertEqual(output[1], self.rows[1])
        self.assertEqual(changed, {"rain"})
        metadata = output[0]["senses"][0]["contentMetadata"]["definitionEn"]
        self.assertEqual(metadata["kind"], "original-authoring")
        self.assertNotIn("model", metadata)
        self.assertEqual(metadata["correctionOf"]["outputSha256"], C.digest("wrong output  \n"))
        self.assertEqual(metadata["correctionOf"]["model"], "fixture/Qwen")
        self.assertEqual(metadata["correctionOf"]["promptVersion"], "fixture-v2")
        self.assertEqual(counts["senseFieldsCorrected"], 1)

    def test_failed_missing_field_can_be_added_without_fabricated_history(self):
        rows = copy.deepcopy(self.rows)
        rows[0]["senses"] = []
        output, _, _ = self.apply(rows=rows)
        self.assertEqual(output[0]["senses"][0]["definitionEn"], "rain; rainfall")
        self.assertNotIn("correctionOf", output[0]["senses"][0]["contentMetadata"]["definitionEn"])

    def test_source_text_and_utf8_hash_are_exact_not_trimmed_or_rewritten(self):
        for key, value, error in [("sourceText", "雨", "source_text_mismatch"),
                                  ("sourceTextSha256", C.digest("雨"), "source_hash_mismatch")]:
            entry = {**self.entry, key: value}
            with self.assertRaisesRegex(C.CompileError, error):
                self.apply([entry])

    def test_nonempty_original_target_cross_word_unknown_and_duplicates_rejected(self):
        lexical = copy.deepcopy(self.lexical)
        lexical[0]["senses"][0]["definitionEn"] = "admin translation"
        with self.assertRaisesRegex(C.CompileError, "original_target_not_exactly_empty"):
            self.apply(lexical=lexical)
        with self.assertRaisesRegex(C.CompileError, "same_lexical_word"):
            self.apply([{**self.entry, "senseId": "quiet-primary"}])
        with self.assertRaisesRegex(C.CompileError, "word_not_in_input"):
            self.apply([{**self.entry, "normalizedLemma": "unknown"}])
        with self.assertRaisesRegex(C.CompileError, "duplicate_correction_target"):
            self.apply([self.entry, self.entry])

    def test_author_method_reason_and_no_injected_metadata_are_required(self):
        for change in [{"author": "anonymous"}, {"authoringMethod": "Qwen output"}, {"reason": ""}, {"model": "forged"}]:
            with self.assertRaises(C.CompileError):
                self.apply([{**self.entry, **change}])

    def test_existing_corpus_translation_preserves_creator_license_and_translator(self):
        example = self.corpus_example()
        rows = copy.deepcopy(self.rows)
        rows[0]["examples"] = [example]
        output, _, _ = self.apply([self.example_entry(example)], rows)
        corrected = output[0]["examples"][0]
        en, zh = corrected["contentMetadata"]["exampleEn"], corrected["contentMetadata"]["exampleZh"]
        self.assertEqual(en, example["contentMetadata"]["exampleEn"])
        self.assertEqual(zh["license"], "CC-BY-2.0-FR")
        self.assertEqual(zh["author"], "Fixture creator")
        self.assertEqual(zh["translationAuthor"], MODULE.AUTHOR)
        self.assertEqual(zh["correctionOf"]["outputSha256"], C.digest("错误译文"))
        bad = {**self.example_entry(example), "exampleSource": {"author": "fake"}}
        with self.assertRaisesRegex(C.CompileError, "source_metadata_mismatch"):
            self.apply([bad], rows)
        rows[0]["examples"] *= 2
        with self.assertRaisesRegex(C.CompileError, "ambiguous_raw_word_example"):
            self.apply([self.example_entry(example)], rows)

    def test_new_example_requires_actual_candidate_and_exact_copied_metadata(self):
        example = self.corpus_example()
        entry = {**self.example_entry(example), "exampleSource": copy.deepcopy(example["contentMetadata"]["exampleEn"])}
        with self.assertRaisesRegex(C.CompileError, "requires_candidates"):
            self.apply([entry])
        candidates = [{"normalizedLemma": "rain", "examples": [example]}]
        output, _, counts = self.apply([entry], candidates=candidates)
        self.assertEqual(counts["wordExamplesRestored"], 1)
        self.assertNotIn("correctionOf", output[0]["examples"][0]["contentMetadata"]["exampleZh"])
        entry["exampleSource"]["author"] = "fake creator"
        with self.assertRaisesRegex(C.CompileError, "candidate_metadata_mismatch"):
            self.apply([entry], candidates=candidates)

    def test_word_example_only_chinese_exact_literal_field(self):
        example = self.corpus_example()
        entry = self.example_entry(example)
        with self.assertRaisesRegex(C.CompileError, "only_chinese"):
            self.apply([{**entry, "field": "exampleEn"}])
        with self.assertRaisesRegex(C.CompileError, "missing_exact_lemma"):
            self.apply([{**entry, "exampleEn": "The rains stopped before we reached the station."}])

    def test_cli_preserves_unmodified_line_bytes_and_failure_preserves_existing_output(self):
        with tempfile.TemporaryDirectory(prefix="nightstudy-corrections-test-") as directory:
            p = Path(directory)
            first = json.dumps(self.rows[0], ensure_ascii=False) + "\r\n"
            untouched = json.dumps(self.rows[1], ensure_ascii=False, indent=None) + "\r\n"
            (p / "raw.jsonl").write_bytes((first + untouched).encode())
            (p / "lexical.jsonl").write_text("".join(C.canonical(row) + "\n" for row in self.lexical))
            (p / "corrections.json").write_text(json.dumps([self.entry], ensure_ascii=False))
            (p / "source.json").write_text(json.dumps(self.source))
            args = ["--input", str(p / "raw.jsonl"), "--lexical", str(p / "lexical.jsonl"),
                    "--corrections", str(p / "corrections.json"), "--source-manifest", str(p / "source.json"),
                    "--output", str(p / "corrected.jsonl")]
            with contextlib.redirect_stdout(io.StringIO()):
                MODULE.main(args)
            before = (p / "corrected.jsonl").read_bytes()
            self.assertTrue(before.endswith(untouched.encode()))
            invalid = {**self.entry, "sourceText": "rewritten original"}
            (p / "corrections.json").write_text(json.dumps([invalid]))
            with self.assertRaisesRegex(C.CompileError, "source_text_mismatch"):
                MODULE.main(args)
            self.assertEqual((p / "corrected.jsonl").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
