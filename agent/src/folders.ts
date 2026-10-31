import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  DiskInfo, EnforcementMode, FolderLimit, FolderLimitInput, FolderLimitState, FolderLimitsResponse, FsEntry, FsListResponse,
} from "@orbit/shared";
import { HttpError, type Router } from "./http.ts";
import type { Ctx } from "./context.ts";
import { diskForPath, latestDisks, linearGrowthPerDay } from "./metrics.ts";
import { measureFolder } from "./sizes.ts";

const DAY = 86_400_000;
const MODES: EnforcementMode[] = ["alert", "pause-sync", "hard"];
const isWin = process.platform === "win32";

interface Row {
  id: string;
  name: string;
  path: string;
  limit_bytes: number;
  mode: EnforcementMode;
  syncthing_folder_id: string | null;
  paused_by_orbit: number;
  last_alert_level: number;
  created_at: number;
}

const getRow = (ctx: Ctx, id: string) => ctx.db.prepare("SELECT * FROM folders WHERE id = ?").get(id) as Row | undefined;
const allRows = (ctx: Ctx) => ctx.db.prepare("SELECT * FROM folders ORDER BY created_at").all() as unknown as Row[];

function latestSize(ctx: Ctx, id: string): { bytes: number; ts: number } | null {
  const r = ctx.db.prepare("SELECT bytes, ts FROM size_samples WHERE key = ? ORDER BY ts DESC LIMIT 1").get(`folder:${id}`) as
    { bytes: number; ts: number } | undefined;
  return r ?? null;
}

function history(ctx: Ctx, id: string): { ts: number; bytes: number }[] {
  const rows = ctx.db.prepare("SELECT ts, bytes FROM size_samples WHERE key = ? AND ts >= ? ORDER BY ts").all(`folder:${id}`, Date.now() - 30 * DAY) as
    { ts: number; bytes: number }[];
  if (rows.length <= 120) return rows;
  const step = rows.length / 120;
  const out: { ts: number; bytes: number }[] = [];
  for (let i = 0; i < 119; i++) out.push(rows[Math.floor(i * step)]);
  out.push(rows[rows.length - 1]);
  return out;
}

function toFolder(ctx: Ctx, r: Row, disks: DiskInfo[]): FolderLimit {
  const size = latestSize(ctx, r.id);
  const used = size?.bytes ?? null;
  const percent = used == null ? null : (used / r.limit_bytes) * 100;
  const growth = linearGrowthPerDay(
    ctx.db.prepare("SELECT ts, bytes FROM size_samples WHERE key = ? AND ts >= ? ORDER BY ts").all(`folder:${r.id}`, Date.now() - 7 * DAY) as
      { ts: number; bytes: number }[],
  );
  let state: FolderLimitState = "unknown";
  if (r.paused_by_orbit) state = "paused";
  else if (percent != null) state = percent >= 100 ? "full" : percent >= 80 ? "warning" : "ok";
  return {
    id: r.id, name: r.name, path: r.path, limitBytes: r.limit_bytes, mode: r.mode, syncthingFolderId: r.syncthing_folder_id,
    createdAt: r.created_at, usedBytes: used, measuredAt: size?.ts ?? null, percent,
    growthBytesPerDay: growth,
    daysUntilFull: used != null && growth != null && growth > 0 ? Math.max(0, (r.limit_bytes - used) / growth) : null,
    state, pausedByOrbit: !!r.paused_by_orbit,
    volume: diskForPath(disks, r.path)?.mount ?? null,
    history: history(ctx, r.id),
  };
}

async function disksSafe(): Promise<DiskInfo[]> {
  try { return (await latestDisks()) ?? []; } catch { return []; }
}

// ───────────────────────────── enforcement ─────────────────────────────

export async function enforceFolders(ctx: Ctx): Promise<void> {
  for (const r of allRows(ctx)) {
    const size = latestSize(ctx, r.id);
    if (!size) continue;
    const percent = (size.bytes / r.limit_bytes) * 100;
    const level = percent >= 100 ? 100 : percent >= 80 ? 80 : 0;
    const tag = `${r.name} (${r.id})`;

    if (level !== r.last_alert_level) {
      console.log(`[folders] ${tag}: ${r.last_alert_level}% -> ${level}% level (${percent.toFixed(1)}% used)`);
      ctx.db.prepare("UPDATE folders SET last_alert_level = ? WHERE id = ?").run(level, r.id);
    }
    if (r.mode === "hard" && level === 100 && r.last_alert_level !== 100) {
      console.log(`[folders] ${tag}: hard limit reached; hard enforcement is alert-only for now`);
    }
    if (r.mode !== "pause-sync" || !r.syncthing_folder_id) continue;

    if (!r.paused_by_orbit && percent >= 100) {
      try {
        await ctx.syncthing.setFolderPaused(r.syncthing_folder_id, true);
        ctx.db.prepare("UPDATE folders SET paused_by_orbit = 1 WHERE id = ?").run(r.id);
        console.log(`[folders] ${tag}: paused syncthing folder ${r.syncthing_folder_id}`);
      } catch (e) {
        console.warn(`[folders] ${tag}: pause failed:`, (e as Error).message);
      }
    } else if (r.paused_by_orbit && percent < 95) {
      try {
        await ctx.syncthing.setFolderPaused(r.syncthing_folder_id, false);
        ctx.db.prepare("UPDATE folders SET paused_by_orbit = 0 WHERE id = ?").run(r.id);
        console.log(`[folders] ${tag}: resumed syncthing folder ${r.syncthing_folder_id}`);
      } catch (e) {
        console.warn(`[folders] ${tag}: resume failed:`, (e as Error).message);
      }
    }
  }
}

export function startFolderEnforcer(ctx: Ctx): void {
  console.log(`[folders] ${allRows(ctx).length} folder limit(s); enforcement runs after each size pass`);
}

// ───────────────────────────── validation ─────────────────────────────

function validate(input: Partial<FolderLimitInput>, full: boolean): void {
  if (full || input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim()) throw new HttpError(400, "name is required");
  }
  if (full || input.path !== undefined) {
    const p = input.path;
    if (typeof p !== "string" || !isAbsolute(p)) throw new HttpError(400, "path must be an absolute path");
    let ok = false;
    try { ok = statSync(p).isDirectory(); } catch { /* missing */ }
    if (!ok) throw new HttpError(400, "path does not exist or is not a directory");
  }
  if (full || input.limitBytes !== undefined) {
    if (typeof input.limitBytes !== "number" || !Number.isFinite(input.limitBytes) || input.limitBytes <= 0) throw new HttpError(400, "limitBytes must be > 0");
  }
  if (full || input.mode !== undefined) {
    if (!MODES.includes(input.mode as EnforcementMode)) throw new HttpError(400, "mode must be alert, pause-sync or hard");
    if (input.mode === "hard" && isWin) throw new HttpError(400, "hard mode is not supported on Windows");
  }
}

async function resumeIfOrbitPaused(ctx: Ctx, r: Row): Promise<void> {
  if (!r.paused_by_orbit || !r.syncthing_folder_id) return;
  try {
    await ctx.syncthing.setFolderPaused(r.syncthing_folder_id, false);
  } catch (e) {
    console.warn(`[folders] ${r.id}: resume failed:`, (e as Error).message);
  }
}

// ───────────────────────────── filesystem browser ─────────────────────────────

function listFs(path: string): FsListResponse {
  if (!path) {
    const entries: FsEntry[] = isWin
      ? Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))
          .filter((l) => existsSync(`${l}:\\`))
          .map((l) => ({ name: `${l}:`, path: `${l}:\\`, isDir: true as const }))
      : [{ name: "/", path: "/", isDir: true }];
    return { path: "", parent: null, entries };
  }
  if (!isAbsolute(path)) throw new HttpError(400, "path must be absolute");
  const p = resolve(path);
  const up = dirname(p);
  const atRoot = up === p;
  const parent = atRoot ? (isWin ? "" : null) : up;
  const entries: FsEntry[] = [];
  try {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      if (e.name.startsWith(".") && !atRoot) continue;
      if (isWin && (e.name === "$Recycle.Bin" || e.name === "System Volume Information")) continue;
      let dir = e.isDirectory();
      if (!dir && e.isSymbolicLink()) {
        try { dir = statSync(join(p, e.name)).isDirectory(); } catch { /* broken link */ }
      }
      if (dir) entries.push({ name: e.name, path: join(p, e.name), isDir: true });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return { path: p, parent, entries };
  } catch (e) {
    return { path: p, parent, entries: [], error: (e as Error).message };
  }
}

// ───────────────────────────── routes ─────────────────────────────

export function registerFolderRoutes(router: Router, ctx: Ctx): void {
  const one = async (id: string) => {
    const r = getRow(ctx, id);
    if (!r) throw new HttpError(404, "folder not found");
    return toFolder(ctx, r, await disksSafe());
  };

  router.get("/v1/folders", async (): Promise<FolderLimitsResponse> => {
    const disks = await disksSafe();
    const folders = allRows(ctx).map((r) => toFolder(ctx, r, disks));
    const volumes = disks
      .map((d) => {
        const on = folders.filter((f) => f.volume === d.mount);
        const limitsSum = on.reduce((a, f) => a + f.limitBytes, 0);
        const usedByLimited = on.reduce((a, f) => a + (f.usedBytes ?? 0), 0);
        return { mount: d.mount, total: d.total, free: d.free, limitsSum, usedByLimited, overcommitted: limitsSum - usedByLimited > d.free, n: on.length };
      })
      .filter((v) => v.n > 0)
      .map(({ n: _n, ...v }) => v);
    return { folders, volumes };
  });

  router.post("/v1/folders", async (req) => {
    const b = (req.body ?? {}) as Partial<FolderLimitInput>;
    validate(b, true);
    const sid = b.syncthingFolderId || null;
    if (b.mode === "pause-sync" && !sid) throw new HttpError(400, "pause-sync requires syncthingFolderId");
    const id = randomBytes(4).toString("hex");
    ctx.db.prepare("INSERT INTO folders (id, name, path, limit_bytes, mode, syncthing_folder_id, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, b.name!.trim(), resolve(b.path!), Math.round(b.limitBytes!), b.mode!, sid, Date.now());
    void measureFolder(ctx, id, resolve(b.path!)).then(() => enforceFolders(ctx)).catch((e) => console.warn("[folders] measure", (e as Error).message));
    return one(id);
  });

  router.patch("/v1/folders/:id", async (req) => {
    const r = getRow(ctx, req.params.id);
    if (!r) throw new HttpError(404, "folder not found");
    const b = (req.body ?? {}) as Partial<FolderLimitInput>;
    validate(b, false);
    const next = {
      name: b.name?.trim() ?? r.name,
      path: b.path !== undefined ? resolve(b.path) : r.path,
      limit: b.limitBytes !== undefined ? Math.round(b.limitBytes) : r.limit_bytes,
      mode: b.mode ?? r.mode,
      sid: b.syncthingFolderId !== undefined ? b.syncthingFolderId || null : r.syncthing_folder_id,
    };
    if (next.mode === "pause-sync" && !next.sid) throw new HttpError(400, "pause-sync requires syncthingFolderId");
    if (r.paused_by_orbit && (next.mode !== "pause-sync" || next.sid !== r.syncthing_folder_id)) {
      await resumeIfOrbitPaused(ctx, r);
      ctx.db.prepare("UPDATE folders SET paused_by_orbit = 0 WHERE id = ?").run(r.id);
    }
    ctx.db.prepare("UPDATE folders SET name=?, path=?, limit_bytes=?, mode=?, syncthing_folder_id=? WHERE id=?")
      .run(next.name, next.path, next.limit, next.mode, next.sid, r.id);
    if (next.path !== r.path) await measureFolder(ctx, r.id, next.path).catch(() => {});
    await enforceFolders(ctx);
    return one(r.id);
  });

  router.delete("/v1/folders/:id", async (req) => {
    const r = getRow(ctx, req.params.id);
    if (!r) throw new HttpError(404, "folder not found");
    await resumeIfOrbitPaused(ctx, r);
    ctx.db.prepare("DELETE FROM folders WHERE id = ?").run(r.id);
    ctx.db.prepare("DELETE FROM size_samples WHERE key = ?").run(`folder:${r.id}`);
    return { ok: true };
  });

  router.post("/v1/folders/:id/measure", async (req) => {
    const r = getRow(ctx, req.params.id);
    if (!r) throw new HttpError(404, "folder not found");
    await measureFolder(ctx, r.id, r.path);
    await enforceFolders(ctx);
    return one(r.id);
  });

  router.get("/v1/fs", (req) => listFs(req.query.get("path") ?? ""));
}
