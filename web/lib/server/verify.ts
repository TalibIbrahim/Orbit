/**
 * Phone backup verification runner. READ-ONLY: it reads the Immich API (search/users) and the agents'
 * file manifests and compares them. Nothing here (or in the agent manifest module) deletes, moves,
 * trashes or modifies photos; the result is advice shown in the UI and sent as notifications.
 */
import type {
  BackupsResponse, BackupVerifyResponse, CopyVerification, DumpStatus, ExpectedFile, FolderLimitsResponse, ManifestEntry,
  ManifestHashResponse, ManifestPage, ManifestStatus, PhoneSource, SyncthingSummary, VerificationRun,
  VerificationRunSummary, VerifyTrigger,
} from "@orbit/shared";
import { holdText } from "@/lib/sync/replica-state";
import {
  capWatermark, diffCopy, dumpStatus, isExcludedPath, offloadDecision, overallWatermark, pickHashSample, recommendedCutoff,
  syncVerdict, type SyncFolderInfo,
} from "@/lib/verify/logic";
import { agentErrMsg, agentSend, cachedOnly, errMsg, isOnline } from "./agents";
import { db, type DeviceRow, listDevices } from "./db";
import { primaryHost } from "./devices";
import { immichSnapshot, immichUsers, type ImmichConn, ImmichError } from "./immich";
import { COLORS, notify } from "./notify";
import { computeReplication } from "./replication";
import { getSettings, immichApiKey } from "./settings";
import { desiredHold } from "./sync-control";

const FOLDER = "immich-library";
const DUMPS_FOLDER = "immich-db-dumps";
const SCAN_WAIT_MS = 20 * 60_000;
const HASH_BUDGET_MS = 15 * 60_000;
const PAGE = 5000;
const DAY = 86_400_000;

const g = globalThis as unknown as { __orbitVerify?: { running: boolean; tableReady: boolean } };
const st = (g.__orbitVerify ??= { running: false, tableReady: false });

function table(): ReturnType<typeof db> {
  const d = db();
  if (!st.tableReady) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS verify_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, finished_at INTEGER, trigger TEXT NOT NULL,
        state TEXT NOT NULL, watermark INTEGER, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS verify_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    st.tableReady = true;
  }
  return d;
}

const kvGet = (k: string): string | null =>
  ((table().prepare("SELECT value FROM verify_kv WHERE key = ?").get(k) as { value: string } | undefined)?.value) ?? null;
const kvSet = (k: string, v: string) => table().prepare("INSERT OR REPLACE INTO verify_kv (key, value) VALUES (?, ?)").run(k, v);

const fmt = (ms: number | null) => (ms == null ? "-" : new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── agent manifest access ─────────────────────────────

/** Ask the agent for a fresh scan and wait until one that started after `since` has finished. */
async function freshManifest(d: DeviceRow, since: number): Promise<ManifestStatus> {
  let s = await agentSend<ManifestStatus>(d, "POST", "/manifest/refresh", { folderId: FOLDER }, 30_000);
  const deadline = Date.now() + SCAN_WAIT_MS;
  while ((s.building || (s.builtAt ?? 0) < since) && s.available && Date.now() < deadline) {
    await sleep(5000);
    s = await agentSend<ManifestStatus>(d, "GET", `/manifest?folder=${FOLDER}`, undefined, 30_000);
  }
  if (!s.available) throw new Error(s.error ?? "Immich library folder not found on this device");
  if (s.building) throw new Error(`file scan still running after ${SCAN_WAIT_MS / 60_000} min (${s.scanned} files so far)`);
  return s;
}

async function readManifest(d: DeviceRow): Promise<Map<string, ManifestEntry>> {
  const out = new Map<string, ManifestEntry>();
  let after: string | null = "";
  while (after !== null) {
    const q: string = `/manifest/entries?folder=${FOLDER}&limit=${PAGE}${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const page: ManifestPage = await agentSend<ManifestPage>(d, "GET", q, undefined, 60_000);
    // Same exclusions on every copy (older agents still list e.g. desktop.ini or conflict copies).
    for (const e of page.entries) if (!isExcludedPath(e.path)) out.set(e.path, e);
    after = page.next;
  }
  return out;
}

/** Hash the requested paths on the device (read-only), updating `manifest` in place. */
async function hashOnDevice(d: DeviceRow, manifest: Map<string, ManifestEntry>, paths: string[]): Promise<number> {
  let todo = paths.filter((p) => manifest.get(p) && !manifest.get(p)!.sha1);
  const deadline = Date.now() + HASH_BUDGET_MS;
  let done = 0;
  while (todo.length && Date.now() < deadline) {
    const batch = todo.slice(0, 2000);
    const r = await agentSend<ManifestHashResponse>(d, "POST", "/manifest/hash", { folderId: FOLDER, paths: batch }, 60_000);
    for (const h of r.hashes) {
      const e = manifest.get(h.path);
      if (e && h.sha1) {
        e.sha1 = h.sha1;
        done++;
      }
    }
    const pending = new Set(r.pending);
    todo = [...r.pending, ...todo.slice(batch.length).filter((p) => !pending.has(p))];
    if (r.hashes.length === 0 && r.pending.length === batch.length) await sleep(2000);
  }
  return done;
}

// ───────────────────────────── sync / dump state ─────────────────────────────

interface CopySync {
  syncOk: boolean;
  issues: string[];
  notes: string[];
  pausedNote: string | null;
  versioning: boolean;
  pausedByOrbit: boolean;
  folders: NonNullable<CopyVerification["syncFolders"]>;
}

/**
 * Syncthing state of one copy, as a secondary signal to the file manifest (see syncVerdict):
 * it only blocks with a concrete reason, never because sync is paused on purpose or a peer is offline.
 */
function syncState(d: DeviceRow, isHost: boolean, manifestClean: boolean, dump: DumpStatus): CopySync {
  const issues: string[] = [];
  const notes: string[] = [];
  let pausedNote: string | null = null;
  const own = cachedOnly<SyncthingSummary>(d.id, "/syncthing");
  const folder = own?.folders.find((f) => f.id === FOLDER);
  const limits = cachedOnly<FolderLimitsResponse>(d.id, "/folders")?.folders ?? [];
  const pausedByOrbit = limits.some((f) => f.syncthingFolderId === FOLDER && f.pausedByOrbit);
  if (pausedByOrbit) issues.push("Syncthing paused by a folder limit");
  const hold = holdText(desiredHold());
  const folders: CopySync["folders"] = [];

  if (isHost) {
    if (!own?.available) notes.push(`Syncthing not reachable${own?.error ? ` (${own.error})` : ""}`);
    else if (!folder) notes.push("Immich library folder is not shared by Syncthing here");
    else {
      if (folder.paused && !pausedByOrbit) {
        pausedNote = hold ?? "folder paused";
        notes.push(`library sync ${hold ?? "paused"}`);
      }
      if (folder.state === "error") issues.push("Syncthing reports a folder error");
    }
    return { syncOk: issues.length === 0, issues, notes, pausedNote, versioning: true, pausedByOrbit, folders };
  }

  const rep = computeReplication().replicas.find((r) => r.deviceId === d.id);
  const info = (id: string): SyncFolderInfo | null => {
    const f = rep?.folders.find((x) => x.folderId === id);
    if (!f) return null;
    folders.push({ folderId: f.folderId, label: f.label, state: f.state, completion: f.completion, reason: f.reason ?? null, ...(f.detail ? { detail: f.detail } : {}) });
    return { folderId: id, state: f.state, completion: f.completion, needItems: f.needItems, needBytes: f.needBytes, reason: f.reason ?? null, lastInSyncAt: f.lastInSyncAt };
  };
  const lib = info(FOLDER);
  const dumps = info(DUMPS_FOLDER);
  const v = syncVerdict({ manifestClean, library: lib, dumps, dump });
  if (!(pausedByOrbit && lib?.state === "paused")) issues.push(...v.issues);
  else issues.push(...v.issues.filter((s) => !s.startsWith("library sync paused")));
  notes.push(...v.notes);
  pausedNote = v.pausedNote;
  const libRow = rep?.folders.find((f) => f.folderId === FOLDER);
  const versioning = !!(libRow?.versioning || folder?.versioning);
  if (!versioning) issues.push("versioning is off");
  return { syncOk: issues.length === 0, issues, notes, pausedNote, versioning, pausedByOrbit, folders };
}

/** Immich DB dump status on the Immich host (pgdump job). */
function hostDump(host: DeviceRow, newestAsset: number | null): DumpStatus {
  const jobs = cachedOnly<BackupsResponse>(host.id, "/backups")?.jobs ?? null;
  return dumpStatus(jobs, newestAsset, host.id);
}

// ───────────────────────────── run ─────────────────────────────

function emptyCopy(d: DeviceRow, isHost: boolean, error: string): CopyVerification {
  return {
    deviceId: d.id, name: d.name, isHost, online: isOnline(d), lastSeen: d.lastSeen, expectedFiles: 0, presentFiles: 0,
    files: 0, bytes: 0, hashed: 0, missing: 0, sizeMismatch: 0, hashMismatch: 0, extra: 0, problems: [], syncOk: false,
    syncIssues: [], watermark: null, verifiedAt: null, error,
  };
}

function save(run: VerificationRun): number {
  const d = table();
  const json = JSON.stringify(run);
  if (run.id) {
    d.prepare("UPDATE verify_runs SET finished_at = ?, state = ?, watermark = ?, json = ? WHERE id = ?")
      .run(run.finishedAt, run.state, run.watermark, json, run.id);
    return run.id;
  }
  const r = d.prepare("INSERT INTO verify_runs (started_at, finished_at, trigger, state, watermark, json) VALUES (?, ?, ?, ?, ?, ?)")
    .run(run.startedAt, run.finishedAt, run.trigger, run.state, run.watermark, json);
  d.prepare("DELETE FROM verify_runs WHERE id NOT IN (SELECT id FROM verify_runs ORDER BY id DESC LIMIT 200)").run();
  return Number(r.lastInsertRowid);
}

export function isVerifying(): boolean {
  return st.running;
}

/** Start a run in the background. Returns false if one is already running. */
export function startVerification(trigger: VerifyTrigger): boolean {
  if (st.running) return false;
  st.running = true;
  kvSet("lastStart", String(Date.now()));
  void runVerification(trigger)
    .catch((e) => console.error("[verify] run failed:", errMsg(e)))
    .finally(() => {
      st.running = false;
    });
  return true;
}

async function runVerification(trigger: VerifyTrigger): Promise<void> {
  const startedAt = Date.now();
  const settings = getSettings();
  const cfg = settings.immich;
  const key = immichApiKey(settings);
  const run: VerificationRun = {
    id: 0, startedAt, finishedAt: null, trigger, state: "unknown", watermark: null, reasons: [], copies: [], sources: [],
    newestAsset: null, newestDump: null,
  };
  run.id = save(run);
  console.log(`[verify] run ${run.id} started (${trigger})`);

  const finish = (state = run.state) => {
    run.state = state;
    run.finishedAt = Date.now();
    save(run);
    console.log(`[verify] run ${run.id} finished: ${run.state}, verified through ${fmt(run.watermark)}${run.reasons.length ? ` - ${run.reasons.join("; ")}` : ""}`);
  };

  if (!cfg.url || !key) {
    run.reasons = [!cfg.url ? "Immich URL not set (Settings -> Immich)" : "Immich API key not set (Settings -> Immich)"];
    return finish("unknown");
  }
  const conn: ImmichConn = { url: cfg.url, apiKey: key };

  // 1. What Immich says must exist.
  let snap: Awaited<ReturnType<typeof immichSnapshot>>;
  let users: { id: string; name: string }[] = [];
  try {
    users = await immichUsers(conn).catch(() => []);
    snap = await immichSnapshot(conn, cfg.sourceUserIds);
  } catch (e) {
    run.error = errMsg(e);
    run.reasons = [e instanceof ImmichError ? run.error : `Immich: ${run.error}`];
    return finish("unknown");
  }
  run.newestAsset = snap.newestAsset;
  run.sources = [...snap.owners].map(([ownerId, o]): PhoneSource => ({
    ownerId, ownerName: users.find((u) => u.id === ownerId)?.name ?? ownerId.slice(0, 8), photos: o.photos, videos: o.videos,
    livePhotoVideos: o.livePhotoVideos, bytes: o.bytes, newestUpload: o.newest,
  }));

  // 2. Every copy: host (Immich itself) and each replica.
  const host = primaryHost();
  if (!host) {
    run.reasons = ["No Immich host device registered"];
    return finish("unknown");
  }
  run.dump = hostDump(host, run.newestAsset);
  run.newestDump = run.dump.newest;
  const replicas = listDevices().filter((d) => d.enrolled && d.id !== host.id && (d.role === "replica" || d.role === "standby"));
  const seed = new Date(startedAt).toISOString().slice(0, 10);
  const hashPaths = pickHashSample(snap.expected, startedAt, cfg.hashRecentDays, cfg.samplePercent, seed);

  const known = new Set(snap.expected.map((e) => e.path));
  const dump = run.dump;
  const verifyCopy = async (d: DeviceRow, isHost: boolean, reference?: Map<string, ManifestEntry>) => {
    if (!isOnline(d)) return { copy: emptyCopy(d, isHost, "offline - not verified this run"), manifest: null };
    try {
      await freshManifest(d, startedAt);
      const manifest = await readManifest(d);
      // Every copy must hold the files on the host's disk that Immich does not list (e.g. XMP sidecars, orphans),
      // the host included, so all copies are checked against the same list and show the same counts.
      const ref = reference ?? manifest;
      const hostOnly: ExpectedFile[] = [];
      for (const e of ref.values()) {
        if (known.has(e.path)) continue;
        hostOnly.push({ path: e.path, assetId: "", ownerId: "", kind: /\.xmp$/i.test(e.path) ? "sidecar" : "photo", size: e.size, sha1: e.sha1, createdAt: e.mtimeMs });
      }
      const expected: ExpectedFile[] = [...snap.expected, ...hostOnly];
      await hashOnDevice(d, manifest, hashPaths);
      const diff = diffCopy(expected, manifest, { reference });
      const sync = syncState(d, isHost, diff.missing + diff.sizeMismatch + diff.hashMismatch === 0, dump);
      let bytes = 0;
      for (const e of manifest.values()) bytes += e.size;
      const copy: CopyVerification = {
        deviceId: d.id, name: d.name, isHost, online: true, lastSeen: d.lastSeen, expectedFiles: expected.length,
        presentFiles: diff.presentFiles, files: manifest.size, bytes, hashed: diff.hashed, missing: diff.missing,
        sizeMismatch: diff.sizeMismatch, hashMismatch: diff.hashMismatch, extra: diff.extra, problems: diff.problems,
        otherFiles: hostOnly.length, otherPaths: hostOnly.slice(0, 20).map((e) => e.path),
        syncOk: sync.syncOk, syncIssues: sync.issues, syncNotes: sync.notes, syncFolders: sync.folders,
        watermark: diff.watermark, verifiedAt: Date.now(),
      };
      return { copy, manifest, sync };
    } catch (e) {
      return { copy: emptyCopy(d, isHost, agentErrMsg(e)), manifest: null };
    }
  };

  const hostResult = await verifyCopy(host, true);
  const replicaResults = await Promise.all(replicas.map((d) => verifyCopy(d, false, hostResult.manifest ?? undefined)));
  const results = [hostResult, ...replicaResults];
  run.copies = results.map((r) => r.copy);

  // 3. Watermark + decision.
  const eligible = (c: CopyVerification) => c.verifiedAt != null && !c.error && (c.isHost || c.syncOk);
  const wm = overallWatermark(
    run.copies.map((c) => ({ watermark: c.watermark, eligible: eligible(c), isHost: c.isHost })),
    cfg.minCopies, cfg.requireNonHostCopy,
  );
  run.watermark = capWatermark(wm, run.newestDump);
  const decision = offloadDecision({
    configured: true, immichReachable: true, newestAsset: run.newestAsset, newestDump: run.newestDump, dump: run.dump, watermark: run.watermark,
    minCopies: cfg.minCopies, requireNonHost: cfg.requireNonHostCopy,
    copies: results.map(({ copy, sync }) => ({
      name: copy.name, isHost: copy.isHost, online: copy.online, verified: copy.verifiedAt != null && !copy.error,
      mismatches: copy.missing + copy.sizeMismatch + copy.hashMismatch, syncOk: copy.syncOk || copy.isHost,
      syncIssues: copy.syncIssues, versioning: copy.isHost || (sync?.versioning ?? false), pausedByOrbit: sync?.pausedByOrbit ?? false,
    })),
  });
  run.reasons = [...decision.reasons, ...run.copies.filter((c) => c.error && c.online).map((c) => `${c.name}: ${c.error}`)];
  if (snap.skipped) run.reasons.push(`${snap.skipped} assets outside the Immich library folder (e.g. external libraries) are not checked`);
  // A clean result while sync is paused on purpose says so, with the exact reason.
  // The exact per-copy reason is in each copy's syncNotes.
  const paused = results.map((r) => r.sync?.pausedNote).find((n): n is string => !!n);
  const hold = desiredHold();
  run.stateNote = decision.state !== "safe" || !paused
    ? null
    : hold.paused
      ? hold.reason === "manual" ? "sync paused by you" : "sync paused by schedule"
      : `sync paused: ${paused}`;
  finish(decision.state);
  await notifyAfterRun(run);
}

async function notifyAfterRun(run: VerificationRun): Promise<void> {
  const cfg = getSettings().immich;
  const prev = Number(kvGet("notifiedWatermark") ?? 0);
  if (cfg.notifyWatermark && run.watermark != null && run.watermark > prev) {
    const copies = run.copies.filter((c) => c.watermark != null && c.watermark >= run.watermark!).map((c) => c.name).join(", ");
    const r = await notify(
      "Phone backup verified",
      `All required copies are verified through ${fmt(run.watermark)} (${copies}).\n` +
        (run.state === "safe" ? "Everything uploaded so far is verified: see Orbit -> Offload for the cutoff to use in the Immich app." : `Not everything is verified yet: ${run.reasons[0] ?? ""}`),
      COLORS.ok,
    );
    if (r.ok) kvSet("notifiedWatermark", String(run.watermark));
  }
  // Missing / mismatched files are raised as "backup-verify" alerts (alerts.ts), notified once and resolved automatically.
}

// ───────────────────────────── queries + scheduling ─────────────────────────────

const summaryOf = (r: VerificationRun): VerificationRunSummary => ({
  id: r.id, startedAt: r.startedAt, finishedAt: r.finishedAt, trigger: r.trigger, state: r.state, watermark: r.watermark,
  reasons: r.reasons, ...(r.error ? { error: r.error } : {}),
});

export function getRun(id: number): VerificationRun | null {
  const r = table().prepare("SELECT json FROM verify_runs WHERE id = ?").get(id) as { json: string } | undefined;
  return r ? (JSON.parse(r.json) as VerificationRun) : null;
}

export function latestRun(): VerificationRun | null {
  const r = table().prepare("SELECT json FROM verify_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1").get() as { json: string } | undefined;
  return r ? (JSON.parse(r.json) as VerificationRun) : null;
}

export function verifyOverview(): BackupVerifyResponse {
  const s = getSettings();
  const latest = latestRun();
  const history = (table().prepare("SELECT json FROM verify_runs ORDER BY id DESC LIMIT 50").all() as { json: string }[])
    .map((r) => summaryOf(JSON.parse(r.json) as VerificationRun));
  return {
    configured: !!s.immich.url && !!s.immich.apiKey,
    running: st.running,
    latest,
    history,
    recommendedCutoff: latest?.state === "safe" || latest?.watermark ? recommendedCutoff(latest?.watermark ?? null) : null,
  };
}

/**
 * Called from the poller every minute: scheduled runs, and a run once an upload batch has settled
 * (new assets seen, then no newer ones for 15 min).
 */
export async function verifyTick(now = Date.now(), newestUpload?: () => Promise<number | null>): Promise<void> {
  const s = getSettings();
  if (!s.immich.url || !s.immich.apiKey || st.running) return;
  const lastStart = Number(kvGet("lastStart") ?? 0);
  if (s.immich.scheduleHours > 0 && now - lastStart > s.immich.scheduleHours * 3_600_000) {
    startVerification("schedule");
    return;
  }
  if (!newestUpload) return;
  const lastCheck = Number(kvGet("uploadCheckAt") ?? 0);
  if (now - lastCheck < 5 * 60_000) return;
  kvSet("uploadCheckAt", String(now));
  const newest = await newestUpload().catch(() => null);
  if (newest == null) return;
  const known = Number(kvGet("newestUpload") ?? 0);
  if (newest > known) {
    kvSet("newestUpload", String(newest));
    kvSet("uploadSeenAt", String(now));
    return;
  }
  const seenAt = Number(kvGet("uploadSeenAt") ?? 0);
  if (seenAt > lastStart && now - seenAt >= 15 * 60_000) startVerification("upload");
}

export const DAY_MS = DAY;
