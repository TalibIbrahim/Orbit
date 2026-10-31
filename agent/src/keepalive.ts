import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import type { KeepaliveState } from "@orbit/shared";
import type { Ctx, KeepaliveApi } from "./context.ts";
import { kvGet, kvSet } from "./db.ts";
import { HttpError, type Router } from "./http.ts";

const KV = "keepalive.enabled";
const BACKOFF_MS = 30_000;

export function createKeepalive(ctx: Ctx): KeepaliveApi {
  const cfg = ctx.config.keepalive;
  let enabled = false;
  let child: ChildProcess | null = null;
  let since: number | null = null;
  let restartTimer: NodeJS.Timeout | null = null;

  const state = (): KeepaliveState => ({
    supported: !!cfg,
    enabled,
    recommended: ctx.config.role === "standby",
    running: !!child && child.exitCode === null && child.pid !== undefined,
    pid: child?.pid ?? null,
    since: child ? since : null,
    command: cfg ? [cfg.command, ...(cfg.args ?? [])].join(" ") : null,
  });

  function start() {
    if (!cfg || child) return;
    const c = spawn(cfg.command, cfg.args ?? [], { stdio: "ignore", detached: false, shell: false, windowsHide: true });
    child = c;
    since = Date.now();
    c.on("error", (e) => console.warn("[keepalive] spawn error:", e.message));
    c.on("exit", (code) => {
      if (child !== c) return;
      child = null;
      since = null;
      console.warn(`[keepalive] exited code=${code}`);
      if (enabled) restartTimer = setTimeout(() => { restartTimer = null; if (enabled) start(); }, BACKOFF_MS);
      restartTimer?.unref();
    });
    if (c.pid) {
      try { os.setPriority(c.pid, 19); } catch { /* ignore */ }
      console.log(`[keepalive] started pid=${c.pid}`);
    }
  }

  function stop() {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    const c = child;
    child = null;
    since = null;
    if (c) {
      try { c.kill(); } catch { /* ignore */ }
    }
  }

  if (cfg) {
    const saved = kvGet<boolean>(ctx.db, KV);
    if (saved === true || (saved == null && cfg.defaultEnabled === true)) {
      enabled = true;
      if (saved == null) kvSet(ctx.db, KV, true);
      start();
    }
  }

  return {
    state,
    async setEnabled(on) {
      if (!cfg) throw new HttpError(400, "keepalive not configured on this device");
      enabled = on;
      kvSet(ctx.db, KV, on);
      if (on) start();
      else stop();
      return state();
    },
    stop,
  };
}

export function registerKeepaliveRoutes(router: Router, ctx: Ctx): void {
  router.get("/v1/keepalive", () => ctx.keepalive.state());
  router.post("/v1/keepalive", (req) => {
    const b = req.body as { enabled?: unknown } | undefined;
    if (!b || typeof b.enabled !== "boolean") throw new HttpError(400, "body must be { enabled: boolean }");
    return ctx.keepalive.setEnabled(b.enabled);
  });
}
