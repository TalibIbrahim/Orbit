"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import type { AlertEvent, AlertsResponse } from "@orbit/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/lib/format";

const DOT: Record<AlertEvent["severity"], string> = {
  critical: "bg-danger",
  warning: "bg-warning",
  info: "bg-primary",
};

export function AlertsCard({ alerts }: { alerts: AlertsResponse | undefined }) {
  const top = alerts?.active.slice(0, 3) ?? [];
  const total = alerts?.active.length ?? 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="size-4" /> Alerts {total > 0 ? `(${total})` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!alerts ? (
          <Skeleton className="h-16 rounded-xl" />
        ) : top.length === 0 ? (
          <p className="text-sm text-muted-foreground">All clear. No active alerts.</p>
        ) : (
          top.map((a) => (
            <div key={a.key} className="flex items-start gap-2.5">
              <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${DOT[a.severity]}`} />
              <div className="min-w-0 text-sm">
                <div className="truncate font-medium">{a.title}</div>
                <div className="text-xs text-muted-foreground">
                  {a.message} · <span suppressHydrationWarning>{timeAgo(a.firstSeen)}</span>
                </div>
              </div>
            </div>
          ))
        )}
        <Link href="/settings" className="text-sm font-medium text-primary hover:underline">
          Manage alerts
        </Link>
      </CardContent>
    </Card>
  );
}
