"use client";

import { LifeBuoy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { pickHost, useDevices } from "@/lib/hooks";
import { KeepaliveCard } from "./keepalive-card";
import { PromoteCard } from "./promote-card";
import { SwitchBackCard } from "./switch-back-card";

function DisasterRecoveryCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LifeBuoy className="size-4 text-muted-foreground" />
          Disaster recovery
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          If arm-free is lost, every replica still holds the full Immich library plus the nightly database dumps.
          Restore Immich on a replica that has Docker, following{" "}
          <code className="font-mono text-foreground">docs/failover-restore.md</code>, section &quot;Disaster recovery
          (arm-free primary)&quot;.
        </p>
        <p className="text-sm text-muted-foreground">
          This is a manual procedure; there are no promote or switch-back buttons in arm-free mode.
        </p>
      </CardContent>
    </Card>
  );
}

/** armFree: undefined while the mode is still loading. */
export function StandbyTab({ armFree }: { armFree?: boolean }) {
  const { data: devices, loading } = useDevices();

  if (loading || armFree === undefined) return <Skeleton className="h-64 rounded-2xl" />;
  const host = pickHost(devices, armFree ? "arm-free" : "device");

  if (armFree) {
    return (
      <div className="space-y-4">
        {host ? (
          <>
            <p className="text-sm text-muted-foreground">
              Primary host: <span className="font-medium text-foreground">{host.name}</span>. Keep-alive is optional
              here: Immich&apos;s memory use normally keeps the VM above Oracle&apos;s idle threshold.
            </p>
            <KeepaliveCard deviceId={host.id} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            arm-free has not registered yet. Run <code className="font-mono">install-arm-free.sh --mode arm-free</code>.
          </p>
        )}
        <DisasterRecoveryCard />
      </div>
    );
  }

  if (!host) {
    return <p className="text-sm text-muted-foreground">No standby device enrolled yet. Add one under Devices.</p>;
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Standby device: <span className="font-medium text-foreground">{host.name}</span>
      </p>
      <KeepaliveCard deviceId={host.id} />
      <PromoteCard deviceId={host.id} />
      <SwitchBackCard />
    </div>
  );
}
