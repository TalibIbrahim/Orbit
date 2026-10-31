import type { AgentConfig } from "./config.ts";
import type { DB } from "./db.ts";
import type { KeepaliveState, SyncthingSummary, SyncthingPairRequest, TailscaleInfo } from "@orbit/shared";

declare const __AGENT_VERSION__: string;
export const AGENT_VERSION: string = typeof __AGENT_VERSION__ === "string" ? __AGENT_VERSION__ : "0.1.0-dev";

// Cross-module interfaces. Implementations:
//   SyncthingApi  -> src/syncthing.ts  (createSyncthing)
//   KeepaliveApi  -> src/keepalive.ts  (createKeepalive)
//   TailscaleApi  -> src/tailscale.ts  (createTailscale)
export interface SyncthingApi {
  available(): Promise<boolean>;
  summary(): Promise<SyncthingSummary>;
  myDeviceId(): Promise<string | null>;
  setFolderPaused(folderId: string, paused: boolean): Promise<void>;
  pair(req: SyncthingPairRequest): Promise<SyncthingSummary>;
}

export interface KeepaliveApi {
  state(): KeepaliveState;
  setEnabled(enabled: boolean): Promise<KeepaliveState>;
  stop(): void; // on shutdown
}

export interface TailscaleApi {
  info(): Promise<TailscaleInfo>; // cached ~60s internally
}

export interface Ctx {
  config: AgentConfig;
  configPath: string;
  db: DB;
  startedAt: number;
  syncthing: SyncthingApi;
  keepalive: KeepaliveApi;
  tailscale: TailscaleApi;
}
