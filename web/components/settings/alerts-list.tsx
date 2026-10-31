"use client";

import type { AlertEvent, AlertsResponse } from "@orbit/shared";
import { BellRing, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToneBadge, type Tone } from "@/components/replication/tone-badge";
import { apiGet } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { usePoll } from "@/lib/use-poll";

const SEVERITY_TONE: Record<AlertEvent["severity"], Tone> = {
  info: "primary",
  warning: "warning",
  critical: "danger",
};

function AlertRow({ a }: { a: AlertEvent }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl bg-surface-container px-3 py-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <ToneBadge tone={SEVERITY_TONE[a.severity]}>{a.severity}</ToneBadge>
          <span className="font-medium">{a.title}</span>
        </div>
        <p className="mt-1 text-sm break-words text-muted-foreground">{a.message}</p>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {a.resolvedAt ? `resolved ${timeAgo(a.resolvedAt)}` : `since ${timeAgo(a.firstSeen)}`}
      </span>
    </div>
  );
}

export function AlertsList() {
  const { data, loading } = usePoll(() => apiGet<AlertsResponse>("/api/alerts"), 30_000);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="size-4 text-muted-foreground" />
          Alerts
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Alerts unavailable.</p>
        ) : (
          <>
            {data.active.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="size-4" /> No active alerts
              </p>
            ) : (
              data.active.map((a) => <AlertRow key={a.key} a={a} />)
            )}
            {data.recent.length > 0 ? (
              <>
                <h3 className="pt-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Recent (7 days)
                </h3>
                {data.recent.map((a) => (
                  <AlertRow key={`${a.key}-${a.firstSeen}`} a={a} />
                ))}
              </>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
