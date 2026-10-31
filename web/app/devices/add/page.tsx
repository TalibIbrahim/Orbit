"use client";

import {
  defaultReplicaPath, type AddDeviceResponse, type DeviceRole, type DeviceSummary, type HubSettings, type Platform,
  type RejectedEnroll,
} from "@orbit/shared";
import { Check, Copy, Loader2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DeviceWarnings } from "@/components/devices/device-list";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { apiGet, apiSend } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { pickRole, useDevices, usePrimaryMode } from "@/lib/hooks";
import { usePoll } from "@/lib/use-poll";
import { cn } from "@/lib/utils";

const STEPS = ["Describe", "Install", "Pair"];

function Stepper({ step }: { step: number }) {
  return (
    <ol className="mb-6 flex items-center gap-2">
      {STEPS.map((label, i) => (
        <li key={label} className="flex flex-1 items-center gap-2">
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
              i < step ? "bg-primary text-primary-foreground" : i === step ? "bg-primary/15 text-primary ring-2 ring-primary" : "bg-muted text-muted-foreground",
            )}
          >
            {i < step ? <Check className="size-4" /> : i + 1}
          </span>
          <span className={cn("hidden text-sm sm:inline", i === step ? "font-medium" : "text-muted-foreground")}>{label}</span>
          {i < STEPS.length - 1 ? <span className={cn("h-px flex-1", i < step ? "bg-primary" : "bg-border")} /> : null}
        </li>
      ))}
    </ol>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-2xl bg-muted p-3">
      <code className="min-w-0 flex-1 break-all font-mono text-xs">{text}</code>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Copy command"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => toast.success("Command copied"),
            () => toast.error("Could not copy"),
          );
        }}
      >
        <Copy />
      </Button>
    </div>
  );
}

const STALL_MS = 90_000;

function PairStep({ deviceId, primary, hubUrl }: { deviceId: string; primary: DeviceSummary | undefined; hubUrl: string }) {
  const [waitedLong, setWaitedLong] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaitedLong(true), STALL_MS);
    return () => clearTimeout(t);
  }, []);
  const { data } = usePoll(() => apiGet<DeviceSummary>(`/api/devices/${encodeURIComponent(deviceId)}`), 3000, [deviceId]);
  const enrolled = data?.enrolled ?? false;
  const rejectedPoll = usePoll(() => (enrolled ? Promise.resolve({ rejected: [] }) : apiGet<{ rejected: RejectedEnroll[] }>("/api/enroll")), 5000, [enrolled]);
  // Only attempts made after this device was created can be about it.
  const rejected = (rejectedPoll.data?.rejected ?? []).filter((r) => data && r.at >= data.createdAt);
  const stalled = !enrolled && waitedLong;
  const win = data?.platform === "windows";

  if (!enrolled) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Loader2 className="size-5 animate-spin text-primary" />
          <span className="font-medium">Waiting for the agent to check in…</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        </div>
        <p className="text-sm text-muted-foreground">Run the install command on the device. This page updates automatically.</p>
        {data?.enrollError ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>The agent&apos;s enroll request failed {timeAgo(data.enrollAttemptAt)}</AlertTitle>
            <AlertDescription>{data.enrollError}</AlertDescription>
          </Alert>
        ) : null}
        {rejected.map((r) => (
          <Alert key={`${r.hostname}-${r.at}`}>
            <TriangleAlert className="text-warning" />
            <AlertTitle>Rejected enroll from {r.hostname} {timeAgo(r.at)}</AlertTitle>
            <AlertDescription>
              {r.reason}. That agent still uses an old agent.json{r.deviceId ? ` (device "${r.deviceId}")` : ""}. Re-run the
              install command above on it: it backs up and replaces agent.json and clears the old agent state.
            </AlertDescription>
          </Alert>
        ))}
        {stalled && !data?.enrollError && rejected.length === 0 ? (
          <Alert>
            <TriangleAlert className="text-warning" />
            <AlertTitle>No enroll request has reached the hub yet</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                <li>
                  Check the agent log for <code>[enroll]</code> lines:{" "}
                  <code>{win ? "C:\\ProgramData\\Orbit\\logs\\agent.log" : "journalctl -u orbit-agent | grep enroll"}</code>. Each attempt
                  is logged with the HTTP status or the network error.
                </li>
                <li>
                  From the device, the hub must answer: <code>{win ? `irm ${hubUrl}/api/agent/version` : `curl ${hubUrl}/api/agent/version`}</code>
                </li>
                <li>
                  <code>hubUrl</code> in the device&apos;s agent.json must be <code>{hubUrl}</code>. Re-running the install command fixes it.
                </li>
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
    );
  }

  const primaryOffline = primary && !primary.online;
  const warnings = data?.warnings ?? [];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-5" />
        </span>
        <span className="font-medium">{data?.name} is enrolled</span>
      </div>
      {data?.role === "primary" ? (
        <p className="text-sm text-muted-foreground">This is the primary device; replicas will pair with it as they enroll.</p>
      ) : warnings.length ? (
        <DeviceWarnings warnings={warnings} />
      ) : primaryOffline ? (
        <Alert>
          <TriangleAlert className="text-warning" />
          <AlertTitle>Pairing pending</AlertTitle>
          <AlertDescription>
            {primary?.name} is offline. This device will pair automatically when it comes online.
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-sm text-muted-foreground">
          Paired with {primary?.name ?? "the primary"} - receiving the Immich library as Receive Only with versioning.
        </p>
      )}
      <Link href="/devices" className={cn(buttonVariants())}>
        View devices
      </Link>
    </div>
  );
}

export default function AddDevicePage() {
  const { data: devices } = useDevices(30_000);
  const hasPrimary = !!pickRole(devices, "primary");
  const { mode } = usePrimaryMode();
  const armFree = mode === "arm-free";
  const settings = usePoll(() => apiGet<HubSettings>("/api/settings"), 0);
  const folders = useMemo(() => settings.data?.sharedFolders ?? [], [settings.data]);
  const [pathEdits, setPathEdits] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [role, setRole] = useState<DeviceRole>("replica");
  const [platform, setPlatform] = useState<Platform>("linux");
  const [manual, setManual] = useState(false);
  const [agentUrl, setAgentUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<AddDeviceResponse | null>(null);

  const pathFor = (id: string) => pathEdits[id] ?? defaultReplicaPath(id, platform);
  const isAbs = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/");
  const replicaPaths: Record<string, string> = Object.fromEntries(folders.map((f) => [f.id, pathFor(f.id).trim()]));
  const pathsOk = role !== "replica" || Object.values(replicaPaths).every(isAbs);
  const hostChosen = armFree && role === "primary";

  const valid = !hostChosen && pathsOk && name.trim() !== "" && (!manual || (agentUrl.trim() !== "" && token.trim() !== ""));

  async function create() {
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        role,
        platform,
        ...(role === "replica" && folders.length > 0 ? { replicaPaths } : {}),
        ...(manual ? { agentUrl: agentUrl.trim(), token: token.trim() } : {}),
      };
      const res = await apiSend<AddDeviceResponse>("POST", "/api/devices", body);
      setCreated(res);
      setStep(manual ? 2 : 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add device");
    } finally {
      setBusy(false);
    }
  }

  const command = created ? (platform === "windows" ? created.windowsCommand : created.linuxCommand) : "";

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Add device" description="Connect a new machine to Orbit" />
      <Stepper step={step} />
      <Card className="rounded-2xl">
        <CardContent className="space-y-5">
          {step === 0 ? (
            <form
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                if (valid) void create();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="d-name">Name</Label>
                <Input id="d-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Dad's laptop" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Role</Label>
                  <Select value={role} onValueChange={(v) => setRole(v as DeviceRole)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {armFree ? (
                        <>
                          <SelectItem value="replica">Replica (PC, laptop, other devices)</SelectItem>
                          <SelectItem value="primary" disabled={hasPrimary}>
                            Primary host (arm-free)
                          </SelectItem>
                        </>
                      ) : (
                        <>
                          <SelectItem value="replica">Replica</SelectItem>
                          <SelectItem value="standby">Standby</SelectItem>
                          {!hasPrimary ? <SelectItem value="primary">Primary</SelectItem> : null}
                        </>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Platform</Label>
                  <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="linux">Linux</SelectItem>
                      <SelectItem value="windows">Windows</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {armFree && hasPrimary ? (
                <p className="text-xs text-muted-foreground">
                  Primary host is unavailable: arm-free is already registered as the primary.
                </p>
              ) : null}
              {hostChosen ? (
                <Alert>
                  <TriangleAlert className="text-warning" />
                  <AlertTitle>arm-free sets itself up</AlertTitle>
                  <AlertDescription>
                    <p>
                      Run <code className="font-mono">sudo deploy/arm-free/scripts/install-arm-free.sh --mode arm-free</code>{" "}
                      on the VM (add <code className="font-mono">--no-ml</code> to skip machine learning). It
                      registers itself automatically; no install command is needed here.
                    </p>
                  </AlertDescription>
                </Alert>
              ) : null}
              {role === "replica" ? (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Replicas are Receive Only copies with file versioning. The installer adds only Tailscale, Syncthing,
                    Node and the Orbit agent (no Docker, no virtualization).
                  </p>
                  {folders.length > 0 ? (
                    <div className="space-y-3">
                      <Label>Replica folders</Label>
                      {folders.map((f) => {
                        const v = pathFor(f.id);
                        const bad = v.trim() !== "" && !isAbs(v.trim());
                        return (
                          <div key={f.id} className="space-y-1.5">
                            <Label htmlFor={`rp-${f.id}`} className="text-xs font-normal text-muted-foreground">
                              {f.label} <span className="font-mono">({f.id})</span>
                            </Label>
                            <Input
                              id={`rp-${f.id}`}
                              value={v}
                              aria-invalid={bad || undefined}
                              onChange={(e) => setPathEdits({ ...pathEdits, [f.id]: e.target.value })}
                              className="font-mono text-xs"
                            />
                            {bad ? <p className="text-xs text-danger">Use an absolute path.</p> : null}
                          </div>
                        );
                      })}
                      <p className="text-xs text-muted-foreground">
                        Any drive, e.g. D:\Orbit\immich-library or /mnt/backup/immich-library
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-3 rounded-2xl border p-3">
                <Label htmlFor="d-manual" className="text-sm">
                  I already installed the agent
                </Label>
                <Switch id="d-manual" checked={manual} onCheckedChange={setManual} />
              </div>
              {manual ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="d-url">Agent URL</Label>
                    <Input id="d-url" value={agentUrl} onChange={(e) => setAgentUrl(e.target.value)} placeholder="http://100.x.y.z:7420" className="font-mono text-xs" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="d-token">Token</Label>
                    <Input id="d-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} className="font-mono text-xs" />
                  </div>
                </div>
              ) : null}
              <Button type="submit" className="w-full" disabled={!valid || busy}>
                {busy ? "Creating…" : manual ? "Add device" : "Continue"}
              </Button>
            </form>
          ) : null}

          {step === 1 && created ? (
            <div className="space-y-4">
              <p className="text-sm">
                Run this on <b>{created.device.name}</b> ({platform === "windows" ? "elevated PowerShell" : "as root / with sudo"}):
              </p>
              <CodeBlock text={command} />
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>Installs only Tailscale, Syncthing, Node and the Orbit agent (no Docker).</li>
                <li>{platform === "windows" ? "Open PowerShell with Run as administrator." : "Needs root; the command uses sudo."}</li>
                <li>The token is embedded in the command and shown only once.</li>
              </ul>
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>Keep this command secret</AlertTitle>
                <AlertDescription>Anyone with it can enroll a machine as this device.</AlertDescription>
              </Alert>
              <Button className="w-full" onClick={() => setStep(2)}>
                I ran it
              </Button>
            </div>
          ) : null}

          {step === 2 && created ? (
            <PairStep
              deviceId={created.device.id}
              primary={pickRole(devices, "primary")}
              hubUrl={/(https?:\/\/\S+?)\/install\//.exec(created.linuxCommand)?.[1] ?? "<hub-url>"}
            />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
