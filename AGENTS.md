# NightStudy engineering guide

Build the product described in docs/architecture/ARCHITECTURE.md. The user has authorized implementation and publication in the public GitHub repository. Keep the original deployment extraction and local runtime data outside this new repository.

The approved mobile-first redesign uses pale cyan study backgrounds, light content surfaces and three primary destinations (learning, content, account). Preserve rain-night, warm black and amber as the optional night theme. Use newly authored code, original demo content and separately licensed, pinned external content packs with provenance and checksums. Do not copy the original compiled bundle, unidentified wallpaper, unlicensed commercial dictionary text, or proprietary audio into this repository.

The API uses Fastify/TypeScript, Prisma 7, PostgreSQL and Better Auth. Site context selects a fixed, isolated database/auth realm. Never fall back to an in-memory production store when PostgreSQL is unavailable. Only authenticated server context determines site/user/role; request fields cannot choose another database or account.

Use one canonical word learning identity within a site. Stable session item IDs connect the visible word and accepted command. Server-side FSRS, revision checks and durable idempotency protect progress. Known-word claims and diagnostic tests are separate from actual review history. Private memory charts distinguish predictions, observed feedback, and insufficient evidence.

Root owns dependency manifests, generated schema/migrations and lockfile during parallel work. Run typecheck/build and meaningful PostgreSQL integration checks before publishing code. Document exactly what is implemented, tested, and deferred; do not describe planned deployment or performance as verified.

Secrets belong in environment/local ignored files. GitHub/CI contributions must not expose real accounts, database backups, tokens, or raw server configuration. Do not create paid hosted resources unless explicitly requested.
