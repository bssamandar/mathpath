#!/usr/bin/env bash
# Shared helpers for the server scripts (deploy.sh, backup/*.sh). Sourced, not run.
set -euo pipefail

INFRA_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_FILE="$INFRA_DIR/.env.prod"
RELEASE_FILE="$INFRA_DIR/release.env"
# node-exporter's textfile directory (infra/monitoring/docker-compose.yml).
TEXTFILE_DIR=${TEXTFILE_DIR:-/var/lib/node-exporter}

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

# docker compose with the production files and both env files.
compose() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE is missing (template: infra/env.prod.example)"
  [ -f "$RELEASE_FILE" ] || die "$RELEASE_FILE is missing: run deploy.sh <version> first"
  docker compose --project-directory "$INFRA_DIR" \
    --env-file "$ENV_FILE" --env-file "$RELEASE_FILE" \
    -f "$INFRA_DIR/docker-compose.prod.yml" "$@"
}

# write_metrics <name> <<< "metric value" lines: replaces <name>.prom atomically,
# so node-exporter never reads a half-written file.
write_metrics() {
  local name=$1 tmp
  install -d -m 0755 "$TEXTFILE_DIR"
  tmp=$(mktemp "$TEXTFILE_DIR/.$name.XXXXXX")
  cat > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$TEXTFILE_DIR/$name.prom"
}
