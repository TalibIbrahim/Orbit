import type { ApiError, Cached } from "@orbit/shared";

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`.trim();
    try {
      const body = (await res.json()) as Partial<ApiError>;
      if (body?.error) message = body.detail ? `${body.error}: ${body.detail}` : body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** GET a hub API path (e.g. "/api/devices"). Throws Error(ApiError.error) on non-2xx. */
export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  return parse<T>(await fetch(path, { ...init, method: "GET", headers: { accept: "application/json", ...init?.headers } }));
}

/** Send JSON to the hub API. Throws Error(ApiError.error) on non-2xx. */
export async function apiSend<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  return parse<T>(
    await fetch(path, {
      method,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
}

/**
 * GET through the hub's agent proxy: `agentPath` is the agent path without /v1 (e.g. "/metrics?range=24h").
 * Always resolves with Cached<T> for known devices, even when the device is offline.
 */
export function agentGet<T>(deviceId: string, agentPath: string): Promise<Cached<T>> {
  const p = agentPath.startsWith("/") ? agentPath : `/${agentPath}`;
  return apiGet<Cached<T>>(`/api/devices/${encodeURIComponent(deviceId)}/agent${p}`);
}
