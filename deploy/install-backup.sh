#!/usr/bin/env bash
# Install the nightly database backup. Run once, on the server, with sudo.
#
# Installs backup-db.sh to /usr/local/bin, creates a systemd timer that runs it
# every night, and takes one backup immediately so you find out NOW whether it
# works — rather than at 4am, silently, on a night nobody is watching.
#
# It touches nothing the game uses: no container is stopped, no config changed.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN=/usr/local/bin/pz-backup-db
OUT_DIR="${PZ_BACKUP_DIR:-/home/ubuntu/pz-backups}"
AT="${PZ_BACKUP_AT:-04:00}"

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
[ -f "$SRC_DIR/backup-db.sh" ] || { echo "backup-db.sh must sit next to this script" >&2; exit 1; }

install -m 755 "$SRC_DIR/backup-db.sh" "$BIN"
echo "installed $BIN"

install -d -m 700 "$OUT_DIR"

cat > /etc/systemd/system/prizzequizz-backup.service <<UNIT
[Unit]
Description=PrizzeQuizz nightly database backup
# Backing up while the database is coming up produces a dump of nothing.
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Environment=PZ_BACKUP_DIR=$OUT_DIR
ExecStart=$BIN
# A backup that quietly fails is the same as no backup, so failures are loud in
# the journal and the timer records them.
StandardOutput=journal
StandardError=journal
UNIT

cat > /etc/systemd/system/prizzequizz-backup.timer <<UNIT
[Unit]
Description=Run the PrizzeQuizz database backup every night

[Timer]
OnCalendar=*-*-* $AT:00
# If the machine was off at $AT, run as soon as it is back — a missed night is
# exactly when a backup matters.
Persistent=true
# So every server in the world does not hit its disk at the same second.
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now prizzequizz-backup.timer
echo "timer enabled for $AT daily"

echo
echo "taking one backup now, so a failure is found today:"
if "$BIN"; then
  echo
  echo "OK. backups live in $OUT_DIR"
  ls -la "$OUT_DIR" | tail -5
  echo
  systemctl list-timers prizzequizz-backup.timer --no-pager | head -3
else
  echo
  echo "THE FIRST BACKUP FAILED — the timer is installed but is not protecting you yet." >&2
  echo "Read the error above, fix it, then run: sudo $BIN" >&2
  exit 1
fi
