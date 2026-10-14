#!/usr/bin/env bash
set -euo pipefail
umask 077
TASK_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$TASK_ROOT"
TASK_PORT=${NIGHTSTUDY_HTTP_PORT:-5198}
TASK_PROJECT=${COMPOSE_PROJECT_NAME:-nightstudy}
if [[ ! "$TASK_PORT" =~ ^[0-9]{1,5}$ ]] || (( 10#$TASK_PORT < 1 || 10#$TASK_PORT > 65535 )); then
  echo 'NIGHTSTUDY_HTTP_PORT must be a valid port.' >&2; exit 1
fi
if [[ ! "$TASK_PROJECT" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
  echo 'COMPOSE_PROJECT_NAME must be a valid project name.' >&2; exit 1
fi
TASK_URL=${PUBLIC_URL:-http://127.0.0.1:$TASK_PORT}
if [[ "$TASK_URL" == *$'\n'* || "$TASK_URL" == *$'\r'* ]]; then
  echo 'PUBLIC_URL must be a single HTTP(S) URL.' >&2; exit 1
fi
if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  for TASK_KEY in POSTGRES_PASSWORD BETTER_AUTH_SECRET BOOTSTRAP_TOKEN; do
    TASK_SECRET=$(openssl rand -hex 32)
    sed -i.task-backup "s/^${TASK_KEY}=$/${TASK_KEY}=${TASK_SECRET}/" .env
    rm -f .env.task-backup
  done
  # A custom URL is written without shell evaluation; application validation is authoritative.
  sed -i.task-backup '/^PUBLIC_URL=/d' .env
  rm -f .env.task-backup
  sed -i.task-backup '/^NIGHTSTUDY_HTTP_PORT=/d; /^COMPOSE_PROJECT_NAME=/d' .env
  rm -f .env.task-backup
  printf 'PUBLIC_URL=%s\n' "$TASK_URL" >> .env
  printf 'NIGHTSTUDY_HTTP_PORT=%s\nCOMPOSE_PROJECT_NAME=%s\n' "$TASK_PORT" "$TASK_PROJECT" >> .env
fi
mkdir -p .local/sites .local/admin
chmod 700 .local/admin
docker compose config --quiet
docker compose up --build --detach --wait --wait-timeout 600 app
TASK_TEMP=$(mktemp .local/admin/credentials.XXXXXX)
trap 'rm -f "$TASK_TEMP"' EXIT
docker compose run --rm --no-deps --entrypoint node init scripts/export-admin-credentials.mjs > "$TASK_TEMP"
chmod 600 "$TASK_TEMP"
mv "$TASK_TEMP" .local/admin/credentials.json
trap - EXIT
printf 'Installation ready. Private initial administrator credentials: %s/.local/admin/credentials.json\n' "$TASK_ROOT"
