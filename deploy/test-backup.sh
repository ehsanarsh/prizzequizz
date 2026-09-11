#!/usr/bin/env bash
# THE BACKUP SCRIPT, AGAINST A REAL POSTGRES.
#
# A backup script is only worth what its failure modes are worth: the dangerous
# outcome is not «no backup», it is a FILE THAT LOOKS LIKE ONE. So most of this
# is about what it refuses to keep, and about never deleting a good backup
# because a later run went wrong.
set -uo pipefail
# Run from a checkout, against any Postgres:
#   PZ_PG_EXEC=<prefix that runs pg_dump/pg_restore/psql> ./deploy/test-backup.sh
# where the prefix is `docker compose exec -T postgres` on a server, or a small
# shim pointing at a local server (see the README block at the end).
SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-db.sh"
export PZ_PG_EXEC="${PZ_PG_EXEC:?set PZ_PG_EXEC to a command prefix that can run pg_dump}"
export PZ_DB_NAME=pzbk PZ_DB_USER=postgres

pass=0; fail=0
ok(){ if [ "$1" = "1" ]; then pass=$((pass+1)); echo "  ok   $2"; else fail=$((fail+1)); echo "  FAIL $2 ${3:-}"; fi; }
fresh(){ rm -rf /tmp/bk; mkdir -p /tmp/bk; export PZ_BACKUP_DIR=/tmp/bk; }
count(){ ls /tmp/bk/pz-*.dump 2>/dev/null | wc -l; }

echo "a normal night:"
fresh
OUT="$(bash "$SCRIPT" 2>&1)"; RC=$?
ok "$([ $RC -eq 0 ] && echo 1 || echo 0)" "it succeeds" "$OUT"
ok "$([ "$(count)" -eq 1 ] && echo 1 || echo 0)" "one backup is written" "$(count)"
F="$(ls /tmp/bk/pz-*.dump | head -1)"
ok "$([ "$(stat -c %a "$F")" = "600" ] && echo 1 || echo 0)" "readable only by its owner" "$(stat -c %a "$F")"
ok "$(echo "$OUT" | grep -q 'tables' && echo 1 || echo 0)" "it reports how many tables it saw"
ok "$([ -z "$(ls /tmp/bk/.inflight-* 2>/dev/null)" ] && echo 1 || echo 0)" "no half-written file is left behind"

echo "and the dump really holds the money:"
ROWS="$(/tmp/pgexec.sh pg_restore --list < "$F" | grep -c 'TABLE DATA')"
ok "$([ "$ROWS" -ge 10 ] && echo 1 || echo 0)" "every table is in the archive" "$ROWS"
/tmp/pgexec.sh psql -q -c "DROP DATABASE IF EXISTS pzbk_v" -c "CREATE DATABASE pzbk_v" >/dev/null 2>&1
/tmp/pgexec.sh pg_restore -d pzbk_v --no-owner < "$F" >/dev/null 2>&1
N="$(/tmp/pgexec.sh psql -tAq -d pzbk_v -c 'SELECT count(*) FROM wallet_ledger' 2>/dev/null || echo 0)"
ok "$([ "$N" = "2000" ] && echo 1 || echo 0)" "and it restores with every ledger row" "$N"

echo "when the database cannot be reached:"
fresh
PZ_DB_NAME=nope_does_not_exist bash "$SCRIPT" >/tmp/o 2>&1; RC=$?
ok "$([ $RC -ne 0 ] && echo 1 || echo 0)" "it fails loudly instead of exiting 0" "rc=$RC"
ok "$([ "$(count)" -eq 0 ] && echo 1 || echo 0)" "and writes no file at all" "$(count)"
ok "$([ -z "$(ls /tmp/bk/.inflight-* 2>/dev/null)" ] && echo 1 || echo 0)" "not even a partial one"

echo "when the dump comes back too small to be a database:"
fresh
PZ_BACKUP_MIN_BYTES=999999999 bash "$SCRIPT" >/tmp/o 2>&1; RC=$?
ok "$([ $RC -ne 0 ] && echo 1 || echo 0)" "it refuses it" "rc=$RC"
ok "$([ "$(count)" -eq 0 ] && echo 1 || echo 0)" "and keeps nothing" "$(count)"
ok "$(grep -q 'refusing to keep' /tmp/o && echo 1 || echo 0)" "saying why"

echo "when the money tables are missing:"
/tmp/pgexec.sh psql -q -c "DROP DATABASE IF EXISTS pzthin" -c "CREATE DATABASE pzthin" >/dev/null 2>&1
/tmp/pgexec.sh psql -q -d pzthin -c "$(for i in $(seq 1 15); do echo "CREATE TABLE t$i (id int); INSERT INTO t$i SELECT generate_series(1,900);"; done)" >/dev/null 2>&1
fresh
PZ_DB_NAME=pzthin bash "$SCRIPT" >/tmp/o 2>&1; RC=$?
ok "$([ $RC -ne 0 ] && echo 1 || echo 0)" "a big readable dump without wallet_ledger is still refused" "rc=$RC"
ok "$(grep -q "wallet_ledger" /tmp/o && echo 1 || echo 0)" "and it names what was missing" "$(tail -1 /tmp/o)"
ok "$([ "$(count)" -eq 0 ] && echo 1 || echo 0)" "nothing kept" "$(count)"

echo "when the dump is readable but is not the whole schema:"
# The money tables ARE here — what is wrong is that almost nothing else is.
# That is what a truncated dump, or a dump of the wrong database, looks like.
/tmp/pgexec.sh psql -q -c "DROP DATABASE IF EXISTS pzsmall" -c "CREATE DATABASE pzsmall" >/dev/null 2>&1
/tmp/pgexec.sh psql -q -d pzsmall -c "CREATE TABLE users (id text); CREATE TABLE wallet_accounts (id text); CREATE TABLE wallet_ledger (id text); INSERT INTO users SELECT 'u'||g FROM generate_series(1,4000) g; INSERT INTO wallet_ledger SELECT 'l'||g FROM generate_series(1,4000) g; INSERT INTO wallet_accounts SELECT 'a'||g FROM generate_series(1,4000) g;" >/dev/null 2>&1
fresh
PZ_DB_NAME=pzsmall bash "$SCRIPT" >/tmp/o 2>&1; RC=$?
ok "$([ $RC -ne 0 ] && echo 1 || echo 0)" "three tables is not a database, however big" "rc=$RC"
ok "$(grep -q 'not a whole database' /tmp/o && echo 1 || echo 0)" "and it says so" "$(tail -1 /tmp/o)"
ok "$([ "$(count)" -eq 0 ] && echo 1 || echo 0)" "nothing kept" "$(count)"

echo "when it refuses, it says what it DID find:"
fresh
PZ_DB_NAME=pzthin bash "$SCRIPT" >/tmp/o 2>&1
ok "$(grep -q 'tables found:' /tmp/o && echo 1 || echo 0)" "the names it saw are printed" "$(tail -1 /tmp/o | head -c 90)"
ok "$(grep -qE 'tables found:.*t1' /tmp/o && echo 1 || echo 0)" "and they are the real ones from the archive"

echo "when the archive cannot be listed at all:"
fresh
# A prefix whose pg_restore produces nothing — a broken archive, or a pg_restore
# that is not there. The old code read this as «0 tables» and blamed the schema.
cat > /tmp/deadpg.sh <<'SHIM'
#!/usr/bin/env bash
if [ "$1" = "pg_restore" ]; then exit 1; fi
exec "/usr/lib/postgresql/16/bin/$1" "${@:2}"
SHIM
chmod +x /tmp/deadpg.sh
PZ_PG_EXEC=/tmp/deadpg.sh bash "$SCRIPT" >/tmp/o 2>&1; RC=$?
ok "$([ $RC -ne 0 ] && echo 1 || echo 0)" "it fails" "rc=$RC"
ok "$(grep -q 'could not be listed at all' /tmp/o && echo 1 || echo 0)" "and blames the archive, not the schema" "$(tail -1 /tmp/o | head -c 80)"
ok "$([ "$(count)" -eq 0 ] && echo 1 || echo 0)" "nothing kept"

echo "rotation:"
fresh
bash "$SCRIPT" >/dev/null 2>&1
touch -d '40 days ago' /tmp/bk/pz-old.dump
sleep 1; bash "$SCRIPT" >/tmp/o 2>&1
ok "$([ ! -f /tmp/bk/pz-old.dump ] && echo 1 || echo 0)" "old backups are removed"
ok "$([ "$(count)" -eq 2 ] && echo 1 || echo 0)" "recent ones are kept" "$(count)"

echo "and the rule that matters most:"
fresh
bash "$SCRIPT" >/dev/null 2>&1
GOOD="$(ls /tmp/bk/pz-*.dump | head -1)"
touch -d '40 days ago' "$GOOD"
PZ_DB_NAME=nope_does_not_exist bash "$SCRIPT" >/dev/null 2>&1
ok "$([ -f "$GOOD" ] && echo 1 || echo 0)" "a FAILED run never deletes the last good backup" "$(count) left"

echo
echo "[backup] $pass passed, $fail failed"
[ "$fail" -eq 0 ]

# ---------------------------------------------------------------------------
# Running this against a throwaway Postgres, with no docker:
#
#   printf '#!/usr/bin/env bash\nexec "/usr/lib/postgresql/16/bin/$1" "${@:2}"\n' > /tmp/pgexec.sh
#   chmod +x /tmp/pgexec.sh
#   export PGHOST=/tmp PGPORT=5432 PGUSER=postgres
#   PZ_PG_EXEC=/tmp/pgexec.sh PZ_DB_NAME=pzbk ./deploy/test-backup.sh
#
# The fixture database it expects is a schema with the real table names and a
# few thousand rows; the test creates the odd ones it needs as it goes.
