// Pure, dependency-free logic for phone backup verification (read-only advice only).
import type { CopyProblem, ExpectedFile, ManifestEntry, OffloadState } from "@orbit/shared";

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

  if (input.newestDump === null) reasons.push("No database dump found");
  else if (input.newestDump < input.newestAsset) {
    reasons.push(`Newest database dump (${fmtDate(input.newestDump)}) is older than the newest upload (${fmtDate(input.newestAsset)})`);
  }
  if (input.watermark === null) reasons.push("No date is verified on enough copies yet");
  else if (input.watermark < input.newestAsset) {
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
