#!/usr/bin/env bash
# promote-standby.sh - turn arm-free into the active Immich server (manual failover).
#
# Steps:
#   1. pause the Syncthing receive-only folders (replica stops changing)
#   2. pick the DB dump ($ORBIT_DUMP_FILE or newest in /srv/orbit/immich-db-dumps)
#   3. start only the standby Postgres, wait for pg_isready
#   4. restore the dump (Immich's documented restore procedure)
#   5. start the rest of the Immich stack
#   6. wait for /api/server/ping == pong
#   7. print the URL + a DATA LAG warning
#
# Re-running is safe: if Immich already answers and no --force is given, the restore
# is skipped. A promotion timestamp is stored in $ORBIT_STATE_DIR/promoted-at (used by
# switch-back.sh to find assets uploaded during the outage).
#
# Env: ORBIT_DUMP_FILE, ORBIT_DUMP_DIR, SYNCTHING_URL, SYNCTHING_CONFIG, ORBIT_STATE_DIR,
#      PROMOTE_FOLDERS (space separated, default "immich-library immich-db-dumps").
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib.sh"

# Not applicable when Immich runs here permanently (arm-free primary mode).
if [ "$(env_file_get "${ARM_FREE_DIR}/.env" ORBIT_PRIMARY_MODE)" = "arm-free" ]; then
  die "ORBIT_PRIMARY_MODE=arm-free: this VM is the primary, there is nothing to promote or switch back. See docs/failover-restore.md, section 'Disaster recovery (arm-free primary)'."
fi

FORCE=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $a" ;;
  esac
done

need docker curl jq gunzip sed date stat
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing"

DUMP_DIR="${ORBIT_DUMP_DIR:-${ORBIT_ROOT}/immich-db-dumps}"
ST_URL="${SYNCTHING_URL:-http://127.0.0.1:8384}"
ST_CONFIG="${SYNCTHING_CONFIG:-${ORBIT_ROOT}/syncthing-config/config.xml}"
FOLDERS="${PROMOTE_FOLDERS:-immich-library immich-db-dumps}"
ENV_FILE="${ARM_FREE_DIR}/immich/.env"
# Installs from before the immich-standby -> immich rename have no config file yet; without it
# Docker would bind-mount an empty directory. Standby: ML off, job concurrency 1.
IMMICH_CFG="${ARM_FREE_DIR}/immich/immich-config.json"
if [ ! -f "$IMMICH_CFG" ]; then
  jq '.machineLearning.enabled=false' "${ARM_FREE_DIR}/immich/immich-config.example.json" > "${IMMICH_CFG}.tmp"
  mv "${IMMICH_CFG}.tmp" "$IMMICH_CFG"
  log "created ${IMMICH_CFG} (ML disabled)"
fi
if [ ! -f "$ENV_FILE" ] && [ -f "${ARM_FREE_DIR}/immich-standby/.env" ]; then
  cp "${ARM_FREE_DIR}/immich-standby/.env" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "migrated immich-standby/.env -> immich/.env"
fi
STATE_FILE="${ORBIT_STATE_DIR}/promoted-at"

[ -f "$IMMICH_COMPOSE" ] || die "missing $IMMICH_COMPOSE"
[ -f "$ENV_FILE" ] || die "missing $ENV_FILE (copy .env.example and fill it in)"

TS_IP="${TAILSCALE_IP:-$(env_file_get "$ENV_FILE" TAILSCALE_IP)}"
case "${TS_IP:-}" in ""|100.x.y.z) TS_IP="127.0.0.1" ;; esac
PING_URL="http://${TS_IP}:2283/api/server/ping"
dc() { docker compose -f "$IMMICH_COMPOSE" --project-directory "$(dirname "$IMMICH_COMPOSE")" "$@"; }

ping_ok() { [ "$(curl -fsS -m 5 "$PING_URL" 2>/dev/null | jq -r '.res // empty' 2>/dev/null || true)" = "pong" ]; }

# --- 1. pause Syncthing folders -------------------------------------------------------
log "Step 1/7: pausing Syncthing folders (${FOLDERS})"
if [ -r "$ST_CONFIG" ]; then
  API_KEY="$(sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' "$ST_CONFIG" | head -n 1)"
  if [ -n "$API_KEY" ]; then
    for f in $FOLDERS; do
      if curl -fsS -m 15 -X PATCH -H "X-API-Key: ${API_KEY}" -H 'Content-Type: application/json' \
          -d '{"paused":true}' "${ST_URL}/rest/config/folders/${f}" >/dev/null; then
        log "  paused folder ${f}"
      else
        warn "could not pause folder ${f} (does it exist? is Syncthing up?)"
      fi
    done
  else
    warn "no apikey in ${ST_CONFIG}; skipping Syncthing pause"
  fi
else
  warn "cannot read ${ST_CONFIG}; skipping Syncthing pause (replica may keep changing)"
fi

# --- already promoted? ----------------------------------------------------------------
if [ "$FORCE" -eq 0 ] && ping_ok; then
  log "Immich already answers at ${PING_URL}; nothing to restore (use --force to redo)."
  [ -f "$STATE_FILE" ] && log "Promoted at: $(cat "$STATE_FILE")"
  echo "Immich URL: http://${TS_IP}:2283"
  exit 0
fi

# --- 2. choose dump -------------------------------------------------------------------
log "Step 2/7: selecting database dump"
DUMP="${ORBIT_DUMP_FILE:-}"
if [ -z "$DUMP" ]; then
  [ -d "$DUMP_DIR" ] || die "dump dir ${DUMP_DIR} not found"
  DUMP="$(find "$DUMP_DIR" -maxdepth 1 -type f \( -name '*.sql.gz' -o -name '*.sql' \) \
            -printf '%T@ %p\n' | sort -rn | head -n 1 | cut -d' ' -f2-)"
fi
[ -n "$DUMP" ] && [ -f "$DUMP" ] || die "no dump found (set ORBIT_DUMP_FILE or sync ${DUMP_DIR})"
case "$DUMP" in *.gz) gunzip --test "$DUMP" || die "dump is corrupt/incomplete: $DUMP" ;; esac
DUMP_EPOCH="$(stat -c %Y "$DUMP")"
log "  using ${DUMP} ($(du -h "$DUMP" | cut -f1))"

# --- 3. start database ----------------------------------------------------------------
log "Step 3/7: starting standby Postgres"
mkdir -p "$ORBIT_STATE_DIR"
dc up -d database
for i in $(seq 1 60); do
  if dc exec -T database sh -c 'pg_isready --username="$POSTGRES_USER"' >/dev/null 2>&1; then break; fi
  [ "$i" -eq 60 ] && die "Postgres did not become ready in 120 s (check: docker logs immich_postgres)"
  sleep 2
done
log "  Postgres is ready"

# --- 4. restore -----------------------------------------------------------------------
log "Step 4/7: restoring dump (pg_dumpall --clean --if-exists: drops and recreates objects)"
# Make sure no server connections hold the DB while we restore.
dc stop immich-server >/dev/null 2>&1 || true
if [[ "$DUMP" == *.gz ]]; then READER=(gunzip --stdout "$DUMP"); else READER=(cat "$DUMP"); fi
"${READER[@]}" \
  | sed "s/SELECT pg_catalog.set_config('search_path', '', false);/SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', true);/g" \
  | dc exec -T database sh -c 'psql --dbname=postgres --username="$POSTGRES_USER" --quiet -v ON_ERROR_STOP=0' >/dev/null
log "  restore finished"

# --- 5. start the rest ----------------------------------------------------------------
log "Step 5/7: starting Immich"
dc up -d
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$STATE_FILE"

# --- 6. wait for ping -----------------------------------------------------------------
log "Step 6/7: waiting for ${PING_URL}"
for i in $(seq 1 90); do
  if ping_ok; then break; fi
  [ "$i" -eq 90 ] && die "Immich did not answer 'pong' in 3 minutes (docker logs immich_server)"
  sleep 2
done
log "  Immich answers: pong"

# --- 7. report ------------------------------------------------------------------------
NOW="$(date +%s)"
LAG_H=$(( (NOW - DUMP_EPOCH) / 3600 ))
echo
log "Step 7/7: standby is ACTIVE"
echo "  Immich URL : http://${TS_IP}:2283   (point the iPhone app's server URL here)"
echo "  Dump used  : ${DUMP}"
echo "  Dump time  : $(date -d "@${DUMP_EPOCH}" '+%Y-%m-%d %H:%M:%S')  (${LAG_H} h ago)"
echo
echo "  !! DATA LAG WARNING !!"
echo "  Photos/albums/edits made on the PC after the dump are NOT in this database."
echo "  The library files are as of the last Syncthing sync. Assets uploaded to the"
echo "  standby now will exist ONLY here until you run scripts/switch-back.sh."
notify_discord "Orbit: arm-free promoted to active Immich (dump ${LAG_H} h old)."
