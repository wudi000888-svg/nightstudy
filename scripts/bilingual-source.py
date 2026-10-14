#!/usr/bin/env python3
"""Select attributed, exact-lemma Tatoeba examples; never invent translations.

This tool reads a checksum-pinned source export and a JSON array of lemmas. It
does not write to a database, pair dictionary senses, or call a translation API.
The selected sentences remain word-level, unreviewed usage candidates.
"""

from __future__ import annotations

import argparse
import bz2
import hashlib
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TOKENS = re.compile(r"[^\W\d_]+(?:['’-][^\W\d_]+)*", re.UNICODE)
# A conservative filter, not a claim of professional content moderation.
BLOCKED = re.compile(
    r"\b(?:fuck\w*|shit\w*|porn\w*|penis|vagina|masturbat\w*|"
    r"rape\w*|rapist\w*|nigger\w*|faggot\w*|nazi\w*|hitler|"
    r"trump|putin|biden|stalin|murder\w*|suicid\w*|kill\w*|"
    r"bomb\w*|terroris\w*|cocaine|heroin|whore\w*|slut\w*)\b",
    re.IGNORECASE,
)
META = re.compile(
    r"\b(?:is (?:an? |the )?(?:word|noun|verb|adjective|adverb)|"
    r"word means|how (?:do|can) you (?:say|spell)|"
    r"translate (?:this|the)|this sentence|the sentence|"
    r"pronounc\w*|spelling of|meaning of)\b",
    re.IGNORECASE,
)
NAMES = {"tom", "mary", "john", "jack", "jane", "alice", "bob", "boston"}


def normalize(value: str) -> str:
    return unicodedata.normalize("NFKC", value).replace("’", "'").strip().lower()


def file_digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_source(path: Path, source: dict) -> None:
    if path.stat().st_size != source["bytes"]:
        raise ValueError("Source byte count does not match the pinned snapshot")
    if file_digest(path) != source["sha256"]:
        raise ValueError("Source SHA256 does not match the pinned snapshot")


def score(text: str, tokens: list[str], sentence_id: int) -> tuple:
    # Prefer ordinary, short context. Stable ties use the source sentence ID.
    names = sum(t in NAMES for t in tokens)
    quotes = text.count('"') + text.count("“") + text.count("”")
    return (names, quotes, abs(len(tokens) - 9), len(text), sentence_id)


def select(args: argparse.Namespace) -> dict:
    manifest = json.loads(args.source_manifest.read_text(encoding="utf-8"))
    source = manifest["datasets"]["tatoebaEnglish"]
    verify_source(args.sentences_file, source)
    values = json.loads(args.lemmas_file.read_text(encoding="utf-8"))
    if not isinstance(values, list) or not all(isinstance(v, str) for v in values):
        raise ValueError("--lemmas-file must be a JSON array of canonical lemmas")
    lemmas = sorted({normalize(v) for v in values if normalize(v)})
    if len(lemmas) != len(values):
        raise ValueError("Canonical lemmas must be nonempty and unique")
    simple = {v for v in lemmas if TOKENS.fullmatch(v)}
    complex_by_first: dict[str, list[tuple[str, re.Pattern]]] = {}
    for lemma in set(lemmas) - simple:
        first = TOKENS.search(lemma)
        if first:
            complex_by_first.setdefault(first.group(0), []).append(
                (lemma, re.compile(r"(?<!\w)" + re.escape(lemma) + r"(?!\w)"))
            )
    best: dict[str, tuple[tuple, dict]] = {}
    counts: Counter = Counter()
    # Reading the entire bz2 stream also verifies its checksum/trailer.
    with bz2.open(args.sentences_file, "rt", encoding="utf-8", errors="strict") as stream:
        for line in stream:
            counts["sourceRows"] += 1
            fields = line.rstrip("\n").split("\t")
            if len(fields) != 6 or fields[1] != "eng" or not fields[0].isdigit():
                counts["invalidRows"] += 1
                continue
            sentence_id = int(fields[0])
            text, author = fields[2], fields[3]
            if not author or author == r"\N":
                counts["unattributedExcluded"] += 1
                continue
            normalized_text = normalize(text)
            tokens = TOKENS.findall(normalized_text)
            if not (5 <= len(tokens) <= 18 and 20 <= len(text) <= 180):
                counts["lengthExcluded"] += 1
                continue
            if (
                not text.endswith((".", "!"))
                or "http" in normalized_text
                or "@" in text
                or "\ufffd" in text
                or any(ord(c) < 32 for c in text)
                or BLOCKED.search(text)
                or META.search(text)
                or len(set(tokens)) < 3
            ):
                counts["qualityFilterExcluded"] += 1
                continue
            token_set = set(tokens)
            matches = token_set & simple
            for token in token_set & complex_by_first.keys():
                for lemma, pattern in complex_by_first[token]:
                    if pattern.search(normalized_text):
                        matches.add(lemma)
            if not matches:
                continue
            counts["usableSourceRows"] += 1
            rank = score(text, tokens, sentence_id)
            example = {
                "exampleEn": text,
                "exampleZh": "",
                "provenance": {
                    "kind": "corpus",
                    "sourceName": "Tatoeba",
                    "sentenceId": sentence_id,
                    "author": author,
                    "sourceUrl": f"https://tatoeba.org/en/sentences/show/{sentence_id}",
                    "license": "CC-BY-2.0-FR",
                    "licenseUrl": "https://creativecommons.org/licenses/by/2.0/fr/",
                    "snapshot": source["snapshot"],
                    "sourceSha256": source["sha256"],
                    "sourceLanguage": "eng",
                    "dateAdded": fields[4],
                    "dateModified": fields[5],
                    "matchKind": "exact-lemma",
                    "senseAlignment": "word-level-unverified",
                    "englishModified": False,
                    "translationStatus": "missing",
                    "reviewStatus": "pending-review",
                },
            }
            for lemma in matches:
                if lemma not in best or rank < best[lemma][0]:
                    best[lemma] = (rank, example)
    words = [
        {"normalizedLemma": lemma, "examples": [best[lemma][1]] if lemma in best else []}
        for lemma in lemmas
    ]
    stats = {
        **dict(counts),
        "targetWordCount": len(lemmas),
        "exactCoveredWordCount": len(best),
        "missingWordCount": len(lemmas) - len(best),
        "uniqueSelectedSentenceCount": len({v[1]["provenance"]["sentenceId"] for v in best.values()}),
        "bilingualPairCount": 0,
        "inflectionMatchesUsed": 0,
        "professionalReviewCompleted": False,
    }
    args.output.mkdir(parents=True, exist_ok=True)
    result = {
        "version": "bilingual-candidates-v1",
        "sourceSnapshot": source["snapshot"],
        "sourceSha256": source["sha256"],
        "selection": {
            "wordCountMin": 5,
            "wordCountMax": 18,
            "matching": "exact normalized lemma; no inflection substitution",
            "senseAlignment": "unverified word-level usage",
            "quality": "heuristic filtered; pending human review",
        },
        "stats": stats,
        "words": words,
    }
    (args.output / "candidates.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    with (args.output / "candidates.jsonl").open("w", encoding="utf-8") as stream:
        for word in words:
            stream.write(json.dumps(word, ensure_ascii=False, separators=(",", ":")) + "\n")
    (args.output / "missing-lemmas.json").write_text(
        json.dumps([w["normalizedLemma"] for w in words if not w["examples"]], ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (args.output / "selection-stats.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lemmas-file", type=Path, required=True)
    parser.add_argument("--sentences-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-manifest", type=Path, default=ROOT / "data/bilingual-source.manifest.json")
    args = parser.parse_args()
    print(json.dumps(select(args), ensure_ascii=False))


if __name__ == "__main__":
    main()
