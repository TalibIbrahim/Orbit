// Pure, dependency-free logic for phone backup verification (read-only advice only).
import type { CopyProblem, DumpStatus, ExpectedFile, JobSummary, ManifestEntry, OffloadState, ReplicaState } from "@orbit/shared";

const DAY_MS = 86_400_000;

/**
 * Map an Immich originals path (container path, e.g. "/data/library/..." or
 * "/usr/src/app/upload/upload/...") to the path relative to the upload root.
 * Returns the part starting at the first "library/" or "upload/" segment, else null.
 */
export function immichPathToRelative(originalPath: string): string | null {
  // Older images mount the upload location at /usr/src/app/upload; that "upload" is the root, not a segment.
  const norm = originalPath.replace(/\\/g, "/").replace(/^\/usr\/src\/app\/upload(?=\/|$)/, "");
  const parts = norm.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === "library" || parts[i] === "upload") {
      return parts.slice(i).filter((p, idx) => idx === 0 || p !== "").join("/");
    }
  }
  return null;
}

const OS_JUNK = new Set(["desktop.ini", "thumbs.db", "ehthumbs.db"]);

/**
 * True for paths that are never Immich originals and are left out of every manifest, so host and replica
 * counts compare like for like: anything outside upload/ and library/, Syncthing's own entries (.stfolder,
 * .stignore, .stversions, .syncthing.*.tmp, ~syncthing~*.tmp, *.syncthing.tmp), conflict copies, other hidden
 * entries, partial/temp files and OS junk (desktop.ini, Thumbs.db). Mirrors the agent's skipName so older
 * agents' manifests are filtered the same way.
 */
export function isExcludedPath(rel: string): boolean {
  const parts = rel.replace(/\\/g, "/").split("/");
  if (parts.length < 2 || (parts[0] !== "upload" && parts[0] !== "library")) return true;
  return parts.some((p) => {
    const l = p.toLowerCase();
    return p.startsWith(".") || p.startsWith("~syncthing~") || l.endsWith(".tmp") || l.endsWith(".partial") || l.includes(".sync-conflict-") || OS_JUNK.has(l);
  });
}

/** Immich checksums are base64 SHA-1; return lowercase hex. */
export function base64ToHex(b64: string): string {
  if (!b64) return "";
  return Buffer.from(b64, "base64").toString("hex");
}

export interface DiffResult {
  presentFiles: number;
  missing: number;
  sizeMismatch: number;
  hashMismatch: number;
  extra: number;
  hashed: number;
  problems: CopyProblem[];
  watermark: number | null;
  newestExpected: number | null;
}

/**
 * Compare a copy's manifest to the files Immich expects.
 * Size is checked against expected.size, or the reference (host) manifest when unknown.
 * Hash is compared only when both sides have one. Extras are informational.
 */
export function diffCopy(
  expected: ExpectedFile[],
  manifest: Map<string, ManifestEntry> | Iterable<ManifestEntry>,
  opts: { reference?: Map<string, ManifestEntry>; maxProblems?: number } = {},
): DiffResult {
  const max = opts.maxProblems ?? 50;
  const map = manifest instanceof Map ? manifest : new Map([...manifest].map((e) => [e.path, e]));
  const expectedPaths = new Set<string>();
  const real: CopyProblem[] = [];
  let presentFiles = 0;
  let missing = 0;
  let sizeMismatch = 0;
  let hashMismatch = 0;
  let hashed = 0;

  for (const f of expected) {
    expectedPaths.add(f.path);
    const m = map.get(f.path);
    if (!m) {
      missing++;
      real.push({ kind: "missing", path: f.path, createdAt: f.createdAt });
      continue;
    }
    const ref = opts.reference?.get(f.path);
    const wantSize = f.size ?? ref?.size ?? null;
    if (wantSize !== null && m.size !== wantSize) {
      sizeMismatch++;
      real.push({ kind: "size-mismatch", path: f.path, detail: `${m.size} bytes, expected ${wantSize}`, createdAt: f.createdAt });
      continue;
    }
    const wantHash = f.sha1 ?? ref?.sha1 ?? null;
    if (m.sha1 && wantHash) {
      hashed++;
      if (m.sha1 !== wantHash) {
        hashMismatch++;
        real.push({ kind: "hash-mismatch", path: f.path, detail: `sha1 ${m.sha1}, expected ${wantHash}`, createdAt: f.createdAt });
        continue;
      }
    }
    presentFiles++;
  }

  const extras: CopyProblem[] = [];
  let extra = 0;
  for (const p of map.keys()) {
    if (expectedPaths.has(p)) continue;
    extra++;
    if (extras.length < max) extras.push({ kind: "extra", path: p });
  }

  real.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const problems = real.slice(0, max);
  for (const e of extras) {
    if (problems.length >= max) break;
    problems.push(e);
  }

  let newestExpected: number | null = null;
  let earliestProblem: number | null = null;
  for (const f of expected) if (newestExpected === null || f.createdAt > newestExpected) newestExpected = f.createdAt;
  for (const p of real) if (p.createdAt !== undefined && (earliestProblem === null || p.createdAt < earliestProblem)) earliestProblem = p.createdAt;

  let watermark: number | null;
  if (earliestProblem === null) watermark = newestExpected;
  else {
    watermark = null;
    for (const f of expected) if (f.createdAt < earliestProblem && (watermark === null || f.createdAt > watermark)) watermark = f.createdAt;
  }
  return { presentFiles, missing, sizeMismatch, hashMismatch, extra, hashed, problems, watermark, newestExpected };
}

/**
 * Largest T such that at least minCopies eligible copies have watermark >= T and,
 * if requireNonHost, at least one of those is not the host.
 */
export function overallWatermark(
  copies: { watermark: number | null; eligible: boolean; isHost: boolean }[],
  minCopies: number,
  requireNonHost: boolean,
): number | null {
  const k = Math.max(1, Math.floor(minCopies));
  const sorted = copies
    .filter((c): c is { watermark: number; eligible: boolean; isHost: boolean } => c.eligible && c.watermark !== null)
    .sort((a, b) => b.watermark - a.watermark);
  if (sorted.length < k) return null;
  const wk = sorted[k - 1].watermark;
  if (!requireNonHost) return wk;
  if (sorted.slice(0, k).some((c) => !c.isHost)) return wk;
  const bestNonHost = sorted.find((c) => !c.isHost);
  return bestNonHost ? bestNonHost.watermark : null;
}

// ───────────────────────────── database dumps ─────────────────────────────

/** Newest real dump time of one pgdump job (a .sql / .sql.gz artifact, else the last successful run). */
function jobDumpTime(j: JobSummary): number | null {
  if (j.latestArtifact && /\.sql(\.gz)?$/i.test(j.latestArtifact.name)) return j.latestArtifact.mtime;
  return j.lastRun?.ok && j.lastRun.finishedAt ? j.lastRun.finishedAt : null;
}

/**
 * Immich database dump status on the host. Separates "no dump job configured", "job exists but no dump yet",
 * "only failed runs", and "newest dump older than the newest upload". jobs === null: the host has not reported.
 */
export function dumpStatus(jobs: JobSummary[] | null, newestAsset: number | null, hostDeviceId: string | null): DumpStatus {
  const base = { hostDeviceId, newest: null, jobId: null };
  if (jobs === null) return { ...base, state: "unknown", detail: "arm-free has not reported its backup jobs yet" };
  const dumpJobs = jobs.filter((j) => j.kind === "pgdump");
  if (dumpJobs.length === 0) {
    return {
      ...base, state: "no-job",
      detail: "No Immich database dump job on arm-free. Re-run install-arm-free.sh --mode arm-free; it adds the immich-db job to /etc/orbit/agent.json.",
    };
  }
  let best: { j: JobSummary; t: number } | null = null;
  for (const j of dumpJobs) {
    const t = jobDumpTime(j);
    if (t !== null && (best === null || t > best.t)) best = { j, t };
  }
  if (!best) {
    const failed = dumpJobs.find((j) => j.lastRun && j.lastRun.ok === false);
    if (failed) {
      return {
        ...base, state: "failed", jobId: failed.id,
        detail: `No database dump yet: the last ${failed.name} run failed${failed.lastRun?.exitCode != null ? ` (exit ${failed.lastRun.exitCode})` : ""}`,
      };
    }
    const running = dumpJobs.find((j) => j.running);
    return { ...base, state: "none", jobId: (running ?? dumpJobs[0]).id, detail: running ? "The first database dump is running now" : "No database dump exists yet" };
  }
  if (newestAsset !== null && best.t < newestAsset) {
    return { ...base, state: "stale", newest: best.t, jobId: best.j.id, detail: `Newest database dump (${fmtDate(best.t)}) is older than the newest upload (${fmtDate(newestAsset)})` };
  }
  return { ...base, state: "ok", newest: best.t, jobId: best.j.id, detail: null };
}

// ───────────────────────────── Syncthing as a secondary signal ─────────────────────────────

export interface SyncFolderInfo {
  folderId: string;
  state: ReplicaState;
  completion: number | null;
  needItems: number | null;
  needBytes: number | null;
  reason: string | null;
  lastInSyncAt: number | null;
}

const fmtBytes = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(0)} KB` : `${b} B`;

/**
 * Turn a replica's Syncthing folder states into blocking issues and informational notes.
 * The file manifest is the proof of completeness: when it is clean, Syncthing may only block with a
 * concrete reason (a folder error, or files actively still arriving). Paused (by schedule, by hand),
 * a disconnected peer, "nothing to sync" and unknown completion are notes, never a downgrade.
 * Database dumps are not in the manifest, so their folder blocks when it is behind a known dump.
 */
export function syncVerdict(input: {
  manifestClean: boolean;
  library: SyncFolderInfo | null;
  dumps: SyncFolderInfo | null;
  dump: DumpStatus;
}): { issues: string[]; notes: string[]; pausedNote: string | null } {
  const issues: string[] = [];
  const notes: string[] = [];
  let pausedNote: string | null = null;
  const why = (f: SyncFolderInfo) => (f.reason ? `: ${f.reason}` : "");
  const pending = (f: SyncFolderInfo) =>
    `${f.needItems ?? "?"} item${f.needItems === 1 ? "" : "s"}${f.needBytes ? ` (${fmtBytes(f.needBytes)})` : ""} still to download`;

  const lib = input.library;
  if (!lib) {
    (input.manifestClean ? notes : issues).push("library folder not reported by Syncthing");
  } else {
    switch (lib.state) {
      case "up-to-date":
        break;
      case "syncing":
        issues.push(`library still syncing${lib.completion != null ? ` (${Math.floor(lib.completion)}%)` : ""}: ${pending(lib)}`);
        break;
      case "error":
        issues.push(`library${why(lib)}`);
        break;
      case "paused":
        pausedNote ??= lib.reason;
        (input.manifestClean ? notes : issues).push(`library sync paused${why(lib)}`);
        break;
      case "peer-offline":
        (input.manifestClean ? notes : issues).push(`library peer offline${why(lib)}`);
        break;
      case "nothing-to-sync":
        notes.push("library: nothing to sync (global size 0)");
        break;
      default:
        (input.manifestClean ? notes : issues).push(`library sync state ${lib.state}${why(lib)}`);
    }
  }

  // Dumps only matter once a dump exists; "no dump yet" is reported once, by the dump status.
  const d = input.dumps;
  const dumpExists = input.dump.newest !== null;
  if (d && dumpExists) {
    const newest = input.dump.newest as number;
    const covered = d.lastInSyncAt !== null && d.lastInSyncAt >= newest;
    switch (d.state) {
      case "up-to-date":
      case "nothing-to-sync":
        break;
      case "syncing":
        issues.push(`database dumps not fully synced: ${pending(d)}`);
        break;
      case "error":
        issues.push(`database dumps${why(d)}`);
        break;
      case "paused":
        pausedNote ??= d.reason;
        if (covered) notes.push(`database dumps sync paused${why(d)}; in sync since the newest dump`);
        else if (d.lastInSyncAt !== null) issues.push(`newest database dump (${fmtDate(newest)}) not synced yet: last in sync ${fmtDate(d.lastInSyncAt)}, sync ${d.reason ?? "paused"}`);
        else notes.push(`database dumps sync paused${why(d)}; not confirmed yet`);
        break;
      case "peer-offline":
        if (covered) notes.push(`database dumps peer offline${why(d)}; in sync since the newest dump`);
        else issues.push(`newest database dump (${fmtDate(newest)}) not confirmed on this copy${why(d)}`);
        break;
      default:
        notes.push(`database dumps sync state ${d.state}${why(d)}`);
    }
  }
  return { issues, notes, pausedNote };
}

/** The DB dump must cover the assets: min(w, newestDump); null if either is null. */
export function capWatermark(w: number | null, newestDump: number | null): number | null {
  if (w === null || newestDump === null) return null;
  return Math.min(w, newestDump);
}

export interface OffloadInput {
  configured: boolean;
  immichReachable: boolean;
  newestAsset: number | null;
  newestDump: number | null;
  dump?: DumpStatus;
  watermark: number | null;
  minCopies: number;
  requireNonHost: boolean;
  copies: {
    name: string;
    isHost: boolean;
    online: boolean;
    verified: boolean; // verification completed this run
    mismatches: number; // missing + size + hash
    syncOk: boolean;
    syncIssues: string[];
    versioning: boolean;
    pausedByOrbit: boolean;
  }[];
}

const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Decide whether it is safe to offload (delete) phone originals. Advice only. */
export function offloadDecision(input: OffloadInput): { state: OffloadState; reasons: string[] } {
  const unknown = (reasons: string[]) => ({ state: "unknown" as const, reasons });
  if (!input.configured) return unknown(["Immich is not configured"]);
  if (!input.immichReachable) return unknown(["Immich is not reachable"]);
  if (input.newestAsset === null) return unknown(["Immich has no assets yet"]);
  if (!input.copies.some((c) => c.verified)) return unknown(["No copy has been verified yet"]);

  const reasons: string[] = [];
  const clean = input.copies.filter((c) => c.verified && c.mismatches === 0);
  if (clean.length < input.minCopies) {
    reasons.push(`Only ${clean.length} verified ${clean.length === 1 ? "copy" : "copies"}, ${input.minCopies} required`);
  }
  if (input.requireNonHost && !clean.some((c) => !c.isHost)) reasons.push("No verified copy outside arm-free");

  for (const c of input.copies) {
    if (c.online && !c.verified) reasons.push(`${c.name}: online but not verified`);
    else if (c.verified && c.mismatches > 0) reasons.push(`${c.name}: ${plural(c.mismatches, "file")} missing or different`);
    if (c.pausedByOrbit) reasons.push(`${c.name}: Syncthing paused by a folder limit`);
    if (!c.isHost && !c.versioning) reasons.push(`${c.name}: file versioning is off`);
    if (c.online && !c.syncOk && !c.pausedByOrbit) {
      reasons.push(`${c.name}: sync not clean${c.syncIssues.length ? ` (${c.syncIssues.join("; ")})` : ""}`);
    }
  }

  const dump = input.dump;
  if (dump && dump.state !== "ok") {
    if (dump.state === "none" || dump.state === "failed") reasons.push(`${dump.detail ?? "No database dump exists yet"}: run the Immich DB dump now (Backups)`);
    else reasons.push(dump.detail ?? "Database dump status unknown");
  } else if (!dump) {
    if (input.newestDump === null) reasons.push("No database dump found");
    else if (input.newestDump < input.newestAsset) {
      reasons.push(`Newest database dump (${fmtDate(input.newestDump)}) is older than the newest upload (${fmtDate(input.newestAsset)})`);
    }
  }
  // Without a dump the watermark is capped to null; that reason is already given above.
  if (input.watermark === null) {
    if (input.newestDump !== null || !dump) reasons.push("No date is verified on enough copies yet");
  } else if (input.watermark < input.newestAsset) {
    reasons.push(`Verified only through ${fmtDate(input.watermark)}, newest upload is ${fmtDate(input.newestAsset)}`);
  }
  return reasons.length ? { state: "not-yet", reasons } : { state: "safe", reasons: [] };
}

/** Start of the watermark's day (00:00 at the given UTC offset in minutes). */
export function recommendedCutoff(watermark: number | null, tzOffsetMinutes = 0): number | null {
  if (watermark === null) return null;
  const off = tzOffsetMinutes * 60_000;
  return Math.floor((watermark + off) / DAY_MS) * DAY_MS - off;
}

/** FNV-1a 32-bit hash. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Paths to hash: every hashable file (has expected.sha1) uploaded within recentDays,
 * plus a deterministic sample (samplePercent %) of older ones.
 */
export function pickHashSample(
  expected: ExpectedFile[],
  now: number,
  recentDays: number,
  samplePercent: number,
  seed: string,
): string[] {
  const cutoff = now - recentDays * DAY_MS;
  const threshold = samplePercent * 100; // out of 10000
  const out: string[] = [];
  for (const f of expected) {
    if (!f.sha1) continue;
    if (f.createdAt >= cutoff || fnv1a(seed + f.path) % 10000 < threshold) out.push(f.path);
  }
  return out;
}
