"use client";

import type { SyncSchedule, SyncWindow } from "@orbit/shared";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { validateSchedule } from "@/lib/sync/schedule";
import { cn } from "@/lib/utils";

const DAYS: { value: number; label: string }[] = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

const PRESETS: { label: string; window: SyncWindow }[] = [
  { label: "Nights (01:00–07:00)", window: { days: [0, 1, 2, 3, 4, 5, 6], start: "01:00", end: "07:00" } },
  { label: "Weekends", window: { days: [6, 0], start: "00:00", end: "00:00" } },
  { label: "Every day", window: { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" } },
];

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function ScheduleDialog({
  open,
  onOpenChange,
  schedule,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule: SyncSchedule | undefined;
  onSave: (schedule: SyncSchedule) => Promise<unknown>;
}) {
  // The form is mounted only while open, so Cancel discards edits.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        {open ? <ScheduleForm schedule={schedule} onClose={() => onOpenChange(false)} onSave={onSave} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ScheduleForm({
  schedule,
  onClose,
  onSave,
}: {
  schedule: SyncSchedule | undefined;
  onClose: () => void;
  onSave: (schedule: SyncSchedule) => Promise<unknown>;
}) {
  const [enabled, setEnabled] = useState(schedule?.enabled ?? false);
  const [windows, setWindows] = useState<SyncWindow[]>(
    schedule?.windows.length ? schedule.windows.map((w) => ({ ...w, days: [...w.days] })) : [],
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const timezone = localZone();

  const update = (i: number, patch: Partial<SyncWindow>) =>
    setWindows((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  const toggleDay = (i: number, d: number) => {
    const days = windows[i].days;
    update(i, { days: days.includes(d) ? days.filter((x) => x !== d) : [...days, d] });
  };
  const addWindow = (w?: SyncWindow) => {
    setEnabled(true);
    setWindows((ws) => [
      ...ws,
      w ? { ...w, days: [...w.days] } : { days: [1, 2, 3, 4, 5], start: "01:00", end: "07:00" },
    ]);
  };

  async function save() {
    const result = validateSchedule({ enabled, timezone, windows });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(result.schedule);
      toast.success("Sync schedule saved");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save schedule");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Sync schedule</DialogTitle>
        <DialogDescription>
          Outside these windows sync is paused on every device. The Pause Sync button always wins.
        </DialogDescription>
      </DialogHeader>

      <label className="flex items-center justify-between gap-3 text-sm font-medium">
        Only sync during these times
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </label>

      <div className={cn("grid gap-3", !enabled && "opacity-60")}>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <Button key={p.label} type="button" variant="outline" size="sm" onClick={() => addWindow(p.window)}>
              {p.label}
            </Button>
          ))}
        </div>

        {windows.map((w, i) => (
          <div key={i} className="grid gap-3 rounded-xl bg-muted/50 p-3">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
              {DAYS.map((d) => {
                const on = w.days.includes(d.value);
                return (
                  <button
                    key={d.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleDay(i, d.value)}
                    className={cn(
                      "h-8 min-w-11 rounded-full border px-3 text-xs font-medium transition-colors",
                      on
                        ? "border-transparent bg-primary text-primary-foreground"
                        : "border-border bg-background hover:bg-muted",
                    )}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="time"
                aria-label="Start time"
                value={w.start}
                onChange={(e) => update(i, { start: e.target.value })}
                className="min-w-0 flex-1"
              />
              <span className="text-sm text-muted-foreground">to</span>
              <Input
                type="time"
                aria-label="End time"
                value={w.end}
                onChange={(e) => update(i, { end: e.target.value })}
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove time window"
                onClick={() => setWindows((ws) => ws.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
        ))}

        <Button type="button" variant="secondary" size="sm" className="justify-self-start" onClick={() => addWindow()}>
          <Plus /> Add time window
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Times are in {timezone}. An end time earlier than the start (e.g. 22:00–06:00) runs past midnight into the next
        day; equal times mean the whole day.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}
