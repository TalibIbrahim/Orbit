"use client";

import type { DeviceSummary, HubSettings, KeepaliveState, ReplicationHealth } from "@orbit/shared";
import { CheckCircle2, Circle, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiGet } from "@/lib/api";
import { pickHost, useAgent } from "@/lib/hooks";
import { usePoll } from "@/lib/use-poll";

const KEY = "orbit.onboarding.dismissed";

interface Step {
  key: string;
  label: string;
  done: boolean;
  href: string;
  cta: string;
  recommended?: boolean;
  /** manual step we cannot detect; ignored when deciding if everything is done */
  manual?: boolean;
}

export function GettingStartedCard({
  devices,
  replication,
}: {
  devices: DeviceSummary[] | undefined;
  replication: ReplicationHealth | undefined;
}) {
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDismissed(localStorage.getItem(KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  const settings = usePoll(() => apiGet<HubSettings>("/api/settings"), 0);
  const armFree = settings.data?.primaryMode === "arm-free";
  const standby = devices?.find((d) => d.role === "standby" && d.enrolled);
  const primary = devices?.find((d) => d.role === "primary" && d.enrolled);
  const keepalive = useAgent<KeepaliveState>(armFree ? undefined : standby?.id, "/keepalive", 60_000);

  if (dismissed || !devices || !settings.data) return null;

  const s = settings.data;
  const alertsDone = !!s.discordWebhookUrl || !!s.email?.enabled;
  const host = pickHost(devices, "arm-free");
  const steps: Step[] = armFree
    ? [
        {
          key: "install",
          label: "Install arm-free with --mode arm-free (Immich starts automatically)",
          done: !!host && host.enrolled,
          href: "/devices/add",
          cta: "How",
        },
        {
          key: "immich",
          label: "Open Immich at http://arm-free.<tailnet>.ts.net:2283 and create the admin account",
          done: !!host?.online,
          href: "/devices",
          cta: "Devices",
          manual: true,
        },
        {
          key: "replicas",
          label: "Add replicas (PC, laptop) from Devices > Add device",
          done: !!devices.some((d) => d.role === "replica" && d.enrolled),
          href: "/devices/add",
          cta: "Add device",
        },
        {
          key: "phone",
          label:
            "Phones: install Tailscale and the Immich app, server URL http://arm-free.<tailnet>.ts.net:2283; keep Tailscale on (background backup needs the tunnel)",
          done: false,
          href: "/settings?tab=general",
          cta: "Info",
          manual: true,
        },
        {
          key: "alerts",
          label: "Optional: configure alerts (Discord or email)",
          done: alertsDone,
          href: "/settings",
          cta: "Configure",
        },
      ]
    : [
    { key: "standby", label: "Standby VM connected", done: !!standby, href: "/devices", cta: "Add device" },
    { key: "primary", label: "Primary PC added", done: !!primary, href: "/devices", cta: "Add device" },
    {
      key: "keepalive",
      label: "Keep-alive enabled on the standby",
      done: !!keepalive.data?.data?.enabled,
      href: "/settings?tab=standby",
      cta: "Enable",
      recommended: true,
    },
    {
      key: "alerts",
      label: "Alerts configured",
      done: alertsDone,
      href: "/settings",
      cta: "Configure",
    },
    {
      key: "replication",
      label: "Replication up to date",
      done: !!replication?.replicas.some((r) => r.folders.some((f) => f.state === "up-to-date")),
      href: "/replication",
      cta: "View",
    },
  ];
  if (steps.every((x) => x.done || x.manual)) return null;

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(KEY, "1");
    } catch {}
  }

  return (
    <Card size="sm" className="mb-3">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          Getting started
          <Button variant="ghost" size="icon-sm" onClick={dismiss} aria-label="Dismiss getting started">
            <X />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2">
          {steps.map((st) => (
            <li key={st.key} className="flex items-center gap-2 text-sm">
              {st.done ? (
                <CheckCircle2 className="size-4 shrink-0 text-success" />
              ) : (
                <Circle className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className={st.done ? "text-muted-foreground line-through" : ""}>{st.label}</span>
              {st.recommended && !st.done ? (
                <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning">Recommended</span>
              ) : null}
              {!st.done ? (
                <Button asChild size="sm" variant={st.recommended ? "default" : "outline"} className="ml-auto">
                  <Link href={st.href}>{st.cta}</Link>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
