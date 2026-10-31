"use client";

import type { HostUpdateStatus } from "@orbit/shared";
import { CloudDownload, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiGet, apiSend } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { usePoll } from "@/lib/use-poll";

const fmt = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "-";

/** Orbit self-update on arm-free: status, "Check for updates" and "Update Orbit". */
export function UpdatesCard() {
  const [busy, setBusy] = useState<null | "check" | "run">(null);
  const [waiting, setWaiting] = useState(false); // update started: the hub restarts, keep polling
  const startedAt = useRef<number>(0);
  const { data, refresh } = usePoll(() => apiGet<HostUpdateStatus>("/api/host-update"), waiting ? 5_000 : 60_000, [waiting]);

  // While an update runs the hub itself is rebuilt: requests fail for a while, then the page reloads.
  useEffect(() => {
    if (!waiting || !data) return;
    const last = data.lastRun;
    if (!data.running && last?.finishedAt && last.startedAt >= startedAt.current - 60_000) {
      setWaiting(false);
      if (last.ok) {
        toast.success(last.message || "Orbit is up to date");
        setTimeout(() => window.location.reload(), 1500);
      } else toast.error(`Update failed: ${last.message}`);
    }
  }, [waiting, data]);

  async function act(action: "check" | "run") {
    setBusy(action);
    try {
      const s = await apiSend<HostUpdateStatus>("POST", "/api/host-update", { action });
      if (action === "run") {
        startedAt.current = Date.now();
        setWaiting(true);
        toast.message("Updating Orbit. The dashboard restarts in a few minutes and reloads by itself.");
      } else {
        toast.success(s.upstream?.behind ? `${s.upstream.behind} new change(s) available` : "Orbit is up to date");
      }
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  const s = data;
  const behind = s?.upstream?.behind ?? null;
  const running = !!s?.running || waiting;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <CloudDownload className="size-4 text-muted-foreground" />
          Orbit updates
          {running ? (
            <Badge className="bg-primary/15 text-primary">Updating…</Badge>
          ) : behind ? (
            <Badge className="bg-warning/15 text-warning">Update available</Badge>
          ) : behind === 0 ? (
            <Badge className="bg-success/15 text-success">Up to date</Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!s ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : !s.available ? (
          <p className="text-muted-foreground">
            {s.error ?? "Updates are managed on arm-free."} Update by hand on arm-free:{" "}
            <code className="font-mono text-xs">sudo systemctl start orbit-update.service</code>
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Installed</dt>
              <dd className="min-w-0 truncate">
                {s.current ? (
                  <>
                    <code className="font-mono text-xs">{s.current.commit}</code> {s.current.subject}
                    {s.current.date ? <span className="text-muted-foreground"> · {timeAgo(s.current.date)}</span> : null}
                  </>
                ) : (
                  "-"
                )}
              </dd>
              <dt className="text-muted-foreground">Available</dt>
              <dd>
                {behind == null ? "not checked yet" : behind === 0 ? "nothing new" : `${behind} new change${behind === 1 ? "" : "s"}`}
                {s.upstream?.checkedAt ? <span className="text-muted-foreground"> · checked {timeAgo(s.upstream.checkedAt)}</span> : null}
                {s.upstream?.error ? <span className="block text-xs text-danger">{s.upstream.error}</span> : null}
              </dd>
              <dt className="text-muted-foreground">Automatic</dt>
              <dd>every night, next {fmt(s.nextRun)}</dd>
              <dt className="text-muted-foreground">Last update</dt>
              <dd>
                {s.lastRun ? (
                  <>
                    <span className={s.lastRun.ok === false ? "text-danger" : ""}>{s.lastRun.message}</span>
                    <span className="text-muted-foreground"> · {timeAgo(s.lastRun.finishedAt ?? s.lastRun.startedAt)}</span>
                  </>
                ) : (
                  "never"
                )}
              </dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void act("run")} disabled={running || busy !== null}>
                {running || busy === "run" ? <Loader2 className="animate-spin" /> : <CloudDownload />}
                {running ? "Updating…" : "Update Orbit"}
              </Button>
              <Button variant="secondary" onClick={() => void act("check")} disabled={running || busy !== null}>
                {busy === "check" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check for updates
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Downloads the newest Orbit on arm-free and reinstalls it (hub, agent, containers). Your photos, settings and
              backups are not touched. The dashboard is unavailable for a few minutes while the hub rebuilds. The PC and
              laptop agents update themselves afterwards. By hand on arm-free:{" "}
              <code className="font-mono">sudo systemctl start orbit-update.service</code>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
