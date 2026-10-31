// Sync hold: pauses the listed Syncthing folders on the hub's request (manual pause / schedule) and keeps
// them paused (re-applied on start and every 5 minutes). Independent of folder-limit pauses.
import type { SyncHoldReason, SyncHoldRequest, SyncHoldState } from "@orbit/shared";
import type { Ctx } from "./context.ts";
import { kvGet, kvSet } from "./db.ts";
import type { Router } from "./http.ts";

// http.ts uses TS parameter properties (unsupported by node strip-types); it is only loaded lazily for the router.
export class SyncHoldError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface StoredHold { paused: boolean; reason: SyncHoldReason | null; folderIds: string[]; since: number | null }

const KEY = "syncHold";
const ID_RE = /^[A-Za-z0-9._-]+$/;
const REAPPLY_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 10_000;

function load(ctx: Ctx): StoredHold | null {
  return kvGet<StoredHold>(ctx.db, KEY);
}

export function isSyncHeld(ctx: Ctx, folderId: string): boolean {
  const h = load(ctx);
  return !!h && h.paused === true && Array.isArray(h.folderIds) && h.folderIds.includes(folderId);
}

export function parseSyncHoldRequest(body: unknown): SyncHoldRequest {
  const b = (body ?? {}) as Partial<SyncHoldRequest>;
  if (typeof b.paused !== "boolean") throw new SyncHoldError(400, "paused must be a boolean");
  if (!Array.isArray(b.folderIds) || b.folderIds.length < 1 || b.folderIds.length > 20) {
    throw new SyncHoldError(400, "folderIds must be an array of 1..20 folder ids");
  }
  for (const id of b.folderIds) {
    if (typeof id !== "string" || !id || !ID_RE.test(id)) throw new SyncHoldError(400, "folderIds contains an invalid folder id");
  }
  const reason = b.reason ?? null;
  if (reason !== null && reason !== "manual" && reason !== "schedule") throw new SyncHoldError(400, 'reason must be "manual", "schedule" or null');
  return { paused: b.paused, folderIds: [...new Set(b.folderIds)], reason };
}

/** Folders whose pause is owned by a folder limit (paused_by_orbit = 1). */
function limitHeld(ctx: Ctx, folderId: string): boolean {
  const r = ctx.db.prepare("SELECT 1 AS x FROM folders WHERE paused_by_orbit = 1 AND syncthing_folder_id = ? LIMIT 1").get(folderId);
  return !!r;
}

/** Bring Syncthing in line with the stored hold. Per-folder errors are returned, never thrown. */
export async function applySyncHold(ctx: Ctx): Promise<SyncHoldState["folders"]> {
  const h = load(ctx);
  if (!h) return [];
  const out: SyncHoldState["folders"] = [];
  let summary;
  try {
    summary = await ctx.syncthing.summary();
  } catch (e) {
    return h.folderIds.map((id) => ({ id, paused: null, error: (e as Error).message }));
  }
  for (const id of h.folderIds) {
    const f = summary.folders.find((x) => x.id === id);
    if (!f) { out.push({ id, paused: null }); continue; }
    let paused = !!f.paused;
    try {
      if (h.paused && !paused) {
        await ctx.syncthing.setFolderPaused(id, true);
        paused = true;
        console.log(`[sync-hold] paused ${id} (${h.reason ?? "manual"})`);
      } else if (!h.paused && paused && !limitHeld(ctx, id)) {
        await ctx.syncthing.setFolderPaused(id, false);
        paused = false;
        console.log(`[sync-hold] resumed ${id} (${h.reason ?? "manual"})`);
      }
      out.push({ id, paused });
    } catch (e) {
      out.push({ id, paused, error: (e as Error).message });
    }
  }
  return out;
}

async function folderStates(ctx: Ctx, ids: string[]): Promise<SyncHoldState["folders"]> {
  try {
    const s = await ctx.syncthing.summary();
    return ids.map((id) => {
      const f = s.folders.find((x) => x.id === id);
      return { id, paused: f ? !!f.paused : null };
    });
  } catch (e) {
    return ids.map((id) => ({ id, paused: null, error: (e as Error).message }));
  }
}

async function state(ctx: Ctx, apply: boolean): Promise<SyncHoldState> {
  const h = load(ctx);
  if (!h) return { paused: false, reason: null, folderIds: [], since: null, folders: [] };
  const folders = apply ? await applySyncHold(ctx) : await folderStates(ctx, h.folderIds);
  return { paused: h.paused, reason: h.reason, folderIds: h.folderIds, since: h.since, folders };
}

export async function setSyncHold(ctx: Ctx, body: unknown): Promise<SyncHoldState> {
  const req = parseSyncHoldRequest(body);
  const prev = load(ctx);
  const since = prev && prev.paused === req.paused && prev.since != null ? prev.since : Date.now();
  const stored: StoredHold = { paused: req.paused, reason: req.paused ? req.reason : null, folderIds: req.folderIds, since };
  kvSet(ctx.db, KEY, stored);
  return state(ctx, true);
}

export function getSyncHold(ctx: Ctx): Promise<SyncHoldState> {
  return state(ctx, false);
}

export function startSyncHold(ctx: Ctx): void {
  const run = () => applySyncHold(ctx).catch((e) => console.warn("[sync-hold]", (e as Error).message));
  setTimeout(() => void run(), STARTUP_DELAY_MS).unref();
  setInterval(() => void run(), REAPPLY_MS).unref();
}

export function registerSyncHoldRoutes(router: Router, ctx: Ctx): void {
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SyncHoldError) {
        const { HttpError } = await import("./http.ts");
        throw new HttpError(e.status, e.message);
      }
      throw e;
    }
  };
  router.get("/v1/sync/hold", () => guard(() => getSyncHold(ctx)));
  router.post("/v1/sync/hold", (req) => guard(() => setSyncHold(ctx, req.body)));
}
