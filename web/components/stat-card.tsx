import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

/** <80 primary, 80-90 warning, >=90 danger. */
export function thresholdColor(value: number): "primary" | "warning" | "danger" {
  return value >= 90 ? "danger" : value >= 80 ? "warning" : "primary";
}

const BAR: Record<"primary" | "warning" | "danger", string> = {
  primary: "[&_[data-slot=progress-indicator]]:bg-primary",
  warning: "[&_[data-slot=progress-indicator]]:bg-warning",
  danger: "[&_[data-slot=progress-indicator]]:bg-danger",
};

export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  progress,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: LucideIcon;
  /** 0..100 */
  progress?: number;
  className?: string;
}) {
  const pct = progress == null ? null : Math.max(0, Math.min(100, progress));
  return (
    <Card size="sm" className={className}>
      <CardContent className="gap-2">
        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <span className="truncate">{label}</span>
          {Icon ? <Icon className="size-4 shrink-0" /> : null}
        </div>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
        {pct != null ? (
          <Progress value={pct} className={cn("h-2 bg-foreground/10", BAR[thresholdColor(pct)])} />
        ) : null}
        {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
      </CardContent>
    </Card>
  );
}
