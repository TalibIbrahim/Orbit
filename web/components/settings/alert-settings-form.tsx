"use client";

import type { HubSettings } from "@orbit/shared";
import { Send } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { apiSend } from "@/lib/api";
import { SaveBar } from "./save-bar";
import { EMPTY_EMAIL, type EmailSettings, type SettingsApi } from "./use-settings";

function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

type Thresholds = HubSettings["thresholds"];

const THRESHOLDS: { key: keyof Thresholds; label: string }[] = [
  { key: "replicaBehindHours", label: "Replica behind (hours)" },
  { key: "primaryOfflineDays", label: "PC offline (days)" },
  { key: "diskPercent", label: "Disk usage (%)" },
  { key: "ramPercent", label: "RAM usage (%)" },
  { key: "libraryPercent", label: "Immich library volume (%)" },
];

export function AlertSettingsForm({ api }: { api: SettingsApi }) {
  const { draft, setDraft, loading } = api;
  const [testing, setTesting] = useState(false);

  if (loading || !draft) return <Skeleton className="h-96 rounded-2xl" />;

  const email = draft.email ?? EMPTY_EMAIL;
  const patch = (p: Partial<HubSettings>) => setDraft({ ...draft, ...p });
  const patchEmail = (p: Partial<EmailSettings>) => patch({ email: { ...email, ...p } });

  async function test() {
    setTesting(true);
    try {
      // Save first so the test uses what is on screen.
      await api.save();
      const r = await apiSend<{ ok: boolean; error?: string }>("POST", "/api/settings/test-alert");
      if (r.ok) toast.success("Test alert sent");
      else toast.error(r.error ?? "Test alert failed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test alert failed");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Discord</CardTitle>
        </CardHeader>
        <CardContent>
          <Field label="Webhook URL">
            <Input
              type="url"
              placeholder="https://discord.com/api/webhooks/..."
              value={draft.discordWebhookUrl ?? ""}
              onChange={(e) => patch({ discordWebhookUrl: e.target.value || null })}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            Email
            <Switch checked={email.enabled} onCheckedChange={(enabled) => patchEmail({ enabled })} aria-label="Enable email" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="SMTP host">
              <Input value={email.smtpHost} onChange={(e) => patchEmail({ smtpHost: e.target.value })} />
            </Field>
            <Field label="SMTP port">
              <Input
                type="number"
                inputMode="numeric"
                value={email.smtpPort}
                onChange={(e) => patchEmail({ smtpPort: Number(e.target.value) })}
              />
            </Field>
            <Field label="User">
              <Input autoComplete="off" value={email.user} onChange={(e) => patchEmail({ user: e.target.value })} />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="••••"
                value={email.password ?? ""}
                onChange={(e) => patchEmail({ password: e.target.value })}
              />
            </Field>
            <Field label="From">
              <Input type="email" value={email.from} onChange={(e) => patchEmail({ from: e.target.value })} />
            </Field>
            <Field label="To">
              <Input type="email" value={email.to} onChange={(e) => patchEmail({ to: e.target.value })} />
            </Field>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Switch checked={email.secure} onCheckedChange={(secure) => patchEmail({ secure })} aria-label="Use TLS" />
            <span className="text-sm">Use TLS (port 465)</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Thresholds</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            {THRESHOLDS.map((t) => (
              <Field key={t.key} label={t.label}>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  value={draft.thresholds[t.key] ?? 90}
                  onChange={(e) => patch({ thresholds: { ...draft.thresholds, [t.key]: Number(e.target.value) } })}
                />
              </Field>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            The library volume threshold is used in arm-free primary mode.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" disabled={testing} onClick={() => void test()}>
          <Send />
          Send test alert
        </Button>
        <SaveBar api={api} />
      </div>
    </div>
  );
}
