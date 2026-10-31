"use client";

import type { IdleRisk, KeepaliveState } from "@orbit/shared";
import { HeartPulse } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { OfflineBadge } from "@/components/offline-badge";
import { ToneBadge } from "@/components/replication/tone-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { apiSend } from "@/lib/api";
import { formatPercent, timeAgo } from "@/lib/format";
import { useAgent } from "@/lib/hooks";

function IdleSummary({ deviceId }: { deviceId: string }) {
  const { data } = useAgent<IdleRisk>(deviceId, "/idle-risk", 5 * 60_000);
  const risk = data?.data;
  if (!risk) return null;
  return (
    <div className="space-y-2 rounded-xl bg-surface-container p-3">
      <div className="flex items-center justify-between gap-2 text-sm font-medium">
        Oracle idle check ({risk.windowDays} d)
        {risk.atRisk ? <ToneBadge tone="danger">At risk</ToneBadge> : <ToneBadge tone="success">Safe</ToneBadge>}
      </div>
      {risk.metrics.map((m) => (
        <div key={m.key} className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">
            {m.label} <span className="text-xs">({m.statistic})</span>
          </span>
          <span className="flex items-center gap-2">
            <span className="tabular-nums">
              {formatPercent(m.value)} / {m.threshold}%
            </span>
            {m.belowThreshold ? <ToneBadge tone="warning">Idle</ToneBadge> : <ToneBadge tone="success">Active</ToneBadge>}
          </span>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Oracle may reclaim the VM only when all three metrics stay under 20%. Coverage {Math.round(risk.coverage * 100)}%.
      </p>
    </div>
  );
}

export function KeepaliveCard({ deviceId }: { deviceId: string }) {
  const { data, loading, refresh } = useAgent<KeepaliveState>(deviceId, "/keepalive", 15_000);
  const [busy, setBusy] = useState(false);
  const ka = data?.data;
  const offline = data ? !data.online : false;

  async function toggle(enabled: boolean) {
    setBusy(true);
    try {
      await apiSend("POST", `/api/devices/${encodeURIComponent(deviceId)}/agent/keepalive`, { enabled });
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change keep-alive");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <HeartPulse className="size-4 text-muted-foreground" />
            Keep-alive
          </span>
          {ka?.supported ? (
            <Switch
              checked={ka.enabled}
              disabled={busy || offline}
              onCheckedChange={(v) => void toggle(v)}
              aria-label="Enable keep-alive"
            />
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data ? <OfflineBadge online={data.online} lastSeen={data.lastSeen} stale={data.stale} className="self-start" /> : null}
        {loading ? (
          <Skeleton className="h-20 rounded-xl" />
        ) : !ka ? (
          <p className="text-sm text-muted-foreground">No keep-alive data yet.</p>
        ) : !ka.supported ? (
          <p className="text-sm text-muted-foreground">Keep-alive is not configured on this device.</p>
        ) : (
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2">
              {ka.running ? <ToneBadge tone="success">Running</ToneBadge> : <ToneBadge tone="muted">Stopped</ToneBadge>}
              {ka.running && ka.pid ? <span className="text-muted-foreground">pid {ka.pid}</span> : null}
              {ka.running && ka.since ? <span className="text-muted-foreground">since {timeAgo(ka.since)}</span> : null}
            </div>
            {ka.command ? <code className="block font-mono text-xs break-all text-muted-foreground">{ka.command}</code> : null}
          </div>
        )}
        <IdleSummary deviceId={deviceId} />
        <p className="text-xs text-muted-foreground">
          Keep-alive runs NeverIdle at lowest priority (nice 19) so Minecraft is unaffected.
        </p>
      </CardContent>
    </Card>
  );
}
