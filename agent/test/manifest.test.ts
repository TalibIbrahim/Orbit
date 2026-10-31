import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createManifest } from "../src/manifest.ts";
import type { Ctx } from "../src/context.ts";

const sha1 = (b: Buffer | string) => createHash("sha1").update(b).digest("hex");
const OLD = new Date(Date.now() - 3600_000);

function put(root: string, rel: string, data: string, old = true) {
  const f = join(root, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, data);
  if (old) utimesSync(f, OLD, OLD);
}

function snapshot(dir: string): string {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        out.push(`D ${p}`);
        rec(p);
      } else out.push(`F ${p} ${statSync(p).mtimeMs} ${sha1(readFileSync(p))}`);
    }
  };
  rec(dir);
  return out.join("\n");
}

test("manifest scan, pagination, rescan, hashing, read-only", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "orbit-manifest-"));
  const root = join(tmp, "tree");
  const db = openDb(join(tmp, "data"));
  try {
    put(root, "upload/u1/a.jpg", "AAA");
    put(root, "upload/u1/b.jpg", "BBBB");
    put(root, "library/admin/2026/c.heic", "CCCCC");
    put(root, "library/admin/2026/d.mov", "DDDDDD");
    put(root, "thumbs/t.webp", "thumb");
    put(root, "library/x.partial", "p");
    put(root, "library/~syncthing~x.tmp", "t");
    put(root, "library/.syncthing.y.tmp", "t");
    put(root, "upload/.immich", "m");
    put(root, "upload/fresh.jpg", "new", false);
    mkdirSync(join(root, ".stfolder"), { recursive: true });

    let folders = [{ id: "f1", path: root }];
    const ctx = { db, syncthing: { summary: async () => ({ available: true, folders }) } } as unknown as Ctx;
    const m = createManifest(ctx);
    const initial = snapshot(root);

    const s0 = await m.status("f1");
    assert.equal(s0.root, root);
    await m.idle();
    const s1 = await m.status("f1");
    assert.equal(s1.building, false);
    assert.equal(s1.files, 4);
    assert.equal(s1.bytes, 3 + 4 + 5 + 6);
    assert.equal(s1.generation, 1);
    assert.ok(s1.builtAt);
    assert.equal(snapshot(root), initial); // scanning did not touch the tree

    const all = m.entries("f1", null, 100);
    assert.deepEqual(
      all.entries.map((e) => e.path),
      ["library/admin/2026/c.heic", "library/admin/2026/d.mov", "upload/u1/a.jpg", "upload/u1/b.jpg"],
    );
    assert.equal(all.next, null);
    assert.equal(all.generation, 1);

    const p1 = m.entries("f1", null, 3);
    assert.equal(p1.entries.length, 3);
    assert.equal(p1.next, "upload/u1/a.jpg");
    const p2 = m.entries("f1", p1.next, 3);
    assert.deepEqual(p2.entries.map((e) => e.path), ["upload/u1/b.jpg"]);
    assert.equal(p2.next, null);

    // validation
    await assert.rejects(m.hash({ folderId: "f1", paths: ["../x"] }), /invalid path/);
    await assert.rejects(m.hash({ folderId: "f1", paths: ["/abs"] }), /invalid path/);
    await assert.rejects(m.hash({ folderId: "f1", paths: ["thumbs/t.webp"] }), /upload\/ or library\//);
    await assert.rejects(m.hash({ folderId: "f1", paths: ["upload/../thumbs/t.webp"] }), /invalid path/);

    // hashing
    const h = await m.hash({ folderId: "f1", paths: ["upload/u1/a.jpg", "upload/u1/nope.jpg", "library/admin/2026/c.heic"] });
    assert.equal(h.pending.length, 0);
    assert.equal(h.hashes[0].sha1, sha1("AAA"));
    assert.equal(h.hashes[1].sha1, null);
    assert.equal(h.hashes[1].error, "ENOENT");
    assert.equal(h.hashes[2].sha1, sha1("CCCCC"));
    assert.equal(m.entries("f1", null, 100).entries.find((e) => e.path === "upload/u1/a.jpg")!.sha1, sha1("AAA"));
    assert.equal((await m.status("f1")).hashed, 2);

    // cache reuse: tamper the cached value; unchanged size+mtime must return it
    db.prepare("UPDATE manifest SET sha1 = 'cafe' WHERE folder='f1' AND path='upload/u1/a.jpg'").run();
    const h2 = await m.hash({ folderId: "f1", paths: ["upload/u1/a.jpg"] });
    assert.equal(h2.hashes[0].sha1, "cafe");

    // incremental rescan: modify b (after hashing it), delete d
    await m.hash({ folderId: "f1", paths: ["upload/u1/b.jpg"] });
    put(root, "upload/u1/b.jpg", "BBBBBBB");
    unlinkSync(join(root, "library/admin/2026/d.mov"));
    const edited = snapshot(root);
    await m.refresh("f1");
    await m.idle();
    const s2 = await m.status("f1");
    assert.equal(s2.generation, 2);
    assert.equal(s2.files, 3);
    const e2 = m.entries("f1", null, 100).entries;
    assert.deepEqual(e2.map((e) => e.path), ["library/admin/2026/c.heic", "upload/u1/a.jpg", "upload/u1/b.jpg"]);
    assert.equal(e2.find((e) => e.path === "upload/u1/b.jpg")!.sha1, null);
    assert.equal(e2.find((e) => e.path === "upload/u1/b.jpg")!.size, 7);
    assert.equal(e2.find((e) => e.path === "upload/u1/a.jpg")!.sha1, "cafe"); // unchanged keeps hash

    // syncthing unavailable -> cached root; unknown folder -> available false
    const ctx2 = { db, syncthing: { summary: async () => { throw new Error("down"); } } } as unknown as Ctx;
    const m2 = createManifest(ctx2);
    assert.equal((await m2.status("f1")).root, root);
    await m2.idle();
    folders = [];
    const unk = await m.status("nope");
    assert.equal(unk.available, false);
    assert.ok(unk.error);

    // read-only: nothing under the root changed through rescans and hashing
    await m.hash({ folderId: "f1", paths: ["upload/u1/b.jpg"] }).catch(() => undefined);
    assert.equal(snapshot(root), edited);
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
