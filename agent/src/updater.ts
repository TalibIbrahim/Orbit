import { createHash } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import type { AgentUpdateInfo, EnrollRequest, Platform } from "@orbit/shared";
import { AGENT_VERSION, type Ctx } from "./context.ts";
import { kvGet, kvSet } from "./db.ts";
import type { Router } from "./http.ts";

const platform: Platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
const isDev = () => !process.argv[1] || process.argv[1].endsWith(".ts");

export async function enrollWithHub(ctx: Ctx): Promise<void> {
  const { config, db } = ctx;
  if (!config.hubUrl || kvGet<boolean>(db, "enrolled")) return;

  const attempt = async (): Promise<boolean> => {
    try {
      const h = config.listen.host;
      let host = h && !["0.0.0.0", "::", "::0", ""].includes(h) ? h : null;
      host ??= (await ctx.tailscale.info()).ip ?? os.hostname();
      const body: EnrollRequest = {
        agentUrl: `http://${host.includes(":") ? `[${host}]` : host}:${config.listen.port}`,
        hostname: os.hostname(),
        platform,
        agentVersion: AGENT_VERSION,
        syncthingDeviceId: await ctx.syncthing.myDeviceId(),
      };
      const res = await fetch(`${config.hubUrl}/api/enroll`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`hub answered ${res.status}`);
      kvSet(db, "enrolled", true);
      console.log("[enroll] enrolled with hub", body.agentUrl);
      return true;
    } catch (e) {
      console.warn("[enroll] failed:", (e as Error).message);
      return false;
    }
  };

  if (await attempt()) return;
  let tries = 1;
  const timer = setInterval(async () => {
    tries++;
    if ((await attempt()) || tries >= 30) clearInterval(timer);
  }, 120_000);
  timer.unref();
}

async function checkUpdate(ctx: Ctx): Promise<{ updating: boolean; from: string; to: string | null }> {
  const { hubUrl } = ctx.config;
  const none = { updating: false, from: AGENT_VERSION, to: null as string | null };
  if (!hubUrl) return none;
  try {
    const res = await fetch(`${hubUrl}/api/agent/version`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`version check ${res.status}`);
    const info = (await res.json()) as AgentUpdateInfo;
    if (!info?.version || info.version === AGENT_VERSION) return { ...none, to: info?.version ?? null };
    if (isDev()) {
      console.log(`[update] ${info.version} available, skipping in dev mode`);
      return { ...none, to: info.version };
    }
    const dl = await fetch(`${hubUrl}${info.url}`, { signal: AbortSignal.timeout(120_000) });
    if (!dl.ok) throw new Error(`download ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    const sum = createHash("sha256").update(buf).digest("hex");
    if (sum.toLowerCase() !== info.sha256.toLowerCase()) throw new Error("sha256 mismatch, update rejected");

    const target = process.argv[1];
    const tmp = `${target}.new`;
    writeFileSync(tmp, buf);
    if (process.platform === "win32") {
      rmSync(`${target}.old`, { force: true });
      renameSync(target, `${target}.old`);
    }
    renameSync(tmp, target);
    console.log(`[update] ${AGENT_VERSION} -> ${info.version}, restarting`);
    setTimeout(() => process.exit(0), 500); // let the HTTP response flush; service manager restarts us
    return { updating: true, from: AGENT_VERSION, to: info.version };
  } catch (e) {
    console.warn("[update] failed:", (e as Error).message);
    return none;
  }
}

export function startUpdater(ctx: Ctx): void {
  if (!ctx.config.autoUpdate || !ctx.config.hubUrl) return;
  setTimeout(() => void checkUpdate(ctx), 120_000).unref();
  setInterval(() => void checkUpdate(ctx), 6 * 3_600_000).unref();
}

export function registerUpdateRoutes(router: Router, ctx: Ctx): void {
  router.post("/v1/update", () => checkUpdate(ctx));
}
