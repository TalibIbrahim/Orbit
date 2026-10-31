import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { enrollWithHub } from "../src/updater.ts";
import { openDb, kvSet, kvGet } from "../src/db.ts";
import type { Ctx } from "../src/context.ts";

interface Seen { method?: string; url?: string; auth?: string; body: any }

async function setup(status: number, reply: unknown) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "orbit-enroll-"));
  const db = openDb(dir);
  const ctx = {
    config: {
      hubUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: "test-token-0123456789abcdef",
      deviceId: "device-test-1",
      role: "replica",
      listen: { host: "127.0.0.1", port: 7 },
    },
    db,
    syncthing: { myDeviceId: async () => null },
    tailscale: { info: async () => ({ ip: null }) },
  } as unknown as Ctx;
  const cleanup = () => { server.close(); server.closeAllConnections(); db.close(); rmSync(dir, { recursive: true, force: true }); };
  return { ctx, seen, db, cleanup };
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
}

test("stale enrolled flag does not prevent POST /api/enroll", async () => {
  const { ctx, seen, db, cleanup } = await setup(200, { ok: true });
  try {
    kvSet(db, "enrolled", true);
    await quiet(() => enrollWithHub(ctx));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/api/enroll");
    assert.equal(seen[0].auth, "Bearer test-token-0123456789abcdef");
    assert.equal(seen[0].body.agentUrl, "http://127.0.0.1:7");
    assert.equal(seen[0].body.deviceId, "device-test-1");
    assert.equal((kvGet(db, "enroll") as any).ok, true);
  } finally { cleanup(); }
});

test("401 from hub is recorded as failed enrolment", async () => {
  const { ctx, db, cleanup } = await setup(401, { error: "unknown device token" });
  try {
    await quiet(() => enrollWithHub(ctx));
    const st = kvGet(db, "enroll") as any;
    assert.equal(st.ok, false);
    assert.equal(st.status, 401);
  } finally { cleanup(); }
});
