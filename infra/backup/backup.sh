#!/usr/bin/env bash
# Nightly backup (security plan C-50), run by mathpath-backup.timer:
#
#   1. a full, encrypted pgBackRest backup of Postgres to the off-site storage
#      (WAL is archived continuously in between, so any point in time between
#      backups can be restored);
#   2. `pgbackrest check`, which proves WAL archiving still works;
#   3. a sync of the media bucket to the same storage.
#
# On success it records the time for Prometheus; the BackupMissing and
# MediaBackupMissing alerts fire when those times get old. On failure it
# exits non-zero, so systemd marks the unit failed.
#
#   infra/backup/backup.sh [full|diff]
# shellcheck source=../lib.sh
source "$(dirname "$0")/../lib.sh"

type=${1:-full}
case $type in full | diff) ;; *) die "usage: backup.sh [full|diff]" ;; esac

started=$(date +%s)
log "Postgres $type backup"
compose exec -T -u postgres postgres pgbackrest --type="$type" backup
compose exec -T -u postgres postgres pgbackrest check
compose exec -T -u postgres postgres pgbackrest info
finished=$(date +%s)
write_metrics mathpath_backup <<METRICS
# HELP mathpath_backup_last_success_timestamp_seconds When the last database backup finished.
# TYPE mathpath_backup_last_success_timestamp_seconds gauge
mathpath_backup_last_success_timestamp_seconds $finished
# HELP mathpath_backup_duration_seconds How long the last database backup took.
# TYPE mathpath_backup_duration_seconds gauge
mathpath_backup_duration_seconds $((finished - started))
METRICS

log "media bucket sync"
MEDIA_BACKUP_DAY=$(date -u +%Y-%m-%d) compose run --rm media-backup
write_metrics mathpath_media_backup <<METRICS
# HELP mathpath_media_backup_last_success_timestamp_seconds When the media bucket was last copied off-site.
# TYPE mathpath_media_backup_last_success_timestamp_seconds gauge
mathpath_media_backup_last_success_timestamp_seconds $(date +%s)
METRICS
log "backup finished"
