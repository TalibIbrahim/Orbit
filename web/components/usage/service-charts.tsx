"use client";

import { useMemo } from "react";
import type { AgentStatus, MetricsRange, MetricsResponse, ServiceMetricPoint } from "@orbit/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes, formatPercent, formatRate } from "@/lib/format";
import { ChartCard } from "./metric-charts";
import { serviceColor, TimeChart, type TimeRow } from "./time-chart";

type Field = Exclude<keyof ServiceMetricPoint, "ts">;

function pivot(services: MetricsResponse["services"], field: Field): TimeRow[] {
  const byTs = new Map<number, TimeRow>();
  for (const [name, pts] of Object.entries(services)) {
    for (const p of pts) {
      const row = byTs.get(p.ts) ?? ({ ts: p.ts } as TimeRow);
      row[name] = p[field];
      byTs.set(p.ts, row);
    }
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

export function ServiceCharts({ metrics, range }: { metrics: MetricsResponse; range: MetricsRange }) {
  const names = useMemo(() => Object.keys(metrics.services), [metrics]);
  const series = useMemo(() => names.map((n) => ({ key: n, label: n, color: serviceColor(names, n) })), [names]);
  const cpu = useMemo(() => pivot(metrics.services, "cpu"), [metrics]);
  const mem = useMemo(() => pivot(metrics.services, "memUsed"), [metrics]);
  const rx = useMemo(() => pivot(metrics.services, "netRx"), [metrics]);
  const tx = useMemo(() => pivot(metrics.services, "netTx"), [metrics]);
  if (names.length === 0) return null;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <ChartCard title="CPU by service">
        <TimeChart data={cpu} series={series} range={range} kind="area" stacked yMax="auto" format={(v) => formatPercent(v)} />
      </ChartCard>
      <ChartCard title="Memory by service">
        <TimeChart data={mem} series={series} range={range} kind="area" stacked yMax="auto" format={(v) => formatBytes(v)} />
      </ChartCard>
      <ChartCard title="Network in by service">
        <TimeChart data={rx} series={series} range={range} kind="line" yMax="auto" format={(v) => formatRate(v)} />
      </ChartCard>
      <ChartCard title="Network out by service">
        <TimeChart data={tx} series={series} range={range} kind="line" yMax="auto" format={(v) => formatRate(v)} />
      </ChartCard>
    </div>
  );
}

export function ServiceTable({ services }: { services: AgentStatus["services"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Services</CardTitle>
      </CardHeader>
      <CardContent>
        {services.length === 0 ? (
          <p className="text-sm text-muted-foreground">No services configured on this device.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">CPU</TableHead>
                <TableHead className="text-right">RAM</TableHead>
                <TableHead className="text-right">Net in</TableHead>
                <TableHead className="text-right">Net out</TableHead>
                <TableHead className="text-right">Disk</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {services.map((s) => (
                <TableRow key={s.name}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>
                    <Badge variant={s.up ? "secondary" : "destructive"}>
                      {s.up ? "Up" : "Down"} {s.running}/{s.expected}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(s.cpu)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatBytes(s.memUsed)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatRate(s.netRx)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatRate(s.netTx)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatBytes(s.diskUsed)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
