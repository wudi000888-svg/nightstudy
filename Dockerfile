# syntax=docker/dockerfile:1
# Official multi-architecture image, checked 2026-10-14.
ARG NODE_IMAGE=node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION=11.25.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM base AS runtime
COPY scripts/audio-requirements.txt /tmp/audio-requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/nightstudy-audio \
    && /opt/nightstudy-audio/bin/pip install --no-cache-dir -r /tmp/audio-requirements.txt \
    && rm /tmp/audio-requirements.txt
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 AUDIO_PYTHON=/opt/nightstudy-audio/bin/python AUDIO_CACHE_DIR=/app/.local/audio
# The alpha image also serves the independent migration/seed/worker roles.
# Prisma CLI and tsx are retained for those roles; no secrets or runtime DBs are copied.
COPY --from=build --chown=node:node /app /app
RUN python3 scripts/install-audio-source.py
RUN mkdir -p /app/.local/content /app/.local/admin /app/.local/audio \
    && chmod 700 /app/.local/admin && chown -R node:node /app/.local
USER node
EXPOSE 3000
LABEL org.opencontainers.image.title="NightStudy" \
      org.opencontainers.image.source="https://github.com/wudi000888-svg/nightstudy" \
      org.opencontainers.image.licenses="MIT AND GPL-3.0-or-later"
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
  CMD node --input-type=module -e "const r=await fetch('http://127.0.0.1:'+process.env.PORT+'/health/ready',{signal:AbortSignal.timeout(3000)});process.exit(r.ok?0:1)"
CMD ["pnpm", "start"]
