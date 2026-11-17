#!/usr/bin/env bash
# Starts the built API, web and studio for the browser and load tests, against
# the Postgres, Redis and S3 given in the environment (CI: .github/workflows/e2e.yml).
# Run `pnpm build` first. Logs go to $E2E_LOG_DIR; the tests read SMS codes
# from api.log.
#
# Build web and studio with API_ORIGIN=http://127.0.0.1:4000: Next.js fixes
# the /api rewrite at build time, and production builds have none without it.
#
#   DATABASE_URL=... REDIS_URL=... S3_ENDPOINT=... tests/e2e/start-stack.sh
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LOG_DIR=${E2E_LOG_DIR:-/tmp/mathpath-e2e}
mkdir -p "$LOG_DIR"

: "${DATABASE_URL:?}" "${REDIS_URL:?}" "${S3_ENDPOINT:?}"

# Test-only settings: SMS codes go to the log, the CAPTCHA accepts "dev-pass",
# and no breached-password lookups leave the machine.
export NODE_ENV=development
export SMS_PROVIDER=log CAPTCHA_PROVIDER=dev BREACHED_PASSWORD_CHECK=off
# The real business rules, with the OTP limits loosened: every test runs from
# one IP and one browser, and a parent asks for a second code seconds after
# signing up. The limits themselves are covered by the API's unit tests.
rm -rf "$LOG_DIR/config" && cp -r "$ROOT/config" "$LOG_DIR/config"
sed -i -E 's/^(  resendAfterSeconds:) [0-9]+/\1 1/' "$LOG_DIR/config/auth.yaml"
sed -i -E -e 's/^(  perIpPrefix: \{ limit:) [0-9]+/\1 1000/' \
  -e 's/^(  perDevice: \{ limit:) [0-9]+/\1 1000/' "$LOG_DIR/config/risk.yaml"
grep -q 'resendAfterSeconds: 1$' "$LOG_DIR/config/auth.yaml"
grep -q 'perIpPrefix: { limit: 1000' "$LOG_DIR/config/risk.yaml"
export CONFIG_DIR="$LOG_DIR/config"
export PORT=4000 METRICS_PORT=0 LOG_LEVEL=info
export CORS_ORIGINS=http://localhost:3000,http://localhost:3001
export MEDIA_BROWSER_ORIGINS=http://localhost:3000,http://localhost:3001
export S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID:-mathpath}
export S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY:-mathpath_local_only}
export MEDIA_KEY_SECRET=${MEDIA_KEY_SECRET:-e2e-media-key-secret-0123456789abcdef}
# A throw-away signing key for this run unless one is given.
if [ -z "${JWT_PRIVATE_KEY:-}" ]; then
  JWT_PRIVATE_KEY=$(openssl genpkey -algorithm ed25519)
  export JWT_PRIVATE_KEY JWT_KEY_ID=e2e
fi
export AUTH_HMAC_SECRET=${AUTH_HMAC_SECRET:-e2e-hmac-secret-0123456789abcdef0123456}

pnpm --dir "$ROOT" --filter @mathpath/db migrate latest
pnpm --dir "$ROOT" --filter @mathpath/db migrate seed

# Each server runs detached with every output in its log, so nothing holds
# this script's stdout open after it exits (a CI step would wait for it).
(cd "$ROOT/apps/api" && exec node dist/main.js) > "$LOG_DIR/api.log" 2>&1 < /dev/null &
for app in web:3000 studio:3001; do
  name=${app%%:*}
  port=${app##*:}
  (cd "$ROOT/apps/$name" && API_ORIGIN=http://127.0.0.1:4000 MEDIA_ORIGIN="$S3_ENDPOINT" \
    NODE_ENV=production exec npx next start -p "$port") > "$LOG_DIR/$name.log" 2>&1 < /dev/null &
done

wait_for() {
  for _ in $(seq 1 60); do
    curl -fs -o /dev/null "$1" && return 0
    sleep 1
  done
  echo "$1 did not start; see $LOG_DIR" >&2
  tail -n 50 "$LOG_DIR"/*.log >&2
  return 1
}
wait_for http://127.0.0.1:4000/api/v1/health/ready
wait_for http://127.0.0.1:3000/login
wait_for http://127.0.0.1:3001/login
echo "stack is up; logs in $LOG_DIR"
