"use client";

import type { PrimaryMode } from "@orbit/shared";
import { Smartphone, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { SaveBar } from "./save-bar";
import type { SettingsApi } from "./use-settings";

const APP_VERSION = "0.1.0";

export function GeneralTab({ api }: { api: SettingsApi }) {
  const { draft, setDraft, loading } = api;
  if (loading || !draft) return <Skeleton className="h-96 rounded-2xl" />;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Hub</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5">
            <Label>Hub URL</Label>
            <Input value={draft.hubUrl} onChange={(e) => setDraft({ ...draft, hubUrl: e.target.value })} />
            <p className="text-xs text-muted-foreground">Used by agents and install scripts to reach this hub.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Tailscale auth key</Label>
            <Input
              type="password"
              autoComplete="off"
              placeholder="tskey-auth-..."
              value={draft.tailscaleAuthKey ?? ""}
              onChange={(e) => setDraft({ ...draft, tailscaleAuthKey: e.target.value || null })}
            />
            <p className="text-xs text-muted-foreground">Optional. Baked into install scripts for new devices.</p>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Theme</span>
            <span>Use the theme toggle in the header (light, dark, system)</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">App version</span>
            <Badge variant="secondary">{APP_VERSION}</Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Primary mode</CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={draft.primaryMode} onValueChange={(v) => setDraft({ ...draft, primaryMode: v as PrimaryMode })}>
            <SelectTrigger className="w-full" aria-label="Primary mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="device">Device primary</SelectItem>
              <SelectItem value="arm-free">arm-free primary</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {draft.primaryMode === "arm-free"
              ? "Immich runs on arm-free; other devices are replicas."
              : "Immich runs on a home PC; arm-free is a standby."}
          </p>
          <Alert>
            <TriangleAlert className="text-warning" />
            <AlertTitle>Changing this does not move anything</AlertTitle>
            <AlertDescription>
              It does not move data or reconfigure Immich or Syncthing. The mode is normally chosen at install time
              (<code className="font-mono">install-arm-free.sh --mode arm-free</code>).
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Replica versioning</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5">
            <Label htmlFor="ver-days">Keep old versions for N days</Label>
            <Input
              id="ver-days"
              type="number"
              inputMode="numeric"
              min={1}
              max={3650}
              value={draft.versioningMaxAgeDays ?? 30}
              onChange={(e) => setDraft({ ...draft, versioningMaxAgeDays: Number(e.target.value) })}
            />
            <p className="text-xs text-muted-foreground">
              Applies to staggered versioning on replicas when they are (re)paired. Allowed range: 1 to 3650 days.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="size-4 text-muted-foreground" />
            Install on iPhone
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Open Orbit in Safari.</li>
            <li>Tap the Share button.</li>
            <li>Choose Add to Home Screen, then Add.</li>
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Shared folders for new replicas</CardTitle>
        </CardHeader>
        <CardContent>
          {draft.sharedFolders.length === 0 ? (
            <p className="text-sm text-muted-foreground">None configured.</p>
          ) : (
            draft.sharedFolders.map((f) => (
              <div key={f.id} className="rounded-xl bg-surface-container px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{f.label}</span>
                  <Badge variant="outline">Versioning: {f.versioning}</Badge>
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {f.id} → {f.replicaPath}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
      <SaveBar api={api} />
    </div>
  );
}
