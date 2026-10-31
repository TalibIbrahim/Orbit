import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type {
  SyncthingFolderSummary,
  SyncthingFolderType,
  SyncthingPairRequest,
  SyncthingPeerProgress,
  SyncthingSummary,
} from "@orbit/shared";
import type { Ctx, SyncthingApi } from "./context.ts";
import { HttpError, type Router } from "./http.ts";

interface StFolder {
  id: string;
  label: string;
  path: string;
  type: SyncthingFolderType;
  paused: boolean;
  devices: { deviceID: string; [k: string]: unknown }[];
  versioning?: { type?: string; [k: string]: unknown };
  [k: string]: unknown;
}
interface StDevice { deviceID: string; name: string; [k: string]: unknown }

function candidateConfigPaths(explicit?: string): string[] {
  if (explicit) return [explicit];
  if (process.platform === "win32") {
    const la = process.env.LOCALAPPDATA ?? join(os.homedir(), "AppData", "Local");
    return [join(la, "Syncthing", "config.xml")];
  }
  const homes = new Set<string>([os.homedir(), "/root"]);
  if (process.env.SUDO_USER) homes.add(`/home/${process.env.SUDO_USER}`);
  const out: string[] = [];
  for (const h of homes) out.push(join(h, ".local/state/syncthing/config.xml"), join(h, ".config/syncthing/config.xml"));
  out.push("/var/lib/syncthing/config.xml");
  return out;
}

function readApiKey(ctx: Ctx): string | null {
  const cfg = ctx.config.syncthing;
  if (cfg?.apiKey) return cfg.apiKey;
  for (const p of candidateConfigPaths(cfg?.configPath)) {
    try {
      if (!existsSync(p)) continue;
      const m = /<apikey>([^<]+)<\/apikey>/.exec(readFileSync(p, "utf8"));
      if (m) return m[1].trim();
    } catch { /* try next */ }
  }
  return null;
}

const versioningBody = (v: { type: string; params: Record<string, string> }) => ({
  type: v.type,
  params: v.params,
  cleanupIntervalS: 3600,
  fsPath: "",
  fsType: "basic",
});

export function createSyncthing(ctx: Ctx): SyncthingApi {
  const base = (ctx.config.syncthing?.url ?? "http://127.0.0.1:8384").replace(/\/$/, "");
  let apiKey: string | null = null;
  let cache: { at: number; value: SyncthingSummary } | null = null;

  async function st<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    apiKey ??= readApiKey(ctx);
    if (!apiKey) throw new Error("Syncthing API key not found (set syncthing.apiKey or configPath)");
    const res = await fetch(base + path, {
      method: init.method ?? "GET",
      headers: { "X-API-Key": apiKey, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 403 || res.status === 401) apiKey = null; // re-read next time
    if (!res.ok) throw new Error(`syncthing ${init.method ?? "GET"} ${path} -> ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  const myDeviceId = async (): Promise<string | null> => {
    try {
      return (await st<{ myID: string }>("/rest/system/status")).myID;
    } catch {
      return null;
    }
  };

  async function build(): Promise<SyncthingSummary> {
    const noStats: Record<string, { lastSeen?: string }> = {};
    const [status, version, folders, devices, conns, stats] = await Promise.all([
      st<{ myID: string }>("/rest/system/status"),
      st<{ version: string }>("/rest/system/version"),
      st<StFolder[]>("/rest/config/folders"),
      st<StDevice[]>("/rest/config/devices"),
      st<{ connections: Record<string, { connected: boolean }> }>("/rest/system/connections"),
      st<Record<string, { lastSeen?: string }>>("/rest/stats/device").catch(() => noStats),
    ]);
    const me = status.myID;
    const names = new Map(devices.map((d) => [d.deviceID, d.name || d.deviceID.slice(0, 7)]));
    const validTime = (iso: unknown): number | null => {
      const t = Date.parse(String(iso ?? ""));
      return Number.isFinite(t) && new Date(t).getUTCFullYear() >= 2000 ? t : null;
    };

    const out: SyncthingFolderSummary[] = await Promise.all(
      folders.map(async (f) => {
        const q = encodeURIComponent(f.id);
        const s = await st<Record<string, number | string>>(`/rest/db/status?folder=${q}`).catch(
          () => ({}) as Record<string, number | string>,
        );
        const num = (k: string) => (typeof s[k] === "number" ? (s[k] as number) : 0);
        const needItems = num("needTotalItems") || num("needFiles") + num("needDirectories") + num("needSymlinks") + num("needDeletes");
        const peers: SyncthingPeerProgress[] = await Promise.all(
          f.devices
            .filter((d) => d.deviceID !== me)
            .map(async (d) => {
              const c = await st<{ completion: number; needItems: number; needBytes: number }>(
                `/rest/db/completion?folder=${q}&device=${encodeURIComponent(d.deviceID)}`,
              ).catch(() => null);
              return {
                deviceId: d.deviceID,
                name: names.get(d.deviceID) ?? d.deviceID.slice(0, 7),
                connected: conns.connections?.[d.deviceID]?.connected ?? false,
                lastSeen: validTime(stats[d.deviceID]?.lastSeen),
                completion: c?.completion ?? 0,
                needItems: c?.needItems ?? 0,
                needBytes: c?.needBytes ?? 0,
              };
            }),
        );
        return {
          id: f.id,
          label: f.label || f.id,
          path: f.path,
          type: f.type,
          paused: !!f.paused,
          state: f.paused ? "paused" : String(s.state ?? "unknown"),
          globalBytes: num("globalBytes"),
          localBytes: num("localBytes"),
          needItems,
          needBytes: num("needBytes"),
          stateChanged: validTime(s.stateChanged),
          versioning: f.versioning?.type ?? "",
          peers,
        };
      }),
    );
    return { available: true, myDeviceId: me, version: version.version, folders: out };
  }

  async function summary(force = false): Promise<SyncthingSummary> {
    if (!force && cache && Date.now() - cache.at < 15_000) return cache.value;
    let value: SyncthingSummary;
    try {
      value = await build();
    } catch (e) {
      value = { available: false, error: (e as Error).message, myDeviceId: null, version: null, folders: [] };
    }
    cache = { at: Date.now(), value };
    return value;
  }

  return {
    available: async () => (await summary()).available,
    summary: () => summary(),
    myDeviceId,
    async setFolderPaused(folderId, paused) {
      await st(`/rest/config/folders/${encodeURIComponent(folderId)}`, { method: "PATCH", body: { paused } });
      cache = null;
    },
    async pair(req: SyncthingPairRequest) {
      const me = await myDeviceId();
      if (!me) throw new Error("Syncthing not reachable");
      await st(`/rest/config/devices/${encodeURIComponent(req.remoteDeviceId)}`, {
        method: "PUT",
        body: {
          deviceID: req.remoteDeviceId,
          name: req.remoteName,
          addresses: [req.remoteAddress ?? "dynamic"],
          autoAcceptFolders: false,
        },
      });
      const existing = await st<StFolder[]>("/rest/config/folders");
      for (const f of req.folders) {
        const cur = existing.find((e) => e.id === f.id);
        const id = encodeURIComponent(f.id);
        if (cur) {
          const devices = cur.devices.some((d) => d.deviceID === req.remoteDeviceId)
            ? cur.devices
            : [...cur.devices, { deviceID: req.remoteDeviceId }];
          const body: Record<string, unknown> = { devices };
          if (f.versioning) body.versioning = versioningBody(f.versioning);
          await st(`/rest/config/folders/${id}`, { method: "PATCH", body });
        } else {
          // path "" means "use the existing folder"; it cannot create a new one.
          if (!f.path) throw new Error(`folder "${f.id}" does not exist on this device and no path was given`);
          mkdirSync(f.path, { recursive: true });
          await st(`/rest/config/folders/${id}`, {
            method: "PUT",
            body: {
              id: f.id,
              label: f.label,
              path: f.path,
              type: f.type,
              devices: [{ deviceID: me }, { deviceID: req.remoteDeviceId }],
              paused: false,
              versioning: f.versioning ? versioningBody(f.versioning) : versioningBody({ type: "", params: {} }),
              minDiskFree: { value: 5, unit: "%" },
            },
          });
        }
      }
      return summary(true);
    },
  };
}

const FOLDER_TYPES = ["sendreceive", "sendonly", "receiveonly", "receiveencrypted"];

function validatePair(b: unknown): SyncthingPairRequest {
  const bad = (m: string) => new HttpError(400, `invalid pair request: ${m}`);
  if (!b || typeof b !== "object") throw bad("body required");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = b as Record<string, any>;
  if (typeof r.remoteDeviceId !== "string" || !/^[A-Z0-9-]{20,}$/i.test(r.remoteDeviceId)) throw bad("remoteDeviceId");
  if (typeof r.remoteName !== "string" || !r.remoteName) throw bad("remoteName");
  if (r.remoteAddress !== undefined && typeof r.remoteAddress !== "string") throw bad("remoteAddress");
  if (!Array.isArray(r.folders)) throw bad("folders");
  for (const f of r.folders) {
    if (!f || typeof f.id !== "string" || !f.id || typeof f.label !== "string" || typeof f.path !== "string") throw bad("folder id/label/path");
    if (!FOLDER_TYPES.includes(f.type)) throw bad("folder type");
    if (f.versioning !== undefined) {
      const v = f.versioning;
      if (!v || !["simple", "staggered", "trashcan"].includes(v.type) || typeof v.params !== "object" || v.params === null) throw bad("versioning");
    }
  }
  return r as unknown as SyncthingPairRequest;
}

export function registerSyncthingRoutes(router: Router, ctx: Ctx): void {
  router.get("/v1/syncthing", () => ctx.syncthing.summary());
  router.post("/v1/syncthing/pair", async (req) => {
    const body = validatePair(req.body);
    try {
      return await ctx.syncthing.pair(body);
    } catch (e) {
      throw new HttpError(502, "syncthing pairing failed", (e as Error).message);
    }
  });
}
