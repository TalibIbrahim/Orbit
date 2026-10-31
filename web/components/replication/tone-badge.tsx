import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type Tone = "success" | "warning" | "danger" | "primary" | "muted";

const TONES: Record<Tone, string> = {
  success: "bg-success/15 text-success",
  warning: "bg-warning/20 text-warning",
  danger: "bg-danger/15 text-danger",
  primary: "bg-primary/15 text-primary",
  muted: "bg-muted text-muted-foreground",
};

export function ToneBadge({ tone, className, ...props }: { tone: Tone } & ComponentProps<typeof Badge>) {
  return <Badge variant="ghost" className={cn(TONES[tone], className)} {...props} />;
}

export const TONE_TEXT: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  primary: "text-primary",
  muted: "text-muted-foreground",
};
