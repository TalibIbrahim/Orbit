"use client";

import type { ImmichVerifySettings } from "@orbit/shared";
import { Loader2, PlugZap } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { apiGet, apiSend } from "@/lib/api";
import { SaveBar } from "./save-bar";
import type { SettingsApi } from "./use-settings";

const MASK = "••••";

interface ImmichUser {
  id: string;
  name: string;
  email: string;
}
interface TestResult {
  ok: boolean;
  version?: string;
  user?: string;
  error?: string;
}

function NumberField({
  id,
  label,
  help,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(Math.min(max, Math.max(min, Math.round(Number(e.target.value) || 0))))}
      />
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  );
}

export function ImmichTab({ api }: { api: SettingsApi }) {
  const { draft, setDraft, loading } = api;
  const [users, setUsers] = useState<ImmichUser[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  if (loading || !draft) return <Skeleton className="h-96 rounded-2xl" />;

  const im = draft.immich;
  const set = (patch: Partial<ImmichVerifySettings>) => setDraft({ ...draft, immich: { ...im, ...patch } });
  const keySaved = im.apiKey === MASK;

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      setResult(
        await apiSend<TestResult>("POST", "/api/immich/test", {
          url: im.url || undefined,
          apiKey: im.apiKey || undefined,
        }),
      );
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function loadUsers() {
    setLoadingUsers(true);
    setUsersError(null);
    try {
      setUsers(await apiGet<ImmichUser[]>("/api/immich/users"));
    } catch (e) {
      setUsersError(e instanceof Error ? e.message : "Could not load users");
    } finally {
      setLoadingUsers(false);
    }
  }

  function toggleUser(id: string, on: boolean) {
    set({ sourceUserIds: on ? [...im.sourceUserIds, id] : im.sourceUserIds.filter((x) => x !== id) });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5">
            <Label htmlFor="immich-url">Immich URL</Label>
            <Input
              id="immich-url"
              inputMode="url"
              placeholder="http://arm-free.<tailnet>.ts.net:2283"
              value={im.url}
              onChange={(e) => set({ url: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="immich-key">API key {keySaved ? <span className="text-success">(Saved)</span> : null}</Label>
            <Input
              id="immich-key"
              type="password"
              autoComplete="off"
              placeholder={keySaved ? "Saved - type to replace" : "Paste API key"}
              value={keySaved ? "" : (im.apiKey ?? "")}
              onChange={(e) => set({ apiKey: e.target.value === "" && keySaved ? MASK : e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Create it in Immich, Account Settings, API Keys, with only the asset.read and user.read permissions.
              Stored encrypted on the hub and never shown again.
            </p>
            {keySaved ? (
              <Button variant="outline" size="sm" onClick={() => set({ apiKey: "" })}>
                Remove saved key
              </Button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" disabled={testing || !im.url} onClick={() => void test()}>
              {testing ? <Loader2 className="animate-spin" /> : <PlugZap />}
              Test connection
            </Button>
            {result ? (
              <span className={`text-sm ${result.ok ? "text-success" : "text-destructive"}`}>
                {result.ok
                  ? `Connected${result.version ? `, Immich ${result.version}` : ""}${result.user ? ` as ${result.user}` : ""}`
                  : (result.error ?? "Connection failed")}
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Testing uses the saved key unless you typed a new one. Save first if you changed the URL on a saved key.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Users to track</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">None selected means all users the API key can see.</p>
          <Button variant="outline" size="sm" disabled={loadingUsers} onClick={() => void loadUsers()}>
            {loadingUsers ? <Loader2 className="animate-spin" /> : null}
            {users ? "Reload users" : "Load users"}
          </Button>
          {usersError ? <p className="text-sm text-destructive">{usersError}</p> : null}
          {users?.map((u) => (
            <label key={u.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={im.sourceUserIds.includes(u.id)}
                onChange={(e) => toggleUser(u.id, e.target.checked)}
              />
              <span className="font-medium">{u.name}</span>
              <span className="text-muted-foreground">{u.email}</span>
            </label>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rules</CardTitle>
        </CardHeader>
        <CardContent>
          <NumberField
            id="im-min"
            label="Minimum verified copies"
            help="How many copies must contain every file (1 to 10)."
            value={im.minCopies}
            min={1}
            max={10}
            onChange={(n) => set({ minCopies: n })}
          />
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label htmlFor="im-nonhost">Require a copy outside the Immich host</Label>
              <p className="text-xs text-muted-foreground">At least one verified copy must be on another device.</p>
            </div>
            <Switch id="im-nonhost" checked={im.requireNonHostCopy} onCheckedChange={(v) => set({ requireNonHostCopy: v })} />
          </div>
          <NumberField
            id="im-hash"
            label="Hash recent days"
            help="Compare checksums for every file uploaded in the last N days (0 to 365)."
            value={im.hashRecentDays}
            min={0}
            max={365}
            onChange={(n) => set({ hashRecentDays: n })}
          />
          <NumberField
            id="im-sample"
            label="Sample percent"
            help="Also hash a random sample of older files (0 to 100)."
            value={im.samplePercent}
            min={0}
            max={100}
            onChange={(n) => set({ samplePercent: n })}
          />
          <NumberField
            id="im-sched"
            label="Schedule (hours)"
            help="Run verification every N hours. 0 turns scheduled runs off."
            value={im.scheduleHours}
            min={0}
            max={720}
            onChange={(n) => set({ scheduleHours: n })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="im-nw">Notify when a new verified-through date is reached</Label>
            <Switch id="im-nw" checked={im.notifyWatermark} onCheckedChange={(v) => set({ notifyWatermark: v })} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="im-np">Notify on missing or mismatched files</Label>
            <Switch id="im-np" checked={im.notifyProblems} onCheckedChange={(v) => set({ notifyProblems: v })} />
          </div>
        </CardContent>
      </Card>
      <SaveBar api={api} />
    </div>
  );
}
