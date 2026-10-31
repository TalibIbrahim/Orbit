import { createHash } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import type { AgentUpdateInfo, EnrollRequest, Platform } from "@orbit/shared";
import { AGENT_VERSION, type Ctx } from "./context.ts";
import { kvSet } from "./db.ts";
import type { Router } from "./http.ts";

const platform: Platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
const isDev = () => !process.argv[1] || process.argv[1].endsWith(".ts");

/**
 * Register this agent with the hub (POST /api/enroll, Bearer = device token).
 * Runs on every start: enrolling is idempotent on the hub, and a persisted "already enrolled" flag
 * would survive a reinstall with a new token (the cause of devices stuck at "Waiting for install").
 * Retries with backoff until it succeeds; every attempt and failure is logged with the HTTP status.
 */
export async function enrollWithHub(ctx: Ctx): Promise<void> {
  const { config, db } = ctx;
  if (!config.hubUrl) {
    console.warn("[enroll] skipped: no hubUrl in agent.json");
    return;
  }
  const tokenHash = createHash("sha256").update(config.token).digest("hex").slice(0, 12);
  const url = `${config.hubUrl}/api/enroll`;

  const attempt = async (n: number): Promise<{ ok: boolean }> => {
    let agentUrl = "?";
    try {
      const h = config.listen.host;
      let host = h && !["0.0.0.0", "::", "::0", ""].includes(h) ? h : null;
      host ??= (await ctx.tailscale.info()).ip ?? os.hostname();
      agentUrl = `http://${host.includes(":") ? `[${host}]` : host}:${config.listen.port}`;
      const body: EnrollRequest = {
        agentUrl,
        hostname: os.hostname(),
        platform,
        agentVersion: AGENT_VERSION,
        syncthingDeviceId: await ctx.syncthing.myDeviceId().catch(() => null),
        deviceId: config.deviceId,
        role: config.role,
      };
      console.log(`[enroll] attempt ${n}: POST ${url} as ${config.deviceId} (${agentUrl}, token ${tokenHash}...)`);
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        let msg = text.slice(0, 300);
        try {
          const j = JSON.parse(text) as { error?: string; detail?: string };
          msg = [j.error, j.detail].filter(Boolean).join(": ") || msg;
        } catch { /* not JSON */ }
        const hint = res.status === 401
          ? " - the hub does not know this token: the device was removed or agent.json is from an older install. Run the install command from Devices -> Add device again."
          : "";
        console.warn(`[enroll] failed: HTTP ${res.status} ${msg}${hint}`);
        kvSet(db, "enroll", { ok: false, at: Date.now(), status: res.status, error: msg, tokenHash, hubUrl: config.hubUrl });
        return { ok: false };
      }
      let paired = "";
      try {
        const j = JSON.parse(text) as { paired?: boolean; pairError?: string };
        paired = j.pairError ? ` (pairing pending: ${j.pairError})` : j.paired ? " (paired)" : "";
      } catch { /* ignore */ }
      kvSet(db, "enroll", { ok: true, at: Date.now(), status: res.status, tokenHash, hubUrl: config.hubUrl, agentUrl });
      console.log(`[enroll] enrolled with hub ${config.hubUrl} as ${agentUrl}${paired}`);
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      console.warn(`[enroll] failed: cannot reach ${url}: ${msg}`);
      kvSet(db, "enroll", { ok: false, at: Date.now(), status: null, error: msg, tokenHash, hubUrl: config.hubUrl });
      return { ok: false };
    }
  };

  // Backoff: 30 s, 1, 2, 4, 8 min, then every 10 min - forever (the hub may come back / the device be re-added).
  let n = 1;
  const ATTEMPT_MS = 45_000;
  const loop = async () => {
    console.log(`[enroll] attempt ${n} starting (hub ${config.hubUrl})`);
    // A step that never settles (Tailscale CLI, Syncthing, DNS) must not silently stall enrolment.
    let timer: NodeJS.Timeout | undefined;
    const r = await Promise.race([
      attempt(n),
      new Promise<{ ok: boolean }>((res) => {
        timer = setTimeout(() => {
          console.warn(`[enroll] attempt ${n} timed out after ${ATTEMPT_MS / 1000} s (resolving the agent address, Syncthing or the hub request hung)`);
          res({ ok: false });
        }, ATTEMPT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (r.ok) return;
    const delay = Math.min(10 * 60_000, 30_000 * 2 ** Math.min(n - 1, 5));
    n++;
    setTimeout(() => void loop(), delay).unref();
  };
  await loop();
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
