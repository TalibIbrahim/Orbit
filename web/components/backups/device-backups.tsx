"use client";

import type { BackupsResponse, DeviceSummary, JobSummary } from "@orbit/shared";
import { useState } from "react";
import { toast } from "sonner";
import { OfflineBadge } from "@/components/offline-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { apiSend } from "@/lib/api";
import { useAgent } from "@/lib/hooks";
import { JobCard } from "./job-card";

export function DeviceBackups({ device }: { device: DeviceSummary }) {
  const [interval, setIntervalMs] = useState(60_000);
  const { data, loading, refresh } = useAgent<BackupsResponse>(device.id, "/backups", interval);

  const jobs = data?.data?.jobs;
  const anyRunning = jobs?.some((j) => j.running) ?? false;
  const wanted = anyRunning ? 5_000 : 60_000;
  if (wanted !== interval) setIntervalMs(wanted);

  async function run(job: JobSummary) {
    try {
      await apiSend("POST", `/api/devices/${encodeURIComponent(device.id)}/agent/backups/${encodeURIComponent(job.id)}/run`);
      toast.success(`${job.name} started`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start backup");
    }
  }

  const sorted = [...(jobs ?? [])].sort((a, b) => Number(b.kind === "pgdump") - Number(a.kind === "pgdump"));

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-medium">{device.name}</h2>
        <OfflineBadge online={data?.online ?? device.online} lastSeen={data?.lastSeen ?? device.lastSeen} stale={data?.stale} />
      </div>
      {loading ? (
        <Skeleton className="h-56 rounded-2xl" />
      ) : sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {data?.data ? "No backup jobs configured on this device." : "No backup data available yet."}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {sorted.map((j) => (
            <JobCard key={j.id} job={j} highlight={j.kind === "pgdump" && device.role === "primary"} onRun={run} />
          ))}
        </div>
      )}
    </section>
  );
}
