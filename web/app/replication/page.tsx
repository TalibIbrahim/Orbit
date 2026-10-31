"use client";

import type { ReplicationHealth } from "@orbit/shared";
import { Info } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { PrimaryCard } from "@/components/replication/primary-card";
import { ReplicaCard } from "@/components/replication/replica-card";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api";
import { usePrimaryMode } from "@/lib/hooks";
import { usePoll } from "@/lib/use-poll";

export default function ReplicationPage() {
  const { data, error, loading } = usePoll(() => apiGet<ReplicationHealth>("/api/replication"), 30_000);
  const { mode } = usePrimaryMode();
  const armFree = mode === "arm-free";

  return (
    <div className="space-y-4">
      <PageHeader title="Replication" description={armFree ? "Syncthing replicas of the arm-free photo library" : "Syncthing replicas of the PC photo library"} />
      <Card size="sm">
        <CardContent className="flex gap-3">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          <p className="text-sm text-muted-foreground">
            {armFree ? "arm-free" : "PC"} is the single source of truth. Replicas are Receive Only with file versioning so
            deletions or corruption can be recovered from <code className="font-mono text-foreground">.stversions</code>.
            {armFree ? " If arm-free is lost, see disaster recovery in Settings." : ""}
          </p>
        </CardContent>
      </Card>
      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      ) : !data ? (
        <p className="text-sm text-muted-foreground">
          Could not load replication health{error ? `: ${error.message}` : ""}.
        </p>
      ) : (
        <>
          <PrimaryCard data={data} mode={mode} />
          <div className="grid gap-4 lg:grid-cols-2">
            {data.replicas.map((r) => (
              <ReplicaCard key={r.deviceId} replica={r} />
            ))}
          </div>
          {data.replicas.length === 0 ? (
            <p className="text-sm text-muted-foreground">No replicas enrolled yet.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
