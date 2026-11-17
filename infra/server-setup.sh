#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 server for MathPath (docs/guides/deploy.md,
# "Server preparation"), once, before the first infra/deploy.sh:
#
#   curl -fsSLO https://raw.githubusercontent.com/bssamandar/mathpath/main/infra/server-setup.sh
#   less server-setup.sh          # read it first
#   sudo bash server-setup.sh
#
# It installs updates, the firewall, Docker and cosign, clones the repository
# to /opt/mathpath and writes infra/.env.prod with freshly generated secrets,
# asking only for what it cannot generate (domain, Eskiz, Turnstile, backups).
# Running it again is safe: it keeps an existing .env.prod and checkout.
#
# It does not change the SSH settings, so it cannot lock you out; it only
# warns when password or root login is still allowed.
set -euo pipefail

REPO_URL=https://github.com/bssamandar/mathpath.git
APP_DIR=/opt/mathpath
# cosign checks the image signatures in deploy.sh. Pinned; the .deb is checked
# against the checksum file of the same release.
COSIGN_VERSION=2.4.1

log() { printf '\n== %s\n' "$*"; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "run with sudo"
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] || die "expected Ubuntu 24.04, found ${PRETTY_NAME:-unknown}"
[ "$(dpkg --print-architecture)" = amd64 ] || die "only amd64 servers are supported"
OWNER=${SUDO_USER:-}
[ -n "$OWNER" ] && [ "$OWNER" != root ] || die "run as your admin user with sudo, not as root directly"

# ── 1. Updates ───────────────────────────────────────────────
log "system updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl git gnupg openssl python3 ufw unattended-upgrades
dpkg-reconfigure -fnoninteractive unattended-upgrades

# ── 2. Firewall: SSH, HTTP and HTTPS only ───────────────────
log "firewall"
ufw default deny incoming
ufw default allow outgoing
# The port SSH really listens on, so the firewall cannot lock you out.
ssh_port=$(sshd -T 2> /dev/null | awk '$1 == "port" { print $2; exit }')
ufw allow "${ssh_port:-22}/tcp"
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

# ── 3. Docker Engine and Compose, from Docker's apt repository ──
if ! command -v docker > /dev/null; then
  log "Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
usermod -aG docker "$OWNER"

# ── 4. cosign ────────────────────────────────────────────────
if ! command -v cosign > /dev/null; then
  log "cosign $COSIGN_VERSION"
  tmp=$(mktemp -d)
  base=https://github.com/sigstore/cosign/releases/download/v$COSIGN_VERSION
  curl -fsSL -o "$tmp/cosign_${COSIGN_VERSION}_amd64.deb" "$base/cosign_${COSIGN_VERSION}_amd64.deb"
  curl -fsSL -o "$tmp/cosign_checksums.txt" "$base/cosign_checksums.txt"
  (cd "$tmp" && grep " cosign_${COSIGN_VERSION}_amd64.deb\$" cosign_checksums.txt | sha256sum -c -)
  dpkg -i "$tmp/cosign_${COSIGN_VERSION}_amd64.deb"
  rm -rf "$tmp"
fi

# ── 5. Code ──────────────────────────────────────────────────
if [ ! -d "$APP_DIR/.git" ]; then
  log "cloning to $APP_DIR"
  git clone --quiet "$REPO_URL" "$APP_DIR"
fi
chown -R "$OWNER:$OWNER" "$APP_DIR"

# ── 6. Settings: infra/.env.prod ─────────────────────────────
ENV_FILE=$APP_DIR/infra/.env.prod
secret() { openssl rand -hex 32; }
# set_env KEY VALUE: replaces the KEY= line in .env.prod. The value is put in
# single quotes, which both bash (deploy.sh) and docker compose read literally,
# so a password with $ or spaces survives; it must not contain a single quote.
set_env() {
  [[ $2 != *"'"* ]] || die "$1 must not contain a single quote (')"

  python3 - "$ENV_FILE" "$1" "$2" << 'PY'
import sys
path, key, value = sys.argv[1:]
lines = open(path).read().split('\n')
for i, line in enumerate(lines):
    if line.startswith(key + '='):
        lines[i] = f"{key}='{value}'"
        break
else:
    lines.append(f"{key}='{value}'")
open(path, 'w').write('\n'.join(lines))
PY
}
ask() { # ask VAR "question" [default]
  local answer
  read -r -p "$2${3:+ [$3]}: " answer
  printf -v "$1" '%s' "${answer:-${3:-}}"
}
ask_secret() {
  local answer
  read -r -s -p "$2: " answer
  echo
  printf -v "$1" '%s' "$answer"
}

if [ -f "$ENV_FILE" ]; then
  log "$ENV_FILE exists; keeping it"
else
  log "settings"
  echo "The site runs on DOMAIN, with www., studio. and media. in front of it."
  ask DOMAIN "Domain (for example mathpath.toom.uz)"
  [[ $DOMAIN =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "not a domain name: $DOMAIN"
  ask ACME_EMAIL "E-mail for certificate warnings (Let's Encrypt)"
  ask ESKIZ_EMAIL "Eskiz.uz login e-mail"
  ask_secret ESKIZ_PASSWORD "Eskiz.uz password"
  ask ESKIZ_SENDER "Eskiz sender name" 4546
  ask_secret TURNSTILE_SECRET_KEY "Cloudflare Turnstile secret key"
  ask BACKUP_MODE "Backups: s3 (off-site, for real users) or local (test server only)" local

  umask 077
  cp "$APP_DIR/infra/env.prod.example" "$ENV_FILE"
  for key in DOMAIN ACME_EMAIL ESKIZ_EMAIL ESKIZ_PASSWORD ESKIZ_SENDER TURNSTILE_SECRET_KEY BACKUP_MODE; do
    set_env "$key" "${!key}"
  done
  for key in POSTGRES_SUPERUSER_PASSWORD MATHPATH_MIGRATOR_PASSWORD MATHPATH_APP_PASSWORD \
    MATHPATH_MONITORING_PASSWORD AUTH_HMAC_SECRET S3_APP_SECRET_ACCESS_KEY \
    S3_ADMIN_SECRET_ACCESS_KEY MEDIA_KEY_SECRET BACKUP_CIPHER_PASS; do
    set_env "$key" "$(secret)"
  done
  set_env S3_APP_ACCESS_KEY_ID "mathpath-app-$(openssl rand -hex 6)"
  set_env S3_ADMIN_ACCESS_KEY_ID "mathpath-admin-$(openssl rand -hex 6)"
  # The JWT signing key on one line, with \n between lines.
  set_env JWT_PRIVATE_KEY "$(openssl genpkey -algorithm ed25519 | awk 'BEGIN { ORS = "\\n" } { print }')"
  set_env JWT_KEY_ID "k$(date -u +%Y%m%d)"
  # Payments stay closed until the merchant keys are added.
  set_env PAYMENT_PROVIDERS ""
  # Size the database for this server: about 25% and 75% of RAM.
  ram_mb=$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)
  set_env PG_SHARED_BUFFERS "$((ram_mb / 4))MB"
  set_env PG_EFFECTIVE_CACHE_SIZE "$((ram_mb * 3 / 4))MB"
  umask 022
  chown "$OWNER:$OWNER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  if [ "$BACKUP_MODE" = s3 ]; then
    echo "Fill in BACKUP_S3_* in $ENV_FILE before deploying (docs/guides/backups.md)."
  fi
fi

# ── 7. Checks that need you ─────────────────────────────────
log "checks"
sshd_config=$(sshd -T 2> /dev/null || true)
grep -q '^passwordauthentication yes' <<< "$sshd_config" &&
  echo "WARNING: SSH still accepts passwords. After your key works, set PasswordAuthentication no."
grep -q '^permitrootlogin yes' <<< "$sshd_config" &&
  echo "WARNING: SSH allows root login. Set PermitRootLogin no."

domain=$(grep '^DOMAIN=' "$ENV_FILE" | cut -d= -f2- | tr -d "'")
ip=$(curl -fsS4 --max-time 5 https://api.ipify.org || echo "<server IP>")
cat << NEXT

Done. Next:

1. DNS: point these four names at $ip (A records), before the first deploy:
     $domain   www.$domain   studio.$domain   media.$domain
   A wildcard like *.example.uz covers one level only, so add them by name
   (or add $domain and *.$domain).
2. Copy these two lines from $ENV_FILE into your password manager; without
   them videos and backups cannot be read:
     MEDIA_KEY_SECRET, BACKUP_CIPHER_PASS
3. Log out and in again (so '$OWNER' can use docker), then, once a release
   exists and its images are public on GitHub (or after 'docker login ghcr.io'):
     cd $APP_DIR && infra/deploy.sh v0.1.0
4. Grant yourself the admin role and enrol 2FA: docs/guides/launch-checklist.md, section 8.
NEXT
