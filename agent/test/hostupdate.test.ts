import { test } from "node:test";
import assert from "node:assert/strict";
import { createHostUpdate, parseNextElapse, type ExecFn } from "../src/hostupdate.ts";

const hostUpdate = { unit: "orbit-update.service", timer: "orbit-update.timer", statusFile: "/var/lib/orbit/update-status.json", repoDir: "/opt/orbit-src" };
const HASH = "0123456789abcdef0123456789abcdef01234567";
const UP = "fedcba9876543210fedcba9876543210fedcba98";
const RUN = { startedAt: 1, finishedAt: 2, ok: true, trigger: "timer", fromCommit: "a", toCommit: "b", message: "already up to date" };

function setup(opts: { active?: string; status?: string | null; platform?: string; cfg?: boolean } = {}) {
  const calls: { cmd: string; args: string[]; env?: Record<string, string>; timeout: number }[] = [];
  const writes: { path: string; data: string }[] = [];
  let t = 1_000_000;
  const active = { v: opts.active ?? "inactive" };
  const exec: ExecFn = async (cmd, args, o) => {
    calls.push({ cmd, args, env: o.env, timeout: o.timeout });
    if (cmd === "systemctl" && args[0] === "is-active") return { stdout: active.v + "\n", code: active.v === "inactive" ? 3 : 0 };
    if (cmd === "systemctl" && args[0] === "show") return { stdout: "Sun 2026-11-02 04:41:12 UTC\n", code: 0 };
    if (cmd === "systemctl") return { stdout: "", code: 0 };
    if (args.includes("log")) return { stdout: `${HASH}\t1700000000\tFix: a\tb\n`, code: 0 };
    if (args.includes("rev-parse")) return { stdout: UP + "\n", code: 0 };
    if (args.includes("rev-list")) return { stdout: "3\n", code: 0 };
    return { stdout: "", code: 0 };
  };
  const h = createHostUpdate(opts.cfg === false ? {} : { hostUpdate }, {
    exec,
    now: () => t,
    platform: opts.platform ?? "linux",
    readFile: async () => {
      if (opts.status === null) throw new Error("ENOENT");
      return opts.status ?? JSON.stringify(RUN);
    },
    writeFile: async (path, data) => { writes.push({ path, data }); },
  });
  return { h, calls, writes, active, advance: (ms: number) => { t += ms; } };
}

test("unavailable without config or off linux", async () => {
  assert.equal((await setup({ cfg: false }).h.status()).available, false);
  const s = setup({ platform: "win32" });
  assert.equal((await s.h.status()).available, false);
  assert.equal(s.calls.length, 0);
});

test("parses git and systemctl output, passes safe.directory", async () => {
  const { h, calls } = setup();
  const st = await h.status();
  assert.equal(st.available, true);
  assert.equal(st.running, false);
  assert.deepEqual(st.current, { commit: "0123456", date: 1700000000_000, subject: "Fix: a\tb" });
  assert.deepEqual(st.upstream, { commit: "fedcba9", behind: 3, checkedAt: null });
  assert.equal(st.nextRun, Date.UTC(2026, 10, 2, 4, 41, 12));
  assert.deepEqual(st.lastRun, RUN);
  const gitCall = calls.find((c) => c.cmd === "git")!;
  assert.deepEqual(gitCall.args.slice(0, 2), ["-C", "/opt/orbit-src"]);
  assert.equal(gitCall.env?.GIT_CONFIG_KEY_0, "safe.directory");
  assert.equal(gitCall.env?.GIT_CONFIG_VALUE_0, "/opt/orbit-src");
  assert.equal(gitCall.env?.GIT_TERMINAL_PROMPT, "0");
  const n = calls.length;
  await h.status();
  assert.equal(calls.length, n, "cached");
});

test("parseNextElapse", () => {
  assert.equal(parseNextElapse(""), null);
  assert.equal(parseNextElapse("n/a\n"), null);
  assert.equal(parseNextElapse("1762058472000000"), 1762058472000);
  assert.equal(parseNextElapse("garbage"), null);
});

test("invalid or missing status file -> lastRun null", async () => {
  assert.equal((await setup({ status: "{nope" }).h.status()).lastRun, null);
  assert.equal((await setup({ status: JSON.stringify({ startedAt: "x" }) }).h.status()).lastRun, null);
  assert.equal((await setup({ status: null }).h.status()).lastRun, null);
});

test("check fetches, sets checkedAt, and is rate limited", async () => {
  const { h, calls, advance } = setup();
  const st = await h.check();
  assert.ok(st.upstream!.checkedAt);
  const fetches = () => calls.filter((c) => c.args.includes("fetch")).length;
  assert.equal(fetches(), 1);
  assert.equal(calls.find((c) => c.args.includes("fetch"))!.timeout, 60_000);
  await h.check();
  assert.equal(fetches(), 1);
  advance(61_000);
  await h.check();
  assert.equal(fetches(), 2);
});

test("run writes trigger and starts the unit once", async () => {
  const { h, calls, writes, active } = setup();
  const st = await h.run();
  assert.equal(st.running, true);
  assert.deepEqual(writes, [{ path: "/var/lib/orbit/update-trigger", data: "button" }]);
  const starts = () => calls.filter((c) => c.cmd === "systemctl" && c.args[0] === "start");
  assert.deepEqual(starts().map((c) => c.args), [["start", "--no-block", "orbit-update.service"]]);
  active.v = "activating";
  const again = await h.run();
  assert.equal(again.running, true);
  assert.equal(starts().length, 1);
  assert.equal(writes.length, 1);
});
