import { spawn, execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Cron } from "croner";
import type { BackupsResponse, JobRun, JobSummary, ResticSnapshotInfo } from "@orbit/shared";
import type { JobConfig } from "./config.ts";
import type { Ctx } from "./context.ts";
import { HttpError, type Router } from "./http.ts";

const TAIL_BYTES = 4096;
const CACHE_MS = 10 * 60_000;

interface Row {
  id: number;
  job: string;
  started_at: number;
  finished_at: number | null;
  exit_code: number | null;
  output_tail: string;
}

const toRun = (r: Row): JobRun => ({
  id: r.id,
  job: r.job,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  exitCode: r.exit_code,
  ok: r.finished_at === null ? null : r.exit_code === 0,
  outputTail: r.output_tail,
});

async function dirSize(dir: string, depth = 0): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) total += depth < 12 ? await dirSize(p, depth + 1) : 0;
      else if (e.isFile()) total += (await stat(p)).size;
    } catch { /* ignore */ }
  }
  return total;
}

async function newestFile(dir: string, depth = 0): Promise<{ name: string; bytes: number; mtime: number } | null> {
  let best: { name: string; bytes: number; mtime: number } | null = null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    // Not backup artifacts: hidden entries (Syncthing's .stfolder marker, .stignore, .stversions),
    // files still being written, Syncthing temp files.
    if (e.name.startsWith(".") || e.name.startsWith("~syncthing~") || /\.(partial|tmp)$/i.test(e.name)) continue;
    const p = join(dir, e.name);
    try {
      let cand: { name: string; bytes: number; mtime: number } | null = null;
      if (e.isFile()) {
        const s = await stat(p);
        cand = { name: e.name, bytes: s.size, mtime: s.mtimeMs };
      } else if (e.isDirectory() && depth < 1) {
        cand = await newestFile(p, depth + 1);
      }
      if (cand && (!best || cand.mtime > best.mtime)) best = cand;
    } catch { /* ignore */ }
  }
  return best;
}

function execJson(cmd: string, args: string[], env: Record<string, string>, timeout = 120_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}

export function startJobs(ctx: Ctx): void {
  const { db, config } = ctx;
  const jobs = new Map<string, JobConfig>(config.jobs.map((j) => [j.id, j]));
  const crons = new Map<string, Cron>();
  const running = new Set<string>();
  const sizeCache = new Map<string, { at: number; bytes: number | null }>();
  const resticCache = new Map<string, { at: number; value: ResticSnapshotInfo | null }>();

  const interrupted = db
    .prepare("UPDATE job_runs SET finished_at = ?, exit_code = -1, output_tail = output_tail || ? WHERE finished_at IS NULL")
    .run(Date.now(), "\n[orbit] agent restarted");
  if (Number(interrupted.changes) > 0) console.warn(`[jobs] marked ${interrupted.changes} interrupted run(s)`);

  function lastRun(jobId: string): JobRun | null {
    const r = db.prepare("SELECT * FROM job_runs WHERE job = ? ORDER BY id DESC LIMIT 1").get(jobId) as Row | undefined;
    return r ? toRun(r) : null;
  }

  function runJob(job: JobConfig): JobRun {
    if (running.has(job.id)) throw new HttpError(409, `job ${job.id} is already running`);
    running.add(job.id);
    const startedAt = Date.now();
    const id = Number(db.prepare("INSERT INTO job_runs (job, started_at) VALUES (?, ?)").run(job.id, startedAt).lastInsertRowid);
    console.log(`[jobs] ${job.id} started (run ${id})`);

    let tail = "";
    let finished = false;
    const append = (b: Buffer | string) => {
      tail += b.toString();
      if (tail.length > TAIL_BYTES * 2) tail = tail.slice(-TAIL_BYTES);
    };
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      running.delete(job.id);
      const t = tail.slice(-TAIL_BYTES);
      try {
        db.prepare("UPDATE job_runs SET finished_at = ?, exit_code = ?, output_tail = ? WHERE id = ?").run(Date.now(), code, t, id);
      } catch (e) {
        console.error("[jobs] failed to record finish", e);
      }
      sizeCache.delete(job.id);
      resticCache.delete(job.id);
      console.log(`[jobs] ${job.id} finished exit=${code} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    };

    let cmd = job.command;
    let args = job.args ?? [];
    if (process.platform === "win32" && /\.ps1$/i.test(cmd)) {
      args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cmd, ...args];
      cmd = "powershell.exe";
    }
    const child = spawn(cmd, args, {
      cwd: job.cwd,
      env: { ...process.env, ...job.env },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      append(`\n[orbit] timeout after ${job.timeoutMin ?? 120} min, killing`);
      child.kill("SIGKILL");
    }, (job.timeoutMin ?? 120) * 60_000);
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (e) => {
      append(`\n[orbit] spawn error: ${e.message}`);
      finish(-1);
    });
    child.on("close", (code, signal) => {
      if (signal) append(`\n[orbit] killed by ${signal}`);
      finish(code ?? -1);
    });

    return { id, job: job.id, startedAt, finishedAt: null, exitCode: null, ok: null, outputTail: "" };
  }

  for (const job of jobs.values()) {
    if (!job.schedule) continue;
    try {
      crons.set(
        job.id,
        new Cron(job.schedule, { protect: true, name: job.id }, () => {
          try {
            runJob(job);
          } catch (e) {
            console.warn(`[jobs] scheduled ${job.id} skipped:`, (e as Error).message);
          }
        }),
      );
    } catch (e) {
      console.error(`[jobs] bad schedule for ${job.id}: ${job.schedule}`, e);
    }
  }

  async function outputBytes(job: JobConfig): Promise<number | null> {
    if (!job.outputDir) return null;
    const c = sizeCache.get(job.id);
    if (c && Date.now() - c.at < CACHE_MS) return c.bytes;
    const bytes = await dirSize(job.outputDir);
    sizeCache.set(job.id, { at: Date.now(), bytes });
    return bytes;
  }

  async function resticInfo(job: JobConfig): Promise<ResticSnapshotInfo | null> {
    if (job.kind !== "restic") return null;
    const c = resticCache.get(job.id);
    if (c && Date.now() - c.at < CACHE_MS) return c.value;
    const env = job.env ?? {};
    let value: ResticSnapshotInfo | null = null;
    try {
      const latest = (await execJson("restic", ["snapshots", "--json", "--latest", "1"], env)) as {
        short_id?: string;
        id: string;
        time: string;
        paths: string[];
      }[];
      const all = (await execJson("restic", ["snapshots", "--json"], env)) as unknown[];
      const snap = latest[latest.length - 1];
      if (snap) {
        let totalSize: number | null = null;
        try {
          const st = (await execJson("restic", ["stats", "latest", "--json", "--mode", "restore-size"], env)) as { total_size?: number };
          totalSize = typeof st.total_size === "number" ? st.total_size : null;
        } catch { /* optional */ }
        value = { id: snap.short_id ?? snap.id.slice(0, 8), time: Date.parse(snap.time), paths: snap.paths ?? [], totalSize, snapshotCount: all.length };
      }
    } catch (e) {
      console.warn(`[jobs] restic info for ${job.id} failed:`, (e as Error).message);
    }
    resticCache.set(job.id, { at: Date.now(), value });
    return value;
  }

  async function summarize(job: JobConfig): Promise<JobSummary> {
    const [bytes, latestArtifact, restic] = await Promise.all([
      outputBytes(job),
      job.outputDir ? newestFile(job.outputDir) : Promise.resolve(null),
      resticInfo(job),
    ]);
    return {
      id: job.id,
      name: job.name,
      kind: job.kind,
      schedule: job.schedule ?? null,
      nextRunAt: crons.get(job.id)?.nextRun()?.getTime() ?? null,
      retention: job.retention ?? null,
      outputDir: job.outputDir ?? null,
      outputBytes: bytes,
      latestArtifact,
      lastRun: lastRun(job.id),
      running: running.has(job.id),
      restic,
    };
  }

  // exposed to route registration via ctx-scoped registry
  registry.set(ctx, {
    list: async (): Promise<BackupsResponse> => ({ jobs: await Promise.all([...jobs.values()].map(summarize)) }),
    run: (id: string) => {
      const job = jobs.get(id);
      if (!job) throw new HttpError(404, `unknown job ${id}`);
      return runJob(job);
    },
  });
}

interface JobsApi {
  list(): Promise<BackupsResponse>;
  run(id: string): JobRun;
}
const registry = new WeakMap<Ctx, JobsApi>();

export function registerBackupRoutes(router: Router, ctx: Ctx): void {
  const api = () => {
    const a = registry.get(ctx);
    if (!a) throw new HttpError(503, "jobs not started");
    return a;
  };
  router.get("/v1/backups", () => api().list());
  router.post("/v1/backups/:job/run", (req) => api().run(req.params.job));
}
