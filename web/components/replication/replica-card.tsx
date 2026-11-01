import type { ReplicaHealth, ReplicaState } from "@orbit/shared";
import { Info, Server } from "lucide-react";
import { DeviceWarnings } from "@/components/devices/device-list";
import { OfflineBadge } from "@/components/offline-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatBytes, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SyncDetails } from "./sync-details";
import { TONE_TEXT, ToneBadge, type Tone } from "./tone-badge";

type Folder = ReplicaHealth["folders"][number];

const DAY_MS = 86_400_000;
const ROLE_LABEL = { primary: "Primary", standby: "Standby", replica: "Replica" } as const;

const STATE_TONE: Record<ReplicaState, Tone> = {
  "up-to-date": "success",
  syncing: "primary",
  offline: "muted",
  unknown: "muted",
  paused: "muted",
  "peer-offline": "warning",
  "nothing-to-sync": "success",
  error: "danger",
};

function stateLabel(f: Folder): string {
  switch (f.state) {
    case "up-to-date":
      return "Up to date";
    case "syncing":
      return f.completion != null ? `Syncing ${Math.floor(f.completion)}%` : "Syncing";
    case "offline":
      return "Offline";
    case "paused":
      return "Paused";
    case "peer-offline":
      return "Peer offline";
    case "nothing-to-sync":
      return "Nothing to sync";
    case "error":
      return "Error";
    default:
      return "Unknown";
  }
}

export function lagText(lagMs: number | null): { text: string; tone: Tone } {
  if (lagMs == null) return { text: "lag unknown", tone: "muted" };
  if (lagMs < 60_000) return { text: "in sync", tone: "success" };
  return { text: `${formatDuration(lagMs)} behind`, tone: lagMs >= DAY_MS ? "warning" : "muted" };
}

function FolderRow({ f }: { f: Folder }) {
  const lag = lagText(f.state === "up-to-date" ? 0 : f.lagMs);
  return (
    <div className="space-y-2 rounded-xl bg-surface-container p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{f.label}</span>
        <ToneBadge tone={STATE_TONE[f.state]}>{stateLabel(f)}</ToneBadge>
      </div>
      <Progress value={f.completion ?? 0} className="h-2 bg-foreground/10" />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {f.needItems ?? 0} items · {formatBytes(f.needBytes ?? 0)} pending
        </span>
        <span className={cn("font-medium", TONE_TEXT[lag.tone])}>{lag.text}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {f.replicaType === "receiveonly" ? (
          <Badge variant="outline">Receive Only</Badge>
        ) : f.replicaType ? (
          <ToneBadge tone="warning">{f.replicaType}</ToneBadge>
        ) : (
          <Badge variant="outline">type unknown</Badge>
        )}
        {f.versioning ? (
          <Badge variant="outline">Versioning: {f.versioning}</Badge>
        ) : (
          <ToneBadge tone="danger">No versioning</ToneBadge>
        )}
      </div>
      {f.reason ? <p className="text-xs text-muted-foreground">{f.reason}</p> : null}
      {f.detail ? <SyncDetails detail={f.detail} /> : null}
      {f.issue ? (
        <p className="flex gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>{f.issue}</span>
        </p>
      ) : null}
    </div>
  );
}

export function ReplicaCard({ replica }: { replica: ReplicaHealth }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Server className="size-4 text-muted-foreground" />
          {replica.name}
          <Badge variant="secondary">{ROLE_LABEL[replica.role]}</Badge>
          <OfflineBadge online={replica.online} lastSeen={replica.lastSeen} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <DeviceWarnings warnings={replica.warnings} />
        {replica.folders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No shared folders paired yet.</p>
        ) : (
          replica.folders.map((f) => <FolderRow key={f.folderId} f={f} />)
        )}
      </CardContent>
    </Card>
  );
}
