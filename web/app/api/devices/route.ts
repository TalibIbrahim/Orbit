import type { AddDeviceResponse, AgentStatus, DeviceRole, Platform, SyncthingSummary } from "@orbit/shared";
import { errMsg } from "@/lib/server/agents";
import { insertDevice, listDevices, setCache, toRecord, updateDevice } from "@/lib/server/db";
import { createDevice, installCommands, needsPairing, pairWithPrimary, summarize, uniqueId } from "@/lib/server/devices";
import { fail, guard, json, readJson } from "@/lib/server/http";
import { getSettings, hubUrlFor } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

const ROLES: DeviceRole[] = ["primary", "standby", "replica"];
const PLATFORMS: Platform[] = ["windows", "linux", "darwin"];

export const GET = () => guard(async () => json(listDevices().map((d) => summarize(d))));

async function probe<T>(url: string, token: string, path: string): Promise<T> {
  const res = await fetch(`${url}/v1${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!res.ok) throw new Error(`agent answered ${res.status}`);
  return (await res.json()) as T;
}

export const POST = (req: Request) =>
  guard(async () => {
    const b = await readJson<{ name?: string; role?: DeviceRole; platform?: Platform; agentUrl?: string; token?: string }>(req);
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 60) : "";
    if (!name) return fail(400, "name is required");
    if (!b.role || !ROLES.includes(b.role)) return fail(400, "role must be primary, standby or replica");
    if (b.platform != null && !PLATFORMS.includes(b.platform)) return fail(400, "invalid platform");
    const settings = getSettings();
    const hub = hubUrlFor(req, settings);

    // "Existing agent" mode: register an already-installed agent after verifying it answers.
    if (b.agentUrl || b.token) {
      if (!b.agentUrl || !b.token) return fail(400, "agentUrl and token must be given together");
      if (!/^https?:\/\/[^\s']+$/.test(b.agentUrl)) return fail(400, "invalid agentUrl");
      const agentUrl = b.agentUrl.replace(/\/+$/, "");
      if (listDevices().some((d) => d.token === b.token)) return fail(409, "that token is already registered");
      let status: AgentStatus;
      try {
        status = await probe<AgentStatus>(agentUrl, b.token, "/status");
      } catch (e) {
        return fail(502, "could not verify the agent", errMsg(e));
      }
      const dev = insertDevice({
        id: uniqueId(name), name, role: b.role, token: b.token, agentUrl, enrolled: true, lastSeen: Date.now(),
        platform: status.health?.platform ?? b.platform ?? null, agentVersion: status.health?.agentVersion ?? null,
        pendingPair: needsPairing(b.role),
      });
      setCache(dev.id, "/status", status);
      try {
        const st = await probe<SyncthingSummary>(agentUrl, b.token, "/syncthing");
        if (st.myDeviceId) updateDevice(dev.id, { syncthingDeviceId: st.myDeviceId });
        setCache(dev.id, "/syncthing", st);
      } catch {
        /* syncthing optional */
      }
      if (needsPairing(b.role)) void pairWithPrimary(updateDevice(dev.id, {})!);
      return json<AddDeviceResponse>({ device: toRecord(updateDevice(dev.id, {})!), token: b.token, ...installCommands(hub, b.token) }, 201);
    }

    if (!b.platform) return fail(400, "platform is required");
    const dev = createDevice(name, b.role, b.platform);
    return json<AddDeviceResponse>({ device: toRecord(dev), token: dev.token, ...installCommands(hub, dev.token) }, 201);
  });

