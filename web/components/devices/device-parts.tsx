"use client";

import type { DeviceRole, DeviceSummary, Platform } from "@orbit/shared";
import { Laptop, Monitor, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const ROLE: Record<DeviceRole, { label: string; cls: string }> = {
  primary: { label: "Primary", cls: "bg-primary text-primary-foreground" },
  standby: { label: "Standby", cls: "bg-warning/15 text-warning" },
  replica: { label: "Replica", cls: "bg-secondary text-secondary-foreground" },
};

export function RoleBadge({ role }: { role: DeviceRole }) {
  return <Badge className={ROLE[role].cls}>{ROLE[role].label}</Badge>;
}

export function PlatformIcon({ platform, className }: { platform: Platform | null; className?: string }) {
  const Icon = platform === "windows" ? Monitor : platform === "darwin" ? Laptop : Server;
  return <Icon className={cn("size-5 text-muted-foreground", className)} aria-label={platform ?? "unknown"} />;
}

export function OnlineDot({ online, pulse }: { online: boolean; pulse?: boolean }) {
  return (
    <span className="relative flex size-2.5 shrink-0">
      {pulse ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-warning opacity-70" /> : null}
      <span className={cn("relative inline-flex size-2.5 rounded-full", pulse ? "bg-warning" : online ? "bg-primary" : "bg-muted-foreground/50")} />
    </span>
  );
}

export function tailscaleText(d: DeviceSummary): string {
  const t = d.status?.tailscale;
  if (!t || !t.available) return "Tailscale unavailable";
  return `${t.online ? "Online" : "Offline"}${t.ip ? ` · ${t.ip}` : ""}`;
}
