import { CloudOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "@/lib/format";

export interface OfflineBadgeProps {
  online: boolean;
  lastSeen: number | null | undefined;
  stale?: boolean;
  className?: string;
}

/** Renders nothing when online and fresh. Offline devices show last-known data plus this badge, never an error page. */
export function OfflineBadge({ online, lastSeen, stale = false, className }: OfflineBadgeProps) {
  if (online && !stale) return null;
  const text = !online
    ? lastSeen
      ? `Offline · last seen ${timeAgo(lastSeen)}`
      : "Offline"
    : "Showing cached data";
  return (
    <Badge variant="secondary" className={className}>
      <CloudOff />
      {text}
    </Badge>
  );
}
