# Deploying MathPath

How a release gets from a Git tag to the production server (architecture
§2, §7.8; security plan C-35, C-37, C-44). Backups and restores have their
own guide: [backups.md](backups.md). Monitoring: [monitoring.md](monitoring.md).

## The pieces

| Piece            | File                                              | What it does                                                                                                                                          |
| ---------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Images           | `infra/docker/*.Dockerfile`                       | api, worker, web, studio (one `next.Dockerfile`), proxy (Caddy + WAF), postgres (with pgBackRest). Base images pinned by digest                       |
| Release workflow | `.github/workflows/release.yml`                   | On a `v*` tag: build, scan with Trivy, push to GitHub Container Registry, sign with Sigstore, publish a release with `release.env`                    |
| Production stack | `infra/docker-compose.prod.yml`                   | All services on one server, three networks (edge, private without internet, backup). Only the proxy publishes ports                                   |
| Edge proxy       | `infra/proxy/Caddyfile`                           | TLS certificates, OWASP CRS WAF, per-IP flood limit, routes `/api` to the API, the studio and media hosts. Never routes metrics or `/health/ready`    |
| Deploy script    | `infra/deploy.sh`                                 | Checks out the tag, verifies image signatures, migrates, applies grants, provisions storage, starts the apps, checks health                           |
| Settings         | `infra/.env.prod` (from `env.prod.example`)       | Every secret and setting, on the server only, mode 600                                                                                                |
| Database roles   | `infra/postgres/initdb/10-roles.sh`, `grants.sql` | `mathpath_migrator` owns the schema; the apps use `mathpath_app`, which cannot change the schema or the audit log; `monitoring` reads statistics only |

### Decisions

| Decision                                                  | Alternative considered                        | Why                                                                                                                                                          |
| --------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Docker Compose on one server                              | Kubernetes                                    | One maintainer; ~5k concurrent users fit on one well-sized server (architecture §7.5). The images and env names do not change if we move to Kubernetes later |
| Caddy with the Coraza WAF plugin                          | nginx + ModSecurity + certbot                 | Automatic certificates and safe TLS defaults, the OWASP CRS compiled into the binary, one config file. The cost is a custom build, done in CI                |
| Images built in CI, deployed by digest, signed (Sigstore) | Building on the server                        | The server runs exactly the bytes CI scanned; a signature check stops images that did not come from this repository's release workflow (C-44)                |
| Manual `deploy.sh <tag>` on the server                    | Automatic deploy from GitHub Actions over SSH | No server credentials in GitHub, and a human chooses when production changes. Can be automated later behind a protected GitHub environment                   |
| Settings in a root-only `.env.prod` file                  | A secret manager (Vault)                      | Proportionate for one server and one maintainer; the file never leaves the server. Revisit when there is a second server or a second admin                   |
| SeaweedFS in the stack for media                          | The hosting provider's S3                     | Works on any provider in Uzbekistan. If the provider offers S3, remove the `seaweedfs` service and point `S3_*` at it                                        |
| No TLS between containers on the same host                | TLS for Postgres and Redis (C-31)             | Traffic never leaves the host's private Docker network. Turn TLS on when the database moves to its own server                                                |

## Server preparation (once)

Use Ubuntu 24.04 LTS in a data centre in Uzbekistan (the personal data law,
architecture §2). Start with 8 vCPU, 16 GB RAM and 200 GB SSD; video
transcoding is the main CPU user.

1. **SSH:** key-only login, no root login (`PermitRootLogin no`,
   `PasswordAuthentication no`). Keep an admin user with sudo.
2. **Firewall:** allow only 22 (from your own IPs if possible), 80 and 443:
   ```sh
   sudo ufw default deny incoming && sudo ufw allow 22/tcp && sudo ufw allow 80/tcp \
     && sudo ufw allow 443/tcp && sudo ufw allow 443/udp && sudo ufw enable
   ```
   Docker publishes only the proxy's ports; every other service is on private networks.
3. **Updates:** `sudo apt install unattended-upgrades` (security patches every night; C-37 asks for monthly at least).
4. **Docker Engine** with the Compose plugin, from Docker's own apt repository.
5. **cosign** (checks image signatures): install the `.deb` from the Sigstore
   releases page and check it with the published checksum.
6. **Code:** `sudo git clone https://github.com/bssamandar/mathpath.git /opt/mathpath`, owned by the admin user.
7. **DNS:** A (and AAAA, if the server has IPv6) records for `DOMAIN`,
   `www.DOMAIN`, `studio.DOMAIN` and `media.DOMAIN`, pointing at the server.
   Certificates are requested on the first start, so DNS must be ready first.
8. **Settings:**
   ```sh
   cd /opt/mathpath/infra && cp env.prod.example .env.prod && chmod 600 .env.prod
   ```
   Fill in every empty value. Passwords and secrets: `openssl rand -hex 32`, one
   per setting. The JWT key: `openssl genpkey -algorithm ed25519`, on one line
   with `\n` between lines. Store `MEDIA_KEY_SECRET` and `BACKUP_CIPHER_PASS`
   in a password manager as well: without them videos and backups cannot be
   read.
9. **Registry access:** packages pushed by the workflow start as private. Either
   make each package public (GitHub → Packages → package → Settings → Change
   visibility; the images hold no secrets) or run `docker login ghcr.io` on the
   server with a token that has only `read:packages`.

## Releasing

1. On GitHub, set the repository variable `TURNSTILE_SITE_KEY` (Settings →
   Secrets and variables → Actions → Variables). It is built into the web and
   studio bundles.
2. Merge `develop` into `main`, then tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. The Release workflow builds, scans, signs and publishes. Its GitHub release
   has `release.env`, which lists every image by digest.

Pull requests that change `infra/` run the same workflow without publishing:
the images must build, pass the scan, and the Caddyfile and compose file must
validate.

## Deploying

```sh
cd /opt/mathpath && infra/deploy.sh v0.2.0
```

The script stops at the first failed step. In order it:

1. checks that `.env.prod` exists and is mode 600, and that `cosign` is installed;
2. checks out the tag and downloads its `release.env`;
3. verifies that every MathPath image was signed by this repository's release
   workflow for a version tag;
4. writes SeaweedFS's credentials file from `.env.prod`;
5. starts Postgres, Redis and SeaweedFS; creates the pgBackRest stanza (idempotent);
   runs the migrations as `mathpath_migrator`; applies `grants.sql`; creates the
   media bucket and its CORS rule;
6. starts the API, worker, web, studio and proxy, waits until their health checks
   pass, and calls `https://DOMAIN/api/v1/health`.

After the first deploy: start the monitoring stack (monitoring.md), install the
backup timers (backups.md) and run the first backup by hand.

### Migrations and rollback

Migrations run before the new code starts and only move forward. Write them so
the previous release still works with the new schema (add first, remove in a
later release). To go back to an older release:

```sh
infra/deploy.sh v0.1.9 --rollback
```

This skips the migration step, because an older release does not know the
newer migrations. If a migration itself damaged data, restore instead
(backups.md, point-in-time recovery).

### Useful commands

```sh
cd /opt/mathpath
infra/compose.sh ps                               # health of every service
infra/compose.sh logs -f --since 10m api          # logs (also in Grafana)
infra/compose.sh exec -u postgres postgres psql -d mathpath   # SQL as superuser, for maintenance
```

## Edge rules

- **Hosts:** the web app on `DOMAIN` (and `/api` on it), the studio on
  `studio.DOMAIN`, media on `media.DOMAIN` (cookieless, C-19). `www` redirects.
- **WAF:** OWASP CRS, paranoia level 1, blocking. Payment callbacks
  (`/api/v1/payments/payme`, `/api/v1/payments/click/*`) skip it: a false
  positive would lose a paid order, and the API authenticates them first (C-27).
  The media host skips it too: uploads are large binary bodies authorised by
  presigned URLs. To handle a false positive, find the rule ID in the proxy log
  and add `SecRuleRemoveById <id>` to the `waf` snippet, with a comment saying why.
- **Flood limit:** `EDGE_RATE_LIMIT_PER_MINUTE` per client IP (default 3000).
  A school class shares one IP, so it is a flood guard only; the API keeps its
  own per-user and per-route limits.
- **Logs:** JSON access logs without query strings (they can carry phone
  numbers, playback tokens and URL signatures) and with IPs cut to /24 (IPv6 /48).
- **Not routed:** `/api/v1/health/ready` (404), the metrics ports. Caddy's own
  metrics are on `proxy:9180`, private network only.

## Still open

- A provider load balancer or DDoS service in front of Caddy: set
  `TRUST_PROXY_HOPS=2` and add its address ranges as `trusted_proxies` in the
  Caddyfile, so client IPs stay correct.
- An optional allow-list of Payme and Click callback IPs at the proxy (C-27),
  once the providers confirm their current ranges.
- A content-security-policy report endpoint and its alert (C-39).
