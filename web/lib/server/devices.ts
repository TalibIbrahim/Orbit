import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  AgentStatus, DeviceRole, DeviceSummary, Platform, SyncthingPairRequest, SyncthingSummary,
} from "@orbit/shared";
import { agentSend, cachedGet, cachedOnly, errMsg } from "./agents";
import { type DeviceRow, getCache, getDevice, insertDevice, primaryDevice, toRecord, updateDevice } from "./db";
import { getSettings } from "./settings";

export const ONLINE_MS = 3 * 60_000;

export const newToken = () => randomBytes(24).toString("hex");

export function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "device";
}
export function uniqueId(name: string): string {
  const base = slugify(name);
  let id = base;
  for (let i = 2; getDevice(id); i++) id = `${base}-${i}`;
  return id;
}

export function summarize(d: DeviceRow, now = Date.now()): DeviceSummary {
  const st = (d.agentUrl ? cachedOnly<AgentStatus>(d.id, "/status") : null);
  const rec = toRecord(d);
  return {
    ...rec,
    online: d.lastSeen != null && now - d.lastSeen < ONLINE_MS,
    status: st,
    statusFetchedAt: st ? (statusFetchedAt(d.id) ?? null) : null,
  };
}

const statusFetchedAt = (id: string) => getCache<AgentStatus>(id, "/status")?.fetchedAt;

/** Syncthing device id of a device: from the record, else from its agent's /syncthing. */
async function syncthingIdOf(d: DeviceRow): Promise<string | null> {
  if (d.syncthingDeviceId) return d.syncthingDeviceId;
  const r = await cachedGet<SyncthingSummary>(d, "/syncthing");
  const id = r.data?.myDeviceId ?? null;
  if (id) updateDevice(d.id, { syncthingDeviceId: id });
  return id;
}

/** Pair a replica/standby with the primary. Returns null on success, else the error text (pending_pair stays set). */
export async function pairWithPrimary(dev: DeviceRow): Promise<string | null> {
  try {
    const primary = primaryDevice();
    if (!primary) throw new Error("no primary device registered");
    if (!primary.enrolled) throw new Error(`primary "${primary.name}" is not enrolled yet`);
    const [primaryStId, devStId] = await Promise.all([syncthingIdOf(primary), syncthingIdOf(dev)]);
    if (!primaryStId) throw new Error("primary Syncthing device id unknown");
    if (!devStId) throw new Error("device Syncthing device id unknown");
    const folders = getSettings().sharedFolders;

    const onPrimary: SyncthingPairRequest = {
      remoteDeviceId: devStId,
      remoteName: dev.name,
      folders: folders.map((f) => ({ id: f.id, label: f.label, path: "", type: "sendonly" })),
    };
    await agentSend(primary, "POST", "/syncthing/pair", onPrimary);

    const onDevice: SyncthingPairRequest = {
      remoteDeviceId: primaryStId,
      remoteName: primary.name,
      folders: folders.map((f) => ({
        id: f.id,
        label: f.label,
        path:
          dev.role === "standby" ? f.replicaPath
          : dev.platform === "windows" ? `C:\\OrbitReplicas\\${f.id}`
          : `/srv/orbit/replicas/${f.id}`,
        type: "receiveonly",
        versioning: versioningOf(f.versioning),
      })),
    };
    await agentSend(dev, "POST", "/syncthing/pair", onDevice);
    updateDevice(dev.id, { pendingPair: false });
    return null;
  } catch (e) {
    updateDevice(dev.id, { pendingPair: true });
    return errMsg(e);
  }
}

const versioningOf = (v: "simple" | "staggered" | "trashcan"): { type: typeof v; params: Record<string, string> } =>
  v === "staggered" ? { type: v, params: { maxAge: "2592000" } } : v === "simple" ? { type: v, params: { keep: "10" } } : { type: v, params: { cleanoutDays: "30" } };

export const needsPairing = (role: DeviceRole) => role === "replica" || role === "standby";

export function installCommands(hubUrl: string, token: string) {
  return {
    linuxCommand: `curl -fsSL ${hubUrl}/install/${token}/linux.sh | sudo bash`,
    windowsCommand: `irm ${hubUrl}/install/${token}/windows.ps1 | iex`,
  };
}

export function createDevice(name: string, role: DeviceRole, platform: Platform | null): DeviceRow {
  return insertDevice({ id: uniqueId(name), name, role, token: newToken(), platform });
}

/** Register the host's own agent (arm-free) from a mounted agent.json. */
export function registerLocalAgent(): void {
  const file = process.env.ORBIT_LOCAL_AGENT_CONFIG;
  if (!file) return;
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8")) as { deviceId?: string; name?: string; role?: DeviceRole; token?: string };
    if (!cfg.deviceId || !cfg.token) throw new Error("agent.json needs deviceId and token");
    const agentUrl = process.env.ORBIT_LOCAL_AGENT_URL ?? "http://host.docker.internal:7420";
    const patch = {
      name: cfg.name ?? cfg.deviceId, role: cfg.role ?? "standby", token: cfg.token, agentUrl, enrolled: true,
      platform: "linux" as Platform,
    };
    if (getDevice(cfg.deviceId)) updateDevice(cfg.deviceId, patch);
    else insertDevice({ id: cfg.deviceId, ...patch, pendingPair: needsPairing(patch.role) });
    console.log(`[hub] local agent "${cfg.deviceId}" registered at ${agentUrl}`);
  } catch (e) {
    console.warn("[hub] local agent auto-registration failed:", errMsg(e));
  }
}
