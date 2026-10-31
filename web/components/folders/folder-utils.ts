import type { DeviceSummary, FolderLimitState, FolderLimitsResponse } from "@orbit/shared";

export const MODE_LABEL = { alert: "Alert only", "pause-sync": "Pause sync", hard: "Hard limit" } as const;

export const STATE_LABEL: Record<FolderLimitState, string> = {
  ok: "OK",
  warning: "Warning",
  full: "Full",
  paused: "Paused",
  unknown: "Unknown",
};

export const STATE_CLASS: Record<FolderLimitState, string> = {
  ok: "bg-secondary text-secondary-foreground",
  warning: "bg-warning/15 text-warning",
  full: "bg-danger/15 text-danger",
  paused: "bg-danger/15 text-danger",
  unknown: "bg-muted text-muted-foreground",
};

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Longest-prefix mount match for a path. Mounts look like "/" or "C:". */
export function matchVolume<T extends { mount: string }>(path: string, volumes: T[]): T | undefined {
  const p = norm(path);
  let best: T | undefined;
  let bestLen = -1;
  for (const v of volumes) {
    const m = norm(v.mount);
    const ok = m === "" ? p.startsWith("/") : p === m || p.startsWith(`${m}/`);
    if (ok && m.length > bestLen) {
      best = v;
      bestLen = m.length;
    }
  }
  return best;
}

export function isWindows(d: DeviceSummary | undefined): boolean {
  return (d?.status?.health.platform ?? d?.platform) === "windows";
}

/** Bytes by which limits would exceed free space on the volume (<=0 means fine). */
export function overcommitBytes(
  path: string,
  newLimit: number,
  editingId: string | null,
  limits: FolderLimitsResponse | undefined,
  device: DeviceSummary | undefined,
): { mount: string; excess: number } | null {
  if (!path || !(newLimit > 0)) return null;
  const vols = limits?.volumes ?? [];
  const disks = device?.status?.disks ?? [];
  const vol = matchVolume(path, vols);
  const disk = vol ? undefined : matchVolume(path, disks);
  const mount = vol?.mount ?? disk?.mount;
  const free = vol?.free ?? disk?.free;
  if (mount == null || free == null) return null;
  const all = limits?.folders ?? [];
  const others = all.filter((f) => f.id !== editingId && matchVolume(f.path, [{ mount }]));
  const committed = others.reduce((s, f) => s + Math.max(0, f.limitBytes - (f.usedBytes ?? 0)), 0);
  const own = all.find((f) => f.id === editingId)?.usedBytes ?? 0;
  return { mount, excess: committed + newLimit - own - free };
}
