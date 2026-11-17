#!/usr/bin/env bash
# Monthly restore drill (security plan C-51), run by mathpath-restore-drill.timer.
# Restores the latest backup plus archived WAL into a throw-away container,
# checks the data and records the result for Prometheus (RestoreDrillMissing,
# RestoreDrillSlow alerts). Production is not touched.
# shellcheck source=../lib.sh
source "$(dirname "$0")/../lib.sh"

log "restore drill: restoring the latest backup into a scratch container"
started=$(date +%s)
output=$(compose run --rm -T restore-drill)
finished=$(date +%s)
printf '%s\n' "$output"

value() { printf '%s\n' "$output" | sed -n "s/^$1=//p" | tail -1; }
users=$(value users)
migrations=$(value migrations)
newest=$(value newest_entry)
[ -n "$users" ] && [ -n "$migrations" ] && [ -n "$newest" ] || die "the drill printed no results"
[ "$migrations" -gt 0 ] || die "the restored database has no schema"

write_metrics mathpath_restore_drill <<METRICS
# HELP mathpath_restore_drill_last_success_timestamp_seconds When the last restore drill passed.
# TYPE mathpath_restore_drill_last_success_timestamp_seconds gauge
mathpath_restore_drill_last_success_timestamp_seconds $finished
# HELP mathpath_restore_drill_duration_seconds Time to restore and check the last backup (compare with the 4 h RTO).
# TYPE mathpath_restore_drill_duration_seconds gauge
mathpath_restore_drill_duration_seconds $((finished - started))
# HELP mathpath_restore_drill_data_lag_seconds Newest restored audit entry, seconds before the drill ended (compare with the 15 min RPO).
# TYPE mathpath_restore_drill_data_lag_seconds gauge
mathpath_restore_drill_data_lag_seconds $((finished - newest))
# HELP mathpath_restore_drill_users Accounts found in the restored copy.
# TYPE mathpath_restore_drill_users gauge
mathpath_restore_drill_users $users
METRICS
log "restore drill passed in $((finished - started)) s; $users accounts"
