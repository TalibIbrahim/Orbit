import type { HostUpdateStatus } from "@orbit/shared";
import { agentErrMsg, agentSend } from "@/lib/server/agents";
import { hubHostDevice } from "@/lib/server/devices";
import { fail, guard, json, readJson } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const unavailable = (error: string): HostUpdateStatus => ({
  available: false, running: false, current: null, upstream: null, lastRun: null, nextRun: null, error,
});

/** Orbit self-update status, from the agent on the machine the hub runs on (arm-free). */
export const GET = () =>
  guard(async () => {
    const host = hubHostDevice();
    if (!host) return json(unavailable("the hub does not know its own host (ORBIT_LOCAL_AGENT_CONFIG not set)"));
    try {
      return json(await agentSend<HostUpdateStatus>(host, "GET", "/host-update", undefined, 20_000));
    } catch (e) {
      return json(unavailable(agentErrMsg(e)));
    }
  });

/** { action: "check" } fetches from GitHub; { action: "run" } starts the update (the hub restarts during it). */
export const POST = (req: Request) =>
  guard(async () => {
    const { action } = await readJson<{ action?: string }>(req);
    if (action !== "check" && action !== "run") return fail(400, 'action must be "check" or "run"');
    const host = hubHostDevice();
    if (!host) return fail(409, "the hub does not know its own host (ORBIT_LOCAL_AGENT_CONFIG not set)");
    try {
      if (action === "run") console.log("[host-update] update requested from the dashboard");
      return json(await agentSend<HostUpdateStatus>(host, "POST", `/host-update/${action}`, {}, 90_000));
    } catch (e) {
      return fail(502, agentErrMsg(e));
    }
  });
