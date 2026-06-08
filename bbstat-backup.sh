#!/usr/bin/env bash
#
# bbstat-backup.sh — daily data-only Postgres backup for the bbstat production
# stack. Lives alongside compose.yaml; writes dumps to a SEPARATE BACKUP_DIR
# and keeps only the most recent $RETENTION dumps.
#
# Data-only ON PURPOSE: the schema is recreated from migrations (the `migrate`
# one-shot), never from the dump. Restore into a freshly-migrated, EMPTY db:
#   docker exec -i bbstat-pg pg_restore -U bbstat -d <db> \
#     --data-only --no-owner --no-privileges --disable-triggers < <dump>
#   (--disable-triggers needs superuser; drop it and rely on pg_restore's
#    dependency ordering if the bbstat role isn't superuser.)
#
# Schedule via system cron, run as a user in the `docker` group. Either a user
# crontab (`crontab -e`) — daily at 02:00:
#   0 2 * * * /opt/bbstat/bbstat-backup.sh >> /var/log/bbstat-backup.log 2>&1
# …or /etc/cron.d/bbstat-backup (note the explicit user field + MAILTO so a
# failure emails you; the script is quiet on success):
#   MAILTO=ops@example.com
#   0 2 * * * deploy /opt/bbstat/bbstat-backup.sh >> /var/log/bbstat-backup.log 2>&1
#
set -euo pipefail

# Cron runs with a bare PATH — make docker + coreutils findable.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# --- config (override via env on the cron line if needed) -------------------
PG_CONTAINER="${PG_CONTAINER:-bbstat-pg}"
PG_USER="${PG_USER:-bbstat}"
PG_DB="${PG_DB:-bbstat}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/bbstat}"   # absolute, and MUST differ from this script's dir
RETENTION="${RETENTION:-7}"                       # keep this many newest dumps
PREFIX="bbstat-data"
# ---------------------------------------------------------------------------

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() {
  printf '[%s] ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
  exit 1
}

# Backups must not land in the script/compose directory.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
resolved_backup="$(readlink -f "$BACKUP_DIR" 2>/dev/null || echo "$BACKUP_DIR")"
[ "$resolved_backup" != "$script_dir" ] ||
  fail "BACKUP_DIR ($BACKUP_DIR) must differ from the script directory ($script_dir)"

# Single-instance guard: skip if a previous (slow) run is still going, rather
# than stacking dumps.
exec 9>"/tmp/${PREFIX}-backup.lock"
flock -n 9 || fail "another backup run is already in progress; skipping"

mkdir -p "$BACKUP_DIR" || fail "cannot create BACKUP_DIR $BACKUP_DIR"

# Don't start unless Postgres is actually up.
[ "$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null || true)" = "true" ] ||
  fail "Postgres container '$PG_CONTAINER' is not running"

ts="$(date '+%Y-%m-%dT%H-%M-%S')"
final="${BACKUP_DIR}/${PREFIX}-${ts}.dump"
tmp="${final}.partial"
trap 'rm -f "$tmp"' EXIT # never leave a half-written file looking like a backup

log "dumping ${PG_DB} (data-only, custom format) from ${PG_CONTAINER}"
# No -it: keep the binary stream clean. Runs inside the pg container, so it
# hits Postgres directly (bypassing any proxy/pooler) with a matching pg_dump.
if ! docker exec "$PG_CONTAINER" \
  pg_dump -U "$PG_USER" -d "$PG_DB" -Fc --data-only --no-owner --no-privileges >"$tmp"; then
  fail "pg_dump failed"
fi

# Reject an empty or corrupt dump before it counts toward retention.
[ -s "$tmp" ] || fail "dump is empty"
docker exec -i "$PG_CONTAINER" pg_restore --list <"$tmp" >/dev/null 2>&1 ||
  fail "dump failed verification (pg_restore --list could not read it)"

mv "$tmp" "$final"
log "backup OK: $final ($(du -h "$final" | cut -f1))"

# --- rotation: keep the newest $RETENTION dumps, delete the rest ------------
mapfile -t all < <(ls -1t "${BACKUP_DIR}/${PREFIX}-"*.dump 2>/dev/null || true)
if ((${#all[@]} > RETENTION)); then
  for old in "${all[@]:RETENTION}"; do
    rm -f "$old" && log "pruned old backup: $old"
  done
fi

log "done — retaining newest ${RETENTION} dump(s)"
