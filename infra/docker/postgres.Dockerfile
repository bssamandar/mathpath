# syntax=docker/dockerfile:1
# PostgreSQL 16 with pgBackRest for continuous WAL archiving and encrypted
# backups to S3-compatible storage (security plan C-50, docs/guides/backups.md).
#
# pgBackRest rather than WAL-G or nightly pg_dump: pg_dump alone cannot meet
# the 15-minute RPO; WAL-G can, but pgBackRest also verifies backups, expires
# them by policy and restores to a point in time with one command, which the
# monthly restore drill relies on. It comes from the PostgreSQL project's own
# apt repository, which the official image already trusts.

FROM postgres:16.15-bookworm@sha256:5264710be20f409750ac6dc4e5706dcef929c87e241605463f0f9aefa932a8d9
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends pgbackrest ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o postgres -g postgres -m 0750 /var/lib/pgbackrest /var/log/pgbackrest /tmp/pgbackrest
COPY infra/postgres/initdb/ /docker-entrypoint-initdb.d/
COPY infra/postgres/grants.sql /usr/local/share/mathpath/grants.sql
