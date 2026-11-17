#!/usr/bin/env bash
# shellcheck disable=SC2154 # POSTGRES_USER and POSTGRES_DB come from the image's entrypoint
# Runs once, when the data directory is first created (security plan C-37):
#
#   mathpath_migrator  owns the schema; used only by the migration step
#   mathpath_app       the API and the worker: read and write rows, no DDL,
#                      and no UPDATE or DELETE on the audit log (grants.sql)
#   monitoring         postgres-exporter: pg_monitor only
#
# The superuser (POSTGRES_USER) is used only for maintenance from inside the
# container. Passwords come from the server's env file (infra/.env.prod).
set -euo pipefail

: "${MATHPATH_MIGRATOR_PASSWORD:?set MATHPATH_MIGRATOR_PASSWORD}"
: "${MATHPATH_APP_PASSWORD:?set MATHPATH_APP_PASSWORD}"
: "${MATHPATH_MONITORING_PASSWORD:?set MATHPATH_MONITORING_PASSWORD}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v db="$POSTGRES_DB" \
  -v migrator_pw="$MATHPATH_MIGRATOR_PASSWORD" \
  -v app_pw="$MATHPATH_APP_PASSWORD" \
  -v monitoring_pw="$MATHPATH_MONITORING_PASSWORD" <<'SQL'
CREATE ROLE mathpath_migrator LOGIN PASSWORD :'migrator_pw';
CREATE ROLE mathpath_app LOGIN PASSWORD :'app_pw' CONNECTION LIMIT 150;
CREATE ROLE monitoring LOGIN PASSWORD :'monitoring_pw' CONNECTION LIMIT 3;
GRANT pg_monitor TO monitoring;

ALTER DATABASE :"db" OWNER TO mathpath_migrator;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO mathpath_app, monitoring;

ALTER SCHEMA public OWNER TO mathpath_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO mathpath_app, monitoring;

-- Tables the migrator creates later are readable and writable by the app.
-- grants.sql, run after every migration, takes back what the app must not do.
ALTER DEFAULT PRIVILEGES FOR ROLE mathpath_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mathpath_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mathpath_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO mathpath_app;
SQL
