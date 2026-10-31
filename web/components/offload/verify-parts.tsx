"use client";

import type { CopyVerification, OffloadState } from "@orbit/shared";
import { CheckCircle2, CircleHelp, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
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
      {copy.syncIssues.map((s, i) => (
        <div key={i} className="text-xs text-warning">
          Sync: {s}
        </div>
      ))}
      {copy.error ? <div className="text-xs text-destructive">{copy.error}</div> : null}
    </div>
  );
}
