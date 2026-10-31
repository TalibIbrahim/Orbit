// Orbit self-update status/trigger (arm-free). Never uses a shell; all commands go through execFile.
import { execFile } from "node:child_process";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { posix } from "node:path";
import type { HostUpdateRun, HostUpdateStatus } from "@orbit/shared";
import type { AgentConfig } from "./config.ts";
import type { Ctx } from "./context.ts";
import { kvGet, kvSet } from "./db.ts";
import type { Router } from "./http.ts";

export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { timeout: number; env?: Record<string, string> },
) => Promise<{ stdout: string; code: number }>;

export interface HostUpdateDeps {
  exec?: ExecFn;
  now?: () => number;
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, data: string) => Promise<void>;
  platform?: string;
  kv?: { get: (key: string) => number | null; set: (key: string, value: number) => void };
}

const STATUS_TTL_MS = 30_000;
const CHECK_MIN_MS = 60_000;
const FAILED = { stdout: "", code: 1 };

const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeout, windowsHide: true, env: opts.env ? { ...process.env, ...opts.env } : process.env, maxBuffer: 1 << 20 },
      (err, stdout) => {
        const c = err ? (err as { code?: unknown }).code : 0;
        resolve({ stdout: String(stdout ?? ""), code: typeof c === "number" ? c : err ? 1 : 0 });
      },
    );
  });

/** Parses `systemctl show -p NextElapseUSecRealtime --value` (date string, or µs since epoch). */
export function parseNextElapse(out: string): number | null {
  const s = out.trim();
  if (!s || s === "n/a" || s === "0") return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s) / 1000;
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  const t = Date.parse(s.replace(/^[A-Za-z]{3}\s+/, ""));
  return Number.isNaN(t) ? null : t;
}

export function parseRun(text: string): HostUpdateRun | null {
  try {
    const r = JSON.parse(text) as Record<string, unknown> | null;
    if (!r || typeof r !== "object") return null;
    const strOrNull = (v: unknown) => v === null || typeof v === "string";
    if (typeof r.startedAt !== "number") return null;
    if (!(r.finishedAt === null || typeof r.finishedAt === "number")) return null;
    if (!(r.ok === null || typeof r.ok === "boolean")) return null;
    if (typeof r.trigger !== "string" || typeof r.message !== "string") return null;
    if (!strOrNull(r.fromCommit) || !strOrNull(r.toCommit)) return null;
    return r as unknown as HostUpdateRun;
  } catch {
    return null;
  }
}

export function createHostUpdate(config: Pick<AgentConfig, "hostUpdate">, deps: HostUpdateDeps = {}) {
  const hu = config.hostUpdate;
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p, "utf8"));
  const writeFile = deps.writeFile ?? ((p: string, d: string) => fsWriteFile(p, d, "utf8"));
  const enabled = !!hu && platform === "linux";

  let cached: { at: number; status: HostUpdateStatus } | null = null;
  let checkedAt: number | null = deps.kv?.get("hostUpdateCheckedAt") ?? null;
  let lastCheckAttempt = 0;

  const git = (args: string[], timeout = 10_000) =>
    exec("git", ["-C", hu!.repoDir, ...args], {
      timeout,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: hu!.repoDir,
        GIT_TERMINAL_PROMPT: "0",
      },
    }).catch(() => FAILED);
  const sysctl = (args: string[]) => exec("systemctl", args, { timeout: 10_000 }).catch(() => FAILED);

  async function build(): Promise<HostUpdateStatus> {
    const status: HostUpdateStatus = { available: enabled, running: false, current: null, upstream: null, lastRun: null, nextRun: null };
    if (!enabled) return status;
    const [active, cur, up, behind, next, run] = await Promise.all([
      sysctl(["is-active", hu!.unit]),
      git(["log", "-1", "--format=%H%x09%ct%x09%s"]),
      git(["rev-parse", "@{u}"]),
      git(["rev-list", "--count", "HEAD..@{u}"]),
      sysctl(["show", hu!.timer, "-p", "NextElapseUSecRealtime", "--value"]),
      readFile(hu!.statusFile).then(parseRun, () => null),
    ]);
    const a = active.stdout.trim();
    status.running = a === "activating" || a === "active";
    if (cur.code === 0 && cur.stdout.trim()) {
      const [hash, ct, ...subj] = cur.stdout.trim().split("\t");
      const secs = Number(ct);
      status.current = { commit: hash.slice(0, 7), date: ct && Number.isFinite(secs) ? secs * 1000 : null, subject: subj.join("\t") };
    } else {
      status.error = "cannot read the checked-out commit";
    }
    if (up.code === 0 && behind.code === 0) {
      const n = Number(behind.stdout.trim());
      status.upstream = { commit: up.stdout.trim().slice(0, 7) || null, behind: Number.isFinite(n) ? n : null, checkedAt };
    } else {
      status.upstream = { commit: null, behind: null, checkedAt, error: "no upstream branch configured" };
    }
    status.nextRun = next.code === 0 ? parseNextElapse(next.stdout) : null;
    status.lastRun = run;
    return status;
  }

  async function status(force = false): Promise<HostUpdateStatus> {
    if (!force && cached && now() - cached.at < STATUS_TTL_MS) return cached.status;
    const s = await build();
    cached = { at: now(), status: s };
    return s;
  }

  async function check(): Promise<HostUpdateStatus> {
    if (!enabled) return status();
    const t = now();
    if (lastCheckAttempt && t - lastCheckAttempt < CHECK_MIN_MS) return status();
    lastCheckAttempt = t;
    const r = await git(["fetch", "--quiet", "origin"], 60_000);
    if (r.code === 0) {
      checkedAt = now();
      try { deps.kv?.set("hostUpdateCheckedAt", checkedAt); } catch { /* ignore */ }
    }
    const s = await status(true);
    if (r.code !== 0 && s.upstream && !s.upstream.error) s.upstream.error = "git fetch failed";
    return s;
  }

  async function run(): Promise<HostUpdateStatus> {
    if (!enabled) return status();
    const cur = await status(true);
    if (cur.running) return cur;
    await writeFile(posix.join(posix.dirname(hu!.statusFile), "update-trigger"), "button");
    console.log("[host-update] update started from the dashboard");
    await exec("systemctl", ["start", "--no-block", hu!.unit], { timeout: 10_000 });
    const s = await status(true);
    s.running = true;
    return s;
  }

  return { available: enabled, status: () => status(), check, run };
}

export function registerHostUpdateRoutes(router: Router, ctx: Ctx) {
  const h = createHostUpdate(ctx.config, {
    kv: { get: (k) => kvGet<number>(ctx.db, k), set: (k, v) => kvSet(ctx.db, k, v) },
  });
  router.get("/v1/host-update", () => h.status());
  router.post("/v1/host-update/check", () => h.check());
  router.post("/v1/host-update/run", () => h.run());
  return h;
}
