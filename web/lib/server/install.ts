import { readFileSync } from "node:fs";
import path from "node:path";
import { getDeviceByToken } from "./db";
import { fail, guard } from "./http";
import { installTemplatesDir } from "./bundle";
import { getSettings, hubUrlFor } from "./settings";

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** Values are substituted inside single-quoted strings: strip control chars and escape quotes per shell. */
const esc = (v: string, kind: "sh" | "ps") =>
  v.replace(/[\r\n\0]/g, " ").replace(/'/g, kind === "sh" ? "'\\''" : "''");

export function serveInstall(req: Request, token: string, kind: "sh" | "ps"): Promise<Response> {
  return guard(async () => {
    const d = getDeviceByToken(token);
    if (!d) return fail(404, "unknown install token");
    if (d.enrolled) return fail(410, "this device is already enrolled");
    const s = getSettings();
    let tpl: string;
    try {
      tpl = readFileSync(path.join(installTemplatesDir(), kind === "sh" ? "linux.sh.tmpl" : "windows.ps1.tmpl"), "utf8");
    } catch {
      return fail(500, "install template not found");
    }
    const vars: Record<string, string> = {
      __HUB_URL__: hubUrlFor(req, s), __TOKEN__: d.token, __DEVICE_ID__: d.id, __DEVICE_NAME__: d.name,
      __ROLE__: d.role, __TS_AUTHKEY__: s.tailscaleAuthKey ?? "",
    };
    const out = tpl.replace(/__[A-Z_]+__/g, (k) => (k in vars ? esc(vars[k], kind) : k));
    return text(out);
  });
}
