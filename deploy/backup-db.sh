#!/usr/bin/env bash
# NIGHTLY DATABASE BACKUP for PrizzeQuizz.
#
# The panel has a «download a backup» button, which is a person remembering to
# press it. This is the other kind: it runs whether anyone remembers or not.
#
# What it protects against is total loss — a dead disk, a `docker compose down
# -v` that takes the pgdata volume with it, a bad migration. Everything that
# cannot be rebuilt lives in Postgres: the users, the wallet ledger, the
# withdrawal history, the questions people wrote.
#
# WHAT IT DOES NOT PROTECT AGAINST: the backups sit on the SAME disk as the
# database. That covers every case except losing the machine itself. Copying
# them off the box is a separate step and RESTORE.md says how.
#
# Run by systemd (see prizzequizz-backup.timer). Safe to run by hand any time.
# `-e` is belt and braces: every step that matters below is already guarded with
# an explicit `|| die`, so nothing observable depends on it today. It stays as a
# net for the next person to edit this file, who will not necessarily guard
# theirs — which is exactly when a backup script fails quietly.
set -euo pipefail

PROJECT="${PZ_PROJECT:-prizzequizz}"
COMPOSE_DIR="${PZ_COMPOSE_DIR:-/home/ubuntu}"
OUT_DIR="${PZ_BACKUP_DIR:-/home/ubuntu/pz-backups}"
KEEP_DAYS="${PZ_BACKUP_KEEP_DAYS:-14}"
DB_NAME="${PZ_DB_NAME:-prizzequizz}"
DB_USER="${PZ_DB_USER:-postgres}"
# A dump smaller than this is not a database, it is an error that exited 0.
MIN_BYTES="${PZ_BACKUP_MIN_BYTES:-20000}"

log() { printf '[backup] %s %s\n' "$(date -Is)" "$*"; }
die() { printf '[backup] %s ERROR: %s\n' "$(date -Is)" "$*" >&2; exit 1; }

# How to reach Postgres. Overridable ONLY so the test suite can point this at a
# local server; on the server it is left alone and the default is used.
# Deliberately unquoted where it is used — it is a command prefix, not a path.
PG_EXEC="${PZ_PG_EXEC:-}"
if [ -z "$PG_EXEC" ]; then
  command -v docker >/dev/null || die "docker not found"
  cd "$COMPOSE_DIR" || die "compose dir not found: $COMPOSE_DIR"
  PG_EXEC="docker compose -p $PROJECT exec -T postgres"
fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
TMP="$OUT_DIR/.inflight-$STAMP.dump"
FINAL="$OUT_DIR/pz-$STAMP.dump"

# Written to a temporary name first and renamed only after it has been VERIFIED.
# A half-written file with the right name is worse than no file: it is a backup
# you believe you have.
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

log "dumping $DB_NAME"
# -Fc is the custom format: compressed, and pg_restore can read a table out of
# it without replaying the whole thing. No password is needed — inside the
# container this connects over the unix socket as the postgres user.
if ! $PG_EXEC pg_dump -U "$DB_USER" -Fc --no-owner "$DB_NAME" > "$TMP" 2>/tmp/pz-backup-err.$$; then
  ERR="$(head -c 400 /tmp/pz-backup-err.$$ || true)"; rm -f /tmp/pz-backup-err.$$
  die "pg_dump failed: $ERR"
fi
rm -f /tmp/pz-backup-err.$$

SIZE="$(stat -c %s "$TMP")"
[ "$SIZE" -ge "$MIN_BYTES" ] || die "dump is only ${SIZE}B — refusing to keep it"

# THE VERIFICATION THAT MAKES IT A BACKUP. An archive that cannot be listed
# cannot be restored, and the only time anyone finds out is the day they need
# it. pg_restore --list reads the whole table of contents.
TABLES="$($PG_EXEC pg_restore --list < "$TMP" 2>/dev/null | grep -c 'TABLE DATA' || true)"
[ "${TABLES:-0}" -ge 10 ] || die "archive lists only ${TABLES:-0} tables — not a whole database"

# The tables that hold money. If these are missing the dump is worthless even
# though it is large and readable.
for t in wallet_ledger wallet_accounts users; do
  $PG_EXEC pg_restore --list < "$TMP" 2>/dev/null \
    | grep -q " $t " || die "no data for '$t' in the archive"
done

mv "$TMP" "$FINAL"
chmod 600 "$FINAL"
trap - EXIT
log "wrote $FINAL ($(numfmt --to=iec "$SIZE" 2>/dev/null || echo "${SIZE}B"), $TABLES tables)"

# Rotation runs AFTER a successful write, never before: a failed backup must
# not be the thing that deletes the last good one.
DELETED="$(find "$OUT_DIR" -maxdepth 1 -name 'pz-*.dump' -mtime "+$KEEP_DAYS" -print -delete | wc -l)"
[ "$DELETED" -eq 0 ] || log "removed $DELETED backup(s) older than $KEEP_DAYS days"

KEPT="$(find "$OUT_DIR" -maxdepth 1 -name 'pz-*.dump' | wc -l)"
log "ok — $KEPT backup(s) on hand"
