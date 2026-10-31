"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { ImmichLinks } from "@orbit/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api";
import { usePoll } from "@/lib/use-poll";

type Mode = "auto" | "lan" | "tailscale";
type Via = "lan" | "tailscale" | "standby";
const STORAGE_KEY = "orbit.immichMode";

function readMode(): Mode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "lan" || v === "tailscale" || v === "auto") return v;
  } catch {
    /* storage unavailable */
  }
  return "auto";
}

/**
 * Probe the LAN URL. NOTE: from an https Orbit page, an http:// LAN probe is blocked as mixed content,
 * so the probe rejects and we treat it as "not on LAN" (falling back to Tailscale).
 */
async function onLan(lanUrl: string): Promise<boolean> {
  try {
    await fetch(`${lanUrl.replace(/\/$/, "")}/api/server/ping`, {
      mode: "no-cors",
      signal: AbortSignal.timeout(1500),
      cache: "no-store",
    });
    return true;
  } catch {
    return false;
  }
}

export function ImmichLink({ className }: { className?: string }) {
  const { data: links, loading } = usePoll(() => apiGet<ImmichLinks>("/api/immich"), 60_000);
  const [mode, setMode] = useState<Mode>("auto");
  const [lanOk, setLanOk] = useState<boolean | null>(null);
  const lanUrl = links?.lanUrl ?? null;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate persisted preference after mount
    setMode(readMode());
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!lanUrl || mode !== "auto") return;
    void onLan(lanUrl).then((ok) => {
      if (!cancelled) setLanOk(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [lanUrl, mode]);

  const changeMode = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* ignore */
    }
  };

  if (loading) return <Skeleton className={`h-9 w-36 rounded-full ${className ?? ""}`} />;
  if (!links) return null;

  let url: string | null;
  let via: Via;
  if (links.promoted && links.standbyUrl) {
    url = links.standbyUrl;
    via = "standby";
  } else if (mode === "lan" && links.lanUrl) {
    url = links.lanUrl;
    via = "lan";
  } else if (mode === "tailscale" && links.tailscaleUrl) {
    url = links.tailscaleUrl;
    via = "tailscale";
  } else if (mode === "auto" && links.lanUrl && lanOk) {
    url = links.lanUrl;
    via = "lan";
  } else {
    url = links.tailscaleUrl ?? links.lanUrl;
    via = "tailscale";
  }

  const caption = via === "lan" ? "via LAN" : via === "standby" ? "standby" : "via Tailscale";
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}>
      {url ? (
        <Button asChild>
          <a href={url} target="_blank" rel="noopener noreferrer">
            Open Immich <ExternalLink />
          </a>
        </Button>
      ) : (
        <Button disabled>Immich not configured</Button>
      )}
      <span className="text-xs text-muted-foreground">{caption}</span>
      {links.promoted ? <Badge className="bg-warning/15 text-warning">Standby (promoted)</Badge> : null}
      <Select value={mode} onValueChange={(v) => changeMode(v as Mode)}>
        <SelectTrigger size="sm" className="ml-auto w-28" aria-label="Immich link mode">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">Auto</SelectItem>
          <SelectItem value="lan">LAN</SelectItem>
          <SelectItem value="tailscale">Tailscale</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
