"use client";

import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { DeviceBackups } from "@/components/backups/device-backups";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDevices } from "@/lib/hooks";

const ORDER = { primary: 0, standby: 1, replica: 2 } as const;

export default function BackupsPage() {
  const { data: devices, loading } = useDevices();
  const sorted = [...(devices ?? [])].filter((d) => d.enrolled).sort((a, b) => ORDER[a.role] - ORDER[b.role]);

  return (
    <div className="space-y-6">
      <PageHeader title="Backups" description="Scheduled jobs per device, with latest artifacts and run history" />
      <Card size="sm">
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Minecraft backups run every 30 min plus daily snapshots; limit the backup folder in{" "}
            <Link href="/folders" className="text-primary underline underline-offset-2">
              Folders
            </Link>
            .
          </p>
        </CardContent>
      </Card>
      {loading ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">No enrolled devices yet.</p>
      ) : (
        sorted.map((d) => <DeviceBackups key={d.id} device={d} />)
      )}
    </div>
  );
}
