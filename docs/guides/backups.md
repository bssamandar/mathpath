# Backups and restore

How MathPath data is backed up and brought back (security plan §13: C-50,
C-51; targets RPO ≤ 15 minutes, RTO ≤ 4 hours). Deployment: [deploy.md](deploy.md).

## What is backed up, and how

| Data                         | How                                                                                                                | Where                                       | Kept                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | --------------------------------- |
| Postgres (all personal data) | pgBackRest: WAL archived continuously (at least every 5 minutes) + a full backup every night at 02:00 Tashkent     | Off-site S3 storage, `/pgbackrest`, AES-256 | 14 full backups + their WAL       |
| Media bucket                 | rclone sync every night after the database backup; replaced or deleted files are kept under `media/removed/<date>` | Off-site S3 storage, `/media`               | Until removed by a lifecycle rule |
| Redis                        | Not backed up: limits, counters and queues only. Sessions are in Postgres                                          | —                                           | —                                 |
| Settings (`infra/.env.prod`) | By hand: a copy of the secrets in a password manager                                                               | Password manager                            | —                                 |

Because WAL is archived every few minutes, the database can be restored to
any moment between the oldest kept backup and about 5 minutes before a
failure, which meets the 15-minute RPO.

### Decisions

| Decision                                            | Alternative considered                 | Why                                                                                                                                                                   |
| --------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pgBackRest                                          | WAL-G; nightly `pg_dump`               | `pg_dump` alone cannot meet a 15-minute RPO. WAL-G could, but pgBackRest also checks the archive (`check`), expires by policy and restores to a time with one command |
| Encryption by pgBackRest with our own passphrase    | The storage provider's encryption only | The provider never sees readable data, and a leaked bucket key is not enough to read a backup                                                                         |
| Off-site storage at a second provider in Uzbekistan | The same provider, another bucket      | Survives the loss of the whole provider account or data centre; stays in the country as the law requires                                                              |
| Monthly automated restore drill                     | Restore by hand when needed            | A backup is only proven by restoring it; the drill measures how long a restore really takes (RTO)                                                                     |

## Off-site storage (once)

1. Create a bucket at a second S3-compatible provider in Uzbekistan.
2. Turn on **versioning** and, if offered, **object lock** in governance mode
   for 30 days (C-50: one copy that cannot be deleted, even with our keys).
3. Create an access key that can use only this bucket. Put the endpoint, bucket,
   key and a new `BACKUP_CIPHER_PASS` into `infra/.env.prod`.
4. Keep `BACKUP_CIPHER_PASS` and `MEDIA_KEY_SECRET` in a password manager too.
   **Without the cipher passphrase the backups cannot be read.**

`infra/deploy.sh` creates the pgBackRest stanza; from then on Postgres ships
WAL by itself.

## Timers (once, after the first deploy)

```sh
sudo cp /opt/mathpath/infra/backup/systemd/* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mathpath-backup.timer mathpath-restore-drill.timer
sudo systemctl start mathpath-backup.service          # first backup now
journalctl -u mathpath-backup.service -f              # watch it
```

Both scripts write their result to `/var/lib/node-exporter/*.prom`, which
Prometheus reads through node-exporter. Alerts (monitoring.md):

| Alert               | Fires when                                     |
| ------------------- | ---------------------------------------------- |
| BackupMissing       | No successful database backup for 26 hours     |
| MediaBackupMissing  | No successful media sync for 2 days            |
| RestoreDrillMissing | No successful restore drill for 35 days        |
| RestoreDrillSlow    | The last drill took longer than the 4-hour RTO |

Useful commands:

```sh
cd /opt/mathpath
infra/compose.sh exec -u postgres postgres pgbackrest info     # backups and WAL range
infra/compose.sh exec -u postgres postgres pgbackrest check    # is WAL archiving working?
infra/backup/backup.sh                                         # a full backup by hand
infra/backup/restore-drill-run.sh                              # a drill by hand
```

## Restore drill (monthly, automatic)

`mathpath-restore-drill.timer` runs on the 2nd of each month at 05:00
Tashkent. It starts a throw-away Postgres container on the backup network
only, restores the latest backup into a scratch volume, replays the archived
WAL, waits until the copy is promoted, and counts accounts, audit entries and
migrations. Archiving is off in the copy, so it can never write into the real
archive. The container and its volume are removed afterwards.

It records the drill time (`mathpath_restore_drill_duration_seconds`, compare
with the 4-hour RTO) and how old the newest restored audit entry is
(`mathpath_restore_drill_data_lag_seconds`; on a busy day this approximates
the RPO).

Twice a year, also do a **full DR exercise** by hand on a separate server:
follow "Restoring production" below from an empty machine and time it.

## Restoring production

Use this when the database is lost or damaged. Write down each step and the
time; it becomes the incident record (security plan §14).

1. **Stop writes:** `infra/compose.sh stop proxy api worker`. Users now see the
   "temporarily unavailable" page.
2. **Choose the target:**
   - the database or disk is lost: the latest state (`--type=default`);
   - bad data was written at a known time (a faulty migration, a mistaken
     bulk change): a moment just before it, for example
     `--type=time "--target=2026-12-01 14:29:00+05"`.
3. **Keep the damaged copy** for investigation, then empty the data volume:
   ```sh
   infra/compose.sh stop postgres
   docker run --rm -v mathpath_postgres:/from -v /srv/pg-damaged-$(date +%F):/to \
     alpine sh -c 'cp -a /from/. /to/ && rm -rf /from/*'
   ```
4. **Restore** (as the postgres user, in a one-off container of the same image):
   ```sh
   infra/compose.sh run --rm --no-deps -u postgres --entrypoint pgbackrest postgres \
     restore --type=default
   # or, for a point in time:
   #   restore --type=time "--target=2026-12-01 14:29:00+05" --target-action=promote
   ```
5. **Start Postgres** and wait for recovery to finish:
   ```sh
   infra/compose.sh up -d --wait postgres
   infra/compose.sh exec -u postgres postgres psql -d mathpath -Atc 'SELECT pg_is_in_recovery()'   # f when done
   ```
6. **Check:** the latest rows look right (`SELECT max(created_at) FROM audit_log`),
   then run the audit chain check by restarting the worker, which checks at start.
7. **Start a new backup line**, because the timeline changed:
   `infra/backup/backup.sh full`.
8. **Open again:** `infra/compose.sh up -d --wait api worker proxy`.

If the whole server is lost: prepare a new server (deploy.md), copy
`.env.prod` from the password manager, run `infra/deploy.sh <same version>`,
then follow steps 1–8. Media comes back with an rclone sync in the other
direction (`media/current` into the bucket).
