"use client";

import type { FolderLimit } from "@orbit/shared";
import { Loader2, Pencil, Ruler, Trash2 } from "lucide-react";
import { useState } from "react";
import { Area, AreaChart } from "recharts";
import { toast } from "sonner";
import { MODE_LABEL, STATE_CLASS, STATE_LABEL } from "@/components/folders/folder-utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { type ChartConfig, ChartContainer } from "@/components/ui/chart";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { apiSend } from "@/lib/api";
import { formatBytes, formatDays } from "@/lib/format";
import { cn } from "@/lib/utils";

const chartConfig = { bytes: { label: "Used", color: "var(--primary)" } } satisfies ChartConfig;

function barColor(pct: number): string {
  return pct >= 100
    ? "[&_[data-slot=progress-indicator]]:bg-danger"
    : pct >= 80
      ? "[&_[data-slot=progress-indicator]]:bg-warning"
      : "[&_[data-slot=progress-indicator]]:bg-primary";
}

export function FolderCard({
  deviceId,
  folder,
  disabled,
  onEdit,
  onChanged,
}: {
  deviceId: string;
  folder: FolderLimit;
  disabled?: boolean;
  onEdit: (f: FolderLimit) => void;
  onChanged: () => void;
}) {
  const [measuring, setMeasuring] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const base = `/api/devices/${deviceId}/agent/folders/${folder.id}`;
  const pct = folder.percent ?? (folder.usedBytes != null && folder.limitBytes > 0 ? (folder.usedBytes / folder.limitBytes) * 100 : 0);

  async function measure() {
    setMeasuring(true);
    try {
      await apiSend("POST", `${base}/measure`);
      toast.success("Measured");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Device offline");
    } finally {
      setMeasuring(false);
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await apiSend("DELETE", base);
      toast.success("Folder limit removed");
      setConfirmDelete(false);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Device offline");
    } finally {
      setDeleting(false);
    }
  }

  const growth = folder.growthBytesPerDay;
  const growing = growth != null && growth > 0;

  return (
    <Card className="rounded-2xl">
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-medium">{folder.name}</div>
            <div className="truncate font-mono text-xs text-muted-foreground" title={folder.path}>
              {folder.path}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge className={cn(STATE_CLASS[folder.state])}>{STATE_LABEL[folder.state]}</Badge>
            <Badge variant="outline">{MODE_LABEL[folder.mode]}</Badge>
          </div>
        </div>

        <Progress value={Math.min(100, pct)} className={cn("h-2 bg-foreground/10", barColor(pct))} />
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
          <span className="tabular-nums">
            {folder.usedBytes == null ? "Not measured" : formatBytes(folder.usedBytes)} of {formatBytes(folder.limitBytes, 0)}
          </span>
          <span className="text-xs text-muted-foreground">
            {growth == null ? "—" : growing ? `+${formatBytes(growth)}/day` : "Not growing"}
            {growing && folder.daysUntilFull != null ? ` · Full in ~${formatDays(folder.daysUntilFull)}` : ""}
          </span>
        </div>

        {folder.history.length > 1 ? (
          <ChartContainer config={chartConfig} className="aspect-auto h-10 w-full">
            <AreaChart data={folder.history} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
              <Area
                dataKey="bytes"
                type="monotone"
                stroke="var(--color-bytes)"
                fill="var(--color-bytes)"
                fillOpacity={0.15}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ChartContainer>
        ) : null}

        {folder.pausedByOrbit ? (
          <p className="text-xs font-medium text-danger">Sync paused by Orbit - resumes when usage drops below the limit.</p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onEdit(folder)}>
            <Pencil /> Edit
          </Button>
          <Button size="sm" variant="secondary" disabled={disabled || measuring} onClick={() => void measure()}>
            {measuring ? <Loader2 className="animate-spin" /> : <Ruler />} Measure now
          </Button>
          <Button size="sm" variant="destructive" disabled={disabled} onClick={() => setConfirmDelete(true)}>
            <Trash2 /> Delete
          </Button>
        </div>
      </CardContent>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete limit for {folder.name}?</DialogTitle>
            <DialogDescription>
              Only the limit is removed; files are untouched. A folder paused by Orbit will be resumed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={() => void remove()}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
