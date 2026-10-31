import type {
  AgentStatus, AlertEvent, AlertKind, AlertsResponse, BackupsResponse, FolderLimitsResponse, IdleRisk,
} from "@orbit/shared";
import { cachedOnly } from "./agents";
import { bundleInfo } from "./bundle";
import { db, listDevices, toAlert } from "./db";
import { COLORS, notify } from "./notify";
import { computeReplication } from "./replication";
import { getSettings } from "./settings";

type Cond = Pick<AlertEvent, "key" | "kind" | "severity" | "deviceId" | "title" | "message">;

const H = 3_600_000;
const DAY = 24 * H;

function collect(now: number): Cond[] {
  const s = getSettings();
  const t = s.thresholds;
  const out: Cond[] = [];
  const add = (kind: AlertKind, severity: Cond["severity"], deviceId: string | null, suffix: string, title: string, message: string) =>
    out.push({ key: `${kind}:${deviceId ?? "-"}${suffix ? `:${suffix}` : ""}`, kind, severity, deviceId, title, message });

  const devices = listDevices();
  const bundle = bundleInfo();
  const ago = (ms: number) => (ms >= DAY ? `${(ms / DAY).toFixed(1)} days` : `${(ms / H).toFixed(1)} hours`);

  for (const d of devices) {
    if (!d.enrolled) continue;
    const offlineMs = d.lastSeen != null ? now - d.lastSeen : null;
    if (d.role === "primary") {
      if (offlineMs != null && offlineMs > t.primaryOfflineDays * DAY)
        add("primary-offline", "critical", d.id, "", `Primary offline: ${d.name}`, `${d.name} has not been seen for ${ago(offlineMs)}. Consider promoting the standby.`);
    } else if (offlineMs != null && offlineMs > H) {
      add("device-offline", "warning", d.id, "", `Device offline: ${d.name}`, `${d.name} has not been seen for ${ago(offlineMs)}.`);
    }
    const online = offlineMs != null && offlineMs < 3 * 60_000;

    const st = cachedOnly<AgentStatus>(d.id, "/status");
    if (st && online) {
      for (const disk of st.disks) {
        const pct = disk.total ? (disk.used / disk.total) * 100 : 0;
        if (pct >= t.diskPercent)
          add("disk-high", pct >= 95 ? "critical" : "warning", d.id, disk.mount, `Disk ${Math.round(pct)}% full on ${d.name}`, `${disk.mount} is ${pct.toFixed(1)}% full (threshold ${t.diskPercent}%).`);
      }
      const ram = st.memTotal ? (st.memUsed / st.memTotal) * 100 : 0;
      if (ram >= t.ramPercent) add("ram-high", "warning", d.id, "", `Memory ${Math.round(ram)}% on ${d.name}`, `RAM use is ${ram.toFixed(1)}% (threshold ${t.ramPercent}%).`);
      for (const sv of st.services) {
        if (sv.containersExpected > 0 && !sv.up)
          add("service-down", "critical", d.id, sv.name, `Service down: ${sv.name} on ${d.name}`, `${sv.containersRunning}/${sv.containersExpected} containers running.`);
      }
    }
    if (st?.health.agentVersion && bundle && st.health.agentVersion !== bundle.version)
      add("update-available", "info", d.id, "", `Agent update for ${d.name}`, `Agent ${st.health.agentVersion} -> ${bundle.version}.`);

    if (d.role === "standby") {
      const idle = cachedOnly<IdleRisk>(d.id, "/idle-risk");
      if (idle?.atRisk && idle.coverage >= 0.5)
        add("idle-risk", "critical", d.id, "", `Oracle idle reclamation risk on ${d.name}`, idle.metrics.map((m) => `${m.label}: ${m.value.toFixed(1)}% (< ${m.threshold}%)`).join("\n"));
    }

    for (const f of cachedOnly<FolderLimitsResponse>(d.id, "/folders")?.folders ?? []) {
      if (f.state === "warning" || f.state === "full" || f.state === "paused")
        add("folder-limit", f.state === "warning" ? "warning" : "critical", d.id, f.id, `Folder limit ${f.state}: ${f.name}`, `${f.name} on ${d.name} is ${f.percent != null ? `${Math.round(f.percent)}% of its limit` : f.state}.`);
    }
    for (const j of cachedOnly<BackupsResponse>(d.id, "/backups")?.jobs ?? []) {
      if (j.lastRun?.ok === false)
        add("backup-failed", "warning", d.id, j.id, `Backup failed: ${j.name}`, `${j.name} on ${d.name} failed (exit ${j.lastRun.exitCode}).`);
    }
  }

  for (const r of computeReplication(now).replicas) {
    for (const f of r.folders) {
      if (f.lagMs != null && f.lagMs > t.replicaBehindHours * H)
        add("replica-behind", "warning", r.deviceId, f.folderId, `Replica behind: ${r.name} / ${f.label}`, `${r.name} has not been fully in sync for ${ago(f.lagMs)} (threshold ${t.replicaBehindHours} h).`);
    }
  }
  return out;
}

const NO_NOTIFY: AlertKind[] = ["update-available"];

export async function evaluateAlerts(now = Date.now()): Promise<void> {
  const conds = collect(now);
  const q = db();
  const open = new Map((q.prepare("SELECT * FROM alerts WHERE resolved_at IS NULL").all() as Record<string, unknown>[]).map((r) => [r.key as string, toAlert(r)]));
  const toSend: { a: Cond; resolved: boolean }[] = [];

  for (const c of conds) {
    const cur = open.get(c.key);
    if (cur) {
      q.prepare("UPDATE alerts SET severity = ?, title = ?, message = ?, last_seen = ? WHERE key = ?").run(c.severity, c.title, c.message, now, c.key);
      const renotify = c.severity === "critical" && cur.notifiedAt != null && now - cur.notifiedAt > DAY;
      if (!NO_NOTIFY.includes(c.kind) && (cur.notifiedAt == null || renotify)) toSend.push({ a: c, resolved: false });
    } else {
      q.prepare("INSERT OR REPLACE INTO alerts (key, kind, severity, device_id, title, message, first_seen, last_seen, resolved_at, notified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)")
        .run(c.key, c.kind, c.severity, c.deviceId, c.title, c.message, now, now);
      if (!NO_NOTIFY.includes(c.kind)) toSend.push({ a: c, resolved: false });
    }
  }
  const active = new Set(conds.map((c) => c.key));
  for (const [key, a] of open) {
    if (active.has(key)) continue;
    q.prepare("UPDATE alerts SET resolved_at = ? WHERE key = ?").run(now, key);
    if (a.notifiedAt != null) toSend.push({ a, resolved: true });
  }

  for (const { a, resolved } of toSend) {
    const r = await notify(resolved ? `Resolved: ${a.title}` : a.title, resolved ? "The condition has cleared." : a.message, resolved ? COLORS.ok : COLORS[a.severity]);
    if (r.ok && !resolved) q.prepare("UPDATE alerts SET notified_at = ? WHERE key = ?").run(now, a.key);
  }
}

export function listAlerts(now = Date.now()): AlertsResponse {
  const rows = (sql: string, ...p: number[]) => (db().prepare(sql).all(...p) as Record<string, unknown>[]).map(toAlert);
  return {
    active: rows("SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, first_seen DESC"),
    recent: rows("SELECT * FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at > ? ORDER BY resolved_at DESC", now - 7 * DAY),
  };
}
