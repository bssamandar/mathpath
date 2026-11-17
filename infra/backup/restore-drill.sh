#!/usr/bin/env bash
# Runs INSIDE the `restore-drill` container (docker-compose.prod.yml), started
# by restore-drill-run.sh on the host. Restores the latest backup into an
# empty scratch directory, replays all archived WAL, promotes, checks the data
# and prints the results as key=value lines for the host script.
set -euo pipefail

DATA=/drill/data/pg
install -d -o postgres -g postgres -m 0700 "$DATA"

started=$(date +%s)
# --archive-mode=off: the scratch copy must never push WAL into the real archive.
gosu postgres pgbackrest --pg1-path="$DATA" --archive-mode=off restore

# A private socket and no TCP listener: nothing can reach this copy.
gosu postgres pg_ctl -D "$DATA" -w -t 600 \
  -o "-c listen_addresses='' -c unix_socket_directories=/tmp -c archive_mode=off" start

# Recovery replays the archived WAL, then promotes; wait for that (up to 1 h).
for _ in $(seq 1 720); do
  if [ "$(gosu postgres psql -h /tmp -d mathpath -Atc 'SELECT pg_is_in_recovery()')" = f ]; then
    break
  fi
  sleep 5
done

q() { gosu postgres psql -h /tmp -d mathpath -v ON_ERROR_STOP=1 -Atc "$1"; }
[ "$(q 'SELECT pg_is_in_recovery()')" = f ] || { echo 'recovery did not finish' >&2; exit 1; }

users=$(q 'SELECT count(*) FROM users')
audit=$(q 'SELECT count(*) FROM audit_log')
# Newest row in the copy: how far behind production the restore is (the RPO).
newest=$(q "SELECT coalesce(extract(epoch FROM max(created_at))::bigint, 0) FROM audit_log")
migrations=$(q 'SELECT count(*) FROM kysely_migration')

gosu postgres pg_ctl -D "$DATA" -m fast stop >/dev/null
finished=$(date +%s)

echo "users=$users"
echo "audit_entries=$audit"
echo "newest_entry=$newest"
echo "migrations=$migrations"
echo "duration=$((finished - started))"
