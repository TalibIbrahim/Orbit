"use client";

import type { ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import type { MetricsRange } from "@orbit/shared";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { cn } from "@/lib/utils";

export interface TimeSeries {
  key: string;
  label: string;
  /** CSS color, e.g. "var(--chart-1)" */
  color: string;
  /** faint secondary line (e.g. max) */
  faint?: boolean;
}

export type TimeRow = { ts: number } & Record<string, number | null>;

const SERVICE_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

/** Stable color per service: by sorted index; beyond 5 services we fall back to the muted disk color. */
export function serviceColor(names: string[], name: string): string {
  const i = [...names].sort().indexOf(name);
  return i >= 0 && i < SERVICE_COLORS.length ? SERVICE_COLORS[i] : "var(--chart-5)";
}

export function formatTick(ts: number, range: MetricsRange): string {
  const d = new Date(ts);
  if (range === "1h" || range === "24h") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return `${d.toLocaleDateString([], { weekday: "short" })} ${d.getDate()}`;
}

function formatFull(ts: number, range: MetricsRange): string {
  const d = new Date(ts);
  return range === "1h" || range === "24h"
    ? d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    : d.toLocaleString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
}

interface TipItem {
  dataKey?: string | number;
  name?: string | number;
  value?: unknown;
  color?: string;
}

function Tip({
  active,
  payload,
  label,
  range,
  format,
}: {
  active?: boolean;
  payload?: readonly TipItem[];
  label?: unknown;
  range: MetricsRange;
  format: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="grid min-w-36 gap-1.5 rounded-xl bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg ring-1 ring-foreground/10">
      <div className="font-medium">{formatFull(Number(label), range)}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2">
          <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}</span>
          <span className="ml-auto font-medium tabular-nums">
            {typeof p.value === "number" ? format(p.value) : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ series }: { series: TimeSeries[] }) {
  const shown = series.filter((s) => !s.faint);
  if (shown.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {shown.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px]" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

export function TimeChart({
  data,
  series,
  range,
  kind,
  stacked = false,
  format,
  yMax,
  className,
  footer,
}: {
  data: TimeRow[];
  series: TimeSeries[];
  range: MetricsRange;
  kind: "area" | "line";
  stacked?: boolean;
  format: (v: number) => string;
  yMax?: number | "auto";
  className?: string;
  footer?: ReactNode;
}) {
  const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]));
  const axes = (
    <>
      <CartesianGrid vertical={false} strokeDasharray="3 3" strokeOpacity={0.5} />
      <XAxis
        dataKey="ts"
        type="number"
        scale="time"
        domain={["dataMin", "dataMax"]}
        tickFormatter={(v: number) => formatTick(v, range)}
        tickLine={false}
        axisLine={false}
        minTickGap={36}
        tickMargin={6}
      />
      <YAxis
        width={76}
        tickLine={false}
        axisLine={false}
        tickFormatter={(v: number) => format(v)}
        domain={[0, yMax == null ? "auto" : yMax]}
      />
      <ChartTooltip cursor={{ strokeOpacity: 0.4 }} content={<Tip range={range} format={format} />} />
    </>
  );
  return (
    <div className="grid gap-2">
      <ChartContainer config={config} className={cn("aspect-auto h-48 w-full", className)}>
        {kind === "area" ? (
          <AreaChart data={data} margin={{ left: 0, right: 8, top: 14 }}>
            {axes}
            {series.map((s) => (
              <Area
                key={s.key}
                dataKey={s.key}
                name={s.label}
                type="monotone"
                stackId={stacked ? "a" : undefined}
                stroke={s.color}
                strokeWidth={2}
                fill={s.color}
                fillOpacity={stacked ? 0.55 : 0.18}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          </AreaChart>
        ) : (
          <LineChart data={data} margin={{ left: 0, right: 8, top: 14 }}>
            {axes}
            {series.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                type="monotone"
                stroke={s.color}
                strokeWidth={s.faint ? 1 : 2}
                strokeOpacity={s.faint ? 0.4 : 1}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          </LineChart>
        )}
      </ChartContainer>
      <Legend series={series} />
      {footer}
    </div>
  );
}
