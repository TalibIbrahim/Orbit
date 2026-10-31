import type { HubSettings } from "@orbit/shared";
import { db } from "./db";

export const MASK = "••••";

export const DEFAULT_SETTINGS: HubSettings = {
  hubUrl: "",
  discordWebhookUrl: null,
  email: null,
  thresholds: { replicaBehindHours: 24, primaryOfflineDays: 3, diskPercent: 80, ramPercent: 90 },
  sharedFolders: [
    { id: "immich-library", label: "Immich library", replicaPath: "/srv/orbit/immich-library", versioning: "staggered" },
    { id: "immich-db-dumps", label: "Immich DB dumps", replicaPath: "/srv/orbit/immich-db-dumps", versioning: "simple" },
  ],
  tailscaleAuthKey: null,
};

/** Stored settings merged over defaults + env fallbacks. hubUrl may be "" when unknown (see hubUrlFor). */
export function getSettings(): HubSettings {
  const r = db().prepare("SELECT json FROM settings WHERE id = 1").get() as { json: string } | undefined;
  let stored: Partial<HubSettings> = {};
  try {
    stored = r ? (JSON.parse(r.json) as Partial<HubSettings>) : {};
  } catch {
    /* corrupt row: use defaults */
  }
  const s: HubSettings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...stored.thresholds },
  };
  s.hubUrl = (s.hubUrl || process.env.ORBIT_HUB_URL || "").replace(/\/+$/, "");
  s.discordWebhookUrl = s.discordWebhookUrl || process.env.DISCORD_WEBHOOK_URL || null;
  return s;
}

export function hubUrlFor(req: Request, s = getSettings()): string {
  if (s.hubUrl) return s.hubUrl;
  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return new URL(req.url).origin;
  const proto = h.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function maskSettings(s: HubSettings): HubSettings {
  return {
    ...s,
    email: s.email ? { ...s.email, password: s.email.password ? MASK : null } : null,
    tailscaleAuthKey: s.tailscaleAuthKey ? MASK : null,
  };
}

export function putSettings(patch: Partial<HubSettings>): HubSettings {
  const cur = getSettings();
  const next: HubSettings = { ...cur };
  if (typeof patch.hubUrl === "string") next.hubUrl = patch.hubUrl.trim().replace(/\/+$/, "");
  if ("discordWebhookUrl" in patch) next.discordWebhookUrl = patch.discordWebhookUrl?.trim() || null;
  if (patch.thresholds) next.thresholds = { ...cur.thresholds, ...patch.thresholds };
  if (Array.isArray(patch.sharedFolders)) next.sharedFolders = patch.sharedFolders;
  if ("tailscaleAuthKey" in patch) {
    next.tailscaleAuthKey = patch.tailscaleAuthKey === MASK ? cur.tailscaleAuthKey : patch.tailscaleAuthKey?.trim() || null;
  }
  if ("email" in patch) {
    const e = patch.email;
    next.email = e ? { ...e, password: e.password === MASK ? (cur.email?.password ?? null) : e.password } : null;
  }
  db().prepare("INSERT OR REPLACE INTO settings (id, json) VALUES (1, ?)").run(JSON.stringify(next));
  return next;
}
