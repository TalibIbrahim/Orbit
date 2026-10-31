#!/usr/bin/env bash
# update.sh - pull newer images and recreate changed services (run daily by orbit-update.timer).
#
#  * main stack: docker compose pull (skips buildable orbit-web), up -d
#  * immich-standby: only if its containers are currently running (promoted)
#  * reports changed images to $DISCORD_WEBHOOK_URL (if set) and the journal/log
#  * optional: ORBIT_AUTO_BUILD=1 rebuilds orbit-web from the checked-out repo
#
# The Orbit agent updates itself (it replaces its bundle and exits; systemd restarts it).
# The Immich tag is pinned to the major (v3), so only minor/patch updates arrive automatically.
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib.sh"
need docker
load_main_env

CHANGED=()
FAILED=()

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
  if [ "${ORBIT_AUTO_BUILD:-0}" = "1" ] && [ "$label" = "main" ]; then
    log "[main] rebuilding orbit-web"
    docker compose -f "$compose" --project-directory "$(dirname "$compose")" build --pull orbit-web || FAILED+=("main: build failed")
  fi
  # `up -d` only recreates services whose image/config changed.
  docker compose -f "$compose" --project-directory "$(dirname "$compose")" up -d --remove-orphans \
    || FAILED+=("${label}: up -d failed")
}

update_stack main "$MAIN_COMPOSE"

if [ -f "$IMMICH_COMPOSE" ] \
   && [ -n "$(docker compose -f "$IMMICH_COMPOSE" --project-directory "$(dirname "$IMMICH_COMPOSE")" ps -q 2>/dev/null || true)" ]; then
  update_stack immich-standby "$IMMICH_COMPOSE"
else
  log "[immich-standby] not running, skipped"
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
