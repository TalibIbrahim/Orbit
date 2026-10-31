import { errMsg } from "@/lib/server/agents";
import { fail, guard, json } from "@/lib/server/http";
import { immichUsers } from "@/lib/server/immich";
import { getSettings, immichApiKey } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

/** Immich users the configured API key can see (for the Settings -> Immich user filter). */
export const GET = () =>
  guard(async () => {
    const s = getSettings();
    const key = immichApiKey(s);
    if (!s.immich.url || !key) return fail(400, "Immich URL and API key are not set");
    try {
      return json(await immichUsers({ url: s.immich.url, apiKey: key }));
    } catch (e) {
      return fail(502, errMsg(e));
    }
  });
