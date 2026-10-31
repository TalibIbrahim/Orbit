"use client";

import type { DeviceSummary } from "@orbit/shared";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { EditDeviceDialog, RemoveDeviceDialog } from "@/components/devices/device-dialogs";
import { DeviceList } from "@/components/devices/device-list";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDevices } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export default function DevicesPage() {
  const { data: devices, loading, error, refresh } = useDevices(10_000);
  const [editing, setEditing] = useState<DeviceSummary | null>(null);
  const [removing, setRemoving] = useState<DeviceSummary | null>(null);

  return (
    <div>
      <PageHeader
        title="Devices"
        description="Machines running the Orbit agent"
        actions={
          <Link href="/devices/add" className={cn(buttonVariants())}>
            <Plus /> Add device
          </Link>
        }
      />
      {loading && !devices ? (
        <div className="grid gap-3">
          <Skeleton className="h-44 w-full rounded-2xl" />
          <Skeleton className="h-44 w-full rounded-2xl" />
        </div>
      ) : devices ? (
        devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No devices yet. Add your first device to get started.</p>
        ) : (
          <DeviceList devices={devices} onEdit={setEditing} onRemove={setRemoving} />
        )
      ) : (
        <p className="text-sm text-muted-foreground">Could not load devices{error ? `: ${error.message}` : ""}.</p>
      )}
      <EditDeviceDialog device={editing} onClose={() => setEditing(null)} onDone={() => void refresh()} />
      <RemoveDeviceDialog device={removing} onClose={() => setRemoving(null)} onDone={() => void refresh()} />
    </div>
  );
}
