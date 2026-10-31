import { execFile } from "node:child_process";
import type { TailscaleInfo } from "@orbit/shared";
import type { Ctx, TailscaleApi } from "./context.ts";

const NONE: TailscaleInfo = { available: false, online: false, ip: null, dnsName: null };

function run(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, ["status", "--json"], { timeout: 5000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      // `tailscale status` exits non-zero when stopped but may still print JSON
      if (stdout && stdout.trim().startsWith("{")) return resolve(stdout);
      reject(err ?? new Error("no output"));
    });
  });
}

export function createTailscale(_ctx: Ctx): TailscaleApi {
  let cache: { at: number; info: TailscaleInfo } | null = null;
  let inflight: Promise<TailscaleInfo> | null = null;
  const bins = process.platform === "win32" ? ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"] : ["tailscale"];

  async function fetchInfo(): Promise<TailscaleInfo> {
    for (const bin of bins) {
      try {
        const j = JSON.parse(await run(bin)) as {
          BackendState?: string;
          Self?: { TailscaleIPs?: string[]; DNSName?: string; Online?: boolean };
        };
        const self = j.Self;
        return {
          available: true,
          online: j.BackendState === "Running" && self?.Online !== false,
          ip: self?.TailscaleIPs?.find((a) => !a.includes(":")) ?? self?.TailscaleIPs?.[0] ?? null,
          dnsName: self?.DNSName ? self.DNSName.replace(/\.$/, "") : null,
        };
      } catch {
        /* try next */
      }
    }
    return NONE;
  }

  return {
    async info() {
      if (cache && Date.now() - cache.at < 60_000) return cache.info;
      inflight ??= fetchInfo().then((info) => {
        cache = { at: Date.now(), info };
        inflight = null;
        return info;
      });
      return inflight;
    },
  };
}
