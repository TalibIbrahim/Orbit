// Pure, dependency-free: the sync state of one replica folder, from both sides of the Syncthing link.
import type { ReplicaState, ReplicaSyncDetail, SyncHoldReason } from "@orbit/shared";

/** The replica's view of its own folder (/rest/db/status on the replica). */
export interface LocalFolderView {
  paused: boolean;
  state: string;
  globalBytes: number;
  globalItems?: number;
  localBytes: number;
  needItems: number;
  needBytes: number;
}

/** The host's (arm-free's) view of the replica (/rest/db/completion?device=<replica>). */
export interface RemotePeerView {
  connected: boolean;
  paused?: boolean;
  completion: number | null;
  needItems: number;
  needBytes: number;
  globalBytes?: number;
  globalItems?: number;
  completionError?: string;
}

export interface FolderSyncInput {
  agentOnline: boolean;
  local: LocalFolderView | null;
  remote: RemotePeerView | null;
  hostFolderPaused: boolean | null;
  hold: { paused: boolean; reason: SyncHoldReason | null };
  hostName: string;
  replicaName: string;
}

export interface FolderSyncResult {
  state: ReplicaState;
  completion: number | null;
  needItems: number | null;
  needBytes: number | null;
  reason: string | null;
  detail: ReplicaSyncDetail;
}

export function holdText(hold: { paused: boolean; reason: SyncHoldReason | null }): string | null {
  if (!hold.paused) return null;
  return hold.reason === "manual" ? "paused by you (Pause sync)" : hold.reason === "schedule" ? "paused by the sync schedule" : "paused";
}

const pct = (global: number, need: number) => (global > 0 ? Math.max(0, Math.min(100, ((global - need) / global) * 100)) : null);

/**
 * Decide a replica folder's state. The replica's own view is authoritative for what it still needs;
 * arm-free's view adds the connection and its completion when the replica's agent cannot tell.
 * Paused folders/devices, a disconnected peer and an empty folder are their own states, never 0%.
 */
export function folderSyncState(i: FolderSyncInput): FolderSyncResult {
  const { local, remote } = i;
  const holdReason = holdText(i.hold);
  const detail: ReplicaSyncDetail = {
    source: local ? "replica" : remote ? "host" : "none",
    local: local
      ? {
          state: local.state, paused: local.paused, globalBytes: local.globalBytes, globalItems: local.globalItems ?? null,
          needBytes: local.needBytes, needItems: local.needItems, localBytes: local.localBytes,
        }
      : null,
    remote: remote
      ? {
          connected: remote.connected, devicePaused: !!remote.paused, completion: remote.completion,
          globalBytes: remote.globalBytes ?? null, globalItems: remote.globalItems ?? null, needBytes: remote.needBytes,
          needItems: remote.needItems, error: remote.completionError ?? null,
        }
      : null,
    hostFolderPaused: i.hostFolderPaused,
    pauseReason: null,
  };
  const out = (state: ReplicaState, completion: number | null, reason: string | null, need?: { items: number; bytes: number } | null): FolderSyncResult => ({
    state, completion, reason, detail,
    needItems: need ? need.items : null,
    needBytes: need ? need.bytes : null,
  });
  const localNeed = local ? { items: local.needItems, bytes: local.needBytes } : null;
  const remoteNeed = remote && remote.completion != null ? { items: remote.needItems, bytes: remote.needBytes } : null;
  const lastKnown = local ? pct(local.globalBytes, local.needBytes) : (remote?.completion ?? null);

  if (!i.agentOnline) return out("offline", remote?.completion ?? null, `Orbit agent on ${i.replicaName} is not reachable`, remoteNeed);

  // Paused on either side (or the device itself paused on arm-free).
  const paused: string[] = [];
  if (local?.paused) paused.push(`folder paused on ${i.replicaName}`);
  if (i.hostFolderPaused) paused.push(`folder paused on ${i.hostName}`);
  if (remote?.paused) paused.push(`${i.replicaName} is paused in ${i.hostName}'s Syncthing`);
  if (paused.length) {
    detail.pauseReason = holdReason ?? paused.join("; ");
    return out("paused", lastKnown, holdReason ? `${holdReason} (${paused.join("; ")})` : paused.join("; "), localNeed ?? remoteNeed);
  }

  if (local?.state === "error") return out("error", lastKnown, `Syncthing reports a folder error on ${i.replicaName}`, localNeed);

  const disconnected = remote != null && !remote.connected;
  if (local) {
    const empty = local.globalBytes === 0 && (local.globalItems ?? 0) === 0 && local.needItems === 0;
    const done = local.needItems === 0 && local.needBytes === 0;
    if (disconnected) {
      return out("peer-offline", empty ? null : lastKnown,
        `${i.replicaName} is not connected to ${i.hostName} in Syncthing${done && !empty ? " (was up to date at last contact)" : ""}`, localNeed);
    }
    if (empty) return out("nothing-to-sync", null, "folder is empty (global size 0)", localNeed);
    if (done) return out("up-to-date", 100, null, localNeed);
    return out("syncing", pct(local.globalBytes, local.needBytes), null, localNeed);
  }

  if (remote) {
    if (disconnected) return out("peer-offline", remote.completion, `${i.replicaName} is not connected to ${i.hostName} in Syncthing`, remoteNeed);
    if (remote.completion == null) {
      return out("unknown", null, `${i.hostName} could not report completion${remote.completionError ? `: ${remote.completionError}` : ""}`, null);
    }
    if (remote.globalBytes === 0 && (remote.globalItems ?? 0) === 0) return out("nothing-to-sync", null, "folder is empty (global size 0)", remoteNeed);
    if (remote.completion >= 100 && remote.needItems === 0) return out("up-to-date", 100, null, remoteNeed);
    return out("syncing", remote.completion, null, remoteNeed);
  }
  return out("unknown", null, `folder not reported by ${i.replicaName} or ${i.hostName}`, null);
}

/** States that mean "the data is there as far as Syncthing can tell". */
export const IN_SYNC_STATES: ReadonlySet<ReplicaState> = new Set(["up-to-date", "nothing-to-sync"]);
