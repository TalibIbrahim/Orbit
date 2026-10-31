#!/usr/bin/env bash
# make-capped-folder.sh - create a folder with a HARD size cap (Linux "hard" enforcement mode).
#
#   sudo make-capped-folder.sh <path> <sizeGB> [--migrate]
#
# How: a sparse-free (fallocate) image file /srv/orbit/.capped/<name>.img is formatted
# ext4 (-m 0: no reserved blocks) and loop-mounted on <path> via /etc/fstab
# (loop,nofail). Writes beyond <sizeGB> fail with ENOSPC, so Syncthing/Immich/your apps
# cannot overrun the quota. The space is reserved up front (fallocate), so make sure
# the sum of all caps fits the 200 GB Oracle volume.
#
# --migrate: the target is non-empty; its contents are rsynced into the new volume
#            (stop the services writing there first!). Without it, a non-empty path is refused.
#
# ALTERNATIVE (no image file, more flexible, but needs a filesystem mounted with the
# right option): project quotas.
#   XFS : mount with `prjquota`; echo "42:/srv/orbit/app-backups" >> /etc/projects;
#         echo "mcb:42" >> /etc/projid; xfs_quota -x -c 'project -s mcb' /srv;
#         xfs_quota -x -c 'limit -p bhard=30g mcb' /srv
#   ext4: `tune2fs -O project,quota /dev/XXX`, mount with `prjquota`,
#         `chattr -p 42 +P <dir>`, `setquota -P 42 0 30G 0 0 /srv`
# The Oracle boot volume is usually ext4/xfs without those options, which is why the
# loopback approach is the default here.
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib.sh"

MIGRATE=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --migrate) MIGRATE=1 ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) ARGS+=("$a") ;;
  esac
done
[ "${#ARGS[@]}" -eq 2 ] || die "usage: $0 <path> <sizeGB> [--migrate]"
TARGET="$(readlink -m "${ARGS[0]}")"
SIZE_GB="${ARGS[1]}"
case "$SIZE_GB" in ''|*[!0-9]*) die "sizeGB must be a positive integer" ;; esac
[ "$SIZE_GB" -ge 1 ] || die "sizeGB must be >= 1"
[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
need fallocate mkfs.ext4 mount findmnt rsync blkid

if findmnt -rn --target "$TARGET" -o TARGET | grep -qxF "$TARGET"; then
  die "${TARGET} is already a mount point"
fi

NAME="$(printf '%s' "$TARGET" | sed 's:^/::; s:/:-:g')"
IMG_DIR="${ORBIT_ROOT}/.capped"
IMG="${IMG_DIR}/${NAME}.img"
[ ! -e "$IMG" ] || die "${IMG} already exists"

HAS_DATA=0
if [ -d "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  HAS_DATA=1
  [ "$MIGRATE" -eq 1 ] || die "${TARGET} is not empty; pass --migrate to copy its contents into the capped volume"
fi

FREE="$(free_gb "$(dirname "$IMG_DIR")")"
[ "$FREE" -gt "$SIZE_GB" ] || die "not enough free space for ${SIZE_GB} GB image (${FREE} GB free)"

OWNER="$(stat -c '%u:%g' "$(dirname "$TARGET")" 2>/dev/null || echo 1000:1000)"
mkdir -p "$IMG_DIR" "$TARGET"
chmod 700 "$IMG_DIR"

log "creating ${SIZE_GB} GB image ${IMG}"
fallocate -l "${SIZE_GB}G" "$IMG"
mkfs.ext4 -q -m 0 -L "cap-${NAME:0:12}" "$IMG"

FSTAB_LINE="${IMG} ${TARGET} ext4 loop,nofail,noatime 0 0"
grep -qF "$IMG" /etc/fstab || printf '%s\n' "$FSTAB_LINE" >> /etc/fstab

if [ "$HAS_DATA" -eq 1 ]; then
  STAGE="$(mktemp -d "${TARGET}.migrate.XXXXXX")"
  mv_aside="${TARGET}.premigrate-$$"
  log "migrating existing data (rsync)"
  mount -o loop,noatime "$IMG" "$STAGE"
  rsync -aHAX "${TARGET}/" "${STAGE}/"
  umount "$STAGE" && rmdir "$STAGE"
  mv "$TARGET" "$mv_aside"
  mkdir -p "$TARGET"
  mount "$TARGET"
  log "old contents kept in ${mv_aside}; delete it once verified"
else
  mount "$TARGET"
fi

chown "$OWNER" "$TARGET"
log "done: ${TARGET} is capped at ${SIZE_GB} GB ($(df -h --output=size,avail "$TARGET" | tail -n 1))"
