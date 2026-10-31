"use client";

import { Suspense, useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { IdleRisk, MetricsRange, MetricsResponse, StorageBreakdown, AgentStatus, DeviceSummary } from "@orbit/shared";
import { OfflineBadge } from "@/components/offline-badge";
import { PageHeader } from "@/components/page-header";
import { IdleRiskCard } from "@/components/usage/idle-risk-card";
import { MetricCharts } from "@/components/usage/metric-charts";
import { ServiceCharts, ServiceTable } from "@/components/usage/service-charts";
import { StorageQuotaCard } from "@/components/usage/storage-quota-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { pickHost, useAgent, useDevices, usePrimaryMode } from "@/lib/hooks";

const RANGES: MetricsRange[] = ["1h", "24h", "7d", "30d"];

function UsageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const devices = useDevices();
  const list: DeviceSummary[] | undefined = devices.data;
  const { mode } = usePrimaryMode();

  const qDevice = params.get("device");
  const qRange = params.get("range");
  const range: MetricsRange = RANGES.includes(qRange as MetricsRange) ? (qRange as MetricsRange) : "24h";
  const device: DeviceSummary | undefined =
    list?.find((d) => d.id === qDevice) ?? pickHost(list, mode) ?? list?.[0];
  const id = device?.id;

  const setParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params.toString());
      next.set(key, value);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  const metrics = useAgent<MetricsResponse>(id, `/metrics?range=${range}`);
  const status = useAgent<AgentStatus>(id, "/status", 30_000);
  const idle = useAgent<IdleRisk>(id, "/idle-risk", 5 * 60_000);
  const storage = useAgent<StorageBreakdown>(id, "/storage", 5 * 60_000);

  const m = metrics.data;
  const services = status.data?.data?.services ?? [];
  const showIdle = device?.role === (mode === "arm-free" ? "primary" : "standby") || !!idle.data?.data;

  return (
    <>
      <PageHeader
        title="Usage"
        description="Resource usage over time"
        actions={
          <>
            {device ? <OfflineBadge online={device.online} lastSeen={device.lastSeen} stale={!!m?.stale} /> : null}
            {list && list.length > 0 ? (
              <Select value={id} onValueChange={(v) => setParam("device", v)}>
                <SelectTrigger aria-label="Device">
                  <SelectValue placeholder="Device" />
                </SelectTrigger>
                <SelectContent>
                  {list.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </>
        }
      />
      <div className="grid gap-4">
        <Tabs value={range} onValueChange={(v) => setParam("range", v)}>
          <TabsList>
            {RANGES.map((r) => (
              <TabsTrigger key={r} value={r}>
                {r}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {devices.loading || (id && metrics.loading) ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-72 rounded-2xl" />
            ))}
          </div>
        ) : !device ? (
          <p className="rounded-2xl bg-card p-6 text-sm text-muted-foreground">No devices yet. Add one in Devices.</p>
        ) : !m?.data ? (
          <p className="rounded-2xl bg-card p-6 text-sm text-muted-foreground">
            No metrics available for {device.name} yet.
          </p>
        ) : (
          <MetricCharts metrics={m.data} range={range} />
        )}

        {m?.data && Object.keys(m.data.services).length > 0 ? (
          <>
            <h2 className="mt-2 text-lg font-semibold tracking-tight">Per service</h2>
            <ServiceCharts metrics={m.data} range={range} />
          </>
        ) : null}
        {status.data?.data ? <ServiceTable services={services} /> : null}

        {showIdle || storage.data?.data ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {showIdle && idle.data?.data ? <IdleRiskCard risk={idle.data.data} mode={mode} /> : null}
            {storage.data?.data ? <StorageQuotaCard storage={storage.data.data} /> : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

export default function UsagePage() {
  return (
    <Suspense fallback={<Skeleton className="h-72 rounded-2xl" />}>
      <UsageInner />
    </Suspense>
  );
}
