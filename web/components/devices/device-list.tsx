"use client";

import type { DeviceSummary } from "@orbit/shared";
import { Pencil, Trash2 } from "lucide-react";
import { OnlineDot, PlatformIcon, RoleBadge, tailscaleText } from "@/components/devices/device-parts";
import { OfflineBadge } from "@/components/offline-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes, timeAgo } from "@/lib/format";

interface Actions {
  onEdit: (d: DeviceSummary) => void;
  onRemove: (d: DeviceSummary) => void;
}

function DiskLine({ d }: { d: DeviceSummary }) {
  const p = d.status?.primaryDisk;
  if (!p) return <span className="text-muted-foreground">—</span>;
  const pct = p.total ? (p.used / p.total) * 100 : 0;
  return (
    <div className="space-y-1">
      <Progress value={pct} className="h-1.5 bg-foreground/10" />
      <div className="text-xs text-muted-foreground tabular-nums">
        {formatBytes(p.free)} free of {formatBytes(p.total, 0)} ({p.mount})
      </div>
    </div>
  );
}

function Status({ d }: { d: DeviceSummary }) {
  if (!d.enrolled)
    return (
      <span className="flex items-center gap-2 text-sm text-warning">
        <OnlineDot online={false} pulse /> Waiting for install…
      </span>
    );
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm">
      <OnlineDot online={d.online} />
      {d.online ? "Online" : null}
      <OfflineBadge online={d.online} lastSeen={d.lastSeen} />
    </span>
  );
}

function DeviceCard({ d, onEdit, onRemove }: Actions & { d: DeviceSummary }) {
  const disks = d.status?.disks ?? [];
  return (
    <Card className="rounded-2xl">
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <PlatformIcon platform={d.status?.health.platform ?? d.platform} />
            <div className="min-w-0">
              <div className="truncate font-medium">{d.name}</div>
              <Status d={d} />
            </div>
          </div>
          <RoleBadge role={d.role} />
        </div>
        <DiskLine d={d} />
        {disks.length > 1 ? (
          <ul className="space-y-0.5 text-xs text-muted-foreground tabular-nums">
            {disks.map((k) => (
              <li key={k.mount} className="flex justify-between gap-2">
                <span className="font-mono">{k.mount}</span>
                <span>
                  {formatBytes(k.used, 0)} used · {formatBytes(k.free, 0)} free
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="space-y-0.5 text-xs text-muted-foreground">
          <div className="truncate">Tailscale: {tailscaleText(d)}</div>
          {d.status?.tailscale.dnsName ? <div className="truncate font-mono">{d.status.tailscale.dnsName}</div> : null}
          <div>Agent {d.status?.health.agentVersion ?? "—"}</div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => onEdit(d)}>
            <Pencil /> Edit
          </Button>
          <Button size="sm" variant="destructive" onClick={() => onRemove(d)}>
            <Trash2 /> Remove
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function DeviceList({ devices, onEdit, onRemove }: Actions & { devices: DeviceSummary[] }) {
  return (
    <>
      <div className="grid gap-3 md:hidden">
        {devices.map((d) => (
          <DeviceCard key={d.id} d={d} onEdit={onEdit} onRemove={onRemove} />
        ))}
      </div>
      <div className="hidden rounded-2xl border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Device</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tailscale</TableHead>
              <TableHead className="w-56">Disk</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {devices.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <span className="flex items-center gap-2 font-medium">
                    <PlatformIcon platform={d.status?.health.platform ?? d.platform} className="size-4" /> {d.name}
                  </span>
                </TableCell>
                <TableCell>
                  <RoleBadge role={d.role} />
                </TableCell>
                <TableCell>
                  <Status d={d} />
                  {d.enrolled && d.online ? <span className="text-xs text-muted-foreground">seen {timeAgo(d.lastSeen)}</span> : null}
                </TableCell>
                <TableCell className="text-xs">{tailscaleText(d)}</TableCell>
                <TableCell>
                  <DiskLine d={d} />
                </TableCell>
                <TableCell className="text-xs">{d.status?.health.agentVersion ?? "—"}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={() => onEdit(d)}>
                      <Pencil />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => onRemove(d)}>
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
