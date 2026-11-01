"use client";

import type { CopyVerification, DumpStatus, OffloadState } from "@orbit/shared";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { SyncDetails } from "@/components/replication/sync-details";
import { apiSend } from "@/lib/api";
import { CheckCircle2, CircleHelp, DatabaseBackup, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatBytes, timeAgo } from "@/lib/format";

const LABEL: Record<OffloadState, string> = { safe: "Safe to offload", "not-yet": "Not yet", unknown: "Unknown" };
const CLASS: Record<OffloadState, string> = {
  safe: "bg-success/15 text-success",
  "not-yet": "bg-warning/15 text-warning",
  unknown: "",
};

export function StatusChip({ state, large }: { state: OffloadState; large?: boolean }) {
  const Icon = state === "safe" ? CheckCircle2 : state === "not-yet" ? TriangleAlert : CircleHelp;
  return (
    <Badge variant="secondary" className={`${CLASS[state]} ${large ? "h-auto gap-2 px-4 py-2 text-lg" : ""}`}>
      <Icon className={large ? "size-5" : "size-3.5"} />
      {LABEL[state]}
    </Badge>
  );
}

/** "Verified (sync paused by schedule)" next to a safe result. */
export function StateNote({ note }: { note: string | null | undefined }) {
  if (!note) return null;
  return <span className="text-xs font-medium text-success">Verified ({note})</span>;
}

/** Database dump problem with the fix: run the dump job now, or open Backups. */
export function DumpAction({ dump }: { dump: DumpStatus | undefined }) {
  const [busy, setBusy] = useState(false);
  if (!dump || dump.state === "ok" || dump.state === "stale" || dump.state === "unknown") return null;
  const canRun = (dump.state === "none" || dump.state === "failed") && !!dump.hostDeviceId && !!dump.jobId;
  async function run() {
    if (!dump?.hostDeviceId || !dump.jobId) return;
    setBusy(true);
    try {
      await apiSend("POST", `/api/devices/${encodeURIComponent(dump.hostDeviceId)}/agent/backups/${encodeURIComponent(dump.jobId)}/run`);
      toast.success("Database dump started; verify again when it finishes");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the database dump");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-warning/10 px-3 py-2 text-sm">
      <DatabaseBackup className="size-4 text-warning" />
      <span className="min-w-0 flex-1">{dump.detail}</span>
      {canRun ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run()}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          Run backup now
        </Button>
      ) : null}
      <Link href="/backups" className="text-sm font-medium text-primary hover:underline">
        Backups
      </Link>
    </div>
  );
}

export function formatDate(ts: number | null | undefined): string {
  return ts == null ? "-" : new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function VerifyButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <Button size="sm" disabled={busy} onClick={onClick}>
      {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
      {busy ? "Verifying..." : "Verify now"}
    </Button>
  );
}

export function ReasonList({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
      {reasons.map((r, i) => (
        <li key={i}>{r}</li>
      ))}
    </ul>
  );
}

export function CopyRow({ copy }: { copy: CopyVerification }) {
  const pct = copy.expectedFiles > 0 ? Math.min(100, (copy.presentFiles / copy.expectedFiles) * 100) : 0;
  const problems = [
    copy.missing > 0 ? `${copy.missing} missing` : null,
    copy.sizeMismatch > 0 ? `${copy.sizeMismatch} size mismatch` : null,
    copy.hashMismatch > 0 ? `${copy.hashMismatch} hash mismatch` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-1.5 rounded-xl bg-surface-container px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{copy.name}</span>
        {copy.isHost ? <Badge variant="outline">Immich host</Badge> : null}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {copy.files.toLocaleString()} files, {formatBytes(copy.bytes)}
        </span>
      </div>
      <Progress value={pct} aria-label={`${copy.name} verified files`} />
      <div className="flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {copy.presentFiles.toLocaleString()} / {copy.expectedFiles.toLocaleString()} present
        </span>
        <span>verified {timeAgo(copy.verifiedAt)}</span>
      </div>
      {problems.length > 0 ? <div className="text-xs text-warning">{problems.join(", ")}</div> : null}
      {copy.otherFiles ? (
        <div className="text-xs text-muted-foreground">
          includes {copy.otherFiles.toLocaleString()} file{copy.otherFiles === 1 ? "" : "s"} on arm-free that Immich does not list
        </div>
      ) : null}
      {copy.extra > 0 ? (
        <div className="text-xs text-muted-foreground">
          {copy.extra.toLocaleString()} extra file{copy.extra === 1 ? "" : "s"} not on arm-free (informational)
        </div>
      ) : null}
      {copy.syncIssues.map((s, i) => (
        <div key={i} className="text-xs text-warning">
          Sync: {s}
        </div>
      ))}
      {(copy.syncNotes ?? []).map((s, i) => (
        <div key={`n${i}`} className="text-xs text-muted-foreground">
          Sync: {s}
        </div>
      ))}
      {copy.error ? <div className="text-xs text-destructive">{copy.error}</div> : null}
      {copy.verifiedAt != null ? <CopyDetails copy={copy} /> : null}
    </div>
  );
}

function CopyDetails({ copy }: { copy: CopyVerification }) {
  const extras = copy.problems.filter((p) => p.kind === "extra");
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">Details</summary>
      <div className="mt-1.5 grid gap-2 rounded-lg bg-background/60 p-2">
        <div>
          <p className="font-medium">File manifest</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 tabular-nums">
            <dt className="text-muted-foreground">files on disk</dt>
            <dd>
              {copy.files.toLocaleString()} ({formatBytes(copy.bytes)})
            </dd>
            <dt className="text-muted-foreground">expected</dt>
            <dd>
              {copy.expectedFiles.toLocaleString()}
              {copy.otherFiles
                ? ` (${(copy.expectedFiles - copy.otherFiles).toLocaleString()} from Immich + ${copy.otherFiles.toLocaleString()} other on arm-free)`
                : ""}
            </dd>
            <dt className="text-muted-foreground">present / hashed</dt>
            <dd>
              {copy.presentFiles.toLocaleString()} / {copy.hashed.toLocaleString()}
            </dd>
            <dt className="text-muted-foreground">missing / size / hash</dt>
            <dd>
              {copy.missing} / {copy.sizeMismatch} / {copy.hashMismatch}
            </dd>
            <dt className="text-muted-foreground">extra</dt>
            <dd>{copy.extra}</dd>
          </dl>
          <p className="mt-1 text-muted-foreground">
            Excluded everywhere: .stfolder, .stignore, .stversions, Syncthing temp files, conflict copies, hidden and OS files, and
            anything outside upload/ and library/.
          </p>
        </div>
        {copy.otherPaths?.length ? (
          <div>
            <p className="font-medium">On arm-free but not listed by Immich</p>
            <ul className="break-all text-muted-foreground">
              {copy.otherPaths.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {extras.length ? (
          <div>
            <p className="font-medium">Extra files (not on arm-free)</p>
            <ul className="break-all text-muted-foreground">
              {extras.map((p) => (
                <li key={p.path}>{p.path}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {(copy.syncFolders ?? []).map((f) => (
          <div key={f.folderId}>
            <p className="font-medium">
              {f.label}: {f.state}
              {f.completion != null ? ` (${Math.floor(f.completion)}%)` : ""}
            </p>
            {f.reason ? <p className="text-muted-foreground">{f.reason}</p> : null}
            {f.detail ? <SyncDetails detail={f.detail} /> : null}
          </div>
        ))}
      </div>
    </details>
  );
}
