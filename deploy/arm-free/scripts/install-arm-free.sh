#!/usr/bin/env bash
# install-arm-free.sh - one-shot bootstrap of the Oracle Always Free Arm VM (Ubuntu 22.04/24.04 arm64).
#
#   git clone <repo> /opt/orbit-src && sudo /opt/orbit-src/deploy/arm-free/scripts/install-arm-free.sh
#
# Installs Docker (+compose plugin), Tailscale, Node 22, restic, zstd, jq, NeverIdle;
# creates /srv/orbit/*; installs the systemd units; writes /etc/orbit/agent.json.
# Re-running is safe (idempotent); existing config/.env files are never overwritten.
#
# Env (optional): ORBIT_HUB_URL, ORBIT_DEVICE_ID, TS_AUTHKEY, SKIP_NEVERIDLE=1, SKIP_START=1
#
# NETWORK NOTE: this script opens nothing publicly and does not touch iptables.
# In the OCI console the VCN security list should have NO ingress rules except SSH (22).
# Recommended: `tailscale up --ssh`, confirm you can `ssh` over the tailnet, then remove
# the port-22 ingress rule too. Ubuntu images on OCI ship restrictive iptables rules
# already; Docker publishes only ports bound to the Tailscale IP (see docker-compose.yml).
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib.sh"

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
[ -r /etc/os-release ] && . /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) die "this installer targets Ubuntu/Debian (found: ${ID:-unknown})" ;; esac
export DEBIAN_FRONTEND=noninteractive

REPO_DIR="$(cd "${ARM_FREE_DIR}/../.." && pwd)"
OPT=/opt/orbit
ARCH="$(dpkg --print-architecture)"
log "repo: ${REPO_DIR}  arch: ${ARCH}"

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

# --- node 22 -----------------------------------------------------------------------------
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  log "installing Node 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# --- directories -------------------------------------------------------------------------
log "creating ${ORBIT_ROOT} layout"
mkdir -p "${ORBIT_ROOT}"/{immich-library,immich-db-dumps,minecraft-backups/30min,minecraft-backups/daily,immich-standby-db} \
         "${ORBIT_ROOT}"/{minecraft-data,syncthing-config,orbit-data,replicas} \
         /etc/orbit /var/lib/orbit "${OPT}/agent" "${OPT}/bin"
# Syncthing (uid 1000), the hub image (node, uid 1000) and Minecraft (itzg, uid 1000) share ownership.
chown 1000:1000 "${ORBIT_ROOT}"/{immich-library,immich-db-dumps,minecraft-backups,minecraft-data,syncthing-config,orbit-data,replicas}
chown -R 1000:1000 "${ORBIT_ROOT}/minecraft-backups"
chmod 700 /etc/orbit
ln -sfn "${REPO_DIR}/deploy" "${OPT}/deploy"
chmod +x "${ARM_FREE_DIR}"/scripts/*.sh

# --- .env for the compose stacks ---------------------------------------------------------
if [ ! -f "${ARM_FREE_DIR}/.env" ]; then
  cp "${ARM_FREE_DIR}/.env.example" "${ARM_FREE_DIR}/.env"
  RCON_PW="$(openssl rand -hex 16)"
  sed -i "s|^RCON_PASSWORD=.*|RCON_PASSWORD=${RCON_PW}|" "${ARM_FREE_DIR}/.env"
  [ -n "$TS_IP" ] && sed -i "s|^TAILSCALE_IP=.*|TAILSCALE_IP=${TS_IP}|" "${ARM_FREE_DIR}/.env"
  [ -n "${ORBIT_HUB_URL:-}" ] && sed -i "s|^ORBIT_HUB_URL=.*|ORBIT_HUB_URL=${ORBIT_HUB_URL}|" "${ARM_FREE_DIR}/.env"
  chmod 600 "${ARM_FREE_DIR}/.env"
  log "wrote ${ARM_FREE_DIR}/.env (review it)"
fi
if [ ! -f "${ARM_FREE_DIR}/immich-standby/.env" ]; then
  cp "${ARM_FREE_DIR}/immich-standby/.env.example" "${ARM_FREE_DIR}/immich-standby/.env"
  [ -n "$TS_IP" ] && sed -i "s|^TAILSCALE_IP=.*|TAILSCALE_IP=${TS_IP}|" "${ARM_FREE_DIR}/immich-standby/.env"
  chmod 600 "${ARM_FREE_DIR}/immich-standby/.env"
  warn "edit ${ARM_FREE_DIR}/immich-standby/.env: IMMICH_POSTGRES_IMAGE and DB_PASSWORD must match the PC"
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
  jq --arg t "$TOKEN" --arg d "$DEVICE_ID" --arg h "${HUB_URL:-http://${TS_IP:-127.0.0.1}:3000}" \
     --arg ip "${TS_IP:-0.0.0.0}" \
     '.token=$t | .deviceId=$d | .hubUrl=$h | .listen.host=$ip' \
     "${ARM_FREE_DIR}/agent.example.json" > "${CFG}.tmp"
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
else
  log "${CFG} exists; left untouched"
fi

# --- systemd -----------------------------------------------------------------------------
log "installing systemd units"
install -m 0644 "${ARM_FREE_DIR}"/systemd/orbit-agent.service /etc/systemd/system/
install -m 0644 "${ARM_FREE_DIR}"/systemd/orbit-update.service /etc/systemd/system/
install -m 0644 "${ARM_FREE_DIR}"/systemd/orbit-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable orbit-update.timer
if [ "${SKIP_START:-0}" != "1" ]; then
  systemctl enable orbit-agent.service
  systemctl restart orbit-agent.service
  systemctl start orbit-update.timer
  if [ -n "$TS_IP" ]; then
    log "starting the main stack (hub, minecraft, syncthing)"
    (cd "$ARM_FREE_DIR" && docker compose up -d --build)
  else
    warn "Tailscale not up yet; start the stack later: cd ${ARM_FREE_DIR} && docker compose up -d --build"
  fi
fi

echo
log "arm-free bootstrap complete"
echo "  Hub        : http://${TS_IP:-<tailscale-ip>}:3000"
echo "  Agent      : systemctl status orbit-agent   (port 7420 on the Tailscale IP)"
echo "  Syncthing  : ssh -L 8384:127.0.0.1:8384 arm-free  ->  http://127.0.0.1:8384"
echo "  Standby    : NOT running (by design). Fail over with ${OPT}/deploy/arm-free/scripts/promote-standby.sh"
echo "  Next       : close OCI ingress on 22 once 'tailscale ssh' works; pair Syncthing from the hub."
