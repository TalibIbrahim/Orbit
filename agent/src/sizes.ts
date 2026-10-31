import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { Ctx } from "./context.ts";
import { enforceFolders } from "./folders.ts";

const IGNORED = new Set(["EACCES", "EPERM", "ENOENT", "ENOTDIR", "EBUSY", "UNKNOWN"]);

function duBytes(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn("du", ["-sb", path], { stdio: ["ignore", "pipe", "ignore"], timeout: 15 * 60_000 });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("error", reject);
    p.on("close", () => {
      const n = Number.parseInt(out.trim().split(/\s+/)[0] ?? "", 10); // du exits 1 on unreadable subdirs but still prints a total
      Number.isFinite(n) ? resolve(n) : reject(new Error("du failed"));
    });
  });
}

async function walkBytes(root: string): Promise<number> {
  const stack = [root];
  let total = 0;
  let active = 0;
  const worker = async () => {
    for (;;) {
      const dir = stack.pop();
      if (dir === undefined) {
        if (active === 0) return;
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      active++;
      try {
        const d = await opendir(dir);
        for await (const e of d) {
          if (e.isSymbolicLink()) continue;
          const full = join(dir, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (e.isFile()) {
            try {
              total += (await lstat(full)).size;
            } catch (err) {
              if (!IGNORED.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
            }
          }
        }
      } catch (err) {
        if (!IGNORED.has((err as NodeJS.ErrnoException).code ?? "")) console.warn("[sizes] walk", dir, (err as Error).message);
      } finally {
        active--;
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  return total;
}

/** Total bytes under `path` (0 if missing). */
export async function measureDir(path: string): Promise<number> {
  if (!existsSync(path)) return 0;
  if (process.platform !== "win32") {
    try {
      return await duBytes(path);
    } catch {
      /* fall back to walker */
    }
  }
  return walkBytes(path);
}

export async function measureFolder(ctx: Ctx, id: string, path: string): Promise<number> {
  const bytes = await measureDir(path);
  ctx.db.prepare("INSERT OR REPLACE INTO size_samples (ts, key, bytes) VALUES (?,?,?)").run(Date.now(), `folder:${id}`, bytes);
  return bytes;
}

let running = false;

async function pass(ctx: Ctx) {
  if (running) return;
  running = true;
  try {
    const put = ctx.db.prepare("INSERT OR REPLACE INTO size_samples (ts, key, bytes) VALUES (?,?,?)");
    for (const s of ctx.config.services) {
      let sum = 0;
      for (const p of s.paths) {
        try { sum += await measureDir(p); } catch (e) { console.warn("[sizes]", p, (e as Error).message); }
      }
      put.run(Date.now(), `service:${s.name}`, sum);
    }
    const folders = ctx.db.prepare("SELECT id, path FROM folders").all() as { id: string; path: string }[];
    for (const f of folders) {
      try { await measureFolder(ctx, f.id, f.path); } catch (e) { console.warn("[sizes]", f.path, (e as Error).message); }
    }
    await enforceFolders(ctx);
  } catch (e) {
    console.warn("[sizes] pass failed:", (e as Error)?.message ?? e);
  } finally {
    running = false;
  }
}

export function startSizer(ctx: Ctx): void {
  setTimeout(() => void pass(ctx), 5000);
  setInterval(() => void pass(ctx), ctx.config.sizeIntervalMin * 60_000);
}
