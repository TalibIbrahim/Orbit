import type { EnrollRequest, EnrollResponse } from "@orbit/shared";
import { getDeviceByToken, toRecord, updateDevice } from "@/lib/server/db";
import { needsPairing, pairWithPrimary } from "@/lib/server/devices";
import { bearer, fail, guard, json, readJson } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const POST = (req: Request) =>
  guard(async () => {
    const token = bearer(req);
    const dev = token ? getDeviceByToken(token) : null;
    if (!dev) return fail(401, "invalid device token");
    const b = await readJson<Partial<EnrollRequest>>(req);
    if (typeof b.agentUrl !== "string" || !/^https?:\/\/[^\s']+$/.test(b.agentUrl)) return fail(400, "agentUrl is required");

    let d = updateDevice(dev.id, {
      agentUrl: b.agentUrl.replace(/\/+$/, ""),
      platform: b.platform ?? dev.platform,
      syncthingDeviceId: b.syncthingDeviceId ?? dev.syncthingDeviceId,
      agentVersion: b.agentVersion ?? dev.agentVersion,
      enrolled: true,
      lastSeen: Date.now(),
      pendingPair: needsPairing(dev.role),
    })!;

    let pairError: string | undefined;
    if (needsPairing(d.role)) {
      pairError = (await pairWithPrimary(d)) ?? undefined;
      d = updateDevice(d.id, {})!;
    }
    return json<EnrollResponse>({ device: toRecord(d), paired: needsPairing(d.role) ? !pairError : false, ...(pairError ? { pairError } : {}) });
  });
