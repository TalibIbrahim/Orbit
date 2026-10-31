import { cachedGet, errMsg } from "./agents";
import { evaluateAlerts } from "./alerts";
import { type DeviceRow, listDevices } from "./db";
import { needsPairing, pairWithPrimary, registerLocalAgent } from "./devices";
import { updateReplicaSync } from "./replication";

const g = globalThis as unknown as { __orbitPoller?: boolean };

const FAST_MS = 60_000;
const SLOW_EVERY = 5; // ticks

async function pollDevice(d: DeviceRow, slow: boolean): Promise<void> {
  if (!d.enrolled || !d.agentUrl) return;
  const r = await cachedGet<{ health?: { agentVersion?: string } }>(d, "/status");
  if (!r.online) return; // agent down: the slow set would just time out too
  if (!slow) return;
  const paths = ["/syncthing", "/folders", "/backups", "/keepalive"];
  if (d.role === "standby") paths.push("/idle-risk", "/storage", "/promote");
  await Promise.all(paths.map((p) => cachedGet(d, p)));
}

async function tick(n: number): Promise<void> {
  const slow = n % SLOW_EVERY === 0;
  const devices = listDevices();
  await Promise.all(devices.map((d) => pollDevice(d, slow).catch((e) => console.warn(`[poll] ${d.id}:`, errMsg(e)))));
  for (const d of listDevices()) {
    if (d.pendingPair && d.enrolled && needsPairing(d.role)) {
      const err = await pairWithPrimary(d);
      if (err) console.warn(`[poll] pairing ${d.id} pending:`, err);
      else console.log(`[poll] paired ${d.id} with primary`);
    }
  }
  updateReplicaSync();
  await evaluateAlerts();
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
