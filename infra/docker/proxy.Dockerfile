# syntax=docker/dockerfile:1
# Edge proxy (security plan C-15, C-35): Caddy with two plugins, built with
# xcaddy from pinned module versions.
#
# - coraza-caddy: OWASP Coraza WAF with the OWASP Core Rule Set compiled in.
# - caddy-ratelimit: per-IP flood limit at the edge.
#
# The two --replace lines raise indirect dependencies to versions with
# security fixes (HIGH findings from the image scan); drop them once Caddy
# itself requires those versions.
#
# Caddy rather than nginx: it gets and renews TLS certificates by itself and
# has safe TLS defaults (TLS 1.2+ with modern ciphers, HTTP/3), which removes a
# certbot cron and a hand-written cipher list. The cost is a custom build for
# the WAF, which this file does.

FROM caddy:2.11.8-builder@sha256:d4eb070c36154bd2d4c94b40359a03c6168346d5af5404963c74691ab77fb63f AS build
RUN xcaddy build v2.11.8 \
    --with github.com/corazawaf/coraza-caddy/v2@v2.6.2 \
    --with github.com/mholt/caddy-ratelimit@v0.1.0 \
    --replace golang.org/x/net=golang.org/x/net@v0.62.0 \
    --replace github.com/go-jose/go-jose/v4=github.com/go-jose/go-jose/v4@v4.1.7

FROM caddy:2.11.8@sha256:4fcafa98afd1c2e642e353e3c5cf9ddbe892fcee14bc990e7ba2c5b78e51f9cf
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY infra/proxy/Caddyfile /etc/caddy/Caddyfile
COPY infra/proxy/errors /srv/errors
