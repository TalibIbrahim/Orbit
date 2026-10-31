/**
 * Read-only Immich API client (Immich v3; v2 fallbacks noted). Only GET / search endpoints are used:
 *   GET  /api/server/version   (no auth)
 *   GET  /api/users, /api/users/me   (permission user.read)
 *   POST /api/search/metadata  (permission asset.read) - a search (read) request, it changes nothing
 * The API key is sent as the x-api-key header and is never logged or returned to the browser.
 * Orbit never calls an Immich endpoint that deletes, trashes, moves or edits assets.
 */
import type { ExpectedFile } from "@orbit/shared";
import { base64ToHex, immichPathToRelative } from "@/lib/verify/logic";

export interface ImmichConn {
  url: string; // without /api
  apiKey: string;
}

export interface ImmichAsset {
  id: string;
  ownerId: string;
  type: "IMAGE" | "VIDEO" | "AUDIO" | "OTHER";
  originalPath: string;
  originalFileName: string;
  checksum: string;
  createdAt: string; // upload time
  isTrashed?: boolean;
  visibility?: "timeline" | "archive" | "hidden" | "locked";
  livePhotoVideoId?: string | null;
  exifInfo?: { fileSizeInByte?: number | null } | null;
}

export class ImmichError extends Error {
  constructor(message: string, public status: number | null = null) {
    super(message);
  }
}

const PAGE = 1000;
const TIMEOUT_MS = 30_000;

async function call<T>(c: ImmichConn, method: "GET" | "POST", path: string, body?: unknown, auth = true): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${c.url}/api${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(auth ? { "x-api-key": c.apiKey } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    throw new ImmichError(`Immich unreachable at ${c.url}: ${(e as Error).message}`);
  }
  if (!res.ok) {
    let msg = "";
    try {
      const j = (await res.json()) as { message?: string | string[]; error?: string };
      msg = Array.isArray(j.message) ? j.message.join("; ") : (j.message ?? j.error ?? "");
    } catch {
      /* not JSON */
    }
    const hint = res.status === 401 ? " (API key invalid)" : res.status === 403 ? " (API key lacks a permission: needs asset.read and user.read)" : "";
    throw new ImmichError(`Immich ${method} ${path} -> ${res.status}${msg ? `: ${msg}` : ""}${hint}`, res.status);
  }
  return (await res.json()) as T;
}

export async function immichVersion(c: ImmichConn): Promise<string> {
  const v = await call<{ major: number; minor: number; patch: number }>(c, "GET", "/server/version", undefined, false);
  return `${v.major}.${v.minor}.${v.patch}`;
}

export async function immichMe(c: ImmichConn): Promise<{ id: string; name: string; email: string }> {
  return call(c, "GET", "/users/me");
}

export async function immichUsers(c: ImmichConn): Promise<{ id: string; name: string; email: string }[]> {
  const list = await call<{ id: string; name: string; email: string }[]>(c, "GET", "/users");
  return list.map(({ id, name, email }) => ({ id, name, email }));
}

interface SearchResponse {
  assets: { items: ImmichAsset[]; nextPage?: string | null; nextCursor?: string | null };
}

/**
 * Every asset the key can see (own + partner timelines; locked assets are never visible to a key),
 * including hidden Live Photo motion parts. Uses the v3.2+ cursor request shape, falling back to the
 * legacy page/size shape for older servers.
 */
export async function* immichAssets(c: ImmichConn): AsyncGenerator<ImmichAsset> {
  let mode: "cursor" | "legacy" = "cursor";
  let cursor: string | null | undefined;
  let page = 1;
  for (let guard = 0; guard < 100_000; guard++) {
    let r: SearchResponse;
    if (mode === "cursor") {
      try {
        r = await call<SearchResponse>(c, "POST", "/search/metadata", {
          size: PAGE,
          withExif: true,
          orderBy: { field: "fileCreatedAt", direction: "asc" },
          ...(cursor ? { cursor } : {}),
        });
      } catch (e) {
        if (guard === 0 && e instanceof ImmichError && e.status === 400) {
          mode = "legacy"; // server older than 3.2
          guard--;
          continue;
        }
        throw e;
      }
      for (const a of r.assets.items) yield a;
      cursor = r.assets.nextCursor;
      if (!cursor) return;
    } else {
      r = await call<SearchResponse>(c, "POST", "/search/metadata", { page, size: PAGE, withExif: true, withDeleted: false });
      for (const a of r.assets.items) yield a;
      if (!r.assets.nextPage) return;
      page = Number(r.assets.nextPage) || page + 1;
    }
  }
}

export interface AssetSnapshot {
  expected: ExpectedFile[];
  owners: Map<string, { photos: number; videos: number; livePhotoVideos: number; bytes: number; newest: number | null }>;
  skipped: number; // assets outside the library tree (e.g. external libraries) or locked
  newestAsset: number | null;
}

/** Map visible, non-trashed assets to the files that must exist under library/ or upload/. */
export async function immichSnapshot(c: ImmichConn, onlyOwners: string[] = []): Promise<AssetSnapshot> {
  const only = new Set(onlyOwners);
  const expected: ExpectedFile[] = [];
  const owners: AssetSnapshot["owners"] = new Map();
  const seen = new Set<string>();
  let skipped = 0;
  let newestAsset: number | null = null;
  for await (const a of immichAssets(c)) {
    if (a.isTrashed || a.visibility === "locked") continue;
    if (only.size && !only.has(a.ownerId)) continue;
    if (seen.has(a.id)) continue; // offset paging can repeat an item when assets arrive mid-scan
    seen.add(a.id);
    const path = immichPathToRelative(a.originalPath);
    if (!path) {
      skipped++;
      continue;
    }
    const createdAt = Date.parse(a.createdAt);
    const size = a.exifInfo?.fileSizeInByte ?? null;
    const video = a.type === "VIDEO";
    expected.push({
      path,
      assetId: a.id,
      ownerId: a.ownerId,
      kind: video ? "video" : "photo",
      size,
      sha1: a.checksum ? (a.checksum.length === 40 ? a.checksum.toLowerCase() : base64ToHex(a.checksum)) : null,
      createdAt,
    });
    const o = owners.get(a.ownerId) ?? { photos: 0, videos: 0, livePhotoVideos: 0, bytes: 0, newest: null };
    if (video && a.visibility === "hidden") o.livePhotoVideos++;
    else if (video) o.videos++;
    else o.photos++;
    o.bytes += size ?? 0;
    o.newest = o.newest == null || createdAt > o.newest ? createdAt : o.newest;
    owners.set(a.ownerId, o);
    newestAsset = newestAsset == null || createdAt > newestAsset ? createdAt : newestAsset;
  }
  return { expected, owners, skipped, newestAsset };
}

/** Newest upload time among assets uploaded in the last 24 h (cheap check for "an upload batch arrived"). */
export async function immichNewestUpload(c: ImmichConn, now = Date.now()): Promise<number | null> {
  const since = new Date(now - 86_400_000).toISOString();
  let items: ImmichAsset[];
  try {
    const r = await call<SearchResponse>(c, "POST", "/search/metadata", { size: 1000, filter: { createdAt: { gte: since } } });
    items = r.assets.items;
  } catch (e) {
    if (!(e instanceof ImmichError && e.status === 400)) throw e;
    const r = await call<SearchResponse>(c, "POST", "/search/metadata", { size: 1000, page: 1, createdAfter: since });
    items = r.assets.items;
  }
  let newest: number | null = null;
  for (const a of items) {
    if (a.isTrashed) continue;
    const t = Date.parse(a.createdAt);
    if (newest == null || t > newest) newest = t;
  }
  return newest;
}
