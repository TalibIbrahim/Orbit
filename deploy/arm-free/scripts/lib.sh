#!/usr/bin/env bash
# Shared helpers for the Orbit arm-free scripts. Source it, do not execute it.
# shellcheck shell=bash

ORBIT_ROOT="${ORBIT_ROOT:-/srv/orbit}"
ORBIT_STATE_DIR="${ORBIT_STATE_DIR:-/var/lib/orbit}"

# Resolve directories relative to this file (works through the /opt/orbit/deploy symlink).
LIB_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
ARM_FREE_DIR="$(cd "${LIB_DIR}/.." && pwd)"
MAIN_COMPOSE="${ARM_FREE_DIR}/docker-compose.yml"
IMMICH_COMPOSE="${ARM_FREE_DIR}/immich/docker-compose.yml"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { printf '[%s] %s\n' "$(ts)" "$*"; }
warn() { printf '[%s] WARN: %s\n' "$(ts)" "$*" >&2; }
die() { printf '[%s] ERROR: %s\n' "$(ts)" "$*" >&2; exit 1; }

need() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "required command not found: ${c}"
  done
}

# Read KEY from an env file without sourcing it (values may contain odd characters).
env_file_get() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true
}

# Load .env of the main stack into the environment for variables we need (does not override).
load_main_env() {
  local k v
  for k in DISCORD_WEBHOOK_URL ORBIT_HUB_URL TAILSCALE_IP; do
    if [ -z "${!k:-}" ]; then
      v="$(env_file_get "${ARM_FREE_DIR}/.env" "$k")"
      [ -n "$v" ] && export "$k=$v"
    fi
  done
  return 0
}

# Post a message to Discord (best effort).
notify_discord() {
  local msg="$1"
  [ -n "${DISCORD_WEBHOOK_URL:-}" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  command -v jq >/dev/null 2>&1 || return 0
  curl -fsS -m 15 -H 'Content-Type: application/json' \
    -d "$(jq -n --arg c "$msg" '{content: $c}')" \
    "$DISCORD_WEBHOOK_URL" >/dev/null 2>&1 || warn "Discord notification failed"
  return 0
}

# Free space (GB, integer) on the filesystem holding $1.
free_gb() { df -Pk "$1" | awk 'NR==2 {print int($4/1024/1024)}'; }
