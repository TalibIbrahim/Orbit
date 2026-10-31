"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { pickRole, useDevices } from "@/lib/hooks";
import { KeepaliveCard } from "./keepalive-card";
import { PromoteCard } from "./promote-card";
import { SwitchBackCard } from "./switch-back-card";

export function StandbyTab() {
  const { data: devices, loading } = useDevices();
  const standby = pickRole(devices, "standby");

  if (loading) return <Skeleton className="h-64 rounded-2xl" />;
  if (!standby) {
    return <p className="text-sm text-muted-foreground">No standby device enrolled yet. Add one under Devices.</p>;
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Standby device: <span className="font-medium text-foreground">{standby.name}</span>
      </p>
      <KeepaliveCard deviceId={standby.id} />
      <PromoteCard deviceId={standby.id} />
      <SwitchBackCard />
    </div>
  );
}
