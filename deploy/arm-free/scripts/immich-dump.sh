#!/usr/bin/env bash
# immich-dump.sh - dump the Immich Postgres database (arm-free primary mode).
#
# pg_dumpall (--clean --if-exists) | gzip -> <dir>/immich-YYYYmmdd-HHMM.sql.gz
# Written as *.partial first and renamed atomically when complete (the dump dir has a
# .stignore with "*.partial" so Syncthing never ships half-written files). Any failure
# removes the partial file and exits non-zero. Only one dump runs at a time (flock).
# Afterwards old dumps are pruned (prune-dumps.sh, newest KEEP_DUMPS=14 kept).
# Env: ORBIT_DUMP_DIR (/srv/orbit/immich-db-dumps), KEEP_DUMPS (14)
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib.sh"
need docker gzip flock

DIR="${ORBIT_DUMP_DIR:-${ORBIT_ROOT}/immich-db-dumps}"
mkdir -p "$DIR"

exec 9>"${DIR}/.immich-dump.lock"
flock -n 9 || die "another Immich dump is already running"

FINAL="${DIR}/immich-$(date +%Y%m%d-%H%M).sql.gz"
PART="${FINAL}.partial"
cleanup() { rm -f -- "$PART"; }
trap cleanup EXIT

log "dumping Immich database to ${FINAL}"
docker exec immich_postgres sh -c 'pg_dumpall --clean --if-exists -U "$POSTGRES_USER"' | gzip > "$PART" \
  || die "pg_dumpall failed"
[ -s "$PART" ] || die "dump is empty"
gzip -t "$PART" || die "dump failed integrity check"
sync "$PART" 2>/dev/null || sync
chown 1000:1000 "$PART"
mv -f -- "$PART" "$FINAL"
trap - EXIT
log "dump complete: $(du -h "$FINAL" | cut -f1)"

"$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/prune-dumps.sh"
