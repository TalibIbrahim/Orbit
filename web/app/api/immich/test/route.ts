import { errMsg } from "@/lib/server/agents";
import { guard, json, readJson } from "@/lib/server/http";
import { immichMe, immichVersion } from "@/lib/server/immich";
import { getSettings, immichApiKey, MASK } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

/**
 * Test an Immich URL + API key without saving. A masked key ("••••") means "use the stored key".
 * The key is never echoed back.
 */
export const POST = (req: Request) =>
  guard(async () => {
    const b = await readJson<{ url?: string; apiKey?: string }>(req);
    const s = getSettings();
    const url = (typeof b.url === "string" && b.url.trim() ? b.url.trim() : s.immich.url).replace(/\/+$/, "").replace(/\/api$/, "");
    const apiKey = typeof b.apiKey === "string" && b.apiKey.trim() && b.apiKey !== MASK ? b.apiKey.trim() : immichApiKey(s);
    if (!/^https?:\/\/[^\s']+$/.test(url)) return json({ ok: false, error: "Enter the Immich URL, e.g. http://arm-free.<tailnet>.ts.net:2283" });
    try {
      const version = await immichVersion({ url, apiKey: apiKey ?? "" });
      if (!apiKey) return json({ ok: false, version, error: "Immich answers, but no API key is set" });
      const me = await immichMe({ url, apiKey });
      return json({ ok: true, version, user: me.name || me.email });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  });
