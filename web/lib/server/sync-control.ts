/**
 * "Pause sync" everywhere + sync schedule. The hub decides the desired state (paused by the user, or
 * outside the schedule's allowed windows) and pushes it to every device's agent as a sync hold, which
 * pauses / resumes only the shared Syncthing folders. Offline devices get it when they come back.
 */
import type { SyncControlState, SyncHoldReason, SyncHoldRequest, SyncHoldState, SyncSchedule } from "@orbit/shared";
import { nextChange, scheduleAllows, validateSchedule } from "@/lib/sync/schedule";
import { agentErrMsg, agentSend, isOnline } from "./agents";
import { db, type DeviceRow, listDevices } from "./db";
import { getSettings } from "./settings";

interface Stored {
  pausedByUser: boolean;
  pausedAt: number | null;
  schedule: SyncSchedule;
}

const DEFAULT: Stored = {
  pausedByUser: false,
  pausedAt: null,
  schedule: { enabled: false, timezone: "UTC", windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "01:00", end: "07:00" }] },
};
const REASSERT_MS = 10 * 60_000;

const g = globalThis as unknown as {
  __orbitSync?: { ready: boolean; sent: Map<string, { key: string; at: number; ok: boolean; error?: string }> };
};
const mem = (g.__orbitSync ??= { ready: false, sent: new Map() });

function table() {
  const d = db();
  if (!mem.ready) {
    d.exec("CREATE TABLE IF NOT EXISTS sync_control (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)");
    mem.ready = true;
  }
  return d;
}

function load(): Stored {
  const r = table().prepare("SELECT json FROM sync_control WHERE id = 1").get() as { json: string } | undefined;
  if (!r) return DEFAULT;
  try {
    const s = JSON.parse(r.json) as Partial<Stored>;
    const v = validateSchedule(s.schedule);
    return { pausedByUser: !!s.pausedByUser, pausedAt: s.pausedAt ?? null, schedule: v.ok ? v.schedule : DEFAULT.schedule };
  } catch {
    return DEFAULT;
  }
}
const store = (s: Stored) => table().prepare("INSERT OR REPLACE INTO sync_control (id, json) VALUES (1, ?)").run(JSON.stringify(s));

/** Desired state right now. */
export function desiredHold(now = Date.now(), s = load()): { paused: boolean; reason: SyncHoldReason | null } {
  if (s.pausedByUser) return { paused: true, reason: "manual" };
  if (!scheduleAllows(s.schedule, now)) return { paused: true, reason: "schedule" };
  return { paused: false, reason: null };
}

/** True while sync is paused on purpose (alerts such as "replica behind" stay quiet then). */
export const syncPausedOnPurpose = (now = Date.now()) => desiredHold(now).paused;

const folderIds = () => getSettings().sharedFolders.map((f) => f.id);

async function pushTo(d: DeviceRow, req: SyncHoldRequest, key: string): Promise<void> {
  try {
    const st = await agentSend<SyncHoldState>(d, "POST", "/sync/hold", req, 15_000);
    const failed = st.folders.filter((f) => f.error).map((f) => `${f.id}: ${f.error}`);
    mem.sent.set(d.id, { key, at: Date.now(), ok: failed.length === 0, ...(failed.length ? { error: failed.join("; ") } : {}) });
  } catch (e) {
    mem.sent.set(d.id, { key, at: Date.now(), ok: false, error: agentErrMsg(e) });
  }
}

/**
 * Push the desired hold to every online device whose last push differs or is older than REASSERT_MS.
 * `force` pushes to all online devices now (after a button press / schedule change).
 */
export async function applySyncControl(force = false, now = Date.now()): Promise<void> {
  const want = desiredHold(now);
  const req: SyncHoldRequest = { paused: want.paused, folderIds: folderIds(), reason: want.reason };
  const key = JSON.stringify(req);
  const jobs = listDevices()
    .filter((d) => d.enrolled && d.agentUrl && isOnline(d, now))
    .filter((d) => {
      const last = mem.sent.get(d.id);
      return force || !last || last.key !== key || !last.ok || now - last.at > REASSERT_MS;
    })
    .map((d) => pushTo(d, req, key));
  if (jobs.length) {
    const prev = g.__orbitSync as unknown as { lastLogged?: string };
    if (prev.lastLogged !== key) {
      console.log(`[sync-control] ${want.paused ? `pausing sync (${want.reason})` : "resuming sync"} on ${jobs.length} device(s)`);
      prev.lastLogged = key;
    }
    await Promise.all(jobs);
  }
}

export function syncControlState(now = Date.now()): SyncControlState {
  const s = load();
  const want = desiredHold(now, s);
  const key = JSON.stringify({ paused: want.paused, folderIds: folderIds(), reason: want.reason });
  const allows = scheduleAllows(s.schedule, now);
  return {
    pausedByUser: s.pausedByUser,
    pausedAt: s.pausedAt,
    schedule: s.schedule,
    scheduleAllowsNow: allows,
    effectivePaused: want.paused,
    reason: want.reason,
    nextChange: s.schedule.enabled ? nextChange(s.schedule, now) : null,
    devices: listDevices()
      .filter((d) => d.enrolled)
      .map((d) => {
        const last = mem.sent.get(d.id);
        return {
          id: d.id, name: d.name, online: isOnline(d, now),
          applied: last ? last.key === key && last.ok : null,
          ...(last?.error ? { error: last.error } : {}),
        };
      }),
  };
}

/** Button / schedule editor. Returns an error message for invalid input. */
export async function updateSyncControl(patch: { paused?: unknown; schedule?: unknown }): Promise<string | null> {
  const s = load();
  if (patch.paused !== undefined) {
    if (typeof patch.paused !== "boolean") return "paused must be true or false";
    if (patch.paused !== s.pausedByUser) {
      s.pausedByUser = patch.paused;
      s.pausedAt = patch.paused ? Date.now() : null;
      console.log(`[sync-control] sync ${patch.paused ? "paused" : "resumed"} by the user`);
    }
  }
  if (patch.schedule !== undefined) {
    const v = validateSchedule(patch.schedule);
    if (!v.ok) return v.error;
    s.schedule = v.schedule;
  }
  store(s);
  await applySyncControl(true);
  return null;
}
