import type { EnrollRequest, EnrollResponse, RejectedEnroll } from "@orbit/shared";
import { getDeviceByToken, toRecord, updateDevice } from "@/lib/server/db";
import { needsPairing, pairWithPrimary, primaryHost } from "@/lib/server/devices";
import { bearer, fail, guard, json, readJson } from "@/lib/server/http";

export const dynamic = "force-dynamic";

// Recent attempts with an unknown token (agent still using an old agent.json). In memory only:
// they are diagnostics for the Add device wizard, not state.
const g = globalThis as unknown as { __orbitRejected?: RejectedEnroll[] };
const KEEP_MS = 30 * 60_000;
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : null);

function remember(r: RejectedEnroll): void {
  const now = Date.now();
  const list = (g.__orbitRejected ?? []).filter((x) => now - x.at < KEEP_MS && !(x.hostname === r.hostname && x.agentUrl === r.agentUrl));
  list.unshift(r);
  g.__orbitRejected = list.slice(0, 20);
}

export const GET = () =>
  guard(async () => {
    const now = Date.now();
    return json({ rejected: (g.__orbitRejected ?? []).filter((x) => now - x.at < KEEP_MS) });
  });

export const POST = (req: Request) =>
  guard(async () => {
    const token = bearer(req);
    const b = await readJson<Partial<EnrollRequest>>(req).catch(() => ({}) as Partial<EnrollRequest>);
    const dev = token ? getDeviceByToken(token) : null;
    if (!dev) {
      const reason = token ? "unknown device token (device removed from the hub, or agent.json is from an older install)" : "missing Bearer token";
      remember({ at: Date.now(), hostname: str(b.hostname) ?? "?", deviceId: str(b.deviceId), agentUrl: str(b.agentUrl), reason });
      console.warn(`[enroll] rejected ${str(b.hostname) ?? "?"} (agent.json deviceId ${str(b.deviceId) ?? "?"}, ${str(b.agentUrl) ?? "?"}): ${reason}`);
      return fail(401, reason);
    }
    const now = Date.now();
    if (typeof b.agentUrl !== "string" || !/^https?:\/\/[^\s']+$/.test(b.agentUrl)) {
      const msg = `invalid agentUrl ${JSON.stringify(b.agentUrl ?? null)}`;
      updateDevice(dev.id, { enrollError: msg, enrollAttemptAt: now });
      console.warn(`[enroll] ${dev.id}: ${msg}`);
      return fail(400, msg);
    }
    if (b.deviceId && b.deviceId !== dev.id)
      console.warn(`[enroll] ${dev.id}: agent.json says deviceId "${b.deviceId}"; the token identifies "${dev.id}", using that`);

    let d = updateDevice(dev.id, {
      agentUrl: b.agentUrl.replace(/\/+$/, ""),
      platform: b.platform ?? dev.platform,
      syncthingDeviceId: b.syncthingDeviceId ?? dev.syncthingDeviceId,
      agentVersion: b.agentVersion ?? dev.agentVersion,
      enrolled: true,
      lastSeen: now,
      enrollError: null,
      enrollAttemptAt: now,
      pendingPair: needsPairing(dev.role) && primaryHost()?.id !== dev.id,
    })!;
    console.log(`[enroll] ${d.id} enrolled from ${d.agentUrl} (agent ${b.agentVersion ?? "?"}, role ${b.role ?? "?"})`);

    let pairError: string | undefined;
    if (d.pendingPair) {
      pairError = (await pairWithPrimary(d)) ?? undefined;
      if (pairError) console.warn(`[enroll] ${d.id}: pairing pending: ${pairError}`);
      else console.log(`[enroll] ${d.id}: paired with ${primaryHost()?.id ?? "primary"}`);
      d = updateDevice(d.id, {})!;
    }
    return json<EnrollResponse>({ device: toRecord(d), paired: needsPairing(d.role) ? !pairError : false, ...(pairError ? { pairError } : {}) });
  });
