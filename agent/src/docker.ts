import http from "node:http";
import type { ContainerState, ContainerStat } from "@orbit/shared";
import type { AgentConfig } from "./config.ts";

// Minimal Docker Engine API client over unix socket / Windows named pipe. Fails soft.

export interface DockerContainer {
  id: string;
  name: string; // without leading "/"
  image: string;
  state: ContainerState;
}

export interface DockerSample {
  available: boolean;
  containers: ContainerStat[]; // service is always null here; metrics.ts maps services
}

const STATES = new Set<ContainerState>(["running", "exited", "restarting", "paused", "created", "dead"]);

function socketPath(config: AgentConfig): string {
  return config.docker?.socketPath ?? (process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock");
}

function dockerGet<T>(config: AgentConfig, path: string, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socketPath(config), path, method: "GET", timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 300) return reject(new Error(`docker ${res.statusCode}: ${text.slice(0, 200)}`));
        try {
          resolve(JSON.parse(text) as T);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("docker request timed out")));
    req.on("error", reject);
    req.end();
  });
}

export async function listContainers(config: AgentConfig): Promise<DockerContainer[]> {
  const raw = await dockerGet<{ Id: string; Names?: string[]; Image: string; State: string }[]>(config, "/containers/json?all=1");
  return raw.map((c) => ({
    id: c.Id,
    name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ""),
    image: c.Image,
    state: STATES.has(c.State as ContainerState) ? (c.State as ContainerState) : "unknown",
  }));
}

interface RawStats {
  cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; stats?: Record<string, number> };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
}

export interface RawContainerStats {
  cpuUsageNs: number;
  cpuPctOfMachineInstant: number | null; // standard docker formula (engine's own 1s window), if available
  memUsed: number;
  rx: number; // cumulative
  tx: number;
}

export async function containerStats(config: AgentConfig, id: string, hostCpus: number): Promise<RawContainerStats> {
  const s = await dockerGet<RawStats>(config, `/containers/${id}/stats?stream=false&one-shot=true`, 10_000);
  const usage = s.cpu_stats?.cpu_usage?.total_usage ?? 0;
  const preUsage = s.precpu_stats?.cpu_usage?.total_usage ?? 0;
  const sys = s.cpu_stats?.system_cpu_usage ?? 0;
  const preSys = s.precpu_stats?.system_cpu_usage ?? 0;
  let instant: number | null = null;
  if (preUsage > 0 && sys > preSys && usage >= preUsage) {
    const online = s.cpu_stats?.online_cpus ?? hostCpus;
    instant = (((usage - preUsage) / (sys - preSys)) * online * 100) / hostCpus;
  }
  const st = s.memory_stats?.stats ?? {};
  const cache = st.inactive_file ?? st.total_inactive_file ?? st.cache ?? 0;
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(s.networks ?? {})) {
    rx += n.rx_bytes ?? 0;
    tx += n.tx_bytes ?? 0;
  }
  return { cpuUsageNs: usage, cpuPctOfMachineInstant: instant, memUsed: Math.max(0, (s.memory_stats?.usage ?? 0) - cache), rx, tx };
}

interface Prev {
  ts: number;
  usage: number;
  rx: number;
  tx: number;
}
const prev = new Map<string, Prev>();

const clamp = (n: number, max = 100) => (Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0);

// CPU is averaged over the wall-clock time since the previous call (one-shot stats have no usable precpu window);
// the first call falls back to the engine's own delta.
export async function sampleDocker(config: AgentConfig, hostCpus: number): Promise<DockerSample> {
  let list: DockerContainer[];
  try {
    list = await listContainers(config);
  } catch {
    prev.clear();
    return { available: false, containers: [] };
  }
  const now = Date.now();
  const out: ContainerStat[] = [];
  const running = list.filter((c) => c.state === "running" || c.state === "restarting");
  const results = new Map<string, RawContainerStats>();
  for (let i = 0; i < running.length; i += 4) {
    await Promise.all(
      running.slice(i, i + 4).map(async (c) => {
        try {
          results.set(c.id, await containerStats(config, c.id, hostCpus));
        } catch {
          /* container may have just exited */
        }
      }),
    );
  }
  for (const c of list) {
    const r = results.get(c.id);
    let cpu = 0, netRx = 0, netTx = 0, memUsed = 0;
    if (r) {
      memUsed = r.memUsed;
      const p = prev.get(c.id);
      if (p && now > p.ts) {
        const dt = (now - p.ts) / 1000;
        cpu = clamp(((r.cpuUsageNs - p.usage) / (dt * 1e9) / hostCpus) * 100);
        netRx = Math.max(0, (r.rx - p.rx) / dt);
        netTx = Math.max(0, (r.tx - p.tx) / dt);
      } else if (r.cpuPctOfMachineInstant != null) {
        cpu = clamp(r.cpuPctOfMachineInstant);
      }
      prev.set(c.id, { ts: now, usage: r.cpuUsageNs, rx: r.rx, tx: r.tx });
    }
    out.push({ id: c.id, name: c.name, image: c.image, state: c.state, service: null, cpu, memUsed, netRx, netTx });
  }
  const ids = new Set(list.map((c) => c.id));
  for (const k of prev.keys()) if (!ids.has(k)) prev.delete(k);
  return { available: true, containers: out };
}
