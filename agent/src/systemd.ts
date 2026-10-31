import { execFile } from "node:child_process";

export interface UnitSample { active: boolean; cpu: number; memUsed: number; netRx: number; netTx: number }

const UNSET = 18446744073709551615n;
const prev = new Map<string, { ts: number; cpuNs: number; rx: number; tx: number }>();
let available: boolean | null = null;

/** True once a `systemctl show` has succeeded (Linux with systemd). */
export const systemdAvailable = () => available === true;

function num(v: string | undefined): number {
  if (!v || v.startsWith("[")) return 0;
  try {
    const b = BigInt(v);
    return b === UNSET || b < 0n ? 0 : Number(b);
  } catch { return 0; }
}

function show(units: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile(
      "systemctl",
      ["show", ...units, "-p", "ActiveState", "-p", "CPUUsageNSec", "-p", "MemoryCurrent", "-p", "IPIngressBytes", "-p", "IPEgressBytes"],
      { timeout: 5000, windowsHide: true },
      (err, out) => (err ? rej(err) : res(out)),
    );
  });
}

export async function sampleUnits(units: string[], hostCpus: number): Promise<Map<string, UnitSample>> {
  const out = new Map<string, UnitSample>();
  if (process.platform !== "linux" || !units.length) return out;
  let text: string;
  try { text = await show(units); } catch { available = false; return out; }
  available = true;
  const now = Date.now();
  const blocks = text.split(/\r?\n\r?\n/).filter((b) => b.trim());
  units.forEach((u, i) => {
    const kv: Record<string, string> = {};
    for (const line of (blocks[i] ?? "").split(/\r?\n/)) {
      const k = line.indexOf("=");
      if (k > 0) kv[line.slice(0, k)] = line.slice(k + 1).trim();
    }
    const cpuNs = num(kv.CPUUsageNSec), rx = num(kv.IPIngressBytes), tx = num(kv.IPEgressBytes);
    const p = prev.get(u);
    prev.set(u, { ts: now, cpuNs, rx, tx });
    let cpu = 0, netRx = 0, netTx = 0;
    if (p && now > p.ts) {
      const dt = (now - p.ts) / 1000;
      cpu = Math.min(100, Math.max(0, (Math.max(0, cpuNs - p.cpuNs) / 1e9 / dt / Math.max(1, hostCpus)) * 100));
      netRx = Math.max(0, rx - p.rx) / dt;
      netTx = Math.max(0, tx - p.tx) / dt;
    }
    out.set(u, { active: kv.ActiveState === "active", cpu, memUsed: num(kv.MemoryCurrent), netRx, netTx });
  });
  return out;
}
