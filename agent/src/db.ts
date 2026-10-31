import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Single SQLite file per agent. node:sqlite is built into Node >= 22.13, so the agent has no native deps.
export type DB = DatabaseSync;

export function openDb(dataDir: string): DB {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "orbit-agent.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    -- one row per sample interval (60s)
    CREATE TABLE IF NOT EXISTS samples (
      ts INTEGER PRIMARY KEY,
      cpu REAL NOT NULL,
      mem_used INTEGER NOT NULL,
      mem_total INTEGER NOT NULL,
      net_rx REAL NOT NULL,
      net_tx REAL NOT NULL,
      disk_used INTEGER NOT NULL,
      disk_total INTEGER NOT NULL
    );

    -- per configured service, same cadence as samples
    CREATE TABLE IF NOT EXISTS service_samples (
      ts INTEGER NOT NULL,
      service TEXT NOT NULL,
      cpu REAL NOT NULL,
      mem_used INTEGER NOT NULL,
      net_rx REAL NOT NULL,
      net_tx REAL NOT NULL,
      PRIMARY KEY (service, ts)
    );

    -- directory size measurements; key = "folder:<id>" | "service:<name>"
    CREATE TABLE IF NOT EXISTS size_samples (
      ts INTEGER NOT NULL,
      key TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (key, ts)
    );

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      limit_bytes INTEGER NOT NULL,
      mode TEXT NOT NULL,
      syncthing_folder_id TEXT,
      paused_by_orbit INTEGER NOT NULL DEFAULT 0,
      last_alert_level INTEGER NOT NULL DEFAULT 0, -- 0, 80, 100
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      exit_code INTEGER,
      output_tail TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs (job, started_at);

    -- read-only file manifest of the Immich originals (upload/, library/) per Syncthing folder
    CREATE TABLE IF NOT EXISTS manifest (
      folder TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      sha1 TEXT,
      hashed_size INTEGER,
      hashed_mtime INTEGER,
      seen_gen INTEGER NOT NULL,
      PRIMARY KEY (folder, path)
    );
    CREATE TABLE IF NOT EXISTS manifest_state (
      folder TEXT PRIMARY KEY,
      root TEXT,
      generation INTEGER NOT NULL DEFAULT 0,
      built_at INTEGER,
      files INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export function kvGet<T>(db: DB, key: string): T | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

export function kvSet(db: DB, key: string, value: unknown): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    JSON.stringify(value),
  );
}

export function pruneOld(db: DB, retentionDays: number): void {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  db.prepare("DELETE FROM samples WHERE ts < ?").run(cutoff);
  db.prepare("DELETE FROM service_samples WHERE ts < ?").run(cutoff);
  db.prepare("DELETE FROM size_samples WHERE ts < ?").run(cutoff);
  db.prepare("DELETE FROM job_runs WHERE started_at < ?").run(Date.now() - retentionDays * 3 * 86_400_000); // keep runs 3x longer
}
