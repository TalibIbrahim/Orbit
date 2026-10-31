"use client";

import { Cpu, HardDrive, MemoryStick } from "lucide-react";
import type { DeviceSummary, IdleRisk, StorageBreakdown } from "@orbit/shared";
import { OfflineBadge } from "@/components/offline-badge";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { IdleVerdictPill } from "@/components/usage/idle-risk-card";
import { StorageBar, storageSegments } from "@/components/usage/storage-quota-card";
import { formatBytes, formatPercent } from "@/lib/format";

export function DeviceTile({
  device,
  idle,
  storage,
}: {
  device: DeviceSummary;
  idle?: IdleRisk | null;
  storage?: StorageBreakdown | null;
}) {
  const s = device.status;
  const memPct = s && s.memTotal > 0 ? (s.memUsed / s.memTotal) * 100 : null;
  const disk = s?.primaryDisk;
  const diskPct = disk && disk.total > 0 ? (disk.used / disk.total) * 100 : null;
  return (
    <Card>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`size-2.5 rounded-full ${device.online ? "bg-success" : "bg-muted-foreground/50"}`}
            aria-label={device.online ? "online" : "offline"}
          />
          <h2 className="text-base font-medium">{device.name}</h2>
          <Badge variant="secondary">{device.role}</Badge>
          <OfflineBadge online={device.online} lastSeen={device.lastSeen} className="ml-auto" />
        </div>
        {s ? (
          <div className="grid grid-cols-3 gap-2">
            <StatCard label="CPU" icon={Cpu} value={formatPercent(s.cpu)} progress={s.cpu} className="bg-muted/40" />
            <StatCard
              label="RAM"
              icon={MemoryStick}
              value={formatPercent(memPct)}
              progress={memPct ?? undefined}
              sub={formatBytes(s.memUsed, 0)}
              className="bg-muted/40"
            />
            <StatCard
              label="Disk"
              icon={HardDrive}
              value={formatPercent(diskPct)}
              progress={diskPct ?? undefined}
              sub={disk ? formatBytes(disk.used, 0) : undefined}
              className="bg-muted/40"
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No data yet for this device.</p>
        )}
        {idle || storage ? (
          <div className="grid gap-2">
            {idle ? <IdleVerdictPill risk={idle} /> : null}
            {storage ? (
              <div className="grid gap-1">
                <StorageBar storage={storage} />
                <span className="text-xs text-muted-foreground">
                  {formatBytes(storage.usedBytes)} of {formatBytes(storageSegments(storage).total)} quota
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
