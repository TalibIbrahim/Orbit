"use client";

import type { Cached, DeviceRole, DeviceSummary, HubSettings, PrimaryMode } from "@orbit/shared";
import { agentGet, apiGet } from "@/lib/api";
import { usePoll } from "@/lib/use-poll";

/** All devices known to the hub (last-known status included, never throws for offline devices). */
export function useDevices(intervalMs = 30_000) {
  return usePoll(() => apiGet<DeviceSummary[]>("/api/devices"), intervalMs);
}

/** First device with the given role, e.g. "standby" = arm-free, "primary" = the PC. */
export function pickRole(devices: DeviceSummary[] | undefined, role: DeviceRole): DeviceSummary | undefined {
  return devices?.find((d) => d.role === role);
}

/** Poll an agent endpoint through the hub proxy. Pass deviceId = undefined to idle until a device is chosen. */
export function useAgent<T>(deviceId: string | undefined, agentPath: string, intervalMs = 60_000) {
  return usePoll<Cached<T> | null>(
    () => (deviceId ? agentGet<T>(deviceId, agentPath) : Promise.resolve(null)),
    intervalMs,
    [deviceId, agentPath],
  );
}

/** The hub's primary mode (null until loaded). */
export function usePrimaryMode(): { mode: PrimaryMode | null; loading: boolean } {
  const { data, loading } = usePoll(() => apiGet<HubSettings>("/api/settings"), 5 * 60_000);
  return { mode: data?.primaryMode ?? null, loading };
}

/** The Oracle / arm-free device: standby in device mode, primary in arm-free mode. */
export function pickHost(devices: DeviceSummary[] | undefined, mode: PrimaryMode | null): DeviceSummary | undefined {
  return pickRole(devices, mode === "arm-free" ? "primary" : "standby");
}
