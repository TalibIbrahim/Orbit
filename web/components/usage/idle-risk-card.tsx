"use client";

import { CheckCircle2, TriangleAlert } from "lucide-react";
import type { IdleMetric, IdleRisk } from "@orbit/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPercent } from "@/lib/format";

function Meter({ m }: { m: IdleMetric }) {
  const pct = Math.max(0, Math.min(100, m.value));
  const tick = Math.max(0, Math.min(100, m.threshold));
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium">{m.label}</span>
        {m.belowThreshold ? (
          <Badge className="bg-warning/15 text-warning">Idle</Badge>
        ) : (
          <Badge className="bg-success/15 text-success">Active</Badge>
        )}
      </div>
      <div
        className="relative h-2.5 rounded-full bg-foreground/10"
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={m.label}
      >
        <div
          className={`h-full rounded-full ${m.belowThreshold ? "bg-warning" : "bg-success"}`}
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute -top-1 h-[18px] w-0.5 rounded bg-foreground/70"
          style={{ left: `${tick}%` }}
          title={`Threshold ${tick}%`}
        />
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">
        {formatPercent(m.value, 1)} vs {m.threshold}% threshold · {m.statistic}
      </div>
    </div>
  );
}

/** Compact verdict, also used on the Overview. */
export function IdleVerdictPill({ risk }: { risk: IdleRisk }) {
  return risk.atRisk ? (
    <Badge className="bg-danger/15 text-danger">
      <TriangleAlert /> Idle risk
    </Badge>
  ) : (
    <Badge className="bg-success/15 text-success">
      <CheckCircle2 /> Safe from reclamation
    </Badge>
  );
}

export function IdleRiskCard({ risk }: { risk: IdleRisk }) {
  const days = (risk.coverage * risk.windowDays).toFixed(1);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Oracle idle reclamation</CardTitle>
        <CardDescription>
          Oracle may reclaim an Always Free VM if CPU p95, network and memory all stay below 20% for 7 days.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {risk.atRisk ? (
          <Alert className="bg-danger/10 text-danger">
            <TriangleAlert />
            <AlertTitle>At risk</AlertTitle>
            <AlertDescription className="text-danger/90">
              All metrics below 20% over 7 days — Oracle may reclaim this VM. Turn on keep-alive in Settings.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert className="bg-success/10 text-success">
            <CheckCircle2 />
            <AlertTitle>Safe</AlertTitle>
            <AlertDescription className="text-success/90">
              Safe: at least one metric is above Oracle&apos;s idle threshold.
            </AlertDescription>
          </Alert>
        )}
        {risk.metrics.map((m) => (
          <Meter key={m.key} m={m} />
        ))}
        {risk.atRisk || risk.coverage < 0.5 ? (
          <Link href="/settings?tab=standby" className="text-sm font-medium text-primary underline underline-offset-2">
            Set up keep-alive on the standby
          </Link>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Based on {days} of {risk.windowDays} days of samples. Network % uses a {risk.networkBandwidthMbps} Mbps
          bandwidth denominator.
        </p>
      </CardContent>
    </Card>
  );
}
