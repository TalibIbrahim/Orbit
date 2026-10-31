import { spawn } from "node:child_process";
import { appendFileSync, readdirSync, statSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { PromoteState, PromoteStatus } from "@orbit/shared";
import type { Ctx } from "./context.ts";
import { kvGet, kvSet } from "./db.ts";
import { HttpError, type Router } from "./http.ts";

const KV = "promote.state";
const TAIL = 8192;

interface Persisted {
  state: PromoteState;
  startedAt: number | null;
  finishedAt: number | null;
  dumpFile: string | null;
  dumpTime: number | null;
}

function newestDump(dir?: string): { file: string; mtime: number } | null {
  if (!dir) return null;
  try {
    let best: { file: string; mtime: number } | null = null;
    for (const name of readdirSync(dir)) {
      if (!/\.(sql\.gz|sql|dump)$/i.test(name)) continue;
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isFile() && (!best || s.mtimeMs > best.mtime)) best = { file: p, mtime: s.mtimeMs };
    }
    return best;
  } catch {
    return null;
  }
}

export function registerPromoteRoutes(router: Router, ctx: Ctx): void {
  const cfg = ctx.config.promote;
  const logPath = join(ctx.config.dataDir, "promote.log");
  let tail = "";

  const idle: Persisted = { state: "idle", startedAt: null, finishedAt: null, dumpFile: null, dumpTime: null };
  let st: Persisted = kvGet<Persisted>(ctx.db, KV) ?? idle;

  const log = (s: string) => {
    tail = (tail + s).slice(-TAIL);
    try { appendFileSync(logPath, s); } catch { /* ignore */ }
  };
  const save = () => kvSet(ctx.db, KV, st);

  if (st.state === "running") {
    st = { ...st, state: "failed", finishedAt: Date.now() };
    save();
    try { appendFileSync(logPath, "\n[orbit] agent restarted while promote was running; marked failed\n"); } catch { /* ignore */ }
  }
  try {
    if (existsSync(logPath)) tail = readFileSync(logPath, "utf8").slice(-TAIL);
  } catch { /* ignore */ }

  const status = (): PromoteStatus => ({
    supported: !!cfg,
    state: st.state,
    startedAt: st.startedAt,
    finishedAt: st.finishedAt,
    immichUrl: st.state === "done" ? (cfg?.immichUrl ?? null) : null,
    dumpFile: st.dumpFile,
    dumpTime: st.dumpTime,
    log: tail,
  });

  async function pauseReceiveOnly() {
    if (!ctx.config.syncthing) return;
    try {
      const sum = await ctx.syncthing.summary();
      for (const f of sum.folders) {
        if (f.type !== "receiveonly" || f.paused) continue;
        try {
          await ctx.syncthing.setFolderPaused(f.id, true);
          log(`[orbit] paused syncthing folder ${f.id}\n`);
        } catch (e) {
          log(`[orbit] could not pause ${f.id}: ${(e as Error).message}\n`);
        }
      }
    } catch (e) {
      log(`[orbit] syncthing pause skipped: ${(e as Error).message}\n`);
    }
  }

  async function run() {
    if (!cfg) return;
    const dump = newestDump(cfg.dumpDir);
    st = { state: "running", startedAt: Date.now(), finishedAt: null, dumpFile: dump?.file ?? null, dumpTime: dump?.mtime ?? null };
    save();
    tail = "";
    try { writeFileSync(logPath, ""); } catch { /* ignore */ }
    log(`[orbit] promote started ${new Date().toISOString()}; dump=${dump?.file ?? "none"}\n`);
    const fail = (msg: string) => {
      log(`\n[orbit] ${msg}\n`);
      st = { ...st, state: "failed", finishedAt: Date.now() };
      save();
    };
    try {
      await pauseReceiveOnly();
      let cmd = cfg.script;
      let args = cfg.args ?? [];
      if (process.platform === "win32") {
        if (/\.ps1$/i.test(cmd)) {
          args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cmd, ...args];
          cmd = "powershell.exe";
        }
      } else {
        args = [cmd, ...args];
        cmd = "bash";
      }
      const env = { ...process.env, ...(dump ? { ORBIT_DUMP_FILE: dump.file } : {}) };
      const child = spawn(cmd, args, { env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (b: Buffer) => log(b.toString()));
      child.stderr.on("data", (b: Buffer) => log(b.toString()));
      child.on("error", (e) => fail(`spawn error: ${e.message}`));
      child.on("close", (code) => {
        if (st.state !== "running") return;
        if (code === 0) {
          log("\n[orbit] promote finished OK\n");
          st = { ...st, state: "done", finishedAt: Date.now() };
          save();
        } else fail(`script exited with code ${code}`);
      });
    } catch (e) {
      fail((e as Error).message);
    }
  }

  router.get("/v1/promote", () => status());
  router.post("/v1/promote", async (req) => {
    if (!cfg) throw new HttpError(400, "promote not configured on this device");
    if ((req.body as { confirm?: unknown } | undefined)?.confirm !== true) throw new HttpError(400, "body must be { confirm: true }");
    if (st.state === "running") throw new HttpError(409, "promote already running");
    void run();
    // run() sets state synchronously before its first await
    return status();
  });
}
