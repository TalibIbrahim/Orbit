#!/usr/bin/env bash
# prune-dumps.sh - keep only the newest N Immich DB dumps (default 14) in the replica.
# The dumps are produced on the PC and arrive via Syncthing ("immich-db-dumps", Receive Only),
# so prune on arm-free only after the PC's own retention has run, never the newest ones.
# Env: ORBIT_DUMP_DIR (/srv/orbit/immich-db-dumps), KEEP_DUMPS (14)
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib.sh"

DIR="${ORBIT_DUMP_DIR:-${ORBIT_ROOT}/immich-db-dumps}"
KEEP="${KEEP_DUMPS:-14}"
need find sort

[ -d "$DIR" ] || die "dump dir ${DIR} not found"
case "$KEEP" in ''|*[!0-9]*) die "KEEP_DUMPS must be a number" ;; esac
[ "$KEEP" -ge 1 ] || die "KEEP_DUMPS must be >= 1"

COUNT=0
while IFS= read -r old; do
  rm -f -- "$old"
  log "pruned ${old}"
  COUNT=$((COUNT + 1))
done < <(find "$DIR" -maxdepth 1 -type f \( -name 'immich-*.sql.gz' -o -name '*.sql.gz' \) -printf '%T@ %p\n' \
          | sort -rn | tail -n +"$((KEEP + 1))" | cut -d' ' -f2-)
log "prune-dumps: removed ${COUNT} old dump(s), keeping ${KEEP}"
