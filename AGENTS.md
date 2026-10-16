# NightStudy engineering guide

## Latest user direction, 2026-10-16

Treat the product as a mobile H5 application, with desktop secondary. The home layout must follow the user's BBDC reference recording: full-screen wallpaper, avatar at the upper left, a separate check-in tile above center, paired Learn / Review actions near the bottom, and three bottom function icons. Learning, content and account/settings modules open as distinct application screens. Do not use a website header, marketing hero, long home bookshelf or dashboard as the primary home.

Read `docs/H5_APP_REDESIGN.md` before the next redesign work. It supersedes the earlier 0.7 layout proposal where they differ. The user explicitly approved full implementation on 2026-10-16 after reviewing this design. The H5 experience is implemented and published as 0.8.0-alpha.1; see the actual validation and deployment record in that document. Future major redesigns still need reviewable design before a new implementation instruction.

The user allows all incompatible changes to the product, routes, APIs, database structures and learning flows. Do not maintain old data formats, old APIs or old-client compatibility layers. This permission does not itself request clearing production data or exposing secrets. Keep the actual approved work verifiable.

These are persistent project preferences. Keep the original deployment extraction and local runtime data outside this repository. Prefer the mounted, writable `/Volumes/XXX/Codex` for freely placeable outputs, cache and large temporary files.

Use pale cyan study backgrounds and light content surfaces, with rain-night available as an optional atmosphere. The learning interface must stay focused on English; do not display code, licensing, supplier protocols or fallback infrastructure in normal learning flows. Use newly authored code, original content and separately licensed, pinned external content packs with provenance and checksums. Do not copy the original compiled bundle, unidentified wallpaper, unlicensed commercial dictionary text, or proprietary audio into this repository.

The API uses Fastify/TypeScript, Prisma 7, PostgreSQL and Better Auth. Site context selects a fixed, isolated database/auth realm. Never fall back to an in-memory production store when PostgreSQL is unavailable. Only authenticated server context determines site/user/role; request fields cannot choose another database or account.

Use one canonical word learning identity within a site. Stable session item IDs connect the visible word and accepted command. Server-side FSRS, revision checks and durable idempotency protect progress. Known-word claims and diagnostic tests are separate from actual review history. Private memory charts distinguish predictions, observed feedback, and insufficient evidence.

Root owns dependency manifests, generated schema/migrations and lockfile during parallel work. Run typecheck/build and meaningful PostgreSQL integration checks before publishing code. Document exactly what is implemented, tested, and deferred; do not describe planned deployment or performance as verified.

Secrets belong in environment/local ignored files. GitHub/CI contributions must not expose real accounts, database backups, tokens, or raw server configuration. Do not create paid hosted resources unless explicitly requested.

## Content, audio and atmosphere direction, 2026-10-16

The user requested implementation of expanded open-source examination wordbooks, rain-night visuals, administrator DIY wallpaper and measured performance improvements. Confirmed examination targets: IELTS, TOEFL, CET4, CET6, TEM4 and TEM8; "8" means TEM8 and "专6" was a typo. Keep fact-based wordbook membership separate from dictionary expressions and their respective licenses.

The latest audio instruction explicitly allows Codex to generate missing-word audio and sentence audio locally, validate it and package it before release. Prefer existing, correctly attributed human recordings for words. This supersedes the earlier prohibition on all synthesized gap filling. Runtime must only play published files: no server synthesis endpoints, browser speech fallback, automatic voice-model downloads or cross-accent substitutions. Failed/missing artifacts remain unavailable. Preserve per-asset voice/accent/type/license/source/checksum evidence outside the ordinary learning UI.

Use the existing H5 shell. Rain-night movement must be inexpensive and stop for background, covering screens, reduced motion and data-saving. Administrator wallpaper upload is site-scoped, validated and re-encoded; do not accept arbitrary remote URLs. Optimize demonstrated bottlenecks without rewriting FSRS or changing the stack just for a label.

## Completed content and polish release, 2026-10-16

The user selected public corpora plus Codex batch authorship only: no paid AI content calls or downloaded translation/language models for this work. Release `0.10.0-alpha.3`, source `8cdb7fd31a39d7424fbd181d857466bf764cad9a`, is published and running on Native and the VPS. Main and release CI, complete Compose cold installation with original-content baseline, 47-table increment/replay checks, both 43-request public HTTP checks and anonymous mobile pages passed. See `docs/CONTENT_BILINGUAL_POLISH_010.md` for scope and actual evidence; `docs/DEPLOYMENT.md` contains the current immutable image and upgrade boundaries.

The completed scope is 18 built-in books, 18,767 active lemmas and 69,840 memberships; paired learning focus/primary definitions and POS, at least one bilingual usage per active word, and both accents for the 17,814 currently referenced unique sentences. This does not make every sense of the 770,611-word dictionary complete or expert-reviewed. Published content/audio pins remain immutable; alpha.3 reuses alpha.1 assets. Keep the simple mobile learning UI and original source/history protection. All task-specific rehearsal databases and exact temporary credential/dump files were cleaned; production backups and verification evidence remain private.
