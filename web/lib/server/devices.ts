import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type AgentStatus, defaultReplicaPath, type DeviceRole, type DeviceSummary, type Platform, type SyncthingPairRequest,
  type SyncthingSummary,
} from "@orbit/shared";
import { agentSend, cachedGet, cachedOnly, errMsg, isOnline } from "./agents";
import { type DeviceRow, getCache, getDevice, insertDevice, primaryDevice, toRecord, updateDevice } from "./db";
import { getSettings } from "./settings";

export { ONLINE_MS } from "./agents";

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
    online: isOnline(d, now),
    status: st,
    statusFetchedAt: st ? (statusFetchedAt(d.id) ?? null) : null,
    agentRole: st?.health?.role ?? null,
    enrollError: d.enrollError,
    enrollAttemptAt: d.enrollAttemptAt,
    warnings: deviceWarnings(d),
  };
}

const ROLE_NAME: Record<DeviceRole, string> = { primary: "Primary", standby: "Standby", replica: "Replica" };

/** Role the device's agent reports (from its agent.json), if known. */
export const agentRoleOf = (d: DeviceRow): DeviceRole | null => cachedOnly<AgentStatus>(d.id, "/status")?.health?.role ?? null;

function roleMismatchText(d: DeviceRow, agentRole: DeviceRole): string {
  const fix = d.id === localAgentId()
    ? "Re-run install-arm-free.sh with the right --mode; it migrates /etc/orbit/agent.json."
    : `Remove the device and add it again as a ${ROLE_NAME[d.role]}; the installer backs up and replaces the old agent.json.`;
  return `The agent reports role "${agentRole}" but the hub has this device as "${d.role}". The agent's config is from another install or the role was relabelled. ${fix}`;
}

/** Configuration problems shown on the device card and the Replication page. */
export function deviceWarnings(d: DeviceRow): string[] {
  const out: string[] = [];
  if (!d.enrolled) return out;
  const agentRole = agentRoleOf(d);
  if (agentRole && agentRole !== d.role) out.push(roleMismatchText(d, agentRole));
  if (d.role === "standby" && getSettings().primaryMode === "arm-free") {
    out.push(
      d.id === localAgentId()
        ? 'arm-free primary mode has no standby, but this agent is still a standby. Re-run install-arm-free.sh --mode arm-free to migrate /etc/orbit/agent.json to role "primary".'
        : "arm-free primary mode has no standby. Remove the device and add it again as a Replica.",
    );
  }
  if (d.role === "primary" && getSettings().primaryMode === "arm-free" && localAgentId() && d.id !== localAgentId()) {
    out.push("In arm-free mode only arm-free is the primary host. Remove this device and add it again as a Replica.");
  }
  if (d.role === "replica" && Object.keys(d.replicaPaths).length === 0) {
    out.push(
      `No replica folder paths saved: Syncthing folders go to the default location (${defaultReplicaPath("<folder>", d.platform)}). ` +
        "To choose the folders, remove the device and add it again as a Replica.",
    );
  }
  if (d.pendingPair && needsPairing(d.role)) out.push(`Not paired with the primary yet${d.pairError ? `: ${d.pairError}` : ""}. The hub retries every minute.`);
  return out;
}

/**
 * Likely reason a replica folder shows type unknown / not Receive Only / no versioning.
 * `own` = the replica's own Syncthing summary (null if never fetched).
 */
export function replicaFolderIssue(d: DeviceRow, folderId: string, own: SyncthingSummary | null, online: boolean): string | null {
  const mine = own?.folders.find((f) => f.id === folderId);
  if (mine) {
    if (mine.type !== "receiveonly") return `This folder is "${mine.type}" on the device, expected Receive Only. It existed before pairing; change it in Syncthing or remove the device and add it again.`;
    if (!mine.versioning) return "No versioning on this replica: the folder existed before pairing or was created by hand. Remove and re-add the device, or enable staggered versioning in Syncthing.";
    return null;
  }
  if (!own) return online ? "No Syncthing data from this device's agent yet (it is polled every 5 minutes)." : "Device offline and no Syncthing data was ever received from it.";
  if (!own.available) return `The agent cannot reach Syncthing on this device${own.error ? ` (${own.error})` : ""}. Check that Syncthing is running.`;
  const agentRole = agentRoleOf(d);
  if (agentRole && agentRole !== d.role) return roleMismatchText(d, agentRole);
  if (d.pendingPair) return `Not paired yet${d.pairError ? `: ${d.pairError}` : ""}. The hub retries every minute.`;
  return "The folder is not shared with this device: it may have been removed in Syncthing. Remove the device and add it again to re-pair.";
}

const localAgentId = (): string | null => {
  const file = process.env.ORBIT_LOCAL_AGENT_CONFIG;
  if (!file) return null;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { deviceId?: string }).deviceId ?? null;
  } catch {
    return null;
  }
};

const statusFetchedAt = (id: string) => getCache<AgentStatus>(id, "/status")?.fetchedAt;

/** Syncthing device id of a device: from the record, else from its agent's /syncthing. */
async function syncthingIdOf(d: DeviceRow): Promise<string | null> {
  if (d.syncthingDeviceId) return d.syncthingDeviceId;
  const r = await cachedGet<SyncthingSummary>(d, "/syncthing");
  const id = r.data?.myDeviceId ?? null;
  if (id) updateDevice(d.id, { syncthingDeviceId: id });
  return id;
}

/**
 * The device that holds the Send Only source folders: in arm-free mode always the hub's own host
 * (whatever role its agent.json still claims), otherwise the device with role "primary".
 */
export function primaryHost(): DeviceRow | null {
  if (getSettings().primaryMode === "arm-free") {
    const id = localAgentId();
    const local = id ? getDevice(id) : null;
    if (local) return local;
  }
  return primaryDevice();
}

/** Pair a replica/standby with the primary. Returns null on success, else the error text (pending_pair stays set). */
export async function pairWithPrimary(dev: DeviceRow): Promise<string | null> {
  try {
    const primary = primaryHost();
    if (!primary) {
      throw new Error(getSettings().primaryMode === "arm-free"
        ? "arm-free (the primary host) is not registered: ORBIT_LOCAL_AGENT_CONFIG is not set or its agent.json is unreadable"
        : "no primary device registered");
    }
    if (primary.id === dev.id) {
      updateDevice(dev.id, { pendingPair: false, pairError: null });
      return null; // the primary host is the source, nothing to pair
    }
    if (!primary.enrolled) throw new Error(`primary "${primary.name}" is not enrolled yet`);
    const [primaryStId, devStId] = await Promise.all([syncthingIdOf(primary), syncthingIdOf(dev)]);
    if (!primaryStId) throw new Error(`Syncthing device id of ${primary.name} unknown (its agent is offline or cannot reach Syncthing)`);
    if (!devStId) throw new Error(`Syncthing device id of ${dev.name} unknown (Syncthing not running on it yet, or the agent cannot reach it)`);
    const settings = getSettings();
    const folders = settings.sharedFolders;
    const armFree = settings.primaryMode === "arm-free";

    // Device mode: the PC's folders already exist (install-pc.ps1), so path "" = keep the existing one.
    // arm-free mode: the folders live on arm-free at the shared-folder path and are created on first pairing.
    const onPrimary: SyncthingPairRequest = {
      remoteDeviceId: devStId,
      remoteName: dev.name,
      folders: folders.map((f) => ({ id: f.id, label: f.label, path: armFree ? f.replicaPath : "", type: "sendonly" })),
    };
    await agentSend(primary, "POST", "/syncthing/pair", onPrimary);

    const onDevice: SyncthingPairRequest = {
      remoteDeviceId: primaryStId,
      remoteName: primary.name,
      folders: folders.map((f) => ({
        id: f.id,
        label: f.label,
        path: dev.role === "standby" ? f.replicaPath : dev.replicaPaths[f.id] || defaultReplicaPath(f.id, dev.platform),
        type: "receiveonly",
        versioning: versioningOf(f.versioning, settings.versioningMaxAgeDays),
      })),
    };
    await agentSend(dev, "POST", "/syncthing/pair", onDevice);
    updateDevice(dev.id, { pendingPair: false, pairError: null });
    return null;
  } catch (e) {
    const msg = errMsg(e);
    updateDevice(dev.id, { pendingPair: true, pairError: msg });
    return msg;
  }
}

const versioningOf = (v: "simple" | "staggered" | "trashcan", maxAgeDays: number): { type: typeof v; params: Record<string, string> } =>
  v === "staggered" ? { type: v, params: { maxAge: String(Math.round(maxAgeDays * 86_400)) } } : v === "simple" ? { type: v, params: { keep: "10" } } : { type: v, params: { cleanoutDays: "30" } };

/** Keep only absolute string paths for known shared folders (trimmed, empties dropped). Throws on bad input. */
export function cleanReplicaPaths(v: unknown): Record<string, string> {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("replicaPaths must be an object");
  const known = new Set(getSettings().sharedFolders.map((f) => f.id));
  const out: Record<string, string> = {};
  for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
    if (!known.has(k)) continue;
    if (typeof p !== "string") throw new Error(`replicaPaths.${k} must be a string`);
    const t = p.trim();
    if (!t) continue;
    if (t.length > 400 || /[\0\r\n]/.test(t)) throw new Error(`replicaPaths.${k} is invalid`);
    if (!(/^[A-Za-z]:[\\/]/.test(t) || t.startsWith("/") || t.startsWith("\\\\"))) throw new Error(`replicaPaths.${k} must be an absolute path`);
    out[k] = t;
  }
  return out;
}

export const needsPairing = (role: DeviceRole) => role === "replica" || role === "standby";

export function installCommands(hubUrl: string, token: string) {
  return {
    linuxCommand: `curl -fsSL ${hubUrl}/install/${token}/linux.sh | sudo bash`,
    windowsCommand: `irm ${hubUrl}/install/${token}/windows.ps1 | iex`,
  };
}

export function createDevice(name: string, role: DeviceRole, platform: Platform | null, replicaPaths: Record<string, string> = {}): DeviceRow {
  return insertDevice({ id: uniqueId(name), name, role, token: newToken(), platform, replicaPaths });
}

const g = globalThis as unknown as { __orbitLocalSig?: string; __orbitLocalWarned?: string };

/**
 * Register / reconcile the host's own agent (arm-free) from the mounted agent.json. Called at startup
 * and on every poll tick, so a mode change or an agent.json migration is picked up without a restart.
 * In arm-free mode this host is always the primary, even if its agent.json still says "standby".
 */
export function registerLocalAgent(): void {
  const file = process.env.ORBIT_LOCAL_AGENT_CONFIG;
  if (!file) return;
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8")) as { deviceId?: string; name?: string; role?: DeviceRole; token?: string };
    if (!cfg.deviceId || !cfg.token) throw new Error("agent.json needs deviceId and token");
    const agentUrl = process.env.ORBIT_LOCAL_AGENT_URL ?? "http://host.docker.internal:7420";
    const armFree = getSettings().primaryMode === "arm-free";
    const role: DeviceRole = armFree ? "primary" : (cfg.role ?? "standby");
    if (armFree && cfg.role && cfg.role !== "primary" && g.__orbitLocalWarned !== cfg.role) {
      g.__orbitLocalWarned = cfg.role;
      console.warn(`[hub] arm-free mode: ${file} says role "${cfg.role}"; treating this host as the primary. Re-run install-arm-free.sh --mode arm-free to migrate agent.json.`);
    }
    // arm-free mode: Immich runs here; the installer puts its tailnet URL in ORBIT_IMMICH_URL.
    const immichUrl = role === "primary" ? process.env.ORBIT_IMMICH_URL?.trim() || undefined : undefined;
    const sig = JSON.stringify([cfg.deviceId, cfg.name, role, cfg.token, agentUrl, immichUrl]);
    if (sig === g.__orbitLocalSig && getDevice(cfg.deviceId)) return;
    const patch = {
      name: cfg.name ?? cfg.deviceId, role, token: cfg.token, agentUrl, enrolled: true,
      platform: "linux" as Platform, immichTailscaleUrl: immichUrl,
      ...(role === "primary" ? { pendingPair: false, pairError: null } : {}),
    };
    if (getDevice(cfg.deviceId)) updateDevice(cfg.deviceId, patch);
    else insertDevice({ id: cfg.deviceId, ...patch, pendingPair: needsPairing(role) });
    g.__orbitLocalSig = sig;
    console.log(`[hub] local agent "${cfg.deviceId}" registered at ${agentUrl} as ${role}`);
  } catch (e) {
    console.warn("[hub] local agent auto-registration failed:", errMsg(e));
  }
}
