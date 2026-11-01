import type { ReplicaHealth, ReplicationHealth, SyncthingFolderSummary, SyncthingSummary } from "@orbit/shared";
import { folderSyncState, IN_SYNC_STATES, type FolderSyncResult } from "@/lib/sync/replica-state";
import { cachedOnly } from "./agents";
import { db, type DeviceRow, listDevices } from "./db";
import { isOnline } from "./agents";
import { deviceWarnings, primaryHost, replicaFolderIssue } from "./devices";
import { getSettings } from "./settings";
import { desiredHold } from "./sync-control";

interface SyncRow { device_id: string; folder_id: string; last_in_sync_at: number | null; last_completion: number | null }

/** One replica folder's state from the replica's own view and the host's view of the replica. */
export function replicaFolderSync(
  d: DeviceRow,
  folderId: string,
  ctx: { host: { name: string } | null; pst: SyncthingSummary | null; own: SyncthingSummary | null; online: boolean; hold: ReturnType<typeof desiredHold> },
): FolderSyncResult {
  const mine: SyncthingFolderSummary | undefined = ctx.own?.available ? ctx.own.folders.find((f) => f.id === folderId) : undefined;
  const pf = ctx.pst?.available ? ctx.pst.folders.find((f) => f.id === folderId) : undefined;
  const peer = pf?.peers.find((p) => p.deviceId === d.syncthingDeviceId);
  // Agents before completion became nullable sent 0 for "unknown"; without globalBytes that 0 can not be trusted.
  const legacyZero = !!peer && peer.completion === 0 && peer.globalBytes === undefined && peer.completionError === undefined;
  return folderSyncState({
    agentOnline: ctx.online,
    local: mine
      ? {
          paused: mine.paused, state: mine.state, globalBytes: mine.globalBytes, globalItems: mine.globalItems,
          localBytes: mine.localBytes, needItems: mine.needItems, needBytes: mine.needBytes,
        }
      : null,
    remote: peer
      ? {
          connected: peer.connected, paused: peer.paused, completion: legacyZero ? null : peer.completion,
          needItems: peer.needItems, needBytes: peer.needBytes, globalBytes: peer.globalBytes, globalItems: peer.globalItems,
          completionError: legacyZero ? "older Orbit agent on the host reports unknown completion as 0%" : peer.completionError,
        }
      : null,
    hostFolderPaused: pf ? pf.paused : null,
    hold: ctx.hold,
    hostName: ctx.host?.name ?? "the host",
    replicaName: d.name,
  });
}

/** Update replica_sync from both sides' /syncthing (called by the poller). */
export function updateReplicaSync(now = Date.now()): void {
  const host = primaryHost();
  if (!host) return;
  const pst = cachedOnly<SyncthingSummary>(host.id, "/syncthing");
  const hold = desiredHold(now);
  const q = db().prepare(`INSERT INTO replica_sync (device_id, folder_id, last_in_sync_at, last_completion) VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id, folder_id) DO UPDATE SET last_completion = COALESCE(excluded.last_completion, replica_sync.last_completion),
    last_in_sync_at = COALESCE(excluded.last_in_sync_at, replica_sync.last_in_sync_at)`);
  for (const d of listDevices()) {
    if (d.id === host.id || !d.enrolled) continue;
    const own = cachedOnly<SyncthingSummary>(d.id, "/syncthing");
    const ids = new Set([
      ...(own?.folders ?? []).map((f) => f.id),
      ...(pst?.folders ?? []).filter((f) => f.peers.some((p) => p.deviceId === d.syncthingDeviceId)).map((f) => f.id),
    ]);
    for (const id of ids) {
      const r = replicaFolderSync(d, id, { host, pst, own, online: isOnline(d, now), hold });
      if (r.state === "offline" || r.state === "unknown") continue;
      q.run(d.id, id, IN_SYNC_STATES.has(r.state) ? now : null, r.completion);
    }
  }
}

export function computeReplication(now = Date.now()): ReplicationHealth {
  const devices = listDevices();
  const host = primaryHost();
  const primary = host ? (devices.find((d) => d.id === host.id) ?? null) : null;
  const pst = primary ? cachedOnly<SyncthingSummary>(primary.id, "/syncthing") : null;
  const settings = getSettings();
  const sync = db().prepare("SELECT * FROM replica_sync").all() as unknown as SyncRow[];
  const sharedIds = new Set([...settings.sharedFolders.map((f) => f.id), ...(pst?.folders ?? []).map((f) => f.id)]);
  const hold = desiredHold(now);

  const replicas: ReplicaHealth[] = devices.filter((d) => d.id !== primary?.id && d.enrolled).map((d) => {
    const online = isOnline(d, now);
    const own = cachedOnly<SyncthingSummary>(d.id, "/syncthing");
    const ids = [...sharedIds].filter((id) => own?.folders.some((f) => f.id === id) || pst?.folders.some((f) => f.id === id));
    return {
      deviceId: d.id, name: d.name, role: d.role, online, lastSeen: d.lastSeen,
      warnings: deviceWarnings(d),
      folders: ids.map((id) => {
        const mine = own?.folders.find((f) => f.id === id);
        const pf = pst?.folders.find((f) => f.id === id);
        const r = replicaFolderSync(d, id, { host: primary, pst, own, online, hold });
        const row = sync.find((x) => x.device_id === d.id && x.folder_id === id);
        const last = row?.last_in_sync_at ?? null;
        const inSync = IN_SYNC_STATES.has(r.state);
        return {
          folderId: id,
          label: pf?.label ?? mine?.label ?? id,
          state: r.state,
          completion: r.completion,
          needItems: r.needItems,
          needBytes: r.needBytes,
          lastInSyncAt: inSync ? now : last,
          // Never in sync yet: count lag from when the device was added so "replica behind" can still fire.
          lagMs: inSync ? 0 : Math.max(0, now - (last ?? d.createdAt)),
          reason: r.reason,
          detail: r.detail,
          versioning: mine ? mine.versioning || null : null,
          replicaType: mine?.type ?? null,
          issue: replicaFolderIssue(d, id, own, online),
        };
      }),
    };
  });

  return {
    primary: primary
      ? {
          deviceId: primary.id, name: primary.name, lastSeen: primary.lastSeen,
          online: isOnline(primary, now),
        }
      : null,
    sharedFolders: (pst?.folders ?? []).filter((f) => sharedIds.has(f.id)).map((f) => ({ id: f.id, label: f.label, type: f.type, globalBytes: f.globalBytes })),
    replicas,
    generatedAt: now,
  };
}
