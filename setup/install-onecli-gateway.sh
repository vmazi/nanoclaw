#!/usr/bin/env bash
# Setup helper: install-onecli-gateway — brings up the OneCLI compose stack
# without the upstream installer's `docker compose up -d --wait` step.
#
# `podman-compose` (≤1.5.0) doesn't recognize `--wait` and aborts, which
# breaks the upstream `curl onecli.sh/install | sh` flow on systems where
# `docker` is a wrapper around podman. This script bypasses that path: it
# fetches the compose file via the upstream installer (whose final
# `up -d --wait` failure is ignored — the side effect we want is the file
# write), then runs `up -d` ourselves and polls /api/health to substitute
# for `--wait` semantics.
#
# Reads ONECLI_BIND_HOST, POSTGRES_PORT, ONECLI_VERSION from the nanoclaw
# .env (path passed as $1, defaults to ./.env) so the compose stack binds
# to the same ports the rest of setup expects.
set -euo pipefail

echo "=== NANOCLAW SETUP: INSTALL_ONECLI_GATEWAY ==="

ENV_FILE="${1:-.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

: "${ONECLI_BIND_HOST:=127.0.0.1}"
: "${POSTGRES_PORT:=6432}"
: "${ONECLI_APP_PORT:=10254}"
: "${ONECLI_VERSION:=1.24.0}"
export ONECLI_BIND_HOST POSTGRES_PORT ONECLI_APP_PORT ONECLI_VERSION

ONECLI_DIR="${ONECLI_DIR:-$HOME/.onecli}"
COMPOSE_FILE="$ONECLI_DIR/docker-compose.yml"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "STEP: fetch-compose-file"
  mkdir -p "$ONECLI_DIR"
  # Run upstream installer for the compose-file side effect. Its final
  # `up -d --wait` may fail on podman-compose — we don't care, we run our
  # own `up` below.
  curl -fsSL onecli.sh/install | sh || true
  if [ ! -f "$COMPOSE_FILE" ]; then
    echo "STATUS: failed"
    echo "ERROR: upstream installer did not write $COMPOSE_FILE"
    echo "=== END ==="
    exit 1
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "STATUS: failed"
  echo "ERROR: docker (or docker-podman shim) not on PATH"
  echo "=== END ==="
  exit 1
fi

echo "STEP: compose-up"
docker compose -p onecli -f "$COMPOSE_FILE" up -d

URL="http://${ONECLI_BIND_HOST}:${ONECLI_APP_PORT}"
echo "STEP: poll-health url=$URL"
deadline=$(( $(date +%s) + 60 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if curl -fsS -m 2 "$URL/api/health" >/dev/null 2>&1; then
    echo "STATUS: ready"
    echo "ONECLI_URL: $URL"
    echo "=== END ==="
    exit 0
  fi
  sleep 1
done

# Health poll timeout isn't fatal — the gateway is sometimes auth-gated
# and `/api/health` returns non-2xx even though the listener is up. Echo
# the URL so the caller can decide; the next step (`onecli secrets list`)
# will surface a real outage.
echo "STATUS: started-unhealthy"
echo "ONECLI_URL: $URL"
echo "NOTE: health poll did not return ok within 60s — proceeding anyway"
echo "=== END ==="
exit 0
