import type { ApiError, Cached } from "@orbit/shared";
import { type DeviceRow, getCache, setCache, updateDevice } from "./db";

const TIMEOUT_MS = 8000;

export class AgentError extends Error {
  constructor(message: string, public status = 503, public body?: unknown) {
    super(message);
  }
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function agentFetch(device: DeviceRow, method: string, path: string, body?: unknown): Promise<Response> {
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    throw new AgentError(`agent unreachable: ${errMsg(e)}`);
  }
}

/** Fetch an agent GET path; cache on success, fall back to cache (stale) on failure. Never throws. */
export async function cachedGet<T>(device: DeviceRow, path: string): Promise<Cached<T>> {
  let error: string;
  try {
    const res = await agentFetch(device, "GET", path);
    if (res.ok) {
      const data = (await res.json()) as T;
      setCache(device.id, path, data);
      const now = Date.now();
      updateDevice(device.id, { lastSeen: now });
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
  const c = getCache<T>(device.id, path);
  return { data: c?.data ?? null, online: false, stale: !!c, fetchedAt: c?.fetchedAt ?? null, lastSeen: device.lastSeen, error };
}

/** Read the cached value without calling the agent. */
export const cachedOnly = <T>(deviceId: string, path: string): T | null => getCache<T>(deviceId, path)?.data ?? null;

/** Proxy a non-GET call. Throws AgentError (503) when offline; agent error statuses are passed through with their body. */
export async function agentSend<T>(device: DeviceRow, method: string, path: string, body?: unknown): Promise<T> {
  const res = await agentFetch(device, method, path, body);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text.slice(0, 300) };
  }
  if (!res.ok) throw new AgentError((json as Partial<ApiError> | null)?.error ?? `agent answered ${res.status}`, res.status, json);
  updateDevice(device.id, { lastSeen: Date.now() });
  return json as T;
}
