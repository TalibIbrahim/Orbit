import type { AgentStatus, ImmichLinks, PromoteStatus } from "@orbit/shared";
import { cachedOnly, isOnline } from "@/lib/server/agents";
import { listDevices } from "@/lib/server/db";
import { primaryHost } from "@/lib/server/devices";
import { getSettings } from "@/lib/server/settings";
import { guard, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const GET = () =>
  guard(async () => {
    const settings = getSettings();
    const armFree = settings.primaryMode === "arm-free";
    const devices = listDevices();
    const primary = (armFree ? primaryHost() : null) ?? devices.find((d) => d.role === "primary");
    const standby = devices.find((d) => d.role === "standby");
    const promote = standby ? cachedOnly<PromoteStatus>(standby.id, "/promote") : null;
    const promoted = promote?.state === "done";

    // arm-free mode: device URL (ORBIT_IMMICH_URL / Devices pencil) -> Settings -> Immich URL ->
    // arm-free's own Tailscale name on port 2283 (Immich binds there).
    let tailscaleUrl = primary?.immichTailscaleUrl ?? null;
    if (!tailscaleUrl && armFree) {
      const dns = primary ? cachedOnly<AgentStatus>(primary.id, "/status")?.tailscale?.dnsName?.replace(/\.$/, "") : null;
      tailscaleUrl = settings.immich.url || (dns ? `http://${dns}:2283` : null);
    }
    return json<ImmichLinks>({
      lanUrl: primary?.immichLanUrl ?? null,
      tailscaleUrl,
      standbyUrl: promoted ? (promote?.immichUrl ?? null) : null,
      primaryOnline: primary ? isOnline(primary) : false,
      promoted,
      primaryMode: settings.primaryMode,
    });
  });
