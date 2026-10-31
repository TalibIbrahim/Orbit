#!/usr/bin/env bash
# update.sh - pull newer images and recreate changed services (run daily by orbit-update.timer).
#
#  * main stack: docker compose pull (skips buildable orbit-web), up -d
#  * immich: arm-free mode always; device mode only if its containers are running (promoted)
#  * reports changed images to $DISCORD_WEBHOOK_URL (if set) and the journal/log
#  * Orbit code: git fetch + fast-forward, then install-arm-free.sh rebuilds/restarts everything
#    (ORBIT_SELF_UPDATE=0 disables); status in /var/lib/orbit/update-status.json
#  * optional: ORBIT_AUTO_BUILD=1 rebuilds orbit-web (skipped when the code step already did)
#
# The Orbit agent updates itself (it replaces its bundle and exits; systemd restarts it).
# The Immich tag is pinned to the major (v3), so only minor/patch updates arrive automatically.
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib.sh"

CHANGED=()
FAILED=()
CODE_CHANGED=0
STEP="starting"
STARTED=0 TRIGGER=manual FROM_COMMIT="" TO_COMMIT="" RESULT_MSG=""
STATUS_FILE="${ORBIT_STATE_DIR}/update-status.json"

image_ids() {
  # Prints "image id" lines for all images referenced by the compose file.
  local compose="$1" img id
  while IFS= read -r img; do
    [ -n "$img" ] || continue
    id="$(docker image inspect -f '{{.Id}}' "$img" 2>/dev/null || echo none)"
    printf '%s %s\n' "$img" "$id"
  done < <(docker compose -f "$compose" --project-directory "$(dirname "$compose")" config --images 2>/dev/null | sort -u)
}

update_stack() {
  local label="$1" compose="$2" before after img
  before="$(image_ids "$compose")"
  log "[${label}] pulling"
  if ! docker compose -f "$compose" --project-directory "$(dirname "$compose")" pull --ignore-buildable --quiet; then
    FAILED+=("$label: pull failed"); return 0
  fi
  after="$(image_ids "$compose")"
  if [ "$before" != "$after" ]; then
    while IFS= read -r line; do
      img="${line%% *}"
      if ! grep -qxF "$line" <<< "$before"; then CHANGED+=("${label}: ${img}"); fi
    done <<< "$after"
  fi
  if [ "${ORBIT_AUTO_BUILD:-0}" = "1" ] && [ "$label" = "main" ] && [ "$CODE_CHANGED" != "1" ]; then
    log "[main] rebuilding orbit-web"
    docker compose -f "$compose" --project-directory "$(dirname "$compose")" build --pull orbit-web || FAILED+=("main: build failed")
  fi
  # `up -d` only recreates services whose image/config changed.
  docker compose -f "$compose" --project-directory "$(dirname "$compose")" up -d --remove-orphans \
    || FAILED+=("${label}: up -d failed")
}

write_status() { # finishedAt ok(true|false|null) message
  local fin="$1" ok="$2" msg="$3" tmp="${STATUS_FILE}.tmp"
  mkdir -p "$(dirname "$STATUS_FILE")"
  jq -n --argjson s "$STARTED" --argjson f "$fin" --argjson ok "$ok" --arg t "$TRIGGER"         --arg from "$FROM_COMMIT" --arg to "$TO_COMMIT" --arg m "$msg"     '{startedAt: $s, finishedAt: $f, ok: $ok, trigger: $t,
      fromCommit: (if $from == "" then null else $from end),
      toCommit: (if $to == "" then null else $to end), message: $m}' > "$tmp"     && mv -f "$tmp" "$STATUS_FILE" || warn "could not write ${STATUS_FILE}"
}

on_exit() {
  local rc=$? msg ok=true
  trap - EXIT
  if [ "$rc" -ne 0 ] || [ "${#FAILED[@]}" -gt 0 ]; then
    ok=false
    if [ "${#FAILED[@]}" -gt 0 ]; then msg="${FAILED[*]}"; else msg="failed at: ${STEP}"; fi
    [ -z "$RESULT_MSG" ] || msg="${RESULT_MSG}; ${msg}"
    if [ "$rc" -ne 0 ] && [ "${#FAILED[@]}" -eq 0 ]; then
      notify_discord "Orbit auto-update on $(hostname) FAILED: ${msg}"
    fi
  else
    msg="${RESULT_MSG:-ok}"
  fi
  write_status "$(date +%s000)" "$ok" "$msg"
  exit "$rc"
}

self_update() {
  STEP="Orbit code"
  local repo from to dirty
  repo="$(git -C "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" rev-parse --show-toplevel)"
  git_r() { git -c safe.directory="$repo" -C "$repo" "$@"; }
  FROM_COMMIT="$(git_r rev-parse --short=7 HEAD)"
  write_status null null "running"
  log "[code] fetching ${repo}"
  git_r fetch --quiet origin
  if [ "$(git_r rev-parse HEAD)" = "$(git_r rev-parse '@{u}')" ]; then
    RESULT_MSG="already up to date"; TO_COMMIT="$FROM_COMMIT"
    log "[code] already up to date (${FROM_COMMIT})"
    return 0
  fi
  dirty="$(git_r status --porcelain --untracked-files=no)"
  if [ -n "$dirty" ]; then
    RESULT_MSG="local changes in ${repo}, not updating"
    FAILED+=("$RESULT_MSG")
    RESULT_MSG=""
    return 0
  fi
  git_r merge --ff-only --quiet '@{u}'
  to="$(git_r rev-parse --short=7 HEAD)"
  TO_COMMIT="$to"
  if [ "$to" = "$FROM_COMMIT" ]; then RESULT_MSG="already up to date"; return 0; fi
  CODE_CHANGED=1
  STEP="install-arm-free.sh"
  log "[code] ${FROM_COMMIT} -> ${to}; running install-arm-free.sh"
  local mode; mode="$(env_file_get "${ARM_FREE_DIR}/.env" ORBIT_PRIMARY_MODE)"
  SKIP_NEVERIDLE=1 "${repo}/deploy/arm-free/scripts/install-arm-free.sh" --mode "${mode:-device}"
  RESULT_MSG="updated ${FROM_COMMIT} -> ${to}"
  notify_discord "Orbit on $(hostname): ${RESULT_MSG}"
}

main() {
  need docker jq git flock
  load_main_env
  exec 9>/run/orbit-update.lock
  flock -n 9 || die "another orbit-update is already running"
  STARTED="$(date +%s000)"
  if [ -f "${ORBIT_STATE_DIR}/update-trigger" ]; then
    TRIGGER="$(tr -d '[:space:]' < "${ORBIT_STATE_DIR}/update-trigger" || true)"
    rm -f "${ORBIT_STATE_DIR}/update-trigger"
    [ -n "$TRIGGER" ] || TRIGGER=manual
  elif [ -n "${INVOCATION_ID:-}" ]; then TRIGGER=timer
  fi
  trap on_exit EXIT
  write_status null null "running"
  if [ "${ORBIT_SELF_UPDATE:-1}" != "0" ]; then self_update; fi
  STEP="images"

  update_stack main "$MAIN_COMPOSE"

  # arm-free mode: Immich is the primary and is always updated. device mode: only while promoted.
  if [ "$(env_file_get "${ARM_FREE_DIR}/.env" ORBIT_PRIMARY_MODE)" = "arm-free" ] && [ -f "$IMMICH_COMPOSE" ]; then
    update_stack immich "$IMMICH_COMPOSE"
  elif [ -f "$IMMICH_COMPOSE" ] \
     && [ -n "$(docker compose -f "$IMMICH_COMPOSE" --project-directory "$(dirname "$IMMICH_COMPOSE")" ps -q 2>/dev/null || true)" ]; then
    update_stack immich "$IMMICH_COMPOSE"
  else
    log "[immich] standby not running, skipped"
  fi

  docker image prune -f >/dev/null || true

  if [ "${#CHANGED[@]}" -gt 0 ]; then
    MSG="Orbit auto-update on $(hostname): updated ${#CHANGED[@]} image(s):"$'\n'"$(printf -- '- %s\n' "${CHANGED[@]}")"
    log "$MSG"
    notify_discord "$MSG"
  else
    log "no image changes"
  fi
  if [ "${#FAILED[@]}" -gt 0 ]; then
    MSG="Orbit auto-update on $(hostname) had problems: ${FAILED[*]}"
    warn "$MSG"
    notify_discord "$MSG"
    exit 1
  fi
}

main "$@"; exit $?
