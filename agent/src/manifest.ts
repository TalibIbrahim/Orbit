// READ-ONLY GUARANTEE: this module never writes, renames, deletes, chmods or touches any file under a
// Syncthing folder root. It only uses fs opendir / lstat / realpath / createReadStream on the photo tree.
// The only thing it writes is its own SQLite tables (manifest, manifest_state) and a kv root cache.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";
import type { ManifestEntry, ManifestHashRequest, ManifestHashResponse, ManifestPage, ManifestStatus } from "@orbit/shared";
import type { Ctx } from "./context.ts";
import { kvGet, kvSet } from "./db.ts";
import type { Req, Router } from "./http.ts";

// http.ts uses TS parameter properties (unsupported by node strip-types), so it is only loaded lazily when
// translating errors for the router; the core of this module (and its tests) stays free of it.
export class ManifestError extends Error {
  status: number;
  detail?: string;
  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}
const HttpError = ManifestError;

const SUBTREES = ["upload", "library"];
const FRESH_MS = 60_000; // newer files are probably still being written
const RESCAN_MS = 10 * 60_000;
const BATCH = 500;
const HASH_BUDGET_MS = 20_000;
const HASH_CONCURRENCY = 2;
const MAX_HASH_PATHS = 2000;

interface Progress { scanned: number }

/** OS files that Windows / macOS drop into folders a user browses; never Immich originals. */
const OS_JUNK = new Set(["desktop.ini", "thumbs.db", "ehthumbs.db"]);

/**
 * Names excluded from every manifest (host and replicas alike), so file counts compare like for like:
 * Syncthing's own entries (.stfolder, .stignore, .stversions, .syncthing.*.tmp, ~syncthing~*.tmp, *.syncthing.tmp),
 * conflict copies (*.sync-conflict-*), partial / temp files, any other hidden entry, and OS junk (desktop.ini, Thumbs.db).
 * Only upload/ and library/ (Immich originals) are walked at all.
 */
export function skipName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    name.startsWith(".") ||
    name.startsWith("~syncthing~") ||
    lower.endsWith(".partial") ||
    lower.endsWith(".tmp") ||
    lower.includes(".sync-conflict-") ||
    OS_JUNK.has(lower)
  );
}

export function validateRelPath(p: unknown): string {
  if (typeof p !== "string" || !p) throw new HttpError(400, "invalid path");
  if (p.includes("\0") || p.includes("\\") || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) throw new HttpError(400, `invalid path: ${p}`);
  const parts = p.split("/");
  if (parts.some((x) => x === "" || x === "." || x === "..")) throw new HttpError(400, `invalid path: ${p}`);
  if (!SUBTREES.includes(parts[0]) || parts.length < 2) throw new HttpError(400, `path must be under upload/ or library/: ${p}`);
  return p;
}

export function createManifest(ctx: Ctx) {
  const db = ctx.db;
  const scans = new Map<string, { promise: Promise<void>; progress: Progress }>();
  const lastAttempt = new Map<string, number>();
  const lastError = new Map<string, string>();

  const getState = db.prepare("SELECT root, generation, built_at, files, bytes FROM manifest_state WHERE folder = ?");
  const upsert = db.prepare(
    `INSERT INTO manifest (folder, path, size, mtime_ms, sha1, hashed_size, hashed_mtime, seen_gen) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)
     ON CONFLICT(folder, path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, seen_gen = excluded.seen_gen,
       sha1 = CASE WHEN hashed_size = excluded.size AND hashed_mtime = excluded.mtime_ms THEN sha1 ELSE NULL END`,
  );

  function state(folder: string) {
    return getState.get(folder) as
      | { root: string | null; generation: number; built_at: number | null; files: number; bytes: number }
      | undefined;
  }

  async function resolveRoot(folder: string): Promise<{ root: string | null; error?: string }> {
    const key = `manifest_root:${folder}`;
    let err = "syncthing unavailable";
    try {
      const s = await ctx.syncthing.summary();
      if (s.available) {
        const f = s.folders.find((x) => x.id === folder);
        if (f?.path) {
          kvSet(db, key, f.path);
          return { root: f.path };
        }
        return { root: null, error: `unknown folder: ${folder}` };
      }
      if (s.error) err = s.error;
    } catch (e) {
      err = (e as Error).message;
    }
    const cached = kvGet<string>(db, key);
    return cached ? { root: cached } : { root: null, error: err };
  }

  async function walk(folder: string, root: string, gen: number, progress: Progress) {
    let batch: [string, number, number][] = [];
    let files = 0;
    let bytes = 0;
    const flush = () => {
      if (!batch.length) return;
      db.exec("BEGIN");
      try {
        for (const [p, size, mtime] of batch) upsert.run(folder, p, size, mtime, gen);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      batch = [];
    };
    let n = 0;
    const walkDir = async (abs: string, rel: string) => {
      const dir = await opendir(abs);
      try {
        for await (const d of dir) {
          if (++n % BATCH === 0) {
            flush();
            await yieldLoop();
          }
          if (skipName(d.name)) continue;
          if (d.isSymbolicLink()) continue;
          const a = join(abs, d.name);
          const r = `${rel}/${d.name}`;
          if (d.isDirectory()) {
            await walkDir(a, r);
          } else if (d.isFile()) {
            let st;
            try {
              st = await lstat(a);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // vanished mid-scan
              throw e;
            }
            if (!st.isFile() || Date.now() - st.mtimeMs < FRESH_MS) continue;
            batch.push([r, st.size, Math.floor(st.mtimeMs)]);
            files++;
            bytes += st.size;
            progress.scanned++;
          }
        }
      } finally {
        await dir.close().catch(() => undefined);
      }
    };
    for (const top of SUBTREES) {
      let st;
      try {
        st = await lstat(join(root, top));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      await walkDir(join(root, top), top);
    }
    flush();
    return { files, bytes };
  }

  async function runScan(folder: string, progress: Progress) {
    const { root, error } = await resolveRoot(folder);
    if (!root) throw new Error(error ?? "no root");
    const st = await lstat(root); // throws if unreadable
    if (!st.isDirectory()) throw new Error("root is not a directory");
    const gen = (state(folder)?.generation ?? 0) + 1;
    const { files, bytes } = await walk(folder, root, gen, progress);
    // complete walk: drop DB rows (not files) for paths no longer present
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM manifest WHERE folder = ? AND seen_gen < ?").run(folder, gen);
      db.prepare(
        `INSERT INTO manifest_state (folder, root, generation, built_at, files, bytes) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(folder) DO UPDATE SET root = excluded.root, generation = excluded.generation, built_at = excluded.built_at,
           files = excluded.files, bytes = excluded.bytes`,
      ).run(folder, root, gen, Date.now(), files, bytes);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  function startScan(folder: string): void {
    if (scans.has(folder)) return;
    lastAttempt.set(folder, Date.now());
    const progress: Progress = { scanned: 0 };
    const promise = runScan(folder, progress)
      .then(() => void lastError.delete(folder))
      .catch((e) => {
        lastError.set(folder, (e as Error).message);
        console.warn(`[manifest] scan ${folder} failed:`, (e as Error).message);
      })
      .finally(() => void scans.delete(folder));
    scans.set(folder, { promise, progress });
  }

  async function status(folder: string, force = false): Promise<ManifestStatus> {
    if (!folder) throw new HttpError(400, "folder required");
    const { root, error } = await resolveRoot(folder);
    const s = state(folder);
    const fresh = Date.now() - Math.max(s?.built_at ?? 0, lastAttempt.get(folder) ?? 0) < RESCAN_MS;
    if (root && (force || !fresh)) startScan(folder);
    const scan = scans.get(folder);
    const err = !root ? error : lastError.get(folder);
    const hashed = (db.prepare("SELECT COUNT(*) AS c FROM manifest WHERE folder = ? AND sha1 IS NOT NULL").get(folder) as { c: number }).c;
    return {
      folderId: folder,
      root,
      available: !!root && !(err && !s),
      ...(err ? { error: err } : {}),
      files: s?.files ?? 0,
      bytes: s?.bytes ?? 0,
      hashed,
      builtAt: s?.built_at ?? null,
      building: !!scan,
      scanned: scan?.progress.scanned ?? 0,
      generation: s?.generation ?? 0,
    };
  }

  function entries(folder: string, after: string | null, limitRaw: number): ManifestPage {
    const limit = Math.min(5000, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 2000));
    const rows = db
      .prepare(`SELECT path, size, mtime_ms, sha1 FROM manifest WHERE folder = ? ${after ? "AND path > ?" : ""} ORDER BY path LIMIT ?`)
      .all(...(after ? [folder, after, limit + 1] : [folder, limit + 1])) as {
      path: string;
      size: number;
      mtime_ms: number;
      sha1: string | null;
    }[];
    const more = rows.length > limit;
    const page = (more ? rows.slice(0, limit) : rows).map(
      (r): ManifestEntry => ({ path: r.path, size: r.size, mtimeMs: r.mtime_ms, sha1: r.sha1 }),
    );
    return { entries: page, next: more ? page[page.length - 1].path : null, generation: state(folder)?.generation ?? 0 };
  }

  function sha1Of(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const h = createHash("sha1");
      createReadStream(file) // read-only
        .on("data", (c) => h.update(c))
        .on("error", reject)
        .on("end", () => resolve(h.digest("hex")));
    });
  }

  async function hash(req: ManifestHashRequest): Promise<ManifestHashResponse> {
    if (!req || typeof req.folderId !== "string" || !req.folderId) throw new HttpError(400, "folderId required");
    if (!Array.isArray(req.paths) || req.paths.length > MAX_HASH_PATHS) {
      throw new HttpError(400, `paths must be an array of at most ${MAX_HASH_PATHS}`);
    }
    const paths = req.paths.map(validateRelPath);
    const { root, error } = await resolveRoot(req.folderId);
    if (!root) throw new HttpError(404, error ?? "unknown folder");
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch (e) {
      throw new HttpError(404, "folder root unreadable", (e as Error).message);
    }
    const deadline = Date.now() + HASH_BUDGET_MS;
    const getRow = db.prepare("SELECT sha1, hashed_size, hashed_mtime FROM manifest WHERE folder = ? AND path = ?");
    const store = db.prepare("UPDATE manifest SET sha1 = ?, hashed_size = ?, hashed_mtime = ? WHERE folder = ? AND path = ?");
    const out = new Map<string, { path: string; sha1: string | null; error?: string }>();
    let next = 0;
    const one = async (p: string) => {
      try {
        const abs = join(root, ...p.split("/"));
        const st = await lstat(abs);
        if (!st.isFile()) throw Object.assign(new Error("not a regular file"), { code: "ENOTFILE" });
        const rel = relative(realRoot, await realpath(abs));
        if (rel.startsWith("..") || isAbsolute(rel)) throw Object.assign(new Error("outside root"), { code: "EOUTSIDE" });
        const mtime = Math.floor(st.mtimeMs);
        const row = getRow.get(req.folderId, p) as { sha1: string | null; hashed_size: number | null; hashed_mtime: number | null } | undefined;
        if (row?.sha1 && row.hashed_size === st.size && row.hashed_mtime === mtime) {
          out.set(p, { path: p, sha1: row.sha1 });
          return;
        }
        const sha1 = await sha1Of(abs);
        const after = await lstat(abs);
        if (after.size === st.size && Math.floor(after.mtimeMs) === mtime) store.run(sha1, st.size, mtime, req.folderId, p);
        out.set(p, { path: p, sha1 });
      } catch (e) {
        out.set(p, { path: p, sha1: null, error: (e as NodeJS.ErrnoException).code ?? (e as Error).message });
      }
    };
    const worker = async () => {
      while (next < paths.length && Date.now() < deadline) await one(paths[next++]);
    };
    await Promise.all(Array.from({ length: HASH_CONCURRENCY }, worker));
    return {
      hashes: paths.filter((p) => out.has(p)).map((p) => out.get(p)!),
      pending: paths.slice(next),
    };
  }

  return {
    status: (folder: string) => status(folder),
    refresh: (folder: string) => status(folder, true),
    entries,
    hash,
    /** resolves when no scan is running (tests) */
    async idle() {
      while (scans.size) await Promise.all([...scans.values()].map((s) => s.promise));
    },
  };
}

export type Manifest = ReturnType<typeof createManifest>;

export function registerManifestRoutes(router: Router, ctx: Ctx): Manifest {
  const m = createManifest(ctx);
  const wrap = <T>(fn: (req: Req) => T | Promise<T>) => async (req: Req): Promise<T> => {
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof ManifestError) {
        const { HttpError: H } = await import("./http.ts");
        throw new H(e.status, e.message, e.detail);
      }
      throw e;
    }
  };
  router.get("/v1/manifest", wrap((req) => m.status(req.query.get("folder") ?? "")));
  router.post("/v1/manifest/refresh", wrap((req) => {
    const id = (req.body as { folderId?: unknown } | undefined)?.folderId;
    if (typeof id !== "string" || !id) throw new ManifestError(400, "folderId required");
    return m.refresh(id);
  }));
  router.get("/v1/manifest/entries", wrap((req) => {
    const folder = req.query.get("folder");
    if (!folder) throw new ManifestError(400, "folder required");
    return m.entries(folder, req.query.get("after") || null, Number(req.query.get("limit") ?? 2000));
  }));
  router.post("/v1/manifest/hash", wrap((req) => m.hash(req.body as ManifestHashRequest)));
  return m;
}
