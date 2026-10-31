import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AlertEvent, DeviceRecord } from "@orbit/shared";

export interface DeviceRow extends DeviceRecord {
  token: string;
  pendingPair: boolean;
  agentVersion: string | null;
}

const g = globalThis as unknown as { __orbitDb?: DatabaseSync };

function open(): DatabaseSync {
  const dir = path.resolve(/*turbopackIgnore: true*/ process.env.ORBIT_DATA_DIR ?? "./.data");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "orbit-hub.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, platform TEXT, agent_url TEXT,
      enrolled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER,
      syncthing_device_id TEXT, immich_lan_url TEXT, immich_tailscale_url TEXT,
      token TEXT NOT NULL UNIQUE, pending_pair INTEGER NOT NULL DEFAULT 0, agent_version TEXT
    );
    CREATE TABLE IF NOT EXISTS cache (
      device_id TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, fetched_at INTEGER NOT NULL,
      PRIMARY KEY (device_id, key)
    );
    CREATE TABLE IF NOT EXISTS replica_sync (
      device_id TEXT NOT NULL, folder_id TEXT NOT NULL, last_in_sync_at INTEGER, last_completion REAL,
      PRIMARY KEY (device_id, folder_id)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      key TEXT PRIMARY KEY, kind TEXT NOT NULL, severity TEXT NOT NULL, device_id TEXT, title TEXT NOT NULL,
      message TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      resolved_at INTEGER, notified_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
  `);
  // Migrations for databases created by older versions.
  const cols = (db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("replica_paths")) db.exec("ALTER TABLE devices ADD COLUMN replica_paths TEXT");
  return db;
}

export function db(): DatabaseSync {
  return (g.__orbitDb ??= open());
}

type Row = Record<string, unknown>;

function parsePaths(v: unknown): Record<string, string> {
  if (typeof v !== "string" || !v) return {};
  try {
    const o = JSON.parse(v) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function toDevice(r: Row): DeviceRow {
  return {
    id: r.id as string,
    name: r.name as string,
    role: r.role as DeviceRow["role"],
    platform: (r.platform as DeviceRow["platform"]) ?? null,
    agentUrl: (r.agent_url as string) ?? null,
    enrolled: !!r.enrolled,
    createdAt: r.created_at as number,
    lastSeen: (r.last_seen as number) ?? null,
    syncthingDeviceId: (r.syncthing_device_id as string) ?? null,
    immichLanUrl: (r.immich_lan_url as string) ?? null,
    immichTailscaleUrl: (r.immich_tailscale_url as string) ?? null,
    replicaPaths: parsePaths(r.replica_paths),
    token: r.token as string,
    pendingPair: !!r.pending_pair,
    agentVersion: (r.agent_version as string) ?? null,
  };
}

/** Strip server-only fields. */
export function toRecord(d: DeviceRow): DeviceRecord {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { token, pendingPair, agentVersion, ...rec } = d;
  return rec;
}

export const listDevices = (): DeviceRow[] =>
  (db().prepare("SELECT * FROM devices ORDER BY created_at").all() as Row[]).map(toDevice);
export const getDevice = (id: string): DeviceRow | null => {
  const r = db().prepare("SELECT * FROM devices WHERE id = ?").get(id) as Row | undefined;
  return r ? toDevice(r) : null;
};
export const getDeviceByToken = (token: string): DeviceRow | null => {
  const r = db().prepare("SELECT * FROM devices WHERE token = ?").get(token) as Row | undefined;
  return r ? toDevice(r) : null;
};
export const primaryDevice = (): DeviceRow | null => listDevices().find((d) => d.role === "primary") ?? null;

const COLS: Record<string, string> = {
  name: "name", role: "role", platform: "platform", agentUrl: "agent_url", enrolled: "enrolled",
  lastSeen: "last_seen", syncthingDeviceId: "syncthing_device_id", immichLanUrl: "immich_lan_url",
  immichTailscaleUrl: "immich_tailscale_url", token: "token", replicaPaths: "replica_paths", pendingPair: "pending_pair", agentVersion: "agent_version",
};

export function insertDevice(d: Pick<DeviceRow, "id" | "name" | "role" | "token"> & Partial<DeviceRow>): DeviceRow {
  db().prepare("INSERT INTO devices (id, name, role, created_at, token) VALUES (?, ?, ?, ?, ?)").run(d.id, d.name, d.role, Date.now(), d.token);
  return updateDevice(d.id, d)!;
}

export function updateDevice(id: string, patch: Partial<DeviceRow>): DeviceRow | null {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = COLS[k];
    if (!col || v === undefined) continue;
    sets.push(`${col} = ?`);
    vals.push(typeof v === "boolean" ? (v ? 1 : 0) : v !== null && typeof v === "object" ? JSON.stringify(v) : (v as string | number | null));
  }
  if (sets.length) db().prepare(`UPDATE devices SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return getDevice(id);
}

export function deleteDevice(id: string): void {
  for (const t of ["cache", "replica_sync"]) db().prepare(`DELETE FROM ${t} WHERE device_id = ?`).run(id);
  db().prepare("DELETE FROM alerts WHERE device_id = ?").run(id);
  db().prepare("DELETE FROM devices WHERE id = ?").run(id);
}

export function getCache<T>(deviceId: string, key: string): { data: T; fetchedAt: number } | null {
  const r = db().prepare("SELECT json, fetched_at FROM cache WHERE device_id = ? AND key = ?").get(deviceId, key) as Row | undefined;
  if (!r) return null;
  try {
    return { data: JSON.parse(r.json as string) as T, fetchedAt: r.fetched_at as number };
  } catch {
    return null;
  }
}
export function setCache(deviceId: string, key: string, data: unknown): void {
  db().prepare("INSERT OR REPLACE INTO cache (device_id, key, json, fetched_at) VALUES (?, ?, ?, ?)").run(deviceId, key, JSON.stringify(data), Date.now());
}

export function toAlert(r: Row): AlertEvent {
  return {
    key: r.key as string, kind: r.kind as AlertEvent["kind"], severity: r.severity as AlertEvent["severity"],
    deviceId: (r.device_id as string) ?? null, title: r.title as string, message: r.message as string,
    firstSeen: r.first_seen as number, lastSeen: r.last_seen as number,
    resolvedAt: (r.resolved_at as number) ?? null, notifiedAt: (r.notified_at as number) ?? null,
  };
}
