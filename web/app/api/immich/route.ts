import type { ImmichLinks, PromoteStatus } from "@orbit/shared";
import { cachedOnly } from "@/lib/server/agents";
import { listDevices } from "@/lib/server/db";
import { ONLINE_MS } from "@/lib/server/devices";
import { guard, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const GET = () =>
  guard(async () => {
    const devices = listDevices();
    const primary = devices.find((d) => d.role === "primary");
    const standby = devices.find((d) => d.role === "standby");
    const promote = standby ? cachedOnly<PromoteStatus>(standby.id, "/promote") : null;
    const promoted = promote?.state === "done";
    return json<ImmichLinks>({
      lanUrl: primary?.immichLanUrl ?? null,
      tailscaleUrl: primary?.immichTailscaleUrl ?? null,
      standbyUrl: promoted ? (promote?.immichUrl ?? null) : null,
      primaryOnline: !!primary?.lastSeen && Date.now() - primary.lastSeen < ONLINE_MS,
      promoted,
    });
  });
