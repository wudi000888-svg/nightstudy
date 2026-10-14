# TranslateGemma model notice

Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms.

TranslateGemma is governed by the custom Gemma Terms of Use, identified in this project as `LicenseRef-Gemma`. It is not licensed under Apache-2.0 or MIT. The separate Apache-2.0 terms for Gemma 4 do not apply to this Gemma 3 based TranslateGemma candidate.

This repository stores public license text, model metadata, runtime configuration and provenance evidence. It does not distribute TranslateGemma model weights or serve the model to users. Any local translation run must comply with the Gemma Terms and Prohibited Use Policy. Adding this evidence does not assert that an account accepted the access-gated Hugging Face agreement or that inference quality has been approved.

The candidate is `mlx-community/translategemma-4b-it-4bit` at revision `5788ec08c047f3f2e17808101b8d9566ac930d58`, converted from `google/translategemma-4b-it`. The converted model card identifies mlx-lm 0.29.1 as the conversion tool. NightStudy's candidate runtime is mlx-lm 0.31.3; these are different version facts. The public upstream metadata was captured at revision `10042cb0e6e7fdce748996a71dc3dc432a4e0c89`.

Gemma Terms section 1.1(e) distinguishes generated outputs from model derivatives. Section 3.3 says Google does not claim rights in generated outputs. This does not establish ownership of source dictionary material, waive its licenses or certify a translation as accurate. Dictionary and corpus attribution must remain attached to their respective fields. Machine translations remain marked as pending review unless a separate review process establishes otherwise.

Model redistribution has additional obligations under section 3.1, including passing along the terms and use restrictions, identifying modifications and providing the required notice for distribution outside hosted services. Making model functionality available through an API or website also falls within the definition of distribution. The present plan publishes compiled lexical data after local generation and validation, without distributing model weights or offering model inference.

The reviewed terms do not list model-specific excluded countries. Applicable laws and the prohibited-use rules still apply; this is not a claim of unrestricted worldwide use.

`translategemma-evidence.json` records anonymous public source URLs, fixed model revisions, publisher LFS checksums and hashes of the saved evidence files. The stored MLX configuration is the conversion's configuration, which differs from the upstream base configuration. The unmodified chat template has the same Git blob identity in both pinned trees. The full tokenizer vocabulary is represented by publisher checksum metadata rather than a copy in this repository.

The anonymous raw upstream README returned HTTP 401. No access gate was accepted or bypassed. Its publicly rendered model card is preserved as HTML alongside the pinned public upstream API and tree metadata. The Gemma Terms and Prohibited Use Policy are preserved in full as text retrieved from their official Google pages through Jina Reader; the source and retrieval hashes are recorded in the evidence file.

Official sources:

- [Gemma Terms of Use](https://ai.google.dev/gemma/terms)
- [Gemma Prohibited Use Policy](https://ai.google.dev/gemma/prohibited_use_policy)
- [Google TranslateGemma model card](https://huggingface.co/google/translategemma-4b-it)
- [Pinned MLX conversion](https://huggingface.co/mlx-community/translategemma-4b-it-4bit/tree/5788ec08c047f3f2e17808101b8d9566ac930d58)
