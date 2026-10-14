#!/usr/bin/env python3
"""Pure fixture checks. Never read .env, database, models or real content outputs."""
import copy
import contextlib
import gzip
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("bilingual_compile", Path(__file__).with_name("bilingual-compile.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CompilerTests(unittest.TestCase):
    def setUp(self):
        self.model = {"repository": "fixture/Qwen", "revision": "a" * 40, "license": "Apache-2.0",
                      "weights": {"sha256": "b" * 64}, "approvedPromptVersions": ["fixture-v1"]}
        self.source = {"selectedTranslationModel": "fixture", "translationModels": {"fixture": self.model},
                       "datasets": {"tatoebaEnglish": {"snapshot": "test-snapshot", "sha256": "c" * 64}}}
        self.lexical = [{"normalizedLemma": "rain", "senses": [{"id": "rain-zh", "definitionZh": "  雨；降雨\n",
                         "definitionEn": "", "exampleEn": "", "exampleZh": ""},
                        {"id": "rain-en", "definitionEn": "water falling from clouds", "definitionZh": "从云层中落下的水",
                         "exampleEn": "", "exampleZh": ""}]}]
        self.rows = [{"normalizedLemma": "rain", "senses": [{"id": "rain-zh", "definitionEn": "rain; rainfall",
                      "contentMetadata": {"definitionEn": self.metadata("  雨；降雨\n", "zh")}}],
                      "examples": [self.original_example()]}]

    def metadata(self, text, language):
        return {"kind": "machine-translation", "review": "pending", "sourceLanguage": language,
                "sourceTextSha256": MODULE.digest(text), "model": self.model["repository"],
                "modelRevision": self.model["revision"], "modelWeightSha256": self.model["weights"]["sha256"],
                "modelLicense": self.model["license"], "promptVersion": "fixture-v1"}

    def original_example(self):
        notice = {"kind": "generated", "review": "pending", "license": "MIT",
                  "author": "NightStudy contributors", "model": "Codex-assisted original writing"}
        return {"exampleEn": "The rain left small puddles along the quiet road.",
                "exampleZh": "雨在安静的路边留下了小水洼。",
                "contentMetadata": {"exampleEn": copy.deepcopy(notice), "exampleZh": copy.deepcopy(notice)}}

    def compile(self, rows=None, lexical=None, warnings=None, allow_missing=False):
        return MODULE.compile_rows(rows if rows is not None else self.rows,
                                   lexical if lexical is not None else self.lexical,
                                   warnings if warnings is not None else [], self.source, 1, allow_missing)

    def test_real_primary_coverage_does_not_borrow_alternate_english_sense(self):
        rows = copy.deepcopy(self.rows)
        rows[0]["senses"] = []
        lexical = copy.deepcopy(self.lexical)
        lexical[0]['senses'][1]['definitionZh'] = ''
        _, report, complete = self.compile(rows, lexical)
        self.assertFalse(complete)
        self.assertEqual(report["statistics"]["bilingualDefinitionWordCount"], 0)
        self.assertEqual(report["missing"]["primaryFocusEnglish"], ["rain"])
        lexical = copy.deepcopy(self.lexical)
        lexical[0]["senses"][1]["definitionZh"] = "另一个完整双语义项"
        _, report, complete = self.compile(rows, lexical)
        self.assertEqual(report["statistics"]["bilingualDefinitionWordCount"], 1)
        self.assertEqual(report["statistics"]["primaryBilingualFocusWordCount"], 0)
        self.assertFalse(complete)
        with self.assertRaisesRegex(MODULE.CompileError, "source_hash_mismatch"):
            rows = copy.deepcopy(self.rows)
            rows[0]["senses"][0]["contentMetadata"]["definitionEn"]["sourceTextSha256"] = MODULE.digest("雨；降雨")
            self.compile(rows)

    def test_valid_exact_original_whitespace_hash_and_warning_binding(self):
        warnings = [{"normalizedLemma": "rain", "warnings": [{"code": "source-spelling-unverified", "message": "Fixture only"}]}]
        rows, report, complete = self.compile(warnings=warnings)
        self.assertTrue(complete)
        self.assertEqual(rows[0]["warnings"][0]["senseId"], "rain-zh")
        self.assertEqual(rows[0]["warnings"][0]["sourceTextSha256"], MODULE.digest("  雨；降雨\n"))
        self.assertEqual(report["statistics"]["primaryBilingualFocusWordCount"], 1)

    def test_nonprimary_sense_gap_is_explicit_and_cannot_be_bypassed_by_example_allowance(self):
        lexical = copy.deepcopy(self.lexical)
        lexical[0]['senses'][1]['definitionZh'] = ''
        _, report, complete = self.compile(lexical=lexical, allow_missing=True)
        self.assertFalse(complete)
        self.assertEqual(report['statistics']['primaryBilingualFocusWordCount'], 1)
        self.assertEqual(report['statistics']['definitionSenseCount'], 2)
        self.assertEqual(report['statistics']['bilingualDefinitionSenseCount'], 1)
        self.assertEqual(report['statistics']['missingBilingualDefinitionSenseCount'], 1)
        self.assertEqual(report['missing']['senseDefinitions'], [{'normalizedLemma': 'rain', 'senseId': 'rain-en', 'missingLanguage': 'zh'}])
        self.assertIn('missing-sense-bilingual-definition', report['entries'][0]['reasons'])

    def test_duplicate_lemma_and_patch_and_wrong_word_sense_rejected(self):
        with self.assertRaisesRegex(MODULE.CompileError, "duplicate_lemma"):
            self.compile(self.rows + self.rows)
        rows = copy.deepcopy(self.rows)
        rows[0]["senses"] *= 2
        with self.assertRaisesRegex(MODULE.CompileError, "duplicate_sense_patch"):
            self.compile(rows)
        rows[0]["senses"] = [{**self.rows[0]["senses"][0], "id": "other-word-sense"}]
        with self.assertRaisesRegex(MODULE.CompileError, "unknown_or_duplicate_sense"):
            self.compile(rows)

    def test_existing_language_and_mismatched_source_language_rejected(self):
        lexical = copy.deepcopy(self.lexical)
        lexical[0]["senses"][0]["definitionEn"] = "existing administrator text"
        with self.assertRaisesRegex(MODULE.CompileError, "nonempty_target_field"):
            self.compile(lexical=lexical)
        lexical[0]["senses"][0]["definitionEn"] = " "
        with self.assertRaisesRegex(MODULE.CompileError, "nonempty_target_field"):
            self.compile(lexical=lexical)
        rows = copy.deepcopy(self.rows)
        rows[0]["senses"][0]["contentMetadata"]["definitionEn"]["sourceLanguage"] = "en"
        with self.assertRaisesRegex(MODULE.CompileError, "source_language_mismatch"):
            self.compile(rows)

    def test_old_opus_or_wrong_qwen_version_rejected(self):
        for field, value in [("model", "Helsinki-NLP/opus-mt-zh-en"), ("modelRevision", "d" * 40)]:
            rows = copy.deepcopy(self.rows)
            rows[0]["senses"][0]["contentMetadata"]["definitionEn"][field] = value
            with self.assertRaisesRegex(MODULE.CompileError, "unapproved_translation_model"):
                self.compile(rows)

    def test_sharded_model_requires_explicit_manifest_digest_kind(self):
        self.model['weights']['digestKind'] = 'sha256-canonical-weight-files-v1'
        with self.assertRaisesRegex(MODULE.CompileError, 'weight_digest_kind_mismatch'):
            self.compile()
        rows = copy.deepcopy(self.rows)
        rows[0]['senses'][0]['contentMetadata']['definitionEn']['modelWeightDigestKind'] = self.model['weights']['digestKind']
        self.assertTrue(self.compile(rows)[2])

    def test_rejected_prompt_cannot_reuse_same_valid_model_identity(self):
        rows = copy.deepcopy(self.rows)
        rows[0]["senses"][0]["contentMetadata"]["definitionEn"]["promptVersion"] = "nightstudy-contextual-gloss-v1"
        with self.assertRaisesRegex(MODULE.CompileError, "unapproved_translation_prompt"):
            self.compile(rows)

    def test_original_authoring_identity_and_separate_counts(self):
        rows = copy.deepcopy(self.rows)
        original = {"kind": "original-authoring", "review": "pending", "author": "NightStudy contributors",
                    "license": "MIT", "authoringMethod": "Codex-assisted bilingual correction",
                    "sourceLanguage": "zh", "sourceTextSha256": MODULE.digest("  雨；降雨\n"),
                    "correctionOf": {"model": "fixture/Qwen", "outputSha256": MODULE.digest("old wrong output")}}
        rows[0]["senses"][0]["contentMetadata"]["definitionEn"] = original
        compiled, report, complete = self.compile(rows)
        self.assertTrue(complete)
        self.assertEqual(report["statistics"]["machineTranslatedFields"], 0)
        self.assertEqual(report["statistics"]["originalAuthoredFields"], 1)
        self.assertEqual(compiled[0]["senses"][0]["contentMetadata"]["definitionEn"], original)
        self.assertIn("original-authoring-pending-review", report["entries"][0]["reasons"])
        self.assertNotIn("machine-translation-pending-review", report["entries"][0]["reasons"])
        original["model"] = "fixture/Qwen"
        with self.assertRaisesRegex(MODULE.CompileError, "must_not_claim_model_output"):
            self.compile(rows)
        del original["model"]
        original["sourceTextSha256"] = MODULE.digest("雨；降雨")
        with self.assertRaisesRegex(MODULE.CompileError, "original_authoring_source_identity_mismatch"):
            self.compile(rows)

    def test_original_corpus_translation_keeps_original_creator_and_separate_translator(self):
        rows = copy.deepcopy(self.rows)
        example = rows[0]["examples"][0]
        en = {"kind": "corpus", "review": "pending", "license": "CC-BY-2.0-FR", "author": "Fixture Author",
              "sourceLanguage": "eng", "sourceName": "Tatoeba", "sourceSentenceId": "123",
              "sourceUrl": "https://tatoeba.org/en/sentences/show/123", "snapshot": "test-snapshot", "sourceSha256": "c" * 64}
        zh = {"kind": "original-authoring", "review": "pending", "sourceLanguage": "en",
              "sourceTextSha256": MODULE.digest(example["exampleEn"]),
              **{k: en[k] for k in ("license", "author", "sourceSentenceId", "sourceUrl", "sourceName", "snapshot")},
              "translationAuthor": "NightStudy contributors", "authoringMethod": "Codex-assisted bilingual correction",
              "adaptation": "AI-assisted original Chinese correction; original English retained"}
        example["contentMetadata"] = {"exampleEn": en, "exampleZh": zh}
        _, report, complete = self.compile(rows)
        self.assertTrue(complete)
        self.assertEqual(report["statistics"]["corpusExamples"], 1)
        self.assertEqual(report["statistics"]["originalAuthoredExampleFields"], 1)
        self.assertEqual(report["statistics"]["machineTranslatedExampleFields"], 0)
        zh["license"] = "MIT"
        with self.assertRaisesRegex(MODULE.CompileError, "original_authoring_license_or_review_mismatch"):
            self.compile(rows)

    def test_literal_unicode_boundary_no_substring_inflection_or_mark(self):
        for text in ["The train arrived on time this morning.", "Heavy rains flooded the nearby fields.", "\u0301rain fell overnight beside the old bridge."]:
            rows = copy.deepcopy(self.rows)
            rows[0]["examples"][0]["exampleEn"] = text
            with self.assertRaisesRegex(MODULE.CompileError, "missing_exact_lemma"):
                self.compile(rows)
        self.assertTrue(MODULE.exact_lemma("Rain fell overnight.", "rain"))
        self.assertTrue(MODULE.exact_lemma("İ is not English I.", "i"))  # The actual separate I is allowed.
        self.assertFalse(MODULE.exact_lemma("İ went home.", "i"))
        self.assertTrue(MODULE.exact_lemma("İ saw rain outside.", "rain"))

    def test_corpus_attribution_and_mt_adaptation_preserved(self):
        rows = copy.deepcopy(self.rows)
        example = rows[0]["examples"][0]
        en = {"kind": "corpus", "review": "pending", "license": "CC-BY-2.0-FR", "author": "Fixture Author",
              "sourceLanguage": "eng", "sourceName": "Tatoeba", "sourceSentenceId": "123",
              "sourceUrl": "https://tatoeba.org/en/sentences/show/123", "snapshot": "test-snapshot", "sourceSha256": "c" * 64}
        zh = {**self.metadata(example["exampleEn"], "en"),
              **{k: en[k] for k in ("license", "author", "sourceSentenceId", "sourceUrl", "sourceName", "snapshot")},
              "adaptation": "Machine translation; original retained"}
        example["contentMetadata"] = {"exampleEn": en, "exampleZh": zh}
        packed, report, complete = self.compile(rows)
        self.assertTrue(complete)
        self.assertEqual(packed[0]["examples"][0]["contentMetadata"], example["contentMetadata"])
        self.assertEqual(report["statistics"]["corpusExamples"], 1)
        zh["author"] = "different author"
        with self.assertRaisesRegex(MODULE.CompileError, "adaptation_attribution_mismatch"):
            self.compile(rows)

    def test_missing_examples_require_warning_or_explicit_allow_missing(self):
        rows = copy.deepcopy(self.rows)
        rows[0]["examples"] = []
        _, report, complete = self.compile(rows)
        self.assertFalse(complete)
        self.assertEqual(report["missing"]["examples"], ["rain"])
        self.assertTrue(self.compile(rows, allow_missing=True)[2])
        warnings = [{"normalizedLemma": "rain", "warnings": [{"code": "source-spelling-unverified", "message": "Hold fixture"}]}]
        _, report, complete = self.compile(rows, warnings=warnings)
        self.assertTrue(complete)
        self.assertEqual(report["statistics"]["knownWarningExampleGapWordCount"], 1)
        rows[0]["senses"] = []
        self.assertFalse(self.compile(rows, warnings=warnings, allow_missing=True)[2])

    def test_deterministic_gzip_and_atomic_failure_without_overwriting_pack(self):
        raw = (MODULE.canonical(self.rows[0]) + "\n").encode()
        packed = MODULE.gzip_bytes(raw)
        self.assertEqual(packed, MODULE.gzip_bytes(raw))
        self.assertEqual(packed[4:8], b"\0" * 4)
        self.assertEqual(gzip.decompress(packed), raw)
        with tempfile.TemporaryDirectory(prefix="nightstudy-compile-test-") as directory:
            p = Path(directory)
            for name, value in [("input.jsonl", self.rows), ("lexical.jsonl", self.lexical)]:
                (p / name).write_text("".join(MODULE.canonical(row) + "\n" for row in value))
            (p / "warnings.json").write_text("[]")
            (p / "source.json").write_text(MODULE.canonical(self.source))
            args = ["--input", str(p / "input.jsonl"), "--lexical", str(p / "lexical.jsonl"),
                    "--warnings", str(p / "warnings.json"), "--source-manifest", str(p / "source.json"),
                    "--output", str(p / "fixture.jsonl.gz"), "--manifest", str(p / "manifest.json"),
                    "--review-queue", str(p / "queue.json"), "--expected-word-count", "1"]
            with contextlib.redirect_stdout(io.StringIO()):
                manifest = MODULE.main(args)
            self.assertEqual(manifest["wordCount"], 1)
            self.assertIn("diagnostic", manifest["scope"])
            before = (p / "fixture.jsonl.gz").read_bytes()
            incomplete = copy.deepcopy(self.rows)
            incomplete[0]["senses"] = []
            (p / "input.jsonl").write_text(MODULE.canonical(incomplete[0]) + "\n")
            with self.assertRaisesRegex(MODULE.CompileError, "coverage_incomplete"):
                MODULE.main(args)
            self.assertEqual((p / "fixture.jsonl.gz").read_bytes(), before)
            self.assertFalse(json.loads((p / "queue.json").read_text())["complete"])

    def test_duplicate_json_key_rejected(self):
        with self.assertRaisesRegex(MODULE.CompileError, "duplicate_json_key"):
            MODULE.parse_json('{"normalizedLemma":"rain","normalizedLemma":"bank"}')

    def no_model_rows(self):
        rows = copy.deepcopy(self.rows)
        rows[0]["senses"][0]["contentMetadata"]["definitionEn"] = {
            "kind": "original-authoring", "review": "pending", "author": "NightStudy contributors",
            "license": "MIT", "authoringMethod": "Codex-assisted bilingual correction", "sourceLanguage": "zh",
            "sourceTextSha256": MODULE.digest("  雨；降雨\n")}
        return rows

    def independent_word_rows(self):
        lexical = copy.deepcopy(self.lexical)
        lexical[0]["senses"][1]["definitionZh"] = ""
        rows = self.no_model_rows()
        rows[0]["senses"] = []
        zh = rows[0]["examples"][0]["contentMetadata"]["exampleZh"]
        zh["sourceLanguage"] = "en"
        zh["sourceTextSha256"] = MODULE.digest(rows[0]["examples"][0]["exampleEn"])
        return rows, lexical

    def test_no_model_required_for_actual_original_authoring(self):
        self.source = {"datasets": {}}
        rows, report, complete = self.compile(self.no_model_rows())
        self.assertTrue(complete)
        self.assertEqual(report["statistics"]["originalAuthoredFields"], 1)
        self.assertEqual(report["statistics"]["machineTranslatedFields"], 0)

    def test_model_required_only_when_current_fields_are_machine_output(self):
        self.source = {"datasets": {}}
        with self.assertRaisesRegex(MODULE.CompileError, "selected_model_required"):
            self.compile()
        rows = self.no_model_rows()
        rows[0]["senses"][0]["contentMetadata"]["definitionEn"]["correctionOf"] = {
            "model": "rejected/past-model", "kind": "machine-translation", "outputSha256": "e" * 64}
        self.assertTrue(self.compile(rows)[2])

    def test_word_policy_does_not_fake_same_sense_alignment(self):
        rows, lexical = self.independent_word_rows()
        output, report, complete = MODULE.compile_rows(rows, lexical, [], {}, 1, False, "word-source-languages")
        self.assertTrue(complete)
        self.assertEqual(output[0]["senses"], [])
        self.assertEqual(report["statistics"]["nativeEnglishDefinitionWordCount"], 1)
        self.assertEqual(report["statistics"]["wordSourceLanguagesWordCount"], 1)
        self.assertEqual(report["statistics"]["pairedDefinitionSenseCount"], 0)
        self.assertEqual(report["statistics"]["primaryBilingualFocusWordCount"], 0)
        self.assertEqual(report["missing"]["primaryFocusEnglish"], ["rain"])
        self.assertEqual(report["languagePairing"], "independent-per-word")
        self.assertEqual(output[0]["examples"], rows[0]["examples"])
        self.assertFalse(MODULE.compile_rows(rows, lexical, [], {}, 1)[2])

    def test_word_policy_cannot_borrow_another_words_english(self):
        rows, lexical = self.independent_word_rows()
        lexical[0]["senses"][1]["definitionEn"] = ""
        _, report, complete = MODULE.compile_rows(rows, lexical, [], {}, 1, True, "word-source-languages")
        self.assertFalse(complete)
        self.assertEqual(report["missing"]["wordSourceEnglish"], ["rain"])

    def test_original_chinese_example_binds_exact_english_without_a_model(self):
        rows, lexical = self.independent_word_rows()
        rows[0]["examples"][0]["contentMetadata"]["exampleZh"]["sourceTextSha256"] = "f" * 64
        with self.assertRaisesRegex(MODULE.CompileError, "original_chinese_example_source_identity_required"):
            MODULE.compile_rows(rows, lexical, [], {}, 1, False, "word-source-languages")

    def manythings_example(self):
        en = "The rain filled the small pond overnight."
        zh = "雨水在一夜之间灌满了小池塘。"
        credit = "CC-BY 2.0 (France) Attribution: tatoeba.org #101 (EnglishOwner) & #202 (ChineseOwner)"
        base = {"kind": "corpus", "review": "pending", "license": "CC-BY-2.0-FR",
                "sourceName": "Tatoeba / ManyThings selection", "sourceDataset": "manyThingsEnglishChinese",
                "sourceSha256": "d" * 64, "snapshot": "test-pairs", "sourceExportUrl": "https://www.manythings.org/anki/cmn-eng.zip",
                "sourceOwnerRole": "export-attributed-owner", "attribution": credit, "relationship": {"kind": "source-export-pair"}}
        em = {**base, "sourceLanguage": "en", "sourceOwner": "EnglishOwner", "sourceSentenceId": "101",
              "sourceUrl": "https://tatoeba.org/en/sentences/show/101", "sourceTextSha256": MODULE.digest(en), "translationSentenceId": "202"}
        zm = {**base, "sourceLanguage": "zh", "sourceOwner": "ChineseOwner", "sourceSentenceId": "202",
              "sourceUrl": "https://tatoeba.org/en/sentences/show/202", "sourceTextSha256": MODULE.digest(zh), "translationOfSentenceId": "101"}
        self.source = {"datasets": {"manyThingsEnglishChinese": {"sha256": "d" * 64, "snapshot": "test-pairs",
                      "sourceUrl": "https://www.manythings.org/anki/cmn-eng.zip"}}}
        return {"exampleEn": en, "exampleZh": zh, "contentMetadata": {"exampleEn": em, "exampleZh": zm}}

    def test_static_pair_accepts_independent_export_owners_without_model_or_fake_author(self):
        rows, lexical = self.independent_word_rows()
        rows[0]["examples"] = [self.manythings_example()]
        _, report, complete = MODULE.compile_rows(rows, lexical, [], self.source, 1, False, "word-source-languages")
        self.assertTrue(complete)
        self.assertEqual(report["statistics"]["corpusExamples"], 1)
        self.assertNotIn("author", rows[0]["examples"][0]["contentMetadata"]["exampleZh"])

    def test_static_pair_rejects_cross_sentence_or_snapshot_or_owner_changes(self):
        for field, value, error in [("sourceOwner", "IncorrectOwner", "owner_credit_mismatch"),
                                    ("translationOfSentenceId", "777", "translation_pair"),
                                    ("sourceSha256", "e" * 64, "snapshot_mismatch"),
                                    ("sourceTextSha256", "e" * 64, "text_hash_mismatch")]:
            rows, lexical = self.independent_word_rows()
            rows[0]["examples"] = [self.manythings_example()]
            rows[0]["examples"][0]["contentMetadata"]["exampleZh"][field] = value
            with self.assertRaisesRegex(MODULE.CompileError, error):
                MODULE.compile_rows(rows, lexical, [], self.source, 1, False, "word-source-languages")

    def test_word_policy_reports_held_examples_as_incomplete_unless_explicitly_allowed(self):
        rows, lexical = self.independent_word_rows(); rows[0]["examples"] = []
        warnings = [{"normalizedLemma": "rain", "warnings": [{"code": "source-spelling-unverified", "message": "Hold fixture only"}]}]
        self.assertFalse(MODULE.compile_rows(rows, lexical, warnings, {}, 1, False, "word-source-languages")[2])
        _, report, complete = MODULE.compile_rows(rows, lexical, warnings, {}, 1, True, "word-source-languages")
        self.assertTrue(complete)
        self.assertEqual(report["missing"]["sourceQualityHeldExamples"], ["rain"])

    def test_word_policy_rejects_uncontextualized_original_filler(self):
        rows, lexical = self.independent_word_rows(); rows[0]["examples"][0]["exampleEn"] = "This is rain."
        with self.assertRaisesRegex(MODULE.CompileError, "original_example_requires_context"):
            MODULE.compile_rows(rows, lexical, [], {}, 1, False, "word-source-languages")


if __name__ == "__main__":
    unittest.main()
