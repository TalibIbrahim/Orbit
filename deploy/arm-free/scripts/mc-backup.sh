#!/usr/bin/env bash
# mc-backup.sh - consistent Minecraft world backup.
#   mc-backup.sh            -> /srv/orbit/minecraft-backups/30min/<timestamp>.tar.zst
#   mc-backup.sh --daily    -> /srv/orbit/minecraft-backups/daily/<timestamp>.tar.zst
#
# Flow: RCON save-off + save-all flush (via `docker exec <container> rcon-cli`),
# tar the world dirs, and ALWAYS save-on again (trap), even on failure.
#
# Env overrides: MC_CONTAINER (minecraft), MC_DATA_DIR (/srv/orbit/minecraft-data),
#   MC_BACKUP_ROOT (/srv/orbit/minecraft-backups), MC_KEEP_30MIN (48), MC_KEEP_DAILY (14),
#   MC_MIN_FREE_GB (2), MC_WORLDS ("world world_nether world_the_end").
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib.sh"

MODE="30min"
case "${1:-}" in
  "") ;;
  --daily) MODE="daily" ;;
  *) die "usage: $0 [--daily]" ;;
esac

CONTAINER="${MC_CONTAINER:-minecraft}"
DATA_DIR="${MC_DATA_DIR:-${ORBIT_ROOT}/minecraft-data}"
BACKUP_ROOT="${MC_BACKUP_ROOT:-${ORBIT_ROOT}/minecraft-backups}"
MIN_FREE_GB="${MC_MIN_FREE_GB:-2}"
if [ "$MODE" = "daily" ]; then KEEP="${MC_KEEP_DAILY:-14}"; else KEEP="${MC_KEEP_30MIN:-48}"; fi
read -r -a WORLDS <<< "${MC_WORLDS:-world world_nether world_the_end}"

need docker tar find sort df
OUT_DIR="${BACKUP_ROOT}/${MODE}"
mkdir -p "$OUT_DIR"

FREE="$(free_gb "$OUT_DIR")"
[ "$FREE" -ge "$MIN_FREE_GB" ] || die "only ${FREE} GB free on backup volume (< ${MIN_FREE_GB} GB); refusing to write"

# Only include world dirs that exist.
INCLUDE=()
for w in "${WORLDS[@]}"; do [ -d "${DATA_DIR}/${w}" ] && INCLUDE+=("$w"); done
[ "${#INCLUDE[@]}" -gt 0 ] || die "no world directories found in ${DATA_DIR}"

docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true \
  || die "container ${CONTAINER} is not running"

SAVED_OFF=0
cleanup() {
  if [ "$SAVED_OFF" -eq 1 ]; then
    docker exec "$CONTAINER" rcon-cli save-on >/dev/null 2>&1 \
      && log "save-on restored" || warn "FAILED to re-enable saving! run: docker exec ${CONTAINER} rcon-cli save-on"
  fi
  [ -n "${TMP_FILE:-}" ] && rm -f "$TMP_FILE"
  return 0
}
trap cleanup EXIT

STAMP="$(date +%Y%m%d-%H%M%S)"
if command -v zstd >/dev/null 2>&1; then EXT="tar.zst"; COMP=(zstd -T2 -3 -q); else EXT="tar.gz"; COMP=(gzip -6); fi
FINAL="${OUT_DIR}/${STAMP}.${EXT}"
TMP_FILE="${FINAL}.partial"

log "mc-backup (${MODE}): flushing world"
docker exec "$CONTAINER" rcon-cli save-off >/dev/null
SAVED_OFF=1
docker exec "$CONTAINER" rcon-cli save-all flush >/dev/null
sleep 2   # let the flush hit the disk before reading

log "archiving: ${INCLUDE[*]} -> ${FINAL}"
# nice/ionice so a backup never competes with game ticks.
nice -n 10 ionice -c3 tar -C "$DATA_DIR" -cf - "${INCLUDE[@]}" 2>/dev/null | "${COMP[@]}" > "$TMP_FILE" || {
  # tar exit 1 = "file changed as we read it"; acceptable only because saving is off,
  # but pipefail makes it fatal, so re-check the archive is readable.
  :
}
# Verify the archive is readable before keeping it.
case "$EXT" in
  tar.zst) zstd -dc "$TMP_FILE" | tar -tf - >/dev/null || die "archive verification failed" ;;
  *)       gzip -dc "$TMP_FILE" | tar -tf - >/dev/null || die "archive verification failed" ;;
esac
mv "$TMP_FILE" "$FINAL"
TMP_FILE=""

# Re-enable saving as early as possible (trap is the safety net).
docker exec "$CONTAINER" rcon-cli save-on >/dev/null && SAVED_OFF=0
log "backup done: $(du -h "$FINAL" | cut -f1)"

# Retention: keep newest $KEEP archives.
find "$OUT_DIR" -maxdepth 1 -type f -name '*.tar.*' -not -name '*.partial' -printf '%T@ %p\n' \
  | sort -rn | tail -n +"$((KEEP + 1))" | cut -d' ' -f2- \
  | while IFS= read -r old; do rm -f -- "$old" && log "pruned ${old}"; done
exit 0
