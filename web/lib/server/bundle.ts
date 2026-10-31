import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentUpdateInfo } from "@orbit/shared";

export const agentDistDir = () => path.resolve(/*turbopackIgnore: true*/ process.env.ORBIT_AGENT_DIST ?? path.join(process.cwd(), "..", "agent", "dist"));
export const installTemplatesDir = () =>
  path.resolve(/*turbopackIgnore: true*/ process.env.ORBIT_INSTALL_TEMPLATES ?? path.join(process.cwd(), "..", "deploy", "install"));

/** Version info of the bundled agent, or null when the bundle has not been built. */
export function bundleInfo(): AgentUpdateInfo | null {
  try {
    const f = path.join(agentDistDir(), "version.json");
    if (!existsSync(f)) return null;
    const v = JSON.parse(readFileSync(f, "utf8")) as { version: string; sha256: string };
    return { version: v.version, sha256: v.sha256, url: "/agent/orbit-agent.mjs" };
  } catch {
    return null;
  }
}
