"use client";

import type { BackupVerifyResponse, Cached, DeviceRole, DeviceSummary, HubSettings, PrimaryMode } from "@orbit/shared";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { agentGet, apiGet, apiSend } from "@/lib/api";
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

/** Phone backup verification status. Polls every 5 s while a run is active, else every 60 s. */
export function useBackupVerify() {
  const [running, setRunning] = useState(false);
  const poll = usePoll(
    async () => {
      const res = await apiGet<BackupVerifyResponse>("/api/backup-verify");
      setRunning(res.running);
      return res;
    },
    running ? 5_000 : 60_000,
  );
  const [starting, setStarting] = useState(false);
  const { refresh } = poll;
  const verifyNow = useCallback(async () => {
    setStarting(true);
    try {
      const r = await apiSend<{ started: boolean }>("POST", "/api/backup-verify/run");
      if (!r.started) toast.info("A verification is already running");
      setRunning(true);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start verification");
    } finally {
      setStarting(false);
    }
  }, [refresh]);
  return { ...poll, verifyNow, busy: starting || (poll.data?.running ?? false) };
}
