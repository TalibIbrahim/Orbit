"use client";

import { useMemo, type ReactNode } from "react";
import type { MetricsRange, MetricsResponse } from "@orbit/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, formatPercent, formatRate } from "@/lib/format";
import { TimeChart, type TimeRow } from "./time-chart";

export function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Whole-machine CPU / RAM / network / disk charts. */
export function MetricCharts({ metrics, range }: { metrics: MetricsResponse; range: MetricsRange }) {
  const rows = useMemo(() => metrics.total.map((p) => ({ ...p })) as unknown as TimeRow[], [metrics]);
  const memTotal = metrics.total.at(-1)?.memTotal;
  const diskTotal = metrics.total.at(-1)?.diskTotal;
  if (rows.length === 0) {
    return <p className="rounded-2xl bg-card p-6 text-sm text-muted-foreground">No samples in this range yet.</p>;
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <ChartCard title="CPU">
        <TimeChart
          data={rows}
          range={range}
          kind="line"
          yMax={100}
          format={(v) => formatPercent(v)}
          series={[
            { key: "cpuMax", label: "Max", color: "var(--chart-1)", faint: true },
            { key: "cpu", label: "Average", color: "var(--chart-1)" },
          ]}
        />
      </ChartCard>
      <ChartCard title={`Memory${memTotal ? ` (of ${formatBytes(memTotal)})` : ""}`}>
        <TimeChart
          data={rows}
          range={range}
          kind="area"
          yMax={memTotal}
          format={(v) => formatBytes(v)}
          series={[{ key: "memUsed", label: "Used", color: "var(--chart-2)" }]}
        />
      </ChartCard>
      <ChartCard title="Network">
        <TimeChart
          data={rows}
          range={range}
          kind="line"
          yMax="auto"
          format={(v) => formatRate(v)}
          series={[
            { key: "netRx", label: "In", color: "var(--chart-3)" },
            { key: "netTx", label: "Out", color: "var(--chart-4)" },
          ]}
        />
      </ChartCard>
      <ChartCard title={`Disk used${diskTotal ? ` (of ${formatBytes(diskTotal)})` : ""}`}>
        <TimeChart
          data={rows}
          range={range}
          kind="area"
          yMax={diskTotal}
          format={(v) => formatBytes(v)}
          series={[{ key: "diskUsed", label: "Used", color: "var(--chart-5)" }]}
        />
      </ChartCard>
    </div>
  );
}
