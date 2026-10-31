import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, kvGet } from "../src/db.ts";
import { applySyncHold, isSyncHeld, setSyncHold, getSyncHold } from "../src/synchold.ts";
import type { Ctx } from "../src/context.ts";

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "orbit-hold-"));
  const db = openDb(join(tmp, "data"));
  const folders = new Map<string, boolean>([["a", false], ["b", false], ["other", false]]);
  const calls: string[] = [];
  const mk = (): Ctx => ({
    db,
    syncthing: {
      summary: async () => ({ available: true, folders: [...folders].map(([id, paused]) => ({ id, paused })) }),
      setFolderPaused: async (id: string, p: boolean) => { calls.push(`${id}:${p}`); folders.set(id, p); },
    },
  }) as unknown as Ctx;
  const done = () => { db.close(); rmSync(tmp, { recursive: true, force: true }); };
  return { db, folders, calls, mk, ctx: mk(), done };
}
const req = (paused: boolean, folderIds = ["a", "b", "missing"], reason: string | null = paused ? "manual" : null) => ({ paused, folderIds, reason });

test("pause applies to listed folders only; idempotent; since preserved", async () => {
  const t = setup();
  try {
    const s1 = await setSyncHold(t.ctx, req(true));
    assert.deepEqual([...t.calls].sort(), ["a:true", "b:true"]);
    assert.equal(t.folders.get("other"), false);
    assert.deepEqual(s1.folders, [{ id: "a", paused: true }, { id: "b", paused: true }, { id: "missing", paused: null }]);
    const since = s1.since!;
    await new Promise((r) => setTimeout(r, 5));
    t.calls.length = 0;
    const s2 = await setSyncHold(t.ctx, req(true));
    assert.equal(t.calls.length, 0);
    assert.equal(s2.since, since);
    const s3 = await setSyncHold(t.ctx, req(false));
    assert.ok(s3.since! > since);
    assert.deepEqual([...t.calls].sort(), ["a:false", "b:false"]);
    assert.equal(s3.reason, null);
  } finally { t.done(); }
});

test("resume skips a folder held by a folder limit; isSyncHeld", async () => {
  const t = setup();
  try {
    t.db.prepare("INSERT INTO folders (id, name, path, limit_bytes, mode, syncthing_folder_id, paused_by_orbit, created_at) VALUES ('f1','n','/x',1,'pause-sync','b',1,1)").run();
    await setSyncHold(t.ctx, req(true));
    assert.equal(isSyncHeld(t.ctx, "a"), true);
    assert.equal(isSyncHeld(t.ctx, "other"), false);
    await setSyncHold(t.ctx, req(false));
    assert.equal(isSyncHeld(t.ctx, "a"), false);
    assert.equal(t.folders.get("a"), false);
    assert.equal(t.folders.get("b"), true);
    const st = await getSyncHold(t.ctx);
    assert.equal(st.folders.find((f) => f.id === "b")!.paused, true);
  } finally { t.done(); }
});

test("validation errors", async () => {
  const t = setup();
  try {
    const bad: unknown[] = [
      { ...req(true), paused: "yes" },
      req(true, []),
      req(true, Array.from({ length: 21 }, (_, i) => `f${i}`)),
      req(true, ["a b"]),
      req(true, [""]),
      req(true, [5 as unknown as string]),
      req(true, ["a"], "whatever"),
      null,
    ];
    for (const b of bad) await assert.rejects(setSyncHold(t.ctx, b), (e: Error & { status?: number }) => e.status === 400);
    assert.equal(kvGet(t.db, "syncHold"), null);
  } finally { t.done(); }
});

test("persistence: new ctx re-applies after Syncthing resumed folders", async () => {
  const t = setup();
  try {
    await setSyncHold(t.ctx, req(true));
    t.folders.set("a", false); // manual resume in the Syncthing GUI
    t.calls.length = 0;
    const ctx2 = t.mk();
    const res = await applySyncHold(ctx2);
    assert.deepEqual(t.calls, ["a:true"]);
    assert.equal(res.find((f) => f.id === "a")!.paused, true);
    assert.equal(isSyncHeld(ctx2, "b"), true);
  } finally { t.done(); }
});

test("per-folder errors are reported, not thrown", async () => {
  const t = setup();
  try {
    t.ctx.syncthing.setFolderPaused = async (id: string) => { if (id === "a") throw new Error("boom"); t.folders.set(id, true); };
    const s = await setSyncHold(t.ctx, req(true));
    assert.equal(s.folders.find((f) => f.id === "a")!.error, "boom");
    assert.equal(s.folders.find((f) => f.id === "b")!.paused, true);
  } finally { t.done(); }
});
