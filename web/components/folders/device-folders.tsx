"use client";

import type { DeviceSummary, FolderLimit, FolderLimitsResponse } from "@orbit/shared";
import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { FolderCard } from "@/components/folders/folder-card";
import { OfflineBadge } from "@/components/offline-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/lib/format";
import { useAgent } from "@/lib/hooks";

export function DeviceFolders({
  device,
  onEdit,
  reloadKey,
}: {
  device: DeviceSummary;
  onEdit: (deviceId: string, f: FolderLimit) => void;
  reloadKey: number;
}) {
  const { data, loading, refresh } = useAgent<FolderLimitsResponse>(device.id, "/folders", 60_000);
  const cached = data ?? null;
  const resp = cached?.data ?? null;

  // Refetch when a sibling form saved something.
  useEffect(() => {
    if (reloadKey > 0) void refresh();
  }, [reloadKey, refresh]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{device.name}</h2>
        <OfflineBadge online={cached ? cached.online : device.online} lastSeen={cached?.lastSeen ?? device.lastSeen} stale={cached?.stale} />
      </div>

      {loading && !cached ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : !resp ? (
        <p className="text-sm text-muted-foreground">No data yet for this device.</p>
      ) : (
        <>
          {resp.volumes.map((v) => (
            <div key={v.mount} className="space-y-2">
              <p className="text-sm text-muted-foreground">
                <span className="font-mono">{v.mount}</span> · Limits {formatBytes(v.limitsSum, 0)} / free {formatBytes(v.free, 0)}
              </p>
              {v.overcommitted ? (
                <Alert>
                  <TriangleAlert className="text-warning" />
                  <AlertDescription>
                    Limits on {v.mount} exceed free space by{" "}
                    {formatBytes(v.limitsSum - v.usedByLimited - v.free, 0)} once fully used.
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          ))}
          {resp.folders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No folder limits yet.</p>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {resp.folders.map((f) => (
                <FolderCard
                  key={f.id}
                  deviceId={device.id}
                  folder={f}
                  disabled={!(cached?.online ?? device.online)}
                  onEdit={(x) => onEdit(device.id, x)}
                  onChanged={() => void refresh()}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
