import { configPathFromArgv, loadConfig } from "./config.ts";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { kvGet, openDb, pruneOld } from "./db.ts";
import { Router, startServer } from "./http.ts";
import { AGENT_VERSION, type Ctx } from "./context.ts";
import { health } from "./health.ts";

// Module A — system metrics, storage, folder limits
import { startSampler, registerMetricsRoutes, lastSampleTs } from "./metrics.ts";
import { startSizer } from "./sizes.ts";
import { startFolderEnforcer, registerFolderRoutes } from "./folders.ts";
import { createTailscale } from "./tailscale.ts";
// Module B — syncthing, backups, keep-alive, promote, self-update
import { createSyncthing, registerSyncthingRoutes } from "./syncthing.ts";
import { startJobs, registerBackupRoutes } from "./jobs.ts";
import { createKeepalive, registerKeepaliveRoutes } from "./keepalive.ts";
import { registerPromoteRoutes } from "./promote.ts";
import { startUpdater, registerUpdateRoutes, enrollWithHub } from "./updater.ts";

async function main() {
  const configPath = configPathFromArgv();
  const config = loadConfig(configPath);
  const db = openDb(config.dataDir);

  const ctx = { config, configPath, db, startedAt: Date.now() } as Ctx;
  ctx.syncthing = createSyncthing(ctx);
  ctx.keepalive = createKeepalive(ctx);
  ctx.tailscale = createTailscale(ctx);

  const router = new Router();
  router.get("/v1/health", () => health(ctx), { auth: false });
  registerMetricsRoutes(router, ctx);
  registerFolderRoutes(router, ctx);
  registerSyncthingRoutes(router, ctx);
  registerBackupRoutes(router, ctx);
  registerKeepaliveRoutes(router, ctx);
  registerPromoteRoutes(router, ctx);
  registerUpdateRoutes(router, ctx);

  const server = startServer(router, { host: config.listen.host, port: config.listen.port, token: config.token });

  startSampler(ctx);
  startSizer(ctx);
  startFolderEnforcer(ctx);
  startJobs(ctx);
  startUpdater(ctx);
  pruneOld(db, config.retentionDays);
  setInterval(() => pruneOld(db, config.retentionDays), 6 * 3_600_000).unref();

  enrollWithHub(ctx).catch((e) => console.warn("[enroll]", e?.message ?? e));

  console.log(`[orbit-agent] ${AGENT_VERSION} device=${config.deviceId} role=${config.role}`);

  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const heartbeat = async () => {
    try {
      const m = process.memoryUsage();
      const ts = lastSampleTs();
      const st = await ctx.syncthing.summary().then((x) => (x.available ? "ok" : "error"), () => "error");
      const enroll = kvGet<{ ok?: boolean }>(db, "enroll");
      const p99 = loop.count ? Math.round(loop.percentile(99) / 1e6) : 0;
      loop.reset();
      console.log(
        `[heartbeat] up ${Math.round(process.uptime())}s rss=${Math.round(m.rss / 1048576)}MB heap=${Math.round(m.heapUsed / 1048576)}MB ` +
          `lastSample=${ts ? Math.round((Date.now() - ts) / 1000) : "none"}s loopDelayP99=${p99}ms syncthing=${st} ` +
          `enroll=${enroll ? (enroll.ok ? "ok" : "failed") : "none"}`,
      );
    } catch (e) {
      console.warn("[heartbeat]", (e as Error)?.message ?? e);
    }
  };
  setTimeout(() => void heartbeat(), 60_000).unref();
  setInterval(() => void heartbeat(), 600_000).unref();

  const shutdown = () => {
    ctx.keepalive.stop();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[orbit-agent] fatal:", e);
  process.exit(1);
});
