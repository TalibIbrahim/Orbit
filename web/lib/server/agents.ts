import type { ApiError, Cached } from "@orbit/shared";
import { type DeviceRow, getCache, setCache, updateDevice } from "./db";

const TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 1500;

/** Last successful contact older than this = offline even without failed polls (poller stopped, never polled). */
export const ONLINE_MS = 3 * 60_000;
/** Consecutive failed status polls before a device is shown Offline (one slow answer is not an outage). */
export const OFFLINE_AFTER_FAILURES = 2;

const g = globalThis as unknown as { __orbitFails?: Map<string, number> };
const fails = (g.__orbitFails ??= new Map<string, number>());

/** Online = seen recently and fewer than OFFLINE_AFTER_FAILURES consecutive failed status polls. */
export function isOnline(d: Pick<DeviceRow, "id" | "lastSeen">, now = Date.now()): boolean {
  return d.lastSeen != null && now - d.lastSeen < ONLINE_MS && (fails.get(d.id) ?? 0) < OFFLINE_AFTER_FAILURES;
}
export const failedPolls = (id: string): number => fails.get(id) ?? 0;

export class AgentError extends Error {
  constructor(message: string, public status = 503, public body?: unknown) {
    super(message);
  }
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function agentFetch(device: DeviceRow, method: string, path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<Response> {
  if (!device.agentUrl) throw new AgentError("device is not enrolled yet");
  const url = `${device.agentUrl.replace(/\/+$/, "")}/v1${path.startsWith("/") ? path : `/${path}`}`;
  try {
    return await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${device.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (e) {
    throw new AgentError(`agent unreachable: ${errMsg(e)}`);
  }
}

/** GET with one retry on network errors / timeouts (not on HTTP error statuses). */
async function agentGet(device: DeviceRow, path: string): Promise<Response> {
  try {
    return await agentFetch(device, "GET", path);
  } catch (e) {
    if (!device.agentUrl) throw e;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return agentFetch(device, "GET", path);
  }
}

/**
 * Fetch an agent GET path; cache on success, fall back to cache (stale) on failure. Never throws.
 * Failures of "/status" (the poller's heartbeat) count towards OFFLINE_AFTER_FAILURES; a failed
 * request still reports online=true while the device is within that grace.
 */
export async function cachedGet<T>(device: DeviceRow, path: string): Promise<Cached<T>> {
  let error: string;
  try {
    const res = await agentGet(device, path);
    if (res.ok) {
      const data = (await res.json()) as T;
      setCache(device.id, path, data);
      const now = Date.now();
      updateDevice(device.id, { lastSeen: now });
      if (fails.get(device.id)) console.log(`[poll] ${device.id} answering again`);
      fails.delete(device.id);
      return { data, online: true, stale: false, fetchedAt: now, lastSeen: now };
    }
    error = `agent answered ${res.status}`;
    try {
      const b = (await res.json()) as Partial<ApiError>;
      if (b.error) error += `: ${b.error}`;
    } catch {
      /* non-JSON */
    }
  } catch (e) {
    error = errMsg(e);
  }
  if (path === "/status" && device.agentUrl) {
    const n = (fails.get(device.id) ?? 0) + 1;
    fails.set(device.id, n);
    console.warn(`[poll] ${device.id} status poll failed (${n} in a row${n >= OFFLINE_AFTER_FAILURES ? ", now shown offline" : ""}): ${error}`);
  }
  const c = getCache<T>(device.id, path);
  return { data: c?.data ?? null, online: isOnline(device), stale: !!c, fetchedAt: c?.fetchedAt ?? null, lastSeen: device.lastSeen, error };
}

/** Read the cached value without calling the agent. */
export const cachedOnly = <T>(deviceId: string, path: string): T | null => getCache<T>(deviceId, path)?.data ?? null;

/** Proxy a non-GET call. Throws AgentError (503) when offline; agent error statuses are passed through with their body. */
export async function agentSend<T>(device: DeviceRow, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const res = await agentFetch(device, method, path, body, timeoutMs);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text.slice(0, 300) };
  }
  if (!res.ok) throw new AgentError((json as Partial<ApiError> | null)?.error ?? `agent answered ${res.status}`, res.status, json);
  updateDevice(device.id, { lastSeen: Date.now() });
  fails.delete(device.id);
  return json as T;
}
