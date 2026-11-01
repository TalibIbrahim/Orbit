"use client";

import Link from "next/link";
import { RefreshCw } from "lucide-react";
import type { ReplicaHealth, ReplicaState, ReplicationHealth } from "@orbit/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration } from "@/lib/format";

const STATE_LABEL: Record<ReplicaState, string> = {
  "up-to-date": "Up to date",
  syncing: "Syncing",
  offline: "Offline",
  unknown: "Unknown",
  paused: "Paused",
  "peer-offline": "Peer offline",
  "nothing-to-sync": "Nothing to sync",
  error: "Error",
};
const STATE_CLASS: Record<ReplicaState, string> = {
  "up-to-date": "bg-success/15 text-success",
  syncing: "bg-primary/15 text-primary",
  offline: "bg-warning/15 text-warning",
  unknown: "",
  paused: "",
  "peer-offline": "bg-warning/15 text-warning",
  "nothing-to-sync": "bg-success/15 text-success",
  error: "bg-destructive/15 text-destructive",
};

/** Worst state across a replica's folders (offline replicas always read "offline"). */
function replicaState(r: ReplicaHealth): { state: ReplicaState; lagMs: number | null } {
  if (!r.online) return { state: "offline", lagMs: r.folders.reduce<number | null>((a, f) => (f.lagMs == null ? a : Math.max(a ?? 0, f.lagMs)), null) };
  const states = r.folders.map((f) => f.state);
  const worst: ReplicaState[] = ["error", "syncing", "offline", "peer-offline", "paused"];
  const state: ReplicaState =
    worst.find((s) => states.includes(s)) ??
    (states.length > 0 && states.every((s) => s === "up-to-date" || s === "nothing-to-sync") ? "up-to-date" : "unknown");
  const lagMs = r.folders.reduce<number | null>((a, f) => (f.lagMs == null ? a : Math.max(a ?? 0, f.lagMs)), null);
  return { state, lagMs };
}

export function ReplicationCard({ replication }: { replication: ReplicationHealth | undefined }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RefreshCw className="size-4" /> Replication
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!replication ? (
          <Skeleton className="h-16 rounded-xl" />
        ) : replication.replicas.length === 0 ? (
          <p className="text-sm text-muted-foreground">No replicas configured.</p>
        ) : (
          replication.replicas.map((r) => {
            const { state, lagMs } = replicaState(r);
            return (
              <div key={r.deviceId} className="flex items-center gap-2 text-sm">
                <span className="truncate font-medium">{r.name}</span>
                <Badge variant="secondary" className={STATE_CLASS[state]}>
                  {STATE_LABEL[state]}
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                  {lagMs ? `lag ${formatDuration(lagMs)}` : ""}
                </span>
              </div>
            );
          })
        )}
        <Link href="/replication" className="text-sm font-medium text-primary hover:underline">
          Replication details
        </Link>
      </CardContent>
    </Card>
  );
}
