import type { ReplicaHealth, ReplicaState, ReplicationHealth, SyncthingSummary } from "@orbit/shared";
import { cachedOnly } from "./agents";
import { db, listDevices } from "./db";
import { isOnline } from "./agents";
import { deviceWarnings, primaryHost, replicaFolderIssue } from "./devices";
import { getSettings } from "./settings";

interface SyncRow { device_id: string; folder_id: string; last_in_sync_at: number | null; last_completion: number | null }

/** Update replica_sync from the primary's /syncthing peers (called by the poller). */
export function updateReplicaSync(now = Date.now()): void {
  const primary = primaryHost();
  if (!primary) return;
  const st = cachedOnly<SyncthingSummary>(primary.id, "/syncthing");
  if (!st?.folders) return;
  const byStId = new Map(listDevices().filter((d) => d.syncthingDeviceId).map((d) => [d.syncthingDeviceId!, d.id]));
  const q = db().prepare(`INSERT INTO replica_sync (device_id, folder_id, last_in_sync_at, last_completion) VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id, folder_id) DO UPDATE SET last_completion = excluded.last_completion,
    last_in_sync_at = COALESCE(excluded.last_in_sync_at, replica_sync.last_in_sync_at)`);
  for (const f of st.folders) {
    for (const p of f.peers ?? []) {
      const id = byStId.get(p.deviceId);
      if (!id) continue;
      const inSync = p.completion >= 100 && p.needItems === 0;
      q.run(id, f.id, inSync ? now : null, p.completion);
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
        const peer = pf?.peers.find((p) => p.deviceId === d.syncthingDeviceId);
        const completion = peer?.completion ?? null;
        const needItems = mine?.needItems ?? peer?.needItems ?? null;
        const row = sync.find((r) => r.device_id === d.id && r.folder_id === id);
        const last = row?.last_in_sync_at ?? null;
        const upToDate = completion != null && completion >= 100 && (needItems ?? 0) === 0;
        const state: ReplicaState = !online ? "offline" : upToDate ? "up-to-date" : completion == null && needItems == null ? "unknown" : "syncing";
        return {
          folderId: id,
          label: pf?.label ?? mine?.label ?? id,
          state,
          completion,
          needItems,
          needBytes: mine?.needBytes ?? peer?.needBytes ?? null,
          lastInSyncAt: last,
          // Never in sync yet: count lag from when the device was added so "replica behind" can still fire.
          lagMs: state === "up-to-date" ? 0 : Math.max(0, now - (last ?? d.createdAt)),
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
