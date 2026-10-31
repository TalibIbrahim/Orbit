import type { HubSettings } from "@orbit/shared";
import { guard, json, readJson } from "@/lib/server/http";
import { getSettings, hubUrlFor, maskSettings, putSettings } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

const view = (req: Request) => {
  const s = getSettings();
  return json(maskSettings({ ...s, hubUrl: hubUrlFor(req, s) }));
};

export const GET = (req: Request) => guard(async () => view(req));

export const PUT = (req: Request) =>
  guard(async () => {
    putSettings(await readJson<Partial<HubSettings>>(req));
    return view(req);
  });
