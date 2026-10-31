"use client";

import type { AlertsResponse, IdleRisk, ReplicationHealth, StorageBreakdown } from "@orbit/shared";
import { ImmichLink } from "@/components/immich-link";
import { AlertsCard } from "@/components/overview/alerts-card";
import { GettingStartedCard } from "@/components/overview/getting-started-card";
import { DeviceTile } from "@/components/overview/device-tile";
import { PhoneBackupCard } from "@/components/overview/phone-backup-card";
import { ReplicationCard } from "@/components/overview/replication-card";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api";
import { pickHost, useAgent, useBackupVerify, useDevices, usePrimaryMode } from "@/lib/hooks";
import { usePoll } from "@/lib/use-poll";

export default function OverviewPage() {
  const devices = useDevices(15_000);
  const alerts = usePoll(() => apiGet<AlertsResponse>("/api/alerts"), 30_000);
  const replication = usePoll(() => apiGet<ReplicationHealth>("/api/replication"), 30_000);
  const verify = useBackupVerify();
  const { mode } = usePrimaryMode();
  const standby = pickHost(devices.data, mode);
  const idle = useAgent<IdleRisk>(standby?.id, "/idle-risk", 5 * 60_000);
  const storage = useAgent<StorageBreakdown>(standby?.id, "/storage", 5 * 60_000);

  return (
    <>
      <PageHeader title="Overview" description="Everything at a glance" actions={<ImmichLink />} />
      <GettingStartedCard devices={devices.data} replication={replication.data} />
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <PhoneBackupCard data={verify.data} busy={verify.busy} onVerify={() => void verify.verifyNow()} />
        {devices.loading ? (
          <>
            <Skeleton className="h-52 rounded-2xl" />
            <Skeleton className="h-52 rounded-2xl" />
          </>
        ) : !devices.data || devices.data.length === 0 ? (
          <p className="rounded-2xl bg-card p-6 text-sm text-muted-foreground md:col-span-2 lg:col-span-3">
            No devices yet. Add one from the Devices page.
          </p>
        ) : (
          devices.data.map((d) => (
            <DeviceTile
              key={d.id}
              device={d}
              idle={d.id === standby?.id ? idle.data?.data : null}
              storage={d.id === standby?.id ? storage.data?.data : null}
            />
          ))
        )}
        <AlertsCard alerts={alerts.data} />
        <ReplicationCard replication={replication.data} />
      </div>
    </>
  );
}
