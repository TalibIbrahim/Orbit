import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { DeviceRole, JobKind, ServiceCategory } from "@orbit/shared";
import { DEFAULT_AGENT_PORT } from "@orbit/shared";

// Any workload the user wants tracked; add entries to agent.json, no code changes needed.
export interface ServiceConfig {
  name: string; // "immich", "nextcloud", "game-server", ...
  category: ServiceCategory; // "photos" | "services" (default "services")
  containers: string[]; // Docker container name prefixes, e.g. ["immich_"]
  systemdUnits: string[]; // Linux systemd units, e.g. ["nextcloud-cron.service"]
  paths: string[]; // directories whose size counts as this service's disk usage
}

export interface JobConfig {
  id: string; // "immich-db", "restic", "app-backup"
  name: string;
  kind: JobKind;
  schedule?: string; // cron expression (croner syntax), omitted = manual only
  command: string; // executable, e.g. "/usr/local/bin/backup-app.sh" or "powershell.exe"
  args?: string[];
  cwd?: string;
  env?: Record<string, string>; // e.g. RESTIC_REPOSITORY / RESTIC_PASSWORD_FILE for kind=restic
  outputDir?: string; // where artifacts land; size + newest file are reported
  retention?: string; // human description shown in the UI
  timeoutMin?: number; // default 120
}

export interface AgentConfig {
  deviceId: string;
  name: string;
  role: DeviceRole;
  token: string; // Bearer token the hub uses
  listen: { host: string; port: number }; // bind to the Tailscale IP in production
  hubUrl?: string; // for enroll + self-update
  dataDir: string; // SQLite + logs
  sampleIntervalSec: number; // 60
  sizeIntervalMin: number; // folder/service size measuring cadence, 10
  retentionDays: number; // 35
  networkBandwidthMbps?: number; // idle-risk denominator; default 1000 * cpuCount on Oracle A1
  storageQuotaGB?: number; // e.g. 200 on Oracle Always Free
  docker?: { socketPath?: string }; // default /var/run/docker.sock or //./pipe/docker_engine
  services: ServiceConfig[];
  syncthing?: { url?: string; apiKey?: string; configPath?: string }; // apiKey read from config.xml if omitted
  jobs: JobConfig[];
  keepalive?: { command: string; args?: string[]; defaultEnabled?: boolean }; // defaultEnabled: on until the user turns it off
  promote?: { script: string; args?: string[]; immichUrl: string; dumpDir?: string };
  autoUpdate: boolean; // poll hub for new agent bundles
}

function defaultConfigPath(): string {
  if (process.platform === "win32") return join(process.env.ProgramData ?? "C:\\ProgramData", "Orbit", "agent.json");
  return "/etc/orbit/agent.json";
}

function defaultDataDir(): string {
  if (process.platform === "win32") return join(process.env.ProgramData ?? "C:\\ProgramData", "Orbit", "data");
  return "/var/lib/orbit";
}

export function configPathFromArgv(argv = process.argv): string {
  const i = argv.indexOf("--config");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return process.env.ORBIT_AGENT_CONFIG ?? defaultConfigPath();
}

export function loadConfig(path = configPathFromArgv()): AgentConfig {
  if (!existsSync(path)) throw new Error(`Agent config not found at ${path}`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentConfig>;
  if (!raw.token || raw.token.length < 16) throw new Error("config.token missing or too short");
  if (!raw.deviceId) throw new Error("config.deviceId missing");
  return {
    deviceId: raw.deviceId,
    name: raw.name ?? os.hostname(),
    role: raw.role ?? "replica",
    token: raw.token,
    listen: { host: raw.listen?.host ?? "0.0.0.0", port: raw.listen?.port ?? DEFAULT_AGENT_PORT },
    hubUrl: raw.hubUrl?.replace(/\/$/, ""),
    dataDir: raw.dataDir ?? defaultDataDir(),
    sampleIntervalSec: raw.sampleIntervalSec ?? 60,
    sizeIntervalMin: raw.sizeIntervalMin ?? 10,
    retentionDays: Math.max(raw.retentionDays ?? 35, 31),
    networkBandwidthMbps: raw.networkBandwidthMbps,
    storageQuotaGB: raw.storageQuotaGB,
    docker: raw.docker,
    services: (raw.services ?? []).map((s) => ({
      name: s.name,
      category: s.category === "photos" ? "photos" : "services",
      containers: s.containers ?? [],
      systemdUnits: s.systemdUnits ?? [],
      paths: s.paths ?? [],
    })),
    syncthing: raw.syncthing,
    jobs: raw.jobs ?? [],
    keepalive: raw.keepalive,
    promote: raw.promote,
    autoUpdate: raw.autoUpdate ?? true,
  };
}
