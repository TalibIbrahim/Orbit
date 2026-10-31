import { fail, guard, json, readJson } from "@/lib/server/http";
import { syncControlState, updateSyncControl } from "@/lib/server/sync-control";

export const dynamic = "force-dynamic";

export const GET = () => guard(async () => json(syncControlState()));

/** { paused?: boolean; schedule?: SyncSchedule } - "Pause sync" / "Resume sync" and the sync schedule. */
export const POST = (req: Request) =>
  guard(async () => {
    const err = await updateSyncControl(await readJson<{ paused?: unknown; schedule?: unknown }>(req));
    return err ? fail(400, err) : json(syncControlState());
  });
