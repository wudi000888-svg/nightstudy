# Qwen translation model evidence

The candidate content-build model is
`mlx-community/Qwen3-4B-Instruct-2507-4bit`, revision
`50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b`. Its conversion card identifies
`Qwen/Qwen3-4B-Instruct-2507`, by the Qwen Team, as the base model and states
that the model was converted with **mlx-lm 0.26.2**. Both model cards identify
**Apache License 2.0**. The upstream conversion card does not identify the
original base-model commit used for conversion.

The inspected base model card and its license are pinned separately to
`cdbee75f17c01a7cc42f958dc650907174af0554`. That revision is attribution and
license evidence; it is not presented as a proven conversion-input commit.
The files retained in this directory are unchanged copies from their pinned
upstream revisions. Their URLs and SHA256 values are recorded in
`../bilingual-source.manifest.json`.

The current build environment uses **mlx-lm 0.31.3**. This execution version is
distinct from the conversion version declared by the publisher. Model weights
are downloaded and verified in the offline content-build environment; they
are not distributed inside the application source or the compiled lexical
content pack. Selection for evaluation does not establish translation quality
or a successful benchmark.

The earlier Helsinki-NLP OPUS candidates are rejected for this pipeline after
a local diagnostic exposed material translation errors. Their cards and
licenses remain here as historical evidence. Rejected outputs are excluded
from published content.

Model licensing does not replace the licensing of translated source text.
Selected Tatoeba originals and Chinese translation adaptations retain
**CC-BY-2.0-FR**, their sentence authors, IDs and source URLs, with translation
changes identified. The separately authored NightStudy examples and application
code retain their own MIT notices.
