import type { SyncthingSummary } from "@orbit/shared";
import { cachedGet, cachedOnly, errMsg, isOnline } from "./agents";
import { evaluateAlerts } from "./alerts";
import { type DeviceRow, listDevices } from "./db";
import { needsPairing, pairWithPrimary, primaryHost, registerLocalAgent } from "./devices";
import { immichNewestUpload } from "./immich";
import { getSettings, immichApiKey } from "./settings";
import { applySyncControl } from "./sync-control";
import { verifyTick } from "./verify";
import { updateReplicaSync } from "./replication";

const g = globalThis as unknown as { __orbitPoller?: boolean };

const FAST_MS = 60_000;
const REPAIR_EVERY_MS = 60 * 60_000;
const repairAt = new Map<string, number>();

/**
 * Self-heal: a replica whose shared folder is missing, not Receive Only, or has no versioning
 * (e.g. folders created before pairing, or after a mode switch) is re-paired, at most once an hour.
 * Pairing only changes Syncthing folder settings; it never touches files.
 */
async function repairReplicas(): Promise<void> {
  const host = primaryHost();
  const shared = getSettings().sharedFolders.map((f) => f.id);
  for (const d of listDevices()) {
    if (!d.enrolled || d.pendingPair || !needsPairing(d.role) || d.id === host?.id || !isOnline(d)) continue;
    const own = cachedOnly<SyncthingSummary>(d.id, "/syncthing");
    if (!own?.available) continue;
    const bad = shared
      .map((id) => {
        const f = own.folders.find((x) => x.id === id);
        return !f ? `${id} not shared` : f.type !== "receiveonly" ? `${id} is ${f.type}` : !f.versioning ? `${id} has no versioning` : null;
      })
      .filter(Boolean);
    if (!bad.length || Date.now() - (repairAt.get(d.id) ?? 0) < REPAIR_EVERY_MS) continue;
    repairAt.set(d.id, Date.now());
    console.log(`[poll] re-pairing ${d.id}: ${bad.join(", ")}`);
    const err = await pairWithPrimary(d);
    if (err) console.warn(`[poll] re-pairing ${d.id} failed:`, err);
  }
}
const SLOW_EVERY = 5; // ticks

async function pollDevice(d: DeviceRow, slow: boolean): Promise<void> {
  if (!d.enrolled || !d.agentUrl) return;
  const r = await cachedGet<{ health?: { agentVersion?: string } }>(d, "/status");
  if (r.error) return; // agent not answering right now: the slow set would just time out too
  if (!slow) return;
  const paths = ["/syncthing", "/folders", "/backups", "/keepalive"];
  if (d.role === "standby") paths.push("/idle-risk", "/storage", "/promote");
  // arm-free mode: the primary is the Oracle VM (idle risk) and holds the library (storage alerts).
  else if (d.role === "primary" && getSettings().primaryMode === "arm-free") paths.push("/idle-risk", "/storage");
  await Promise.all(paths.map((p) => cachedGet(d, p)));
}

async function tick(n: number): Promise<void> {
  const slow = n % SLOW_EVERY === 0;
  registerLocalAgent(); // picks up mode changes / a migrated agent.json
  const devices = listDevices();
  await Promise.all(devices.map((d) => pollDevice(d, slow).catch((e) => console.warn(`[poll] ${d.id}:`, errMsg(e)))));
  for (const d of listDevices()) {
    if (d.pendingPair && d.enrolled && needsPairing(d.role)) {
      const err = await pairWithPrimary(d);
      if (err) console.warn(`[poll] pairing ${d.id} pending:`, err);
      else console.log(`[poll] paired ${d.id} with primary`);
    }
  }
  await repairReplicas().catch((e) => console.warn("[poll] repair:", errMsg(e)));
  // Pause sync / schedule: push the desired hold to devices (re-asserted every 10 min).
  await applySyncControl().catch((e) => console.warn("[sync-control]", errMsg(e)));
  updateReplicaSync();
  await evaluateAlerts();
  // Phone backup verification: scheduled runs + a run after an upload batch settles (read-only).
  const s = getSettings();
  const key = immichApiKey(s);
  await verifyTick(Date.now(), key && s.immich.url ? () => immichNewestUpload({ url: s.immich.url, apiKey: key }) : undefined).catch((e) =>
    console.warn("[verify] tick:", errMsg(e)),
  );
}

export function startPoller(): void {
  if (g.__orbitPoller) return;
  g.__orbitPoller = true;
  registerLocalAgent();
  let n = 0;
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await tick(n++);
    } catch (e) {
      console.error("[poll] tick failed:", errMsg(e));
    } finally {
      busy = false;
    }
  };
  setTimeout(run, 3000).unref();
  setInterval(run, FAST_MS).unref();
  console.log("[hub] poller started");
}
