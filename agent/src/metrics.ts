import os from "node:os";
import { resolve } from "node:path";
import si from "systeminformation";
import {
  GB,
  ORACLE_LIMITS,
  RANGE_BUCKET_SEC,
  type AgentStatus,
  type ContainerStat,
  type DiskInfo,
  type IdleRisk,
  type MetricPoint,
  type MetricsRange,
  type MetricsResponse,
  type ServiceMetricPoint,
  type ServiceStat,
  type StorageBreakdown,
  type StorageCategory,
} from "@orbit/shared";
import type { Router } from "./http.ts";
import { HttpError } from "./http.ts";
import type { Ctx } from "./context.ts";
import { health } from "./health.ts";
import { sampleDocker } from "./docker.ts";
import { sampleUnits, systemdAvailable, type UnitSample } from "./systemd.ts";

const DAY = 86_400_000;
const cpuCount = Math.max(1, os.availableParallelism());

// ───────────────────────────── pure helpers ─────────────────────────────

/** Least-squares slope of bytes over time, in bytes/day. null if < 2 points or no time spread. */
export function linearGrowthPerDay(points: { ts: number; bytes: number }[]): number | null {
  const n = points.length;
  if (n < 2) return null;
  const t0 = points[0].ts;
  let sx = 0, sy = 0;
  for (const p of points) { sx += (p.ts - t0) / DAY; sy += p.bytes; }
  const mx = sx / n, my = sy / n;
  let num = 0, den = 0;
  for (const p of points) {
    const dx = (p.ts - t0) / DAY - mx;
    num += dx * (p.bytes - my);
    den += dx * dx;
  }
  if (den < 1e-9) return null;
  return num / den;
}

/** Nearest-rank percentile (p in 0..100). */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

const isWin = process.platform === "win32";
const norm = (p: string) => {
  const x = p.replace(/\\/g, "/");
  return isWin ? x.toLowerCase() : x;
};

/** Disk whose mount is the longest prefix of `path`. */
export function diskForPath(disks: DiskInfo[], path: string): DiskInfo | null {
  const p = norm(resolve(path));
  let best: DiskInfo | null = null;
  let bestLen = -1;
  for (const d of disks) {
    const m = norm(d.mount).replace(/\/+$/, "");
    if ((p === m || p.startsWith(m + "/") || m === "") && m.length > bestLen) { best = d; bestLen = m.length; }
  }
  return best;
}

// ───────────────────────────── disks ─────────────────────────────

const PSEUDO_FS = new Set([
  "overlay", "tmpfs", "squashfs", "devtmpfs", "devfs", "proc", "sysfs", "cgroup", "cgroup2", "ramfs", "efivarfs", "autofs",
  "iso9660", "udf", "fuse.lxcfs", "fuse.gvfsd-fuse", "fuse.snapfuse", "nsfs", "binfmt_misc", "securityfs", "debugfs",
]);
const PSEUDO_MOUNT = ["/boot/efi", "/snap", "/run", "/sys", "/proc", "/dev", "/var/lib/docker", "/var/lib/kubelet", "/etc"];

let diskCache: { at: number; disks: DiskInfo[] } | null = null;

export async function listDisks(maxAgeMs = 30_000): Promise<DiskInfo[]> {
  if (diskCache && Date.now() - diskCache.at < maxAgeMs) return diskCache.disks;
  const raw = await si.fsSize();
  const byDev = new Map<string, DiskInfo>();
  for (const d of raw) {
    const type = (d.type ?? "").toLowerCase();
    const mount = d.mount ?? "";
    if (!mount || PSEUDO_FS.has(type) || d.size < GB) continue;
    if (PSEUDO_MOUNT.some((p) => mount === p || mount.startsWith(p + "/"))) continue;
    const key = d.fs && d.fs !== "none" ? d.fs : `${mount}`;
    const info: DiskInfo = { mount, fs: d.type || d.fs || "", total: d.size, used: d.used, free: d.available ?? Math.max(0, d.size - d.used) };
    const ex = byDev.get(key);
    if (!ex || mount.length < ex.mount.length) byDev.set(key, info);
  }
  const disks = [...byDev.values()].sort((a, b) => a.mount.localeCompare(b.mount));
  diskCache = { at: Date.now(), disks };
  return disks;
}

/** Disks from the latest sampler tick (no I/O); bounded direct call only if no sample exists yet. */
export async function latestDisks(): Promise<DiskInfo[] | null> {
  if (latest) return latest.disks;
  if (diskCache) return diskCache.disks;
  return Promise.race([listDisks().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
}

// ───────────────────────────── network ─────────────────────────────

let ifaceCache: { at: number; names: Set<string> } | null = null;
let netPrev: { ts: number; ifaces: Map<string, { rx: number; tx: number }> } | null = null;
const VIRTUAL_RE = /^(lo|docker|veth|br-|virbr|vethernet|loopback|tailscale|ts\d|wg)/i;

async function realIfaces(): Promise<Set<string>> {
  if (ifaceCache && Date.now() - ifaceCache.at < 300_000) return ifaceCache.names;
  const names = new Set<string>();
  try {
    for (const i of await si.networkInterfaces()) {
      if (i.internal || i.virtual) continue;
      if (VIRTUAL_RE.test(i.iface) || VIRTUAL_RE.test(i.ifaceName ?? "")) continue;
      names.add(i.iface.toLowerCase());
      if (i.ifaceName) names.add(i.ifaceName.toLowerCase());
    }
  } catch { /* fall through to name filter */ }
  ifaceCache = { at: Date.now(), names };
  return names;
}

// Diff per interface so a change in the interface set between ticks can't create a fake spike.
async function netRates(): Promise<{ rx: number; tx: number }> {
  const stats = await si.networkStats("*");
  const allowed = await realIfaces();
  let use = stats.filter((s) => allowed.has(s.iface.toLowerCase()));
  if (!use.length) use = stats.filter((s) => !VIRTUAL_RE.test(s.iface));
  const now = Date.now();
  const p = netPrev;
  const cur = new Map(use.map((s) => [s.iface, { rx: s.rx_bytes ?? 0, tx: s.tx_bytes ?? 0 }]));
  netPrev = { ts: now, ifaces: cur };
  if (!p || now <= p.ts) return { rx: 0, tx: 0 };
  const dt = (now - p.ts) / 1000;
  let rx = 0, tx = 0;
  for (const [name, c] of cur) {
    const prev = p.ifaces.get(name);
    if (!prev) continue;
    rx += Math.max(0, c.rx - prev.rx);
    tx += Math.max(0, c.tx - prev.tx);
  }
  return { rx: rx / dt, tx: tx / dt };
}

// ───────────────────────────── sampler ─────────────────────────────

type Base = Omit<AgentStatus, "health" | "tailscale" | "keepalive" | "services"> & { services: Omit<ServiceStat, "diskUsed">[] };
let latest: Base | null = null;
export const lastSampleTs = (): number | null => latest?.ts ?? null;
let firstTick: Promise<void> = Promise.resolve();

function mapServices(ctx: Ctx, containers: ContainerStat[], units: Map<string, UnitSample>) {
  const services = ctx.config.services.map((s) => ({
    name: s.name, category: s.category, cpu: 0, memUsed: 0, netRx: 0, netTx: 0, running: 0, expected: 0, up: false,
  }));
  for (const c of containers) {
    const idx = ctx.config.services.findIndex((s) => s.containers.some((p) => c.name.replace(/^\//, "").startsWith(p.replace(/^\//, ""))));
    if (idx === -1) continue;
    c.service = services[idx].name;
    const s = services[idx];
    s.expected++;
    if (c.state === "running") s.running++;
    s.cpu += c.cpu; s.memUsed += c.memUsed; s.netRx += c.netRx; s.netTx += c.netTx;
  }
  if (systemdAvailable()) {
    ctx.config.services.forEach((cfg, i) => {
      const s = services[i];
      for (const u of cfg.systemdUnits) {
        const m = units.get(u);
        s.expected++;
        if (!m) continue;
        if (m.active) s.running++;
        s.cpu += m.cpu; s.memUsed += m.memUsed; s.netRx += m.netRx; s.netTx += m.netTx;
      }
    });
  }
  for (const s of services) s.up = s.expected > 0 && s.running === s.expected;
  return services;
}

async function tick(ctx: Ctx) {
  const allUnits = [...new Set(ctx.config.services.flatMap((s) => s.systemdUnits))];
  const [load, mem, disks, net, dock, units] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    listDisks(0).catch(() => diskCache?.disks ?? []),
    netRates().catch(() => ({ rx: 0, tx: 0 })),
    sampleDocker(ctx.config, cpuCount).catch(() => ({ available: false, containers: [] as ContainerStat[] })),
    sampleUnits(allUnits, cpuCount).catch(() => new Map<string, UnitSample>()),
  ]);
  const ts = Date.now();
  const cpu = Math.min(100, Math.max(0, load.currentLoad));
  const memTotal = mem.total;
  const memUsed = Math.max(0, mem.total - mem.available);
  const diskUsed = disks.reduce((a, d) => a + d.used, 0);
  const diskTotal = disks.reduce((a, d) => a + d.total, 0);
  const services = mapServices(ctx, dock.containers, units);

  ctx.db.prepare("INSERT OR REPLACE INTO samples (ts, cpu, mem_used, mem_total, net_rx, net_tx, disk_used, disk_total) VALUES (?,?,?,?,?,?,?,?)")
    .run(ts, cpu, memUsed, memTotal, net.rx, net.tx, diskUsed, diskTotal);
  const ins = ctx.db.prepare("INSERT OR REPLACE INTO service_samples (ts, service, cpu, mem_used, net_rx, net_tx) VALUES (?,?,?,?,?,?)");
  for (const s of services) ins.run(ts, s.name, s.cpu, s.memUsed, s.netRx, s.netTx);

  const dataDisk = diskForPath(disks, ctx.config.dataDir);
  latest = {
    ts, cpu, cpuCount, memUsed, memTotal, netRx: net.rx, netTx: net.tx, disks,
    primaryDisk: dataDisk ?? [...disks].sort((a, b) => b.total - a.total)[0] ?? null,
    dockerAvailable: dock.available, containers: dock.containers, services,
  };
}

export function startSampler(ctx: Ctx): void {
  // systeminformation shells out to PowerShell/WMI on Windows and can take >10s, so never let ticks overlap.
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try { await tick(ctx); } catch (e) { console.warn("[sampler]", (e as Error)?.message ?? e); } finally { busy = false; }
  };
  firstTick = run();
  setInterval(run, ctx.config.sampleIntervalSec * 1000);
}

// ───────────────────────────── routes ─────────────────────────────

function latestSize(ctx: Ctx, key: string): number | null {
  const r = ctx.db.prepare("SELECT bytes FROM size_samples WHERE key = ? ORDER BY ts DESC LIMIT 1").get(key) as { bytes: number } | undefined;
  return r ? r.bytes : null;
}

async function buildStatus(ctx: Ctx): Promise<AgentStatus> {
  if (!latest) await Promise.race([firstTick, new Promise((r) => setTimeout(r, 5_000))]);
  if (!latest) throw new HttpError(503, "metrics not ready");
  const tailscale = await ctx.tailscale.info();
  return {
    ...latest,
    health: health(ctx),
    tailscale,
    keepalive: ctx.keepalive.state(),
    services: latest.services.map((s) => ({ ...s, diskUsed: latestSize(ctx, `service:${s.name}`) })),
  };
}

function metricsFor(ctx: Ctx, range: MetricsRange): MetricsResponse {
  const bucketSec = RANGE_BUCKET_SEC[range];
  const bms = bucketSec * 1000;
  const to = Date.now();
  const from = to - { "1h": 3_600_000, "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY }[range];
  const db = ctx.db;
  // bms is a trusted integer constant; inlined so SQLite does integer division
  const rows = db.prepare(`
    SELECT (ts / ${bms}) * ${bms} AS b, AVG(cpu) AS cpu, MAX(cpu) AS cpuMax, AVG(mem_used) AS memUsed, MAX(mem_total) AS memTotal,
           AVG(net_rx) AS netRx, AVG(net_tx) AS netTx, MAX(ts) AS lastTs, disk_used AS diskUsed, disk_total AS diskTotal
    FROM samples WHERE ts >= ? GROUP BY b ORDER BY b`).all(from) as Record<string, number>[];
  const total: MetricPoint[] = rows.map((r) => ({
    ts: r.b, cpu: r.cpu, cpuMax: r.cpuMax, memUsed: r.memUsed, memTotal: r.memTotal, netRx: r.netRx, netTx: r.netTx,
    diskUsed: r.diskUsed, diskTotal: r.diskTotal,
  }));

  const svcRows = db.prepare(`
    SELECT service, (ts / ${bms}) * ${bms} AS b, AVG(cpu) AS cpu, AVG(mem_used) AS memUsed, AVG(net_rx) AS netRx, AVG(net_tx) AS netTx
    FROM service_samples WHERE ts >= ? GROUP BY service, b ORDER BY service, b`).all(from) as Record<string, number | string>[];
  const services: Record<string, ServiceMetricPoint[]> = {};
  for (const s of ctx.config.services) services[s.name] = [];
  for (const r of svcRows) {
    (services[r.service as string] ??= []).push({
      ts: r.b as number, cpu: r.cpu as number, memUsed: r.memUsed as number, netRx: r.netRx as number, netTx: r.netTx as number, diskUsed: null,
    });
  }
  for (const [name, pts] of Object.entries(services)) {
    if (!pts.length) continue;
    const key = `service:${name}`;
    const sizes = db.prepare("SELECT ts, bytes FROM size_samples WHERE key = ? AND ts <= ? ORDER BY ts").all(key, to) as { ts: number; bytes: number }[];
    let i = 0;
    let cur: number | null = null;
    for (const p of pts) {
      while (i < sizes.length && sizes[i].ts <= p.ts + bms) cur = sizes[i++].bytes;
      p.diskUsed = cur;
    }
  }
  return { range, bucketSec, from, to, total, services };
}

function idleRisk(ctx: Ctx): IdleRisk {
  const I = ORACLE_LIMITS.idle;
  const windowMs = I.windowDays * DAY;
  const windowStart = Date.now() - windowMs;
  const rows = ctx.db.prepare("SELECT cpu, mem_used, mem_total, net_rx, net_tx FROM samples WHERE ts >= ?").all(windowStart) as
    { cpu: number; mem_used: number; mem_total: number; net_rx: number; net_tx: number }[];
  const n = rows.length;
  const bandwidthMbps = ctx.config.networkBandwidthMbps ?? ORACLE_LIMITS.networkMbpsPerOcpu * cpuCount;
  const cpuP95 = percentile(rows.map((r) => r.cpu), 95);
  const netPct = n
    ? ((rows.reduce((a, r) => a + Math.max(r.net_rx, r.net_tx), 0) / n) * 8) / (bandwidthMbps * 1e6) * 100
    : 0;
  const memPct = n ? rows.reduce((a, r) => a + (r.mem_total ? (r.mem_used / r.mem_total) * 100 : 0), 0) / n : 0;
  const w = `${I.windowDays}d`;
  const metrics: IdleRisk["metrics"] = [
    { key: "cpu", label: "CPU (95th percentile)", value: cpuP95, threshold: I.cpuP95Percent, statistic: `p95 over ${w}`, belowThreshold: cpuP95 < I.cpuP95Percent },
    { key: "network", label: "Network utilisation", value: netPct, threshold: I.networkPercent, statistic: `avg over ${w}`, belowThreshold: netPct < I.networkPercent },
    { key: "memory", label: "Memory utilisation", value: memPct, threshold: I.memoryPercent, statistic: `avg over ${w}`, belowThreshold: memPct < I.memoryPercent },
  ];
  const coverage = Math.min(1, (n * ctx.config.sampleIntervalSec * 1000) / windowMs);
  return {
    windowDays: I.windowDays, windowStart, coverage, metrics,
    atRisk: n > 0 && metrics.every((m) => m.belowThreshold),
    networkBandwidthMbps: bandwidthMbps,
  };
}

function storage(ctx: Ctx): StorageBreakdown {
  const last = ctx.db.prepare("SELECT ts, disk_used, disk_total FROM samples ORDER BY ts DESC LIMIT 1").get() as
    { ts: number; disk_used: number; disk_total: number } | undefined;
  const used = last?.disk_used ?? 0;
  const provisioned = last?.disk_total ?? 0;
  const quotaBytes = ctx.config.storageQuotaGB ? ctx.config.storageQuotaGB * GB : null;
  const cat = (c: StorageCategory) =>
    ctx.config.services.filter((s) => (c === "photos") === (s.category === "photos")).reduce((a, s) => a + (latestSize(ctx, `service:${s.name}`) ?? 0), 0);
  const photos = cat("photos");
  const services = cat("services");
  const pts = (ctx.db.prepare("SELECT ts, disk_used AS bytes FROM samples WHERE ts >= ? ORDER BY ts").all(Date.now() - 7 * DAY) as { ts: number; bytes: number }[]);
  const growth = linearGrowthPerDay(pts);
  const cap = quotaBytes ?? provisioned;
  return {
    ts: last?.ts ?? Date.now(),
    quotaBytes,
    provisionedBytes: provisioned,
    usedBytes: used,
    categories: [
      { category: "photos", label: "Photos", bytes: photos },
      { category: "services", label: "Services", bytes: services },
      { category: "system", label: "System", bytes: Math.max(0, used - photos - services) },
    ],
    growthBytesPerDay: growth,
    daysUntilFull: growth != null && growth > 0 && cap > 0 ? Math.max(0, (cap - used) / growth) : null,
  };
}

export function registerMetricsRoutes(router: Router, ctx: Ctx): void {
  router.get("/v1/status", () => buildStatus(ctx));
  router.get("/v1/metrics", (req) => {
    const range = req.query.get("range") ?? "24h";
    if (!(range in RANGE_BUCKET_SEC)) throw new HttpError(400, "invalid range", "expected 1h, 24h, 7d or 30d");
    return metricsFor(ctx, range as MetricsRange);
  });
  router.get("/v1/idle-risk", () => idleRisk(ctx));
  router.get("/v1/storage", () => storage(ctx));
}
