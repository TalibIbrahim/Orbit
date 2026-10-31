import os from "node:os";
import { AGENT_VERSION, type Ctx } from "./context.ts";
import type { AgentHealth, Platform } from "@orbit/shared";
import { AGENT_API_VERSION } from "@orbit/shared";

export function health(ctx: Ctx): AgentHealth {
  return {
    apiVersion: AGENT_API_VERSION,
    agentVersion: AGENT_VERSION,
    deviceId: ctx.config.deviceId,
    name: ctx.config.name,
    role: ctx.config.role,
    hostname: os.hostname(),
    platform: (process.platform === "win32" ? "windows" : process.platform) as Platform,
    arch: process.arch,
    uptimeSec: Math.round(os.uptime()),
    startedAt: ctx.startedAt,
  };
}
