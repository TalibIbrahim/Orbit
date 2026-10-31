#!/usr/bin/env bash
# install-arm-free.sh - one-shot bootstrap of the Oracle Always Free Arm VM (Ubuntu 22.04/24.04 arm64).
#
#   git clone <repo> /opt/orbit-src && sudo /opt/orbit-src/deploy/arm-free/scripts/install-arm-free.sh
#
# Usage: install-arm-free.sh [--mode device|arm-free] [--no-ml]
#   --mode device   (default) Immich primary runs on a home PC; this VM is a standby replica.
#                   The Immich stack is NOT started (scripts/promote-standby.sh does that).
#   --mode arm-free Immich runs permanently on this VM (agent role "primary"), fresh DB,
#                   all other devices are Receive Only replicas. Started by this script.
#   --no-ml         arm-free mode: run Immich without the machine-learning container.
#                   (device-mode standby always has ML disabled)
# Re-run with a different --mode / --no-ml to switch; the choice is stored in .env.
#
# Installs Docker (+compose plugin), Tailscale, Node 22, restic, zstd, jq, NeverIdle;
# creates /srv/orbit/*; installs the systemd units; writes /etc/orbit/agent.json.
# Re-running is safe (idempotent); existing config/.env files are never overwritten.
#
# Env (optional): ORBIT_PRIMARY_MODE (same as --mode), IMMICH_ML=0 (same as --no-ml), ORBIT_HUB_URL, ORBIT_DEVICE_ID, TS_AUTHKEY, SKIP_NEVERIDLE=1, SKIP_START=1, SKIP_IPTABLES=1
#
# NETWORK NOTE: this script opens nothing publicly. Its only iptables change is an INPUT accept
# for the agent port (7420) from Docker bridges (br+, docker0) so the orbit-web container can
# reach the host agent; it is saved with netfilter-persistent (SKIP_IPTABLES=1 to skip).
# In the OCI console the VCN security list should have NO ingress rules except SSH (22).
# Recommended: `tailscale up --ssh`, confirm you can `ssh` over the tailnet, then remove
# the port-22 ingress rule too. Ubuntu images on OCI ship restrictive iptables rules
# already; Docker publishes only ports bound to the Tailscale IP (see docker-compose.yml).
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib.sh"

MODE="${ORBIT_PRIMARY_MODE:-device}"
ML=1
[ "${IMMICH_ML:-1}" = "0" ] && ML=0
NO_ML_FLAG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) [ $# -ge 2 ] || die "--mode needs a value (device|arm-free)"; MODE="$2"; shift 2 ;;
    --mode=*) MODE="${1#--mode=}"; shift ;;
    --no-ml) ML=0; NO_ML_FLAG=1; shift ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
case "$MODE" in device|arm-free) ;; *) die "--mode must be device or arm-free (got: ${MODE})" ;; esac
[ "$MODE" = "arm-free" ] || ML=0

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
[ -r /etc/os-release ] && . /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) die "this installer targets Ubuntu/Debian (found: ${ID:-unknown})" ;; esac
export DEBIAN_FRONTEND=noninteractive

REPO_DIR="$(cd "${ARM_FREE_DIR}/../.." && pwd)"
OPT=/opt/orbit
ARCH="$(dpkg --print-architecture)"
log "repo: ${REPO_DIR}  arch: ${ARCH}  mode: ${MODE}  ml: ${ML}"

# --- base packages -----------------------------------------------------------------------
log "installing base packages"
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl gnupg jq zstd restic rsync openssl git \
  build-essential

# --- docker ------------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker (official repo)"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  if ! apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
    warn "Docker official repo failed; falling back to docker.io"
    apt-get install -y docker.io docker-compose-v2 || apt-get install -y docker.io docker-compose-plugin
  fi
fi
systemctl enable --now docker
docker compose version >/dev/null 2>&1 || die "docker compose plugin not available"

# --- tailscale ---------------------------------------------------------------------------
if ! command -v tailscale >/dev/null 2>&1; then
  log "installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi
systemctl enable --now tailscaled
if ! tailscale ip -4 >/dev/null 2>&1; then
  if [ -n "${TS_AUTHKEY:-}" ]; then
    tailscale up --ssh --authkey "${TS_AUTHKEY}" --hostname arm-free
  else
    warn "Tailscale is not logged in. Run:  sudo tailscale up --ssh --hostname arm-free   then re-run this script."
  fi
fi
TS_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
TS_DNS="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' 2>/dev/null | sed 's/\.$//' || true)"

# --- node 22 -----------------------------------------------------------------------------
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  log "installing Node 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# --- directories -------------------------------------------------------------------------
log "creating ${ORBIT_ROOT} layout"
mkdir -p "${ORBIT_ROOT}"/{immich-library,immich-db-dumps,immich-standby-db,immich-db,immich-ml-cache} \
         "${ORBIT_ROOT}"/{syncthing-config,orbit-data,replicas} \
         /etc/orbit /var/lib/orbit "${OPT}/agent" "${OPT}/bin"
# Syncthing (uid 1000) and the hub image (node, uid 1000) share ownership.
chown 1000:1000 "${ORBIT_ROOT}"/{immich-library,immich-db-dumps,syncthing-config,orbit-data,replicas}
# Syncthing must not ship half-written dumps (immich-dump.sh writes *.partial, then renames).
if [ ! -f "${ORBIT_ROOT}/immich-db-dumps/.stignore" ]; then
  echo '*.partial' > "${ORBIT_ROOT}/immich-db-dumps/.stignore"
  chown 1000:1000 "${ORBIT_ROOT}/immich-db-dumps/.stignore"
fi
chmod 700 /etc/orbit
ln -sfn "${REPO_DIR}/deploy" "${OPT}/deploy"
chmod +x "${ARM_FREE_DIR}"/scripts/*.sh

# --- .env for the compose stacks ---------------------------------------------------------
if [ ! -f "${ARM_FREE_DIR}/.env" ]; then
  cp "${ARM_FREE_DIR}/.env.example" "${ARM_FREE_DIR}/.env"
  [ -n "$TS_IP" ] && sed -i "s|^TAILSCALE_IP=.*|TAILSCALE_IP=${TS_IP}|" "${ARM_FREE_DIR}/.env"
  [ -n "${ORBIT_HUB_URL:-}" ] && sed -i "s|^ORBIT_HUB_URL=.*|ORBIT_HUB_URL=${ORBIT_HUB_URL}|" "${ARM_FREE_DIR}/.env"
  chmod 600 "${ARM_FREE_DIR}/.env"
  log "wrote ${ARM_FREE_DIR}/.env (review it)"
fi
# Mode switch: always (re)written, so re-running with --mode changes it.
MAIN_ENV="${ARM_FREE_DIR}/.env"
set_kv() { # file key value
  if grep -qE "^$2=" "$1"; then sed -i "s|^$2=.*|$2=$3|" "$1"; else echo "$2=$3" >> "$1"; fi
}
set_kv "$MAIN_ENV" ORBIT_PRIMARY_MODE "$MODE"
IMMICH_URL=""
if [ "$MODE" = "arm-free" ]; then
  if [ -n "$TS_DNS" ]; then IMMICH_URL="http://${TS_DNS}:2283"
  elif [ -n "$TS_IP" ]; then IMMICH_URL="http://${TS_IP}:2283"; fi
  if [ -n "$IMMICH_URL" ] && [ -z "$(env_file_get "$MAIN_ENV" ORBIT_IMMICH_URL)" ]; then
    set_kv "$MAIN_ENV" ORBIT_IMMICH_URL "$IMMICH_URL"
  fi
fi
IMMICH_URL="$(env_file_get "$MAIN_ENV" ORBIT_IMMICH_URL)"

IMMICH_ENV="${ARM_FREE_DIR}/immich/.env"
# Installs from before the immich-standby -> immich rename: keep the existing standby settings.
if [ ! -f "$IMMICH_ENV" ] && [ "$MODE" = "device" ] && [ -f "${ARM_FREE_DIR}/immich-standby/.env" ]; then
  cp "${ARM_FREE_DIR}/immich-standby/.env" "$IMMICH_ENV"
  chmod 600 "$IMMICH_ENV"
  log "migrated immich-standby/.env -> immich/.env"
fi
if [ ! -f "$IMMICH_ENV" ]; then
  cp "${ARM_FREE_DIR}/immich/.env.example" "$IMMICH_ENV"
  [ -n "$TS_IP" ] && sed -i "s|^TAILSCALE_IP=.*|TAILSCALE_IP=${TS_IP}|" "$IMMICH_ENV"
  if [ "$MODE" = "arm-free" ]; then
    set_kv "$IMMICH_ENV" DB_DATA_LOCATION /srv/orbit/immich-db
    set_kv "$IMMICH_ENV" DB_PASSWORD "$(openssl rand -hex 24)"
    if [ "$ML" = "1" ]; then set_kv "$IMMICH_ENV" COMPOSE_PROFILES ml; else set_kv "$IMMICH_ENV" COMPOSE_PROFILES ""; fi
  else
    set_kv "$IMMICH_ENV" DB_DATA_LOCATION /srv/orbit/immich-standby-db
    set_kv "$IMMICH_ENV" COMPOSE_PROFILES ""
    warn "edit ${IMMICH_ENV}: IMMICH_POSTGRES_IMAGE and DB_PASSWORD must match the PC"
  fi
  chmod 600 "$IMMICH_ENV"
elif [ "$NO_ML_FLAG" = "1" ]; then
  set_kv "$IMMICH_ENV" COMPOSE_PROFILES ""
  log "ML disabled in ${IMMICH_ENV}"
fi

# Immich config file (read-only in the admin UI while mounted): ML on/off + job concurrency 1.
IMMICH_CFG="${ARM_FREE_DIR}/immich/immich-config.json"
if [ ! -f "$IMMICH_CFG" ]; then
  jq --argjson ml "$([ "$ML" = "1" ] && echo true || echo false)" '.machineLearning.enabled=$ml'     "${ARM_FREE_DIR}/immich/immich-config.example.json" > "${IMMICH_CFG}.tmp"
  mv "${IMMICH_CFG}.tmp" "$IMMICH_CFG"
elif [ "$NO_ML_FLAG" = "1" ] || [ "$MODE" = "device" ]; then
  jq '.machineLearning.enabled=false' "$IMMICH_CFG" > "${IMMICH_CFG}.tmp" && mv "${IMMICH_CFG}.tmp" "$IMMICH_CFG"
fi

# --- agent bundle ------------------------------------------------------------------------
HUB_URL="${ORBIT_HUB_URL:-$(env_file_get "${ARM_FREE_DIR}/.env" ORBIT_HUB_URL)}"
BUNDLE="${OPT}/agent/orbit-agent.mjs"
if [ ! -f "$BUNDLE" ]; then
  if [ -f "${REPO_DIR}/agent/dist/orbit-agent.mjs" ]; then
    cp "${REPO_DIR}/agent/dist/orbit-agent.mjs" "$BUNDLE"
  else
    log "building the agent bundle from source (first install; later updates come from the hub)"
    (cd "$REPO_DIR" && npm ci && npm run build -w agent)
    cp "${REPO_DIR}/agent/dist/orbit-agent.mjs" "$BUNDLE"
  fi
fi

# --- NeverIdle (Oracle idle-reclamation keepalive, spawned by the agent) -----------------
if [ "${SKIP_NEVERIDLE:-0}" != "1" ] && [ ! -x "${OPT}/bin/NeverIdle" ]; then
  log "downloading NeverIdle (linux/arm64)"
  case "$ARCH" in arm64) PAT='linux.*arm64' ;; amd64) PAT='linux.*amd64' ;; *) PAT='' ;; esac
  if [ -n "$PAT" ]; then
    URL="$(curl -fsSL https://api.github.com/repos/layou233/NeverIdle/releases/latest \
            | jq -r --arg p "$PAT" '[.assets[] | select(.name | test($p; "i")) | .browser_download_url][0] // empty')"
    if [ -n "$URL" ]; then
      curl -fsSL "$URL" -o "${OPT}/bin/NeverIdle"
      chmod +x "${OPT}/bin/NeverIdle"
    else
      warn "no matching NeverIdle asset found; install it manually to ${OPT}/bin/NeverIdle"
    fi
  fi
fi

# --- agent config ------------------------------------------------------------------------
CFG=/etc/orbit/agent.json
if [ ! -f "$CFG" ]; then
  TOKEN="$(openssl rand -hex 24)"
  DEVICE_ID="${ORBIT_DEVICE_ID:-arm-free}"
  if [ "$MODE" = "arm-free" ]; then TEMPLATE="${ARM_FREE_DIR}/agent.primary.example.json"; else TEMPLATE="${ARM_FREE_DIR}/agent.example.json"; fi
  jq --arg t "$TOKEN" --arg d "$DEVICE_ID" --arg h "${HUB_URL:-http://${TS_IP:-127.0.0.1}:3000}" \
     --arg ip "${TS_IP:-0.0.0.0}" \
     '.token=$t | .deviceId=$d | .hubUrl=$h | .listen.host=$ip' \
     "$TEMPLATE" > "${CFG}.tmp"
  mv "${CFG}.tmp" "$CFG"
  # Readable by the orbit-web container (uid 1000), which mounts it to auto-register this agent.
  chown root:1000 "$CFG"
  chmod 640 "$CFG"
  log "generated ${CFG}"
  echo "----------------------------------------------------------------"
  echo " deviceId: ${DEVICE_ID}"
  echo " token   : ${TOKEN}"
  echo " The hub registers this agent automatically (compose mounts /etc/orbit/agent.json)."
  echo "----------------------------------------------------------------"
elif [ "$MODE" = "arm-free" ]; then
  # Existing config (e.g. from a device-mode install): migrate it in place to the arm-free primary
  # layout. deviceId, token, hubUrl, listen and any other custom fields are kept.
  #  - role "primary", no promote block, keep-alive not on by default
  #  - stale leftovers removed: jobs whose script (absolute command / *.sh|*.py|*.ps1 arg) no longer
  #    exists, and services whose Docker containers and systemd units no longer exist on this host
  #  - "immich" service and the 02:30 "immich-db" dump job taken from agent.primary.example.json
  #  - restic jobs kept/added only if /etc/orbit/restic-password exists and a repository is set
  #    (RESTIC_REPOSITORY env, or the value already in the restic job); otherwise removed
  #  - other jobs (e.g. prune-dumps) kept
  # Idempotent: the file is only rewritten (with a .bak-<timestamp> copy) when something changes.
  CUR_REPO="$(jq -r '[.jobs[]? | select(.kind == "restic" or .id == "restic") | .env.RESTIC_REPOSITORY // empty][0] // empty' "$CFG" 2>/dev/null || true)"
  REPO="${RESTIC_REPOSITORY:-$CUR_REPO}"
  RESTIC_OK=false
  if [ -f /etc/orbit/restic-password ] && [ -n "$REPO" ] && [[ "$REPO" != REPLACE* ]]; then RESTIC_OK=true; fi
  # Script paths referenced by jobs that are gone from disk.
  MISSING="$(jq -r '.jobs[]? | (.command // empty), (.args // [] | .[] | select(type == "string" and test("\\.(sh|py|ps1)$")))' "$CFG" 2>/dev/null \
    | while IFS= read -r f; do case "$f" in /*) [ -e "$f" ] || printf '%s\n' "$f" ;; esac; done | jq -R . | jq -s -c .)"
  # Existing containers / units; "null" = unknown (tool unavailable), then nothing is judged stale on it.
  CONTAINERS=null; UNITS=null
  if NAMES="$(docker ps -a --format '{{.Names}}' 2>/dev/null)"; then CONTAINERS="$(printf '%s\n' "$NAMES" | sed '/^$/d' | jq -R . | jq -s -c .)"; fi
  if UNIT_LIST="$(systemctl list-unit-files --no-legend --plain 2>/dev/null | awk '{print $1}')"; then UNITS="$(printf '%s\n' "$UNIT_LIST" | sed '/^$/d' | jq -R . | jq -s -c .)"; fi
  jq --slurpfile tpl "${ARM_FREE_DIR}/agent.primary.example.json" --argjson resticOk "$RESTIC_OK" --arg repo "$REPO" \
     --argjson missing "$MISSING" --argjson containers "$CONTAINERS" --argjson units "$UNITS" '
    def staleJob: [(.command // empty), (.args // [] | .[] | select(type == "string"))] | any(. as $f | $missing | any(. == $f));
    def gone($have; $want): $have != null and ($want | length) > 0
      and ($want | all(. as $p | $have | all(startswith($p) | not)));
    def staleSvc: ((.containers // []) | length) + ((.systemdUnits // []) | length) > 0
      and ((.containers // []) | length == 0 or gone($containers; .))
      and ((.systemdUnits // []) | length == 0 or gone($units; .));
    def isRestic: .kind == "restic" or .id == "restic";
    $tpl[0] as $t
    | .role = "primary"
    | del(.promote)
    | (if .keepalive then .keepalive.defaultEnabled = false else . end)
    | .services = ([$t.services[] | select(.name == "immich")]
        + [(.services // [])[] | select((staleSvc | not) and .name != "immich")]
        | . as $s | $s + [$t.services[] | select(.name as $n | any($s[]; .name == $n) | not)])
    | .jobs = ((.jobs // []) as $j
        | [$j[] | select((staleJob | not) and (isRestic | not) and .id != "immich-db")] as $keep
        | [$t.jobs[] | select(.id == "immich-db")]
          + $keep
          + (if $resticOk then
               ([$j[] | select(isRestic)] | if length > 0 then . else [$t.jobs[] | select(isRestic)] end)
               | map(.env = ((.env // {}) + {RESTIC_REPOSITORY: $repo, RESTIC_PASSWORD_FILE: (.env.RESTIC_PASSWORD_FILE // "/etc/orbit/restic-password")}))
             else [] end))
  ' "$CFG" > "${CFG}.new"
  if cmp -s <(jq -S . "$CFG") <(jq -S . "${CFG}.new"); then
    rm -f "${CFG}.new"
    log "${CFG} already matches arm-free primary mode"
  else
    BAK="${CFG}.bak-$(date +%Y%m%d-%H%M%S)"
    cp -p "$CFG" "$BAK"
    cat "${CFG}.new" > "$CFG"   # keep owner/mode of the original file
    rm -f "${CFG}.new"
    chown root:1000 "$CFG"
    chmod 640 "$CFG"
    CFG_CHANGED=1
    log "migrated ${CFG} to arm-free primary mode (backup: ${BAK})"
    log "  jobs: $(jq -r '[.jobs[].id] | join(", ")' "$CFG")"
    [ "$RESTIC_OK" = true ] || warn "restic job left out: needs /etc/orbit/restic-password and RESTIC_REPOSITORY (re-run with RESTIC_REPOSITORY=... to add it)"
  fi
else
  log "${CFG} exists; left untouched"
  HAVE_ROLE="$(jq -r '.role // empty' "$CFG" 2>/dev/null || true)"
  [ "$HAVE_ROLE" = "standby" ] || warn "${CFG} has role '${HAVE_ROLE}' but device mode expects 'standby'; edit it by hand (see agent.example.json)"
fi

# --- iptables: agent port from Docker bridges ---------------------------------------------
# OCI Ubuntu images end the INPUT chain with a REJECT, which also blocks orbit-web (a container
# on a compose bridge br-<id>) from reaching the host agent at <TAILSCALE_IP>:7420. Accept only
# that port, only from Docker bridge interfaces; tailnet/public access is unchanged.
if [ "${SKIP_IPTABLES:-0}" != "1" ]; then
  AGENT_PORT="$(jq -r '.listen.port // 7420' "$CFG" 2>/dev/null || echo 7420)"
  case "$AGENT_PORT" in ''|*[!0-9]*) AGENT_PORT=7420 ;; esac
  if ! command -v netfilter-persistent >/dev/null 2>&1; then
    log "installing iptables-persistent"
    echo "iptables-persistent iptables-persistent/autosave_v4 boolean false" | debconf-set-selections
    echo "iptables-persistent iptables-persistent/autosave_v6 boolean false" | debconf-set-selections
    apt-get install -y --no-install-recommends iptables-persistent netfilter-persistent
  fi
  CHANGED=0
  for IFACE in 'br+' docker0; do
    RULE=(INPUT -i "$IFACE" -p tcp --dport "$AGENT_PORT" -m comment --comment orbit-agent-from-docker -j ACCEPT)
    if ! iptables -C "${RULE[@]}" 2>/dev/null; then
      # Insert at the top so it precedes the image's final REJECT rule.
      iptables -I "${RULE[@]:0:1}" 1 "${RULE[@]:1}"
      CHANGED=1
      log "iptables: accept tcp/${AGENT_PORT} on ${IFACE}"
    fi
  done
  if [ "$CHANGED" = "1" ] || ! grep -q orbit-agent-from-docker /etc/iptables/rules.v4 2>/dev/null; then
    netfilter-persistent save >/dev/null
    log "iptables rules saved (netfilter-persistent)"
  fi
fi

# --- systemd -----------------------------------------------------------------------------
log "installing systemd units"
install -m 0644 "${ARM_FREE_DIR}"/systemd/orbit-agent.service /etc/systemd/system/
install -m 0644 "${ARM_FREE_DIR}"/systemd/orbit-update.service /etc/systemd/system/
install -m 0644 "${ARM_FREE_DIR}"/systemd/orbit-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable orbit-update.timer
if [ "${SKIP_START:-0}" = "1" ] && [ "${CFG_CHANGED:-0}" = "1" ]; then
  systemctl try-restart orbit-agent.service || true   # running agent must pick up the migrated config
fi
if [ "${SKIP_START:-0}" != "1" ]; then
  systemctl enable orbit-agent.service
  systemctl restart orbit-agent.service
  systemctl start orbit-update.timer
  if [ -n "$TS_IP" ]; then
    log "starting the main stack (hub, syncthing)"
    (cd "$ARM_FREE_DIR" && docker compose up -d --build)
    # The hub reads agent.json (role) only at startup.
    [ "${CFG_CHANGED:-0}" = "1" ] && docker restart orbit-web >/dev/null && log "restarted orbit-web to pick up the new agent role"
    if [ "$MODE" = "arm-free" ]; then
      log "starting Immich (primary, fresh database)"
      (cd "${ARM_FREE_DIR}/immich" && docker compose up -d)
    fi
  else
    warn "Tailscale not up yet; start the stack later: cd ${ARM_FREE_DIR} && docker compose up -d --build"
  fi
fi

echo
log "arm-free bootstrap complete"
echo "  Hub        : http://${TS_IP:-<tailscale-ip>}:3000"
echo "  Agent      : systemctl status orbit-agent   (port 7420 on the Tailscale IP)"
echo "  Syncthing  : ssh -L 8384:127.0.0.1:8384 arm-free  ->  http://127.0.0.1:8384"
echo "  Mode       : ${MODE}"
if [ "$MODE" = "arm-free" ]; then
  echo "  Immich     : ${IMMICH_URL:-http://<tailscale-ip>:2283}  (primary, ML $([ "$ML" = "1" ] && echo on || echo off))"
  echo "  Note       : promote/switch-back do not apply; disaster recovery: docs/failover-restore.md"
else
  echo "  Standby    : NOT running (by design). Fail over with ${OPT}/deploy/arm-free/scripts/promote-standby.sh"
fi
echo "  Next       : close OCI ingress on 22 once 'tailscale ssh' works; pair Syncthing from the hub."
