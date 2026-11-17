#!/usr/bin/env bash
# shellcheck disable=SC2154 # settings come from the env files it sources
# Deploys a release to this server (docs/guides/deploy.md).
#
#   infra/deploy.sh v0.2.0              deploy a release
#   infra/deploy.sh v0.1.9 --rollback   go back to an older release (skips migrations)
#
# Steps: check out the release tag, fetch its image digests, verify the image
# signatures, start the data services, migrate, apply grants, provision
# storage, start the apps and wait until they are healthy. Any failure stops
# the script before the next step; the running apps keep running until the
# new images are healthy enough to replace them.
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

REPO=${MATHPATH_REPO:-bssamandar/mathpath}

# Everything is inside main(), which bash reads in full before running it:
# step 2 checks out another version of this very file.
main() {
  version=${1:-}
  mode=${2:-}
  [[ $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] ||
    die "usage: deploy.sh vX.Y.Z [--rollback]"
  [ -z "$mode" ] || [ "$mode" = --rollback ] || die "unknown option: $mode"

  # ── 1. Settings file ─────────────────────────────────────────
  [ -f "$ENV_FILE" ] || die "$ENV_FILE is missing: copy infra/env.prod.example and fill it in"
  [ "$(stat -c %a "$ENV_FILE")" = 600 ] || die "$ENV_FILE must be readable by its owner only: chmod 600 $ENV_FILE"
  command -v cosign > /dev/null || die "cosign is not installed (docs/guides/deploy.md, server preparation)"

  # ── 2. Code and image digests of the release ────────────────
  cd "$INFRA_DIR/.."
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "the checkout has local changes; commit or discard them first"
  git fetch --quiet --tags origin
  git -c advice.detachedHead=false checkout --quiet "refs/tags/$version"
  curl -fsSL --proto '=https' -o "$RELEASE_FILE.new" \
    "https://github.com/$REPO/releases/download/$version/release.env"
  grep -Eq '^IMAGE_API=ghcr\.io/.+@sha256:[0-9a-f]{64}$' "$RELEASE_FILE.new" ||
    die "release.env of $version does not look right"
  mv -f "$RELEASE_FILE.new" "$RELEASE_FILE"
  log "release $version"

  # ── 3. Signatures: only images built by this repository's release workflow ──
  # shellcheck disable=SC1090
  set -a && source "$RELEASE_FILE" && set +a
  for image in "$IMAGE_API" "$IMAGE_WORKER" "$IMAGE_WEB" "$IMAGE_STUDIO" "$IMAGE_PROXY" "$IMAGE_POSTGRES"; do
    cosign verify --output text \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      --certificate-identity-regexp "^https://github.com/$REPO/\\.github/workflows/release\\.yml@refs/tags/v" \
      "$image" > /dev/null || die "signature check failed for $image"
  done
  log "image signatures verified"

  # ── 4. Storage credentials file for SeaweedFS (from .env.prod) ──
  # shellcheck disable=SC1090
  set -a && source "$ENV_FILE" && set +a
  bucket=${S3_BUCKET:-mathpath-media}
  umask 077
  cat > "$INFRA_DIR/seaweedfs/s3.prod.json" <<JSON
  {
    "identities": [
      {
        "name": "mathpath-app",
        "credentials": [{ "accessKey": "$S3_APP_ACCESS_KEY_ID", "secretKey": "$S3_APP_SECRET_ACCESS_KEY" }],
        "actions": ["Read:$bucket", "Write:$bucket", "List:$bucket", "Tagging:$bucket"]
      },
      {
        "name": "mathpath-admin",
        "credentials": [{ "accessKey": "$S3_ADMIN_ACCESS_KEY_ID", "secretKey": "$S3_ADMIN_SECRET_ACCESS_KEY" }],
        "actions": ["Admin", "Read", "Write", "List", "Tagging"]
      }
    ]
  }
JSON
  # SeaweedFS runs as root in its container and reads the file read-only.
  umask 022

  # ── 5. Data services, migrations, grants, storage ────────────
  compose pull --quiet
  compose up -d --wait postgres redis seaweedfs
  compose exec -T -u postgres postgres pgbackrest stanza-create
  if [ "$mode" = --rollback ]; then
    log "rollback: migrations are skipped (they only move forward)"
  else
    compose run --rm migrate
  fi
  compose exec -T postgres psql -U postgres -d mathpath -v ON_ERROR_STOP=1 -q \
    -f /usr/local/share/mathpath/grants.sql
  compose run --rm provision-storage

  # ── 6. Applications ──────────────────────────────────────────
  compose up -d --wait --remove-orphans api worker web studio proxy
  curl -fsS --retry 10 --retry-delay 3 --retry-all-errors -o /dev/null "https://$DOMAIN/api/v1/health" ||
    die "https://$DOMAIN/api/v1/health does not answer"
  log "deployed $version"
}

main "$@"
