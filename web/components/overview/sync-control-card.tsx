"use client";

import type { SyncControlState, SyncSchedule } from "@orbit/shared";
import { CalendarClock, Pause, Play, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ScheduleDialog } from "@/components/sync/schedule-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { describeSchedule } from "@/lib/sync/schedule";

function formatWhen(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return `today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

function statusLine(s: SyncControlState): string {
  const next = s.nextChange ? formatWhen(s.nextChange) : null;
  if (s.pausedByUser) {
    const since = s.pausedAt ? ` since ${formatWhen(s.pausedAt)}` : "";
    const hint = !s.scheduleAllowsNow ? ". The schedule would also pause now; resuming hands control back to it" : "";
    return `Paused by you${since}${hint}`;
  }
  if (!s.scheduleAllowsNow) return `Paused by schedule - resumes ${next ?? "later"}`;
  if (s.schedule.enabled && next) return `Syncing normally. Schedule: pauses ${next}`;
  return "Syncing normally";
}

export function SyncControlCard({
  state,
  busy,
  onSetPaused,
  onSaveSchedule,
}: {
  state: SyncControlState | undefined;
  busy: boolean;
  onSetPaused: (paused: boolean) => void;
  onSaveSchedule: (schedule: SyncSchedule) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RefreshCw className="size-4" /> Sync
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!state ? (
          <Skeleton className="h-28 rounded-xl" />
        ) : (
          <>
            <Button
              size="lg"
              variant={state.pausedByUser ? "default" : "secondary"}
              disabled={busy}
              onClick={() => onSetPaused(!state.pausedByUser)}
              className="h-11 w-full"
            >
              {state.pausedByUser ? <Play /> : <Pause />}
              {state.pausedByUser ? "Resume Sync" : "Pause Sync"}
            </Button>
            <p className="text-sm text-muted-foreground">{statusLine(state)}</p>

            <div className="flex items-center justify-between gap-3">
              <p className="min-w-0 text-xs text-muted-foreground">{describeSchedule(state.schedule)}</p>
              <Button variant="outline" size="sm" className="shrink-0" onClick={() => setOpen(true)}>
                <CalendarClock /> Schedule…
              </Button>
            </div>

            {state.devices.length > 0 ? (
              <ul className="grid gap-1.5 border-t pt-3 text-sm">
                {state.devices.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="font-medium">
                      {d.name}{" "}
                      <span className="text-xs font-normal text-muted-foreground">
                        {d.online ? "online" : "offline"}
                      </span>
                    </span>
                    <span className={d.error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                      {d.error ?? (!d.online ? "applies when online" : d.applied ? "✓ applied" : "pending")}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </CardContent>
      <ScheduleDialog open={open} onOpenChange={setOpen} schedule={state?.schedule} onSave={onSaveSchedule} />
    </Card>
  );
}
