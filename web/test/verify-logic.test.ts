import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  immichPathToRelative, base64ToHex, diffCopy, overallWatermark, capWatermark,
  offloadDecision, recommendedCutoff, pickHashSample, type OffloadInput, dumpStatus, syncVerdict, isExcludedPath,
} from "../lib/verify/logic.ts";

const DAY = 86_400_000;
const ef = (path: string, createdAt: number, o: Record<string, unknown> = {}) => ({
  path, assetId: path, ownerId: "o", deviceId: "d", kind: "photo" as const, size: 10 as number | null, sha1: null as string | null, createdAt, ...o,
});
const me = (path: string, size = 10, sha1: string | null = null) => ({ path, size, mtimeMs: 0, sha1 });

test("immichPathToRelative", () => {
  assert.equal(immichPathToRelative("/data/library/admin/2026/x.heic"), "library/admin/2026/x.heic");
  assert.equal(immichPathToRelative("/usr/src/app/upload/upload/u1/ab/cd/f.jpg"), "upload/u1/ab/cd/f.jpg");
  assert.equal(immichPathToRelative("/usr/src/app/upload/library/a/b.jpg"), "library/a/b.jpg");
  assert.equal(immichPathToRelative("\\data\\library\\a\\b.jpg"), "library/a/b.jpg");
  assert.equal(immichPathToRelative("/data/thumbs/u1/ab/x.webp"), null);
  assert.equal(immichPathToRelative(""), null);
});

test("base64ToHex", () => {
  assert.equal(base64ToHex("qZk+NkcGgWq6PiVxeFDCbJzQ2J0="), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(base64ToHex(createHash("sha1").update("abc").digest("base64")), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(base64ToHex(""), "");
});

test("diffCopy: all good", () => {
  const r = diffCopy([ef("a", 1), ef("b", 2)], [me("a"), me("b")]);
  assert.equal(r.presentFiles, 2);
  assert.equal(r.problems.length, 0);
  assert.equal(r.watermark, 2);
  assert.equal(r.newestExpected, 2);
});

test("diffCopy: missing, size, hash, extra", () => {
  const exp = [ef("a", 1, { sha1: "aa" }), ef("b", 2), ef("c", 3, { sha1: "cc" }), ef("d", 4)];
  const man = [me("a", 10, "aa"), me("b", 99), me("c", 10, "zz"), me("zzz")];
  const r = diffCopy(exp, man);
  assert.equal(r.presentFiles, 1);
  assert.equal(r.missing, 1);
  assert.equal(r.sizeMismatch, 1);
  assert.equal(r.hashMismatch, 1);
  assert.equal(r.extra, 1);
  assert.equal(r.hashed, 2);
  assert.deepEqual(r.problems.map((p) => p.kind), ["size-mismatch", "hash-mismatch", "missing", "extra"]);
  assert.equal(r.watermark, 1);
});

test("diffCopy: reference used for unknown size/hash; map input", () => {
  const exp = [ef("a", 1, { size: null })];
  const reference = new Map([["a", me("a", 20, "hh")]]);
  assert.equal(diffCopy(exp, new Map([["a", me("a", 21)]]), { reference }).sizeMismatch, 1);
  const ok = diffCopy(exp, new Map([["a", me("a", 20, "hh")]]), { reference });
  assert.equal(ok.presentFiles, 1);
  assert.equal(ok.hashed, 1);
  assert.equal(diffCopy(exp, new Map([["a", me("a", 20, "xx")]]), { reference }).hashMismatch, 1);
  // no hash on manifest -> not counted
  assert.equal(diffCopy([ef("a", 1, { sha1: "aa" })], [me("a")]).hashed, 0);
});

test("diffCopy: Live Photo pair with missing MOV", () => {
  const exp = [ef("library/x/IMG_1.HEIC", 100), ef("library/x/IMG_1.MOV", 100), ef("library/x/IMG_2.HEIC", 200)];
  const r = diffCopy(exp, [me("library/x/IMG_1.HEIC"), me("library/x/IMG_2.HEIC")]);
  assert.equal(r.missing, 1);
  assert.equal(r.watermark, null); // problem at 100, nothing earlier
  assert.equal(r.newestExpected, 200);
});

test("diffCopy: sidecar without size/hash", () => {
  const r = diffCopy([ef("a.xmp", 1, { kind: "sidecar", size: null })], [me("a.xmp", 123)]);
  assert.equal(r.presentFiles, 1);
  assert.equal(r.problems.length, 0);
});

test("diffCopy: watermark edge cases", () => {
  const none = diffCopy([], []);
  assert.equal(none.watermark, null);
  assert.equal(none.newestExpected, null);
  assert.equal(diffCopy([ef("a", 5), ef("b", 6)], [me("b")]).watermark, null);
  // equal timestamps: problem at T means T not verified
  assert.equal(diffCopy([ef("a", 1), ef("b", 5), ef("c", 5)], [me("a"), me("b")]).watermark, 1);
  assert.equal(diffCopy([ef("a", 1), ef("b", 5), ef("c", 7)], [me("a"), me("c")]).watermark, 1);
});

test("diffCopy: maxProblems caps and extras come last", () => {
  const exp = Array.from({ length: 10 }, (_, i) => ef(`m${i}`, 10 - i));
  const r = diffCopy(exp, [me("x1"), me("x2")], { maxProblems: 4 });
  assert.equal(r.missing, 10);
  assert.equal(r.extra, 2);
  assert.equal(r.problems.length, 4);
  assert.deepEqual(r.problems.map((p) => p.createdAt), [1, 2, 3, 4]);
  const r2 = diffCopy(exp.slice(0, 2), [me("x1"), me("x2"), me("x3")], { maxProblems: 3 });
  assert.deepEqual(r2.problems.map((p) => p.kind), ["missing", "missing", "extra"]);
});

test("overallWatermark basics", () => {
  const c = (watermark: number | null, isHost = false, eligible = true) => ({ watermark, eligible, isHost });
  assert.equal(overallWatermark([], 2, false), null);
  assert.equal(overallWatermark([c(10), c(5)], 2, false), 5);
  assert.equal(overallWatermark([c(10, true), c(5, true), c(3)], 2, true), 3);
  assert.equal(overallWatermark([c(10, true), c(5, true)], 2, true), null);
  assert.equal(overallWatermark([c(10), c(null)], 2, false), null);
  assert.equal(overallWatermark([c(10), c(8, false, false)], 2, false), null);
});

test("overallWatermark closed form equals brute force", () => {
  let seed = 12345;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  for (let i = 0; i < 200; i++) {
    const n = Math.floor(rnd() * 6);
    const copies = Array.from({ length: n }, () => ({
      watermark: rnd() < 0.15 ? null : Math.floor(rnd() * 10),
      eligible: rnd() < 0.8,
      isHost: rnd() < 0.4,
    }));
    const k = 1 + Math.floor(rnd() * 3);
    const req = rnd() < 0.5;
    let best: number | null = null;
    for (const t of copies.map((c) => c.watermark)) {
      if (t === null) continue;
      const ok = copies.filter((c) => c.eligible && c.watermark !== null && c.watermark >= t);
      if (ok.length >= k && (!req || ok.some((c) => !c.isHost)) && (best === null || t > best)) best = t;
    }
    assert.equal(overallWatermark(copies, k, req), best, JSON.stringify({ copies, k, req }));
  }
});

test("capWatermark", () => {
  assert.equal(capWatermark(10, 5), 5);
  assert.equal(capWatermark(3, 5), 3);
  assert.equal(capWatermark(null, 5), null);
  assert.equal(capWatermark(5, null), null);
});

const T = Date.UTC(2026, 9, 31, 12);
const good = (name: string, isHost = false) => ({
  name, isHost, online: true, verified: true, mismatches: 0, syncOk: true, syncIssues: [] as string[], versioning: true, pausedByOrbit: false,
});
const base = (): OffloadInput => ({
  configured: true, immichReachable: true, newestAsset: T, newestDump: T, watermark: T,
  minCopies: 2, requireNonHost: true, copies: [good("Server", true), good("PC")],
});

test("offloadDecision: safe", () => {
  assert.deepEqual(offloadDecision(base()), { state: "safe", reasons: [] });
});

test("offloadDecision: unknown cases", () => {
  const u = (m: Partial<OffloadInput>) => offloadDecision({ ...base(), ...m });
  assert.equal(u({ configured: false }).state, "unknown");
  assert.equal(u({ immichReachable: false }).state, "unknown");
  assert.equal(u({ newestAsset: null }).state, "unknown");
  const none = u({ copies: [{ ...good("PC"), verified: false }] });
  assert.equal(none.state, "unknown");
  assert.ok(none.reasons.length > 0);
});

test("offloadDecision: not-yet rules", () => {
  const n = (m: Partial<OffloadInput>) => offloadDecision({ ...base(), ...m });
  let r = n({ copies: [good("Server", true), { ...good("PC"), mismatches: 3 }] });
  assert.equal(r.state, "not-yet");
  assert.ok(r.reasons.some((s) => s.startsWith("PC: 3 files")));
  assert.ok(r.reasons.some((s) => s.includes("Only 1 verified copy, 2 required")));
  assert.ok(r.reasons.some((s) => s.includes("No verified copy outside arm-free")));

  r = n({ copies: [good("Server", true), good("PC"), { ...good("Laptop"), pausedByOrbit: true }] });
  assert.equal(r.state, "not-yet");
  assert.ok(r.reasons.includes("Laptop: Syncthing paused by a folder limit"));

  r = n({ copies: [good("Server", true), good("PC"), { ...good("Laptop"), online: true, verified: false }] });
  assert.equal(r.state, "not-yet");
  assert.ok(r.reasons.some((s) => s.startsWith("Laptop:")));

  // offline unverified copy does not block
  assert.equal(n({ copies: [good("Server", true), good("PC"), { ...good("Laptop"), online: false, verified: false }] }).state, "safe");

  r = n({ copies: [good("Server", true), { ...good("PC"), versioning: false }] });
  assert.ok(r.reasons.some((s) => s.includes("PC") && s.includes("versioning")));
  // host without versioning is fine
  assert.equal(n({ copies: [{ ...good("Server", true), versioning: false }, good("PC")] }).state, "safe");

  r = n({ newestDump: T - 3 * DAY });
  assert.ok(r.reasons.some((s) => s.startsWith("Newest database dump (2026-10-28) is older than the newest upload (2026-10-31)")));
  assert.equal(n({ newestDump: null }).state, "not-yet");

  assert.equal(n({ watermark: T - 1 }).state, "not-yet");
  assert.equal(n({ watermark: null }).state, "not-yet");

  r = n({ copies: [good("Server", true), { ...good("PC"), syncOk: false, syncIssues: ["out of sync"] }] });
  assert.ok(r.reasons.some((s) => s.includes("out of sync")));

  assert.equal(n({ requireNonHost: false, minCopies: 1, copies: [good("Server", true)] }).state, "safe");
  assert.equal(n({ requireNonHost: true, minCopies: 1, copies: [good("Server", true)] }).state, "not-yet");
});

test("recommendedCutoff", () => {
  const w = Date.UTC(2026, 9, 31, 15, 30);
  assert.equal(recommendedCutoff(null), null);
  assert.equal(recommendedCutoff(w), Date.UTC(2026, 9, 31));
  assert.equal(recommendedCutoff(Date.UTC(2026, 9, 31)), Date.UTC(2026, 9, 31));
  // UTC+5:30: 15:30Z is 21:00 local on Oct 31 -> local midnight = Oct 30 18:30Z
  assert.equal(recommendedCutoff(w, 330), Date.UTC(2026, 9, 30, 18, 30));
  // UTC-5: 02:00Z Oct 31 is Oct 30 21:00 local -> Oct 30 05:00Z
  assert.equal(recommendedCutoff(Date.UTC(2026, 9, 31, 2), -300), Date.UTC(2026, 9, 30, 5));
  assert.ok((recommendedCutoff(w, 330) as number) <= w);
});

test("pickHashSample", () => {
  const now = Date.UTC(2026, 9, 31);
  const exp = Array.from({ length: 2000 }, (_, i) =>
    ef(`library/f${i}.jpg`, now - i * 3600_000 * 6, { sha1: "aa" }));
  exp.push(ef("library/side.xmp", now, { kind: "sidecar", size: null }));
  const a = pickHashSample(exp, now, 7, 5, "seed");
  assert.deepEqual(a, pickHashSample(exp, now, 7, 5, "seed"));
  assert.ok(!a.includes("library/side.xmp"));
  const recent = exp.filter((f) => f.sha1 && f.createdAt >= now - 7 * DAY).map((f) => f.path);
  for (const p of recent) assert.ok(a.includes(p));
  const older = a.length - recent.length;
  const olderTotal = 2000 - recent.length;
  assert.ok(older > olderTotal * 0.02 && older < olderTotal * 0.09, `sample ${older}/${olderTotal}`);
  assert.notDeepEqual(a, pickHashSample(exp, now, 7, 5, "other"));
  assert.equal(pickHashSample(exp, now, 7, 0, "seed").length, recent.length);
  assert.equal(pickHashSample(exp, now, 0, 100, "seed").length, 2000);
});

// ───────────── manifest first, Syncthing second; dump states; exclusions ─────────────

const job = (o: Record<string, unknown> = {}) => ({
  id: "immich-db", name: "Immich DB dump", kind: "pgdump" as const, schedule: null, nextRunAt: null, retention: null, outputDir: null,
  outputBytes: null, latestArtifact: null as { name: string; bytes: number; mtime: number } | null, lastRun: null as null | Record<string, unknown>,
  running: false, restic: null, ...o,
}) as never;
const okDump = { state: "ok" as const, newest: T, jobId: "immich-db", hostDeviceId: "h", detail: null };
const folder = (state: string, o: Record<string, unknown> = {}) => ({
  folderId: "f", state: state as never, completion: null as number | null, needItems: 0 as number | null, needBytes: 0 as number | null,
  reason: null as string | null, lastInSyncAt: null as number | null, ...o,
});

test("dumpStatus: no job, empty dumps folder, failed, stale, ok", () => {
  assert.equal(dumpStatus(null, T, "h").state, "unknown");
  const noJob = dumpStatus([job({ kind: "restic", id: "restic" })], T, "h");
  assert.equal(noJob.state, "no-job");
  assert.match(noJob.detail ?? "", /install-arm-free\.sh --mode arm-free/);
  // Job exists but the dumps folder is empty: "no dump exists yet", with the job id for "Run backup now".
  const none = dumpStatus([job()], T, "h");
  assert.deepEqual([none.state, none.jobId, none.hostDeviceId, none.newest], ["none", "immich-db", "h", null]);
  assert.equal(dumpStatus([job({ lastRun: { ok: false, exitCode: 2, finishedAt: T } })], T, "h").state, "failed");
  // Syncthing's marker is not a dump.
  assert.equal(dumpStatus([job({ latestArtifact: { name: ".stfolder", bytes: 0, mtime: T } })], T, "h").state, "none");
  const stale = dumpStatus([job({ latestArtifact: { name: "immich-2026-10-28.sql.gz", bytes: 9, mtime: T - 3 * DAY } })], T, "h");
  assert.equal(stale.state, "stale");
  assert.match(stale.detail ?? "", /older than the newest upload/);
  assert.equal(dumpStatus([job({ latestArtifact: { name: "d.sql.gz", bytes: 9, mtime: T } })], T, "h").state, "ok");
});

test("offloadDecision: dump states give one clear reason each", () => {
  const n = (dump: Parameters<typeof offloadDecision>[0]["dump"], newestDump: number | null = null) =>
    offloadDecision({ ...base(), dump, newestDump, watermark: capWatermark(T, newestDump) });
  const none = n(dumpStatus([job()], T, "h"));
  assert.equal(none.state, "not-yet");
  assert.deepEqual(none.reasons, ["No database dump exists yet: run the Immich DB dump now (Backups)"]);
  assert.match(n(dumpStatus([], T, "h")).reasons[0], /No Immich database dump job/);
  assert.equal(n(okDump, T).state, "safe");
});

test("syncVerdict: matching manifests with completion unknown do not downgrade", () => {
  const v = syncVerdict({ manifestClean: true, library: folder("unknown", { reason: "arm-free could not report completion" }), dumps: folder("up-to-date"), dump: okDump });
  assert.deepEqual(v.issues, []);
  assert.equal(v.notes.length, 1);
  // ...and the same unknown state does count when files are actually missing.
  assert.equal(syncVerdict({ manifestClean: false, library: folder("unknown"), dumps: null, dump: okDump }).issues.length, 1);
});

test("syncVerdict: paused by schedule with a clean manifest is a note with the exact reason", () => {
  const reason = "paused by the sync schedule (folder paused on PC)";
  const v = syncVerdict({ manifestClean: true, library: folder("paused", { reason }), dumps: folder("paused", { reason, lastInSyncAt: T + 1 }), dump: okDump });
  assert.deepEqual(v.issues, []);
  assert.equal(v.pausedNote, reason);
  assert.ok(v.notes.some((s) => s.includes(reason)));
});

test("syncVerdict: disconnected peer with a clean manifest is a note", () => {
  const v = syncVerdict({ manifestClean: true, library: folder("peer-offline", { reason: "laptop is not connected to arm-free" }), dumps: folder("peer-offline", { lastInSyncAt: T }), dump: okDump });
  assert.deepEqual(v.issues, []);
  assert.equal(v.notes.length, 2);
});

test("syncVerdict: dumps", () => {
  // Empty dumps folder / no dump yet: not reported here (the dump status says it once).
  const noDump = dumpStatus([job()], T, "h");
  assert.deepEqual(syncVerdict({ manifestClean: true, library: folder("up-to-date"), dumps: folder("nothing-to-sync"), dump: noDump }), { issues: [], notes: [], pausedNote: null });
  assert.deepEqual(syncVerdict({ manifestClean: true, library: folder("up-to-date"), dumps: folder("syncing", { needItems: 1 }), dump: noDump }).issues, []);
  // A dump exists and is still arriving: blocks with the numbers.
  const s = syncVerdict({ manifestClean: true, library: folder("up-to-date"), dumps: folder("syncing", { needItems: 1, needBytes: 5e6 }), dump: okDump });
  assert.deepEqual(s.issues, ["database dumps not fully synced: 1 item (5.0 MB) still to download"]);
  // Paused before the newest dump arrived: blocks with the reason.
  const p = syncVerdict({ manifestClean: true, library: folder("up-to-date"), dumps: folder("paused", { reason: "paused by the sync schedule", lastInSyncAt: T - DAY }), dump: okDump });
  assert.equal(p.issues.length, 1);
  assert.match(p.issues[0], /not synced yet.*paused by the sync schedule/);
});

test("syncVerdict: real problems still block a clean manifest", () => {
  assert.equal(syncVerdict({ manifestClean: true, library: folder("syncing", { completion: 90, needItems: 3 }), dumps: null, dump: okDump }).issues.length, 1);
  assert.equal(syncVerdict({ manifestClean: true, library: folder("error", { reason: "Syncthing reports a folder error" }), dumps: null, dump: okDump }).issues.length, 1);
});

test("isExcludedPath: Syncthing, OS and non-original entries never count", () => {
  for (const p of [
    ".stfolder", ".stignore", "library/.stfolder", ".stversions/library/a.jpg", "library/.stversions/a~20260101.jpg",
    "library/a/.syncthing.b.jpg.tmp", "library/a/~syncthing~b.jpg.tmp", "library/a/b.jpg.syncthing.tmp",
    "library/a/b.sync-conflict-20260101-000000-ABCDEF.jpg", "library/a/desktop.ini", "upload/x/Thumbs.db",
    "thumbs/u/a.webp", "encoded-video/a.mp4", "backups/dump.sql.gz", "library", "upload/.immich",
  ]) assert.equal(isExcludedPath(p), true, p);
  for (const p of ["library/admin/2026/a.heic", "upload/u1/ab/cd/f.jpg", "library/a/b.jpg.xmp"]) assert.equal(isExcludedPath(p), false, p);
});
