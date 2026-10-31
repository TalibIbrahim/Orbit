import type { ReplicationHealth } from "@orbit/shared";
import { Monitor } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, timeAgo } from "@/lib/format";
import { ToneBadge } from "./tone-badge";

export function PrimaryCard({ data }: { data: ReplicationHealth }) {
  const p = data.primary;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Monitor className="size-4 text-muted-foreground" />
          {p?.name ?? "Primary (PC)"}
          <Badge variant="secondary">Source of truth</Badge>
          {p ? (
            p.online ? (
              <ToneBadge tone="success">Online</ToneBadge>
            ) : (
              <ToneBadge tone="muted">Offline, last seen {timeAgo(p.lastSeen)}</ToneBadge>
            )
          ) : (
            <ToneBadge tone="muted">Not enrolled</ToneBadge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.sharedFolders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No shared folders yet.</p>
        ) : (
          data.sharedFolders.map((f) => (
            <div key={f.id} className="flex items-center justify-between gap-2 rounded-xl bg-surface-container px-3 py-2">
              <div className="min-w-0">
                <div className="truncate font-medium">{f.label}</div>
                <div className="truncate text-xs text-muted-foreground">{f.id}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="outline">{f.type === "sendonly" ? "Send Only" : f.type}</Badge>
                <span className="text-sm tabular-nums">{formatBytes(f.globalBytes)}</span>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
