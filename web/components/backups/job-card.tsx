"use client";

import type { JobKind, JobSummary } from "@orbit/shared";
import { Archive, ChevronDown, Database, Loader2, Play, Terminal, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToneBadge, TONE_TEXT } from "@/components/replication/tone-badge";
import { formatBytes, formatDuration, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<JobKind, LucideIcon> = {
  pgdump: Database,
  restic: Archive,
  command: Terminal,
};

export const DUMP_WARN_MS = 36 * 3_600_000;

/** Newest artifact time, falling back to the last successful run. */
export function jobFreshness(job: JobSummary): number | null {
  return job.latestArtifact?.mtime ?? (job.lastRun?.ok ? job.lastRun.finishedAt : null);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right break-words">{children}</span>
    </div>
  );
}

function RunStatus({ job }: { job: JobSummary }) {
  const run = job.lastRun;
  if (job.running) return <ToneBadge tone="primary">Running</ToneBadge>;
  if (!run) return <ToneBadge tone="muted">Never run</ToneBadge>;
  if (run.ok === false) return <ToneBadge tone="danger">Failed</ToneBadge>;
  return <ToneBadge tone="success">OK</ToneBadge>;
}

export function JobCard({
  job,
  highlight = false,
  onRun,
}: {
  job: JobSummary;
  highlight?: boolean;
  onRun: (job: JobSummary) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const Icon = KIND_ICON[job.kind];
  const run = job.lastRun;
  const busy = job.running || starting;
  const fresh = jobFreshness(job);
  const stale = highlight && (fresh == null || now - fresh > DUMP_WARN_MS);
  const duration = run?.finishedAt ? run.finishedAt - run.startedAt : null;

  async function click() {
    setStarting(true);
    try {
      await onRun(job);
    } finally {
      setStarting(false);
    }
  }

  return (
    <Card className={cn(highlight && "ring-2 ring-primary/40")}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          {job.name}
          <RunStatus job={job} />
          {highlight ? <Badge variant="secondary">Used for failover</Badge> : null}
        </CardTitle>
        {highlight ? (
          <p className={cn("text-sm", stale ? TONE_TEXT.warning : "text-muted-foreground")}>
            {fresh == null
              ? "No dump found yet"
              : `Newest dump ${timeAgo(fresh)}${stale ? " - older than 36 h, check the job" : ""}`}
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        <Row label="Schedule">
          {job.schedule ? (
            <>
              <code className="font-mono text-xs">{job.schedule}</code>
              {job.nextRunAt ? <span className="text-muted-foreground"> · next {timeAgo(job.nextRunAt)}</span> : null}
            </>
          ) : (
            "Manual"
          )}
        </Row>
        <Row label="Last run">
          {run ? (
            <>
              {timeAgo(run.startedAt)}
              {duration != null ? <span className="text-muted-foreground"> · took {formatDuration(duration)}</span> : null}
            </>
          ) : (
            "never"
          )}
        </Row>
        {job.latestArtifact ? (
          <Row label="Latest artifact">
            <span className="font-mono text-xs">{job.latestArtifact.name}</span>
            <span className="text-muted-foreground">
              {" "}
              · {formatBytes(job.latestArtifact.bytes)} · {timeAgo(job.latestArtifact.mtime)}
            </span>
          </Row>
        ) : null}
        {job.outputBytes != null ? (
          <Row label="Output folder">
            {formatBytes(job.outputBytes)}
            {job.outputDir ? <span className="block font-mono text-xs text-muted-foreground">{job.outputDir}</span> : null}
          </Row>
        ) : null}
        {job.retention ? <Row label="Retention">{job.retention}</Row> : null}
        {job.restic ? (
          <Row label="Restic">
            <span className="font-mono text-xs">{job.restic.id.slice(0, 8)}</span>
            <span className="text-muted-foreground">
              {" "}
              · {timeAgo(job.restic.time)} · {formatBytes(job.restic.totalSize)} · {job.restic.snapshotCount} snapshots
            </span>
          </Row>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" disabled={busy} onClick={() => void click()}>
            {busy ? <Loader2 className="animate-spin" /> : <Play />}
            {busy ? "Running..." : "Run backup now"}
          </Button>
          {run ? (
            <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
              Last output
            </Button>
          ) : null}
        </div>
        {open && run ? (
          <ScrollArea className="h-48 rounded-xl bg-surface-container-high">
            <pre className="p-3 font-mono text-xs break-words whitespace-pre-wrap">{run.outputTail || "(no output)"}</pre>
          </ScrollArea>
        ) : null}
      </CardContent>
    </Card>
  );
}
