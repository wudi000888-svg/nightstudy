#!/usr/bin/env python3
"""Small original fixtures only: no network, models, database or production packs."""
import copy
import argparse
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "nightstudy_bilingual_assembly_fixture",
    Path(__file__).with_name("bilingual-assemble.py"),
)
ASSEMBLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASSEMBLER)
C = ASSEMBLER.C
ERRORS = (C.CompileError, ASSEMBLER.CORRECTIONS.COMPILER.CompileError)


class AssemblyTests(unittest.TestCase):
    def setUp(self):
        self.source = {"datasets": {}}
        self.lexical = [
            {"normalizedLemma": "rain", "senses": [
                {"id": "rain-zh", "definitionZh": "  雨；降雨\n", "definitionEn": "",
                 "exampleEn": "", "exampleZh": ""}]},
            {"normalizedLemma": "window", "senses": [
                {"id": "window-zh", "definitionZh": "窗", "definitionEn": "",
                 "exampleEn": "", "exampleZh": ""},
                {"id": "window-en", "definitionZh": "", "definitionEn": "An opening admitting light.",
                 "exampleEn": "", "exampleZh": ""}]},
            {"normalizedLemma": "quiet", "senses": [
                {"id": "quiet-paired", "definitionZh": "安静的", "definitionEn": "Making little noise.",
                 "exampleEn": "", "exampleZh": ""}]},
        ]
        self.authored = [
            {"normalizedLemma": "rain", "exampleEn": "The rain soaked our coats beside the station.",
             "exampleZh": "雨水在车站旁打湿了我们的外套。"},
            {"normalizedLemma": "window", "exampleEn": "She closed the window before lighting the fireplace.",
             "exampleZh": "她在点燃壁炉前关上了窗户。"},
            {"normalizedLemma": "quiet", "exampleEn": "The quiet courtyard offered shelter from the busy market.",
             "exampleZh": "安静的庭院让人避开了繁忙的市场。"},
        ]
        self.corrections = [{
            "normalizedLemma": "rain", "senseId": "rain-zh", "field": "definitionEn",
            "sourceText": "  雨；降雨\n", "sourceTextSha256": C.digest("  雨；降雨\n"),
            "value": "Rain; rainfall.", "author": "NightStudy contributors",
            "authoringMethod": "Codex-assisted bilingual correction",
            "reason": "Original synthetic test definition only.",
        }]

    def assemble(self, **changes):
        arguments = {
            "lexical_rows": copy.deepcopy(self.lexical), "corpus_rows": [],
            "authored_rows": copy.deepcopy(self.authored),
            "corrections": copy.deepcopy(self.corrections), "phrase_rows": [],
            "source_manifest": copy.deepcopy(self.source), "warning_rows": [],
            "expected_count": 3,
        }
        arguments.update(changes)
        return ASSEMBLER.assemble(**arguments)

    def phrase_patch(self):
        source = "  雨；降雨\n"
        return {"normalizedLemma": "rain", "sourceWordId": C.digest("rain"), "senses": [{
            "id": "rain-zh", "sourceText": source,
            "sourceTextSha256": C.digest(source), "definitionEn": "Rain; rainfall.",
            "contentMetadata": {"definitionEn": {
                "kind": "original-authoring", "review": "pending", "license": "MIT",
                "author": "NightStudy contributors", "authoringMethod": "Codex-assisted phrase definition",
                "sourceLanguage": "zh", "sourceTextSha256": C.digest(source),
                "sourceSenseId": "rain-zh",
            }},
        }]}

    def corpus_candidate(self):
        en = "The rain filled the small pond overnight."
        zh = "雨水在一夜之间灌满了小池塘。"
        credit = "CC-BY 2.0 (France) Attribution: tatoeba.org #101 (FixtureEnglishOwner) & #202 (FixtureChineseOwner)"
        common = {
            "kind": "corpus", "review": "pending", "license": "CC-BY-2.0-FR",
            "sourceName": "Tatoeba / ManyThings selection", "sourceDataset": "manyThingsEnglishChinese",
            "sourceSha256": "a" * 64, "snapshot": "synthetic-fixture-snapshot",
            "sourceExportUrl": "https://www.manythings.org/anki/cmn-eng.zip",
            "sourceOwnerRole": "export-attributed-owner", "attribution": credit,
            "relationship": {"kind": "source-export-pair"},
        }
        return {"normalizedLemma": "rain", "candidates": [{
            "exampleEn": en, "exampleZh": zh, "sourceLine": 1,
            "selection": {"fixture": True}, "contentMetadata": {
                "exampleEn": {**common, "sourceLanguage": "en", "sourceOwner": "FixtureEnglishOwner",
                              "sourceSentenceId": "101", "translationSentenceId": "202",
                              "sourceUrl": "https://tatoeba.org/en/sentences/show/101",
                              "sourceTextSha256": C.digest(en)},
                "exampleZh": {**common, "sourceLanguage": "zh", "sourceOwner": "FixtureChineseOwner",
                              "sourceSentenceId": "202", "translationOfSentenceId": "101",
                              "sourceUrl": "https://tatoeba.org/en/sentences/show/202",
                              "sourceTextSha256": C.digest(zh)},
            },
        }]}

    def corpus_source(self):
        return {"datasets": {"manyThingsEnglishChinese": {
            "sha256": "a" * 64, "snapshot": "synthetic-fixture-snapshot",
            "sourceUrl": "https://www.manythings.org/anki/cmn-eng.zip",
        }}}

    def test_missing_definition_is_original_bound_and_independent_existing_languages_are_preserved(self):
        originals = copy.deepcopy((self.lexical, self.authored, self.corrections))
        rows, counts = self.assemble()
        self.assertEqual([row["normalizedLemma"] for row in rows], ["quiet", "rain", "window"])
        by_word = {row["normalizedLemma"]: row for row in rows}
        self.assertEqual(by_word["quiet"]["senses"], [])
        self.assertEqual(by_word["window"]["senses"], [])
        metadata = by_word["rain"]["senses"][0]["contentMetadata"]["definitionEn"]
        self.assertEqual(metadata["kind"], "original-authoring")
        self.assertEqual(metadata["sourceTextSha256"], C.digest("  雨；降雨\n"))
        self.assertEqual(metadata["sourceLanguage"], "zh")
        self.assertEqual(metadata["license"], "MIT")
        self.assertEqual(metadata["review"], "pending")
        self.assertNotIn("model", metadata)
        self.assertNotIn("correctionOf", metadata)
        self.assertEqual(counts["nativeEnglishAuthoredFields"], 1)
        compiled, report, complete = C.compile_rows(rows, self.lexical, [], self.source, 3, False, "word-source-languages")
        self.assertTrue(complete)
        self.assertEqual(report["statistics"]["wordSourceLanguagesWordCount"], 3)
        self.assertEqual(report["statistics"]["pairedDefinitionSenseCount"], 2)
        self.assertEqual(report["statistics"]["machineTranslatedFields"], 0)
        self.assertEqual(report["languagePairing"], "independent-per-word")
        self.assertEqual(len(compiled), 3)
        self.assertEqual((self.lexical, self.authored, self.corrections), originals)

    def test_generated_example_metadata_is_pending_mit_and_chinese_binds_exact_english_without_model(self):
        rows, counts = self.assemble()
        self.assertEqual(counts["authoredExampleWordCount"], 3)
        for row in rows:
            example = row["examples"][0]
            for language, field in [("en", "exampleEn"), ("zh", "exampleZh")]:
                metadata = example["contentMetadata"][field]
                self.assertEqual((metadata["kind"], metadata["license"], metadata["review"]), ("generated", "MIT", "pending"))
                self.assertEqual(metadata["author"], "NightStudy contributors")
                self.assertEqual(metadata["authoringMethod"], "Codex-assisted original writing")
                self.assertEqual(metadata["language"], language)
                self.assertNotIn("model", metadata)
                self.assertEqual(metadata["sourceTextSha256"], C.digest(example["exampleEn"]))
            self.assertEqual(example["contentMetadata"]["exampleZh"]["sourceLanguage"], "en")

    def test_rejects_incomplete_usage_scope_and_wrong_expected_word_count(self):
        with self.assertRaisesRegex(ERRORS, "assembly_usage_drafts_incomplete:quiet"):
            self.assemble(authored_rows=[row for row in self.authored if row["normalizedLemma"] != "quiet"])
        with self.assertRaisesRegex(ERRORS, "assembly_lexical_scope_mismatch"):
            self.assemble(expected_count=4)

    def test_rejects_foreign_authored_and_corpus_words_before_compilation(self):
        foreign = {**self.authored[0], "normalizedLemma": "foreign"}
        with self.assertRaisesRegex(ERRORS, "assembly_foreign_word"):
            self.assemble(authored_rows=self.authored + [foreign])
        with self.assertRaisesRegex(ERRORS, "assembly_foreign_word"):
            self.assemble(corpus_rows=[{"normalizedLemma": "foreign", "candidates": []}])

    def test_rejects_duplicate_lemmas_in_every_input_and_conflicting_example_sources(self):
        for key, rows, error in [
            ("lexical_rows", self.lexical + [self.lexical[0]], "lexical_duplicate_lemma"),
            ("authored_rows", self.authored + [self.authored[0]], "authored_duplicate_lemma"),
            ("corpus_rows", [self.corpus_candidate(), self.corpus_candidate()], "corpus_duplicate_lemma"),
        ]:
            with self.subTest(input=key), self.assertRaisesRegex(ERRORS, error):
                self.assemble(**{key: rows})
        with self.assertRaisesRegex(ERRORS, "assembly_duplicate_example_source"):
            self.assemble(corpus_rows=[self.corpus_candidate()])

    def test_rejects_extra_authored_fields_empty_values_and_nonliteral_or_contextless_examples(self):
        for patch, error in [
            ({"model": "pretend-model"}, "assembly_authored_draft_shape"),
            ({"exampleZh": ""}, "assembly_authored_chinese_required"),
            ({"exampleEn": "The brain changed after a long conversation."}, "example_missing_exact_lemma"),
            ({"exampleEn": "This is rain."}, "original_example_requires_context|assembly_authored_context_length"),
        ]:
            rows = copy.deepcopy(self.authored)
            rows[0].update(patch)
            with self.subTest(patch=patch), self.assertRaisesRegex(ERRORS, error):
                self.assemble(authored_rows=rows)

    def test_rejects_english_chinese_script_mix_and_chinese_field_without_han(self):
        for patch in [
            {"exampleEn": "The rain left 雨 puddles beside the station."},
            {"exampleEn": "雨水在车站旁打湿了我们的外套。"},
            {"exampleZh": "The rain soaked our coats beside the station."},
        ]:
            rows = copy.deepcopy(self.authored)
            rows[0].update(patch)
            with self.subTest(patch=patch), self.assertRaises(ERRORS):
                self.assemble(authored_rows=rows)

    def test_authored_examples_enforce_six_to_sixteen_words(self):
        for en in ["The rain fell very softly.", "The rain soaked our coats while we waited beside the station for the late bus after a very long unexpected delay."]:
            rows = copy.deepcopy(self.authored)
            rows[0]["exampleEn"] = en
            with self.subTest(sentence=en), self.assertRaises(ERRORS):
                self.assemble(authored_rows=rows)
        for en in ["The rain soaked our coats again.", "The rain soaked our coats while we waited quietly beside the old station for a taxi."]:
            rows = copy.deepcopy(self.authored)
            rows[0]["exampleEn"] = en
            self.assertEqual(len(self.assemble(authored_rows=rows)[0]), 3)

    def test_explicit_source_hold_stays_empty_and_cannot_silently_gain_a_usage_example(self):
        warnings = [{"normalizedLemma": "rain", "warnings": [{"code": "source-spelling-unverified", "message": "Synthetic source hold."}]}]
        with self.assertRaisesRegex(ERRORS, "assembly_held_word_has_usage"):
            self.assemble(warning_rows=warnings)
        rows, counts = self.assemble(warning_rows=warnings, authored_rows=self.authored[1:])
        self.assertEqual(counts["sourceHeldExampleWordCount"], 1)
        self.assertEqual(next(row for row in rows if row["normalizedLemma"] == "rain")["examples"], [])
        self.assertFalse(C.compile_rows(rows, self.lexical, warnings, self.source, 3, False, "word-source-languages")[2])
        self.assertTrue(C.compile_rows(rows, self.lexical, warnings, self.source, 3, True, "word-source-languages")[2])
        with self.assertRaisesRegex(ERRORS, "assembly_source_warning_scope"):
            self.assemble(warning_rows=[{**warnings[0], "normalizedLemma": "foreign"}])

    def test_ordinary_warning_does_not_excuse_a_missing_example(self):
        with self.assertRaisesRegex(ERRORS, "assembly_usage_drafts_incomplete:rain"):
            self.assemble(authored_rows=self.authored[1:], warning_rows=[{"normalizedLemma": "rain", "warnings": [{"code": "unrelated-warning", "message": "Fixture note."}]}])

    def test_manythings_pair_keeps_both_real_export_credit_fields_and_strips_selection_helpers(self):
        candidate = self.corpus_candidate()
        rows, counts = self.assemble(corpus_rows=[candidate], authored_rows=self.authored[1:], source_manifest=self.corpus_source())
        example = next(row for row in rows if row["normalizedLemma"] == "rain")["examples"][0]
        self.assertEqual(set(example), {"exampleEn", "exampleZh", "contentMetadata"})
        self.assertEqual(example["contentMetadata"], candidate["candidates"][0]["contentMetadata"])
        self.assertNotIn("author", example["contentMetadata"]["exampleEn"])
        self.assertNotIn("author", example["contentMetadata"]["exampleZh"])
        self.assertEqual(counts["corpusWordCount"], 1)
        self.assertEqual(counts["authoredExampleWordCount"], 2)
        self.assertTrue(C.compile_rows(rows, self.lexical, [], self.corpus_source(), 3, False, "word-source-languages")[2])

    def test_rejects_corpus_owner_pair_snapshot_and_exact_text_hash_mismatch(self):
        for field, value, error in [
            ("sourceOwner", "DifferentOwner", "owner_credit_mismatch"),
            ("translationOfSentenceId", "303", "translation_pair"),
            ("sourceSha256", "b" * 64, "snapshot_mismatch"),
            ("sourceTextSha256", "b" * 64, "text_hash_mismatch"),
        ]:
            candidate = self.corpus_candidate()
            candidate["candidates"][0]["contentMetadata"]["exampleZh"][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ERRORS, error):
                self.assemble(corpus_rows=[candidate], authored_rows=self.authored[1:], source_manifest=self.corpus_source())

    def test_corpus_slot_cannot_mislabel_original_generated_content_or_claim_a_model(self):
        candidate = self.corpus_candidate()
        example = candidate["candidates"][0]
        original = {"kind": "generated", "review": "pending", "license": "MIT", "author": "NightStudy contributors"}
        example["contentMetadata"] = {
            "exampleEn": {**original, "language": "en"},
            "exampleZh": {**original, "language": "zh", "sourceLanguage": "en", "sourceTextSha256": C.digest(example["exampleEn"])},
        }
        with self.assertRaisesRegex(ERRORS, "assembly_corpus_source_kind"):
            self.assemble(corpus_rows=[candidate], authored_rows=self.authored[1:], source_manifest=self.corpus_source())
        for field in ["exampleEn", "exampleZh"]:
            for key in ["model", "runtimeVersion", "promptVersion"]:
                candidate = self.corpus_candidate()
                candidate["candidates"][0]["contentMetadata"][field][key] = "not-a-real-inference"
                with self.subTest(field=field, key=key), self.assertRaisesRegex(ERRORS, "assembly_corpus_inference_metadata"):
                    self.assemble(corpus_rows=[candidate], authored_rows=self.authored[1:], source_manifest=self.corpus_source())

    def test_rejects_empty_or_unbounded_corpus_candidates(self):
        for candidates in [[], [self.corpus_candidate()["candidates"][0]] * 4]:
            with self.subTest(count=len(candidates)), self.assertRaisesRegex(ERRORS, "assembly_corpus_candidates_required"):
                self.assemble(corpus_rows=[{"normalizedLemma": "rain", "candidates": candidates}], authored_rows=self.authored[1:])

    def test_corrections_reject_cross_word_source_sense_or_changed_exact_source_hash(self):
        for patch, error in [
            ({"sourceTextSha256": C.digest("雨；降雨")}, "correction_source_hash_mismatch"),
            ({"sourceText": "雨；降雨"}, "correction_source_text_mismatch"),
            ({"senseId": "window-zh"}, "correction_sense_not_in_same_lexical_word"),
            ({"normalizedLemma": "foreign"}, "correction_word_not_in_input_and_lexical"),
        ]:
            entry = {**self.corrections[0], **patch}
            with self.subTest(patch=patch), self.assertRaisesRegex(ERRORS, error):
                self.assemble(corrections=[entry])
        with self.assertRaisesRegex(ERRORS, "duplicate_correction_target"):
            self.assemble(corrections=self.corrections * 2)

    def test_correction_cannot_replace_an_existing_original_target(self):
        lexical = copy.deepcopy(self.lexical)
        lexical[0]["senses"][0]["definitionEn"] = "Already-authored original meaning."
        with self.assertRaisesRegex(ERRORS, "correction_original_target_not_exactly_empty"):
            self.assemble(lexical_rows=lexical)

    def test_shared_phrase_patch_is_bound_to_original_raw_sense_and_compiles_without_model(self):
        rows, counts = self.assemble(corrections=[], phrase_rows=[self.phrase_patch()])
        self.assertEqual(counts["sharedPhraseEnglishFields"], 1)
        self.assertEqual(counts["nativeEnglishAuthoredFields"], 0)
        self.assertTrue(C.compile_rows(rows, self.lexical, [], self.source, 3, False, "word-source-languages")[2])
        metadata = next(row for row in rows if row["normalizedLemma"] == "rain")["senses"][0]["contentMetadata"]
        self.assertEqual(set(metadata), {"definitionEn"})
        self.assertNotIn("model", metadata["definitionEn"])

    def test_shared_phrase_rejects_wrong_same_word_sense_source_hash_and_language(self):
        for field, value in [("id", "window-zh"), ("sourceText", "雨；降雨")]:
            phrase = self.phrase_patch()
            phrase["senses"][0][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ERRORS, "assembly_phrase_source_identity"):
                self.assemble(corrections=[], phrase_rows=[phrase])
        for field, value in [("sourceTextSha256", C.digest("雨；降雨")), ("sourceLanguage", "en"), ("sourceSenseId", "foreign-sense")]:
            phrase = self.phrase_patch()
            phrase["senses"][0]["contentMetadata"]["definitionEn"][field] = value
            with self.subTest(metadata=field), self.assertRaises(ERRORS):
                self.assemble(corrections=[], phrase_rows=[phrase])
        phrase = self.phrase_patch()
        phrase["senses"][0]["sourceTextSha256"] = "b" * 64
        with self.assertRaisesRegex(ERRORS, "assembly_phrase_source_hash"):
            self.assemble(corrections=[], phrase_rows=[phrase])
        phrase = self.phrase_patch()
        phrase["sourceWordId"] = "foreign-word"
        with self.assertRaisesRegex(ERRORS, "assembly_phrase_word_identity"):
            self.assemble(corrections=[], phrase_rows=[phrase])

    def test_shared_phrase_preserves_nonempty_native_fields_and_rejects_duplicate_patches(self):
        for existing in ["Existing administrator definition.", " "]:
            lexical = copy.deepcopy(self.lexical)
            lexical[0]["senses"][0]["definitionEn"] = existing
            rows, counts = self.assemble(lexical_rows=lexical, corrections=[], phrase_rows=[self.phrase_patch()])
            self.assertEqual(next(row for row in rows if row["normalizedLemma"] == "rain")["senses"], [])
            self.assertEqual(counts["sharedPhraseEnglishFields"], 0)
        with self.assertRaisesRegex(ERRORS, "assembly_duplicate_phrase_patch"):
            self.assemble(corrections=[], phrase_rows=[self.phrase_patch(), self.phrase_patch()])
        with self.assertRaisesRegex(ERRORS, "assembly_duplicate_phrase_patch"):
            self.assemble(phrase_rows=[self.phrase_patch()])

    def test_cli_output_cannot_overwrite_the_implicit_phrase_manifest(self):
        implicit_manifest = Path(ASSEMBLER.__file__).resolve().parents[1] / "data/phrase-books.manifest.json"
        with tempfile.TemporaryDirectory(prefix="nightstudy-assembly-fixture-") as directory:
            root = Path(directory)
            authored = root / "authored"
            authored.mkdir()
            (authored / "authored-00.jsonl").write_text("{}\n", encoding="utf-8")
            args = argparse.Namespace(lexical=root/"lexical.jsonl", corpus_candidates=root/"corpus.jsonl", authored_directory=authored, corrections=root/"corrections.json", phrase_pack=root/"phrase.jsonl.gz", source_manifest=root/"source.json", warnings=root/"warnings.json", output=implicit_manifest)
            with patch.object(ASSEMBLER.argparse.ArgumentParser, "parse_args", return_value=args), \
                 patch.object(C, "read_jsonl", side_effect=AssertionError("Output guard must precede source reads")), \
                 patch.object(C, "atomic_write", side_effect=AssertionError("Must never write any real manifest")), \
                 self.assertRaisesRegex(ERRORS, "assembly_output_must_not_replace_source"):
                ASSEMBLER.main()


if __name__ == "__main__":
    unittest.main()
