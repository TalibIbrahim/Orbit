"use client";

import type { BackupsResponse, PromoteStatus, ReplicationHealth } from "@orbit/shared";
import { AlertTriangle, ExternalLink, Loader2, Rocket } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { OfflineBadge } from "@/components/offline-badge";
import { ToneBadge } from "@/components/replication/tone-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet, apiSend } from "@/lib/api";
import { formatDuration, timeAgo } from "@/lib/format";
import { useAgent } from "@/lib/hooks";
import { usePoll } from "@/lib/use-poll";
import { CopyButton } from "./copy-button";

const LIBRARY_FOLDER = "immich-library";

function LogTail({ log }: { log: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log]);
  return (
    <div ref={ref} className="h-56 overflow-auto rounded-xl bg-surface-container-high">
      <pre className="p-3 font-mono text-xs break-words whitespace-pre-wrap">{log || "(no output yet)"}</pre>
    </div>
  );
}

function ConfirmDialog({ open, onOpenChange, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; onConfirm: () => void }) {
  const [text, setText] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setText("");
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Promote standby?</DialogTitle>
          <DialogDescription>
            This starts Immich on arm-free from the latest replica and Postgres dump. Type PROMOTE to confirm.
          </DialogDescription>
        </DialogHeader>
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="PROMOTE" autoComplete="off" autoCapitalize="characters" />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={text !== "PROMOTE"}
            onClick={() => {
              setText("");
              onConfirm();
            }}
          >
            Promote standby
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Done({ s }: { s: PromoteStatus }) {
  return (
    <div className="space-y-3 rounded-xl bg-success/10 p-4">
      <ToneBadge tone="success">Promoted {timeAgo(s.finishedAt)}</ToneBadge>
      {s.immichUrl ? (
        <>
          <div className="text-xs text-muted-foreground">New Immich URL</div>
          <div className="text-lg font-semibold break-all">{s.immichUrl}</div>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={s.immichUrl} />
            <Button size="sm" asChild>
              <a href={s.immichUrl} target="_blank" rel="noreferrer">
                <ExternalLink />
                Open
              </a>
            </Button>
          </div>
        </>
      ) : null}
      <p className="text-sm text-muted-foreground">
        On your iPhone open the Immich app, log out, and set the server URL to the address above (Settings, Server
        endpoint), then log in again.
      </p>
    </div>
  );
}

export function PromoteCard({ deviceId }: { deviceId: string }) {
  const [interval, setIntervalMs] = useState(15_000);
  const { data, loading, refresh } = useAgent<PromoteStatus>(deviceId, "/promote", interval);
  const { data: repl } = usePoll(() => apiGet<ReplicationHealth>("/api/replication"), 30_000);
  const { data: backups } = useAgent<BackupsResponse>(deviceId, "/backups", 5 * 60_000);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  const status = data?.data;
  const running = status?.state === "running";
  const wanted = running ? 3_000 : 15_000;
  if (wanted !== interval) setIntervalMs(wanted);

  const lag = repl?.replicas.find((r) => r.deviceId === deviceId)?.folders.find((f) => f.folderId === LIBRARY_FOLDER);
  const dumpArtifact = backups?.data?.jobs.find((j) => j.kind === "pgdump")?.latestArtifact?.mtime ?? null;
  const dumpTime = status?.dumpTime ?? dumpArtifact;
  const pcOnline = repl?.primary?.online ?? false;

  async function promote() {
    setConfirmOpen(false);
    setStarting(true);
    try {
      await apiSend("POST", `/api/devices/${encodeURIComponent(deviceId)}/agent/promote`, { confirm: true });
      toast.success("Promotion started");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start promotion");
    } finally {
      setStarting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Rocket className="size-4 text-muted-foreground" />
          Promote standby
          {data ? <OfflineBadge online={data.online} lastSeen={data.lastSeen} stale={data.stale} /> : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-32 rounded-xl" />
        ) : !status ? (
          <p className="text-sm text-muted-foreground">No promote status available.</p>
        ) : !status.supported ? (
          <p className="text-sm text-muted-foreground">Promotion is not configured on this device.</p>
        ) : (
          <>
            <div className="space-y-1 rounded-xl bg-surface-container p-3 text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Library replica</span>
                <span>
                  {lag?.lagMs == null
                    ? "unknown"
                    : lag.lagMs < 60_000
                      ? "in sync"
                      : `${formatDuration(lag.lagMs)} behind`}
                  {lag?.lastInSyncAt ? ` (last in sync ${timeAgo(lag.lastInSyncAt)})` : ""}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Postgres dump</span>
                <span>{dumpTime ? timeAgo(dumpTime) : "none found"}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">PC</span>
                {pcOnline ? <ToneBadge tone="success">Online</ToneBadge> : <ToneBadge tone="muted">Offline</ToneBadge>}
              </div>
            </div>
            {pcOnline ? (
              <Alert className="bg-warning/15 text-warning">
                <AlertTriangle />
                <AlertTitle>The PC is online</AlertTitle>
                <AlertDescription className="text-warning/90">
                  Promoting creates a split brain; only do this if the PC is unavailable.
                </AlertDescription>
              </Alert>
            ) : null}
            {lag?.lagMs != null && lag.lagMs >= 86_400_000 ? (
              <Alert className="bg-warning/15 text-warning">
                <AlertTriangle />
                <AlertTitle>Replica is {formatDuration(lag.lagMs)} behind</AlertTitle>
                <AlertDescription className="text-warning/90">Photos added since then will be missing after promotion.</AlertDescription>
              </Alert>
            ) : null}

            {status.state === "done" ? <Done s={status} /> : null}
            {status.state === "failed" ? (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>Promotion failed</AlertTitle>
                <AlertDescription>See the log below.</AlertDescription>
              </Alert>
            ) : null}
            {status.state === "running" || status.state === "failed" || (status.state === "done" && status.log) ? (
              <LogTail log={status.log} />
            ) : null}

            <div>
              <Button variant="destructive" disabled={running || starting} onClick={() => setConfirmOpen(true)}>
                {running || starting ? <Loader2 className="animate-spin" /> : <Rocket />}
                {running ? "Promoting..." : "Promote standby"}
              </Button>
            </div>
            <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} onConfirm={() => void promote()} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
