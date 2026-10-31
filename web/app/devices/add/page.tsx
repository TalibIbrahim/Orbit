"use client";

import type { AddDeviceResponse, DeviceRole, DeviceSummary, Platform } from "@orbit/shared";
import { Check, Copy, Loader2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { apiGet, apiSend } from "@/lib/api";
import { pickRole, useDevices } from "@/lib/hooks";
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

function PairStep({ deviceId, primary }: { deviceId: string; primary: DeviceSummary | undefined }) {
  const { data } = usePoll(() => apiGet<DeviceSummary>(`/api/devices/${encodeURIComponent(deviceId)}`), 3000, [deviceId]);
  const enrolled = data?.enrolled ?? false;

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
      </div>
    );
  }

  const primaryOffline = primary && !primary.online;
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
          Paired with {primary?.name ?? "the primary"} - receiving Immich library as Receive Only with versioning.
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
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [role, setRole] = useState<DeviceRole>("replica");
  const [platform, setPlatform] = useState<Platform>("linux");
  const [manual, setManual] = useState(false);
  const [agentUrl, setAgentUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<AddDeviceResponse | null>(null);

  const valid = name.trim() !== "" && (!manual || (agentUrl.trim() !== "" && token.trim() !== ""));

  async function create() {
    setBusy(true);
    try {
      const body = { name: name.trim(), role, platform, ...(manual ? { agentUrl: agentUrl.trim(), token: token.trim() } : {}) };
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
                      <SelectItem value="replica">Replica</SelectItem>
                      <SelectItem value="standby">Standby</SelectItem>
                      {!hasPrimary ? <SelectItem value="primary">Primary</SelectItem> : null}
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
                <li>Installs Tailscale, Syncthing and the Orbit agent.</li>
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

          {step === 2 && created ? <PairStep deviceId={created.device.id} primary={pickRole(devices, "primary")} /> : null}
        </CardContent>
      </Card>
    </div>
  );
}
