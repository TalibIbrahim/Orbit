import type { DeviceRecord, DeviceRole } from "@orbit/shared";
import { deleteDevice, getDevice, toRecord, updateDevice } from "@/lib/server/db";
import { cleanReplicaPaths, summarize } from "@/lib/server/devices";
import { fail, guard, json, readJson } from "@/lib/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = (_req: Request, { params }: Ctx) =>
  guard(async () => {
    const d = getDevice((await params).id);
    return d ? json(summarize(d)) : fail(404, "unknown device");
  });

export const PATCH = (req: Request, { params }: Ctx) =>
  guard(async () => {
    const { id } = await params;
    const cur = getDevice(id);
    if (!cur) return fail(404, "unknown device");
    const b = await readJson<Partial<Pick<DeviceRecord, "name" | "role" | "agentUrl" | "immichLanUrl" | "immichTailscaleUrl" | "replicaPaths">>>(req);
    const patch: Parameters<typeof updateDevice>[1] = {};
    if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim().slice(0, 60);
    // The role lives in the device's agent.json and decides how Syncthing was paired; relabelling it
    // here would only change the hub's view. Re-adding the device reinstalls with the right role.
    if (b.role !== undefined && b.role !== cur.role) {
      if (!(["primary", "standby", "replica"] as DeviceRole[]).includes(b.role)) return fail(400, "invalid role");
      return fail(409, `Changing the role here only changes the hub's label. Remove the device and add it again as a ${b.role === "replica" ? "Replica" : b.role === "primary" ? "Primary" : "Standby"}.`);
    }
    for (const k of ["agentUrl", "immichLanUrl", "immichTailscaleUrl"] as const) {
      const v = b[k];
      if (v === undefined) continue;
      if (v !== null && !/^https?:\/\/[^\s']+$/.test(v)) return fail(400, `invalid ${k}`);
      patch[k] = v ? v.replace(/\/+$/, "") : null;
    }
    if (b.replicaPaths !== undefined) {
      try {
        patch.replicaPaths = cleanReplicaPaths(b.replicaPaths);
      } catch (e) {
        return fail(400, (e as Error).message);
      }
    }
    return json(toRecord(updateDevice(id, patch)!));
  });

export const DELETE = (_req: Request, { params }: Ctx) =>
  guard(async () => {
    const { id } = await params;
    if (!getDevice(id)) return fail(404, "unknown device");
    deleteDevice(id);
    return json({ ok: true });
  });
