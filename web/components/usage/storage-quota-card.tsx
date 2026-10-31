"use client";

import type { StorageBreakdown, StorageCategory } from "@orbit/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, formatDays } from "@/lib/format";

const CAT_COLOR: Record<StorageCategory, string> = {
  photos: "var(--chart-1)",
  services: "var(--chart-3)",
  system: "var(--chart-4)",
};

export function storageSegments(s: StorageBreakdown) {
  const total = s.quotaBytes ?? s.provisionedBytes;
  const segs = s.categories.map((c) => ({
    key: c.category,
    label: c.label,
    bytes: c.bytes,
    color: CAT_COLOR[c.category],
  }));
  const free = Math.max(0, total - segs.reduce((a, c) => a + c.bytes, 0));
  return { total, segs, free };
}

/** Segmented used/free bar; reused by the Overview. */
export function StorageBar({ storage, className = "h-3" }: { storage: StorageBreakdown; className?: string }) {
  const { total, segs } = storageSegments(storage);
  return (
    <div
      className={`flex w-full gap-0.5 overflow-hidden rounded-full bg-foreground/10 ${className}`}
      role="img"
      aria-label={`${formatBytes(storage.usedBytes)} of ${formatBytes(total)} used`}
    >
      {segs.map((s) =>
        s.bytes > 0 && total > 0 ? (
          <div key={s.key} style={{ width: `${(s.bytes / total) * 100}%`, background: s.color }} />
        ) : null,
      )}
    </div>
  );
}

export function StorageQuotaCard({ storage }: { storage: StorageBreakdown }) {
  const { total, segs, free } = storageSegments(storage);
  const growing = storage.growthBytesPerDay != null && storage.growthBytesPerDay > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Storage quota</CardTitle>
        <CardDescription>
          {formatBytes(storage.usedBytes)} of {formatBytes(total)}{" "}
          {storage.quotaBytes != null ? "Always Free quota" : "provisioned"}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <StorageBar storage={storage} className="h-4" />
        <ul className="grid gap-1.5 text-sm">
          {segs.map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <span className="size-2.5 rounded-[3px]" style={{ background: s.color }} />
              <span className="text-muted-foreground">{s.label}</span>
              <span className="ml-auto tabular-nums">{formatBytes(s.bytes)}</span>
            </li>
          ))}
          <li className="flex items-center gap-2">
            <span className="size-2.5 rounded-[3px] bg-foreground/15" />
            <span className="text-muted-foreground">Free</span>
            <span className="ml-auto tabular-nums">{formatBytes(free)}</span>
          </li>
        </ul>
        <div className="flex flex-wrap justify-between gap-2 text-sm">
          <span className="text-muted-foreground">
            Growth:{" "}
            <span className="text-foreground tabular-nums">
              {growing ? `${formatBytes(storage.growthBytesPerDay)}/day` : "—"}
            </span>
          </span>
          <span className="font-medium">
            {growing && storage.daysUntilFull != null ? `Full in ~${formatDays(storage.daysUntilFull)}` : "Not growing"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
