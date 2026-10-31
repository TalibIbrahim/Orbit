import { type HubSettings, type ImmichVerifySettings, type PrimaryMode, PRIMARY_MODES } from "@orbit/shared";
import { db } from "./db";
import { decryptSecret, encryptSecret } from "./secret";

export const MASK = "••••";

const envMode = (): PrimaryMode =>
  PRIMARY_MODES.includes(process.env.ORBIT_PRIMARY_MODE as PrimaryMode) ? (process.env.ORBIT_PRIMARY_MODE as PrimaryMode) : "device";

export const DEFAULT_SETTINGS: HubSettings = {
  primaryMode: "device",
  versioningMaxAgeDays: 30,
  hubUrl: "",
  discordWebhookUrl: null,
  email: null,
  thresholds: { replicaBehindHours: 24, primaryOfflineDays: 3, diskPercent: 80, ramPercent: 90, libraryPercent: 90 },
  sharedFolders: [
    { id: "immich-library", label: "Immich library", replicaPath: "/srv/orbit/immich-library", versioning: "staggered" },
    { id: "immich-db-dumps", label: "Immich DB dumps", replicaPath: "/srv/orbit/immich-db-dumps", versioning: "simple" },
  ],
  tailscaleAuthKey: null,
  immich: {
    url: "",
    apiKey: null,
    sourceUserIds: [],
    minCopies: 2,
    requireNonHostCopy: true,
    hashRecentDays: 7,
    samplePercent: 2,
    scheduleHours: 6,
    notifyWatermark: true,
    notifyProblems: true,
  },
};

const num = (v: unknown, min: number, max: number, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;

/** Immich settings with defaults; apiKey stays encrypted here (see immichApiKey()). */
function immichOf(stored: Partial<ImmichVerifySettings> | undefined): ImmichVerifySettings {
  const d = DEFAULT_SETTINGS.immich;
  const s = stored ?? {};
  return {
    url: (s.url || process.env.ORBIT_IMMICH_URL || "").trim().replace(/\/+$/, "").replace(/\/api$/, ""),
    apiKey: s.apiKey ?? null,
    sourceUserIds: Array.isArray(s.sourceUserIds) ? s.sourceUserIds.filter((x) => typeof x === "string").slice(0, 50) : [],
    minCopies: Math.round(num(s.minCopies, 1, 10, d.minCopies)),
    requireNonHostCopy: typeof s.requireNonHostCopy === "boolean" ? s.requireNonHostCopy : d.requireNonHostCopy,
    hashRecentDays: Math.round(num(s.hashRecentDays, 0, 365, d.hashRecentDays)),
    samplePercent: num(s.samplePercent, 0, 100, d.samplePercent),
    scheduleHours: num(s.scheduleHours, 0, 168, d.scheduleHours),
    notifyWatermark: typeof s.notifyWatermark === "boolean" ? s.notifyWatermark : d.notifyWatermark,
    notifyProblems: typeof s.notifyProblems === "boolean" ? s.notifyProblems : d.notifyProblems,
  };
}

/** Decrypted Immich API key, server-side only. Never log it or send it to the client. */
export const immichApiKey = (s: HubSettings = getSettings()): string | null => decryptSecret(s.immich.apiKey);

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
    // Until changed in Settings, the mode chosen at install time (ORBIT_PRIMARY_MODE) applies.
    primaryMode: envMode(),
    ...stored,
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...stored.thresholds },
    immich: immichOf(stored.immich),
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
    immich: { ...s.immich, apiKey: s.immich.apiKey ? MASK : null },
  };
}

export function putSettings(patch: Partial<HubSettings>): HubSettings {
  const cur = getSettings();
  const next: HubSettings = { ...cur };
  if (patch.primaryMode && PRIMARY_MODES.includes(patch.primaryMode)) next.primaryMode = patch.primaryMode;
  if (typeof patch.versioningMaxAgeDays === "number" && Number.isFinite(patch.versioningMaxAgeDays))
    next.versioningMaxAgeDays = Math.min(3650, Math.max(1, Math.round(patch.versioningMaxAgeDays)));
  if (typeof patch.hubUrl === "string") next.hubUrl = patch.hubUrl.trim().replace(/\/+$/, "");
  if ("discordWebhookUrl" in patch) next.discordWebhookUrl = patch.discordWebhookUrl?.trim() || null;
  if (patch.thresholds) next.thresholds = { ...cur.thresholds, ...patch.thresholds };
  if (Array.isArray(patch.sharedFolders)) next.sharedFolders = patch.sharedFolders;
  if ("tailscaleAuthKey" in patch) {
    next.tailscaleAuthKey = patch.tailscaleAuthKey === MASK ? cur.tailscaleAuthKey : patch.tailscaleAuthKey?.trim() || null;
  }
  if (patch.immich && typeof patch.immich === "object") {
    const p = patch.immich;
    const merged = immichOf({ ...cur.immich, ...p, apiKey: cur.immich.apiKey });
    if ("apiKey" in p && p.apiKey !== MASK) {
      const k = typeof p.apiKey === "string" ? p.apiKey.trim() : "";
      merged.apiKey = k ? encryptSecret(k) : null; // stored encrypted, never returned
    }
    next.immich = merged;
  }
  if ("email" in patch) {
    const e = patch.email;
    next.email = e ? { ...e, password: e.password === MASK ? (cur.email?.password ?? null) : e.password } : null;
  }
  // Persist the mode only as an explicit override of the installer's ORBIT_PRIMARY_MODE, so re-running
  // install-arm-free.sh --mode … still takes effect when nobody changed it in Settings.
  const { primaryMode, ...rest } = next;
  const toStore = primaryMode === envMode() ? rest : next;
  db().prepare("INSERT OR REPLACE INTO settings (id, json) VALUES (1, ?)").run(JSON.stringify(toStore));
  return next;
}
