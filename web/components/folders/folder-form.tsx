"use client";

import { GB, TB } from "@orbit/shared";
import type {
  DeviceSummary,
  EnforcementMode,
  FolderLimit,
  FolderLimitInput,
  FolderLimitsResponse,
  SyncthingSummary,
} from "@orbit/shared";
import { Copy, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { FolderPicker, basename } from "@/components/folders/folder-picker";
import { isWindows, overcommitBytes } from "@/components/folders/folder-utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiSend } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { useAgent } from "@/lib/hooks";

const PRESETS = [
  { label: "Immich replica · 150 GB", name: "Immich replica", gb: 150 },
  { label: "Minecraft backups · 20 GB", name: "Minecraft backups", gb: 20 },
];

const MODES: { value: EnforcementMode; title: string; desc: string }[] = [
  { value: "alert", title: "Alert only", desc: "Notify at 80% and 100%." },
  {
    value: "pause-sync",
    title: "Pause sync",
    desc: "At 100% Orbit pauses the Syncthing folder and resumes when usage drops below the limit.",
  },
  {
    value: "hard",
    title: "Hard limit (Linux)",
    desc: "Folder lives on a size-capped volume; create it with the script below.",
  },
];

function splitLimit(bytes: number): { value: string; unit: "GB" | "TB" } {
  if (bytes >= TB && bytes % TB === 0) return { value: String(bytes / TB), unit: "TB" };
  return { value: String(Math.round((bytes / GB) * 100) / 100), unit: "GB" };
}

export interface FolderFormProps {
  devices: DeviceSummary[];
  /** Pre-selected device (add mode) */
  defaultDeviceId?: string;
  /** When set, the form edits (PATCH) this folder and the device is fixed. */
  editing?: { deviceId: string; folder: FolderLimit };
  onSaved: () => void;
  onCancel: () => void;
}

export function FolderForm({ devices, defaultDeviceId, editing, onSaved, onCancel }: FolderFormProps) {
  const initial = editing?.folder;
  const initialLimit = initial ? splitLimit(initial.limitBytes) : { value: "", unit: "GB" as const };
  const [deviceId, setDeviceId] = useState(editing?.deviceId ?? defaultDeviceId ?? devices[0]?.id ?? "");
  const [path, setPath] = useState(initial?.path ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [nameTouched, setNameTouched] = useState(!!initial);
  const [limit, setLimit] = useState(initialLimit.value);
  const [unit, setUnit] = useState<"GB" | "TB">(initialLimit.unit);
  const [mode, setMode] = useState<EnforcementMode>(initial?.mode ?? "alert");
  const [stId, setStId] = useState(initial?.syncthingFolderId ?? "");
  const [busy, setBusy] = useState(false);

  const device = devices.find((d) => d.id === deviceId);
  const windows = isWindows(device);
  const limits = useAgent<FolderLimitsResponse>(deviceId || undefined, "/folders").data?.data ?? undefined;
  const st = useAgent<SyncthingSummary>(deviceId || undefined, "/syncthing").data?.data ?? undefined;

  const limitBytes = Math.round((Number(limit) || 0) * (unit === "TB" ? TB : GB));
  const stFolders = useMemo(() => {
    const all = st?.available ? st.folders : [];
    const p = path.replace(/\\/g, "/").toLowerCase();
    const rel = (f: { path: string }) => {
      const fp = f.path.replace(/\\/g, "/").toLowerCase();
      return p && (fp === p || p.startsWith(fp) || fp.startsWith(p)) ? 0 : 1;
    };
    return [...all].sort((a, b) => rel(a) - rel(b));
  }, [st, path]);
  const stUnavailable = !st?.available;
  const over = overcommitBytes(path, limitBytes, editing?.folder.id ?? null, limits, device);
  const hardCmd = `deploy/arm-free/scripts/make-capped-folder.sh ${path || "<path>"} ${Math.max(1, Math.round(limitBytes / GB)) || "<GB>"}`;

  const pickPath = (p: string) => {
    setPath(p);
    if (!nameTouched) setName(basename(p));
  };

  const valid =
    !!deviceId &&
    path.trim() !== "" &&
    name.trim() !== "" &&
    limitBytes > 0 &&
    (mode !== "pause-sync" || !!stId) &&
    !(mode === "hard" && windows);

  async function submit() {
    setBusy(true);
    const input: FolderLimitInput = {
      name: name.trim(),
      path: path.trim(),
      limitBytes,
      mode,
      syncthingFolderId: mode === "pause-sync" ? stId : null,
    };
    try {
      if (editing) await apiSend("PATCH", `/api/devices/${editing.deviceId}/agent/folders/${editing.folder.id}`, input);
      else await apiSend("POST", `/api/devices/${deviceId}/agent/folders`, input);
      toast.success(editing ? "Folder limit updated" : "Folder limit added");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save (device offline?)");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void submit();
      }}
    >
      {!editing ? (
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setName(p.name);
                setNameTouched(true);
                setLimit(String(p.gb));
                setUnit("GB");
              }}
            >
              {p.label}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="space-y-2">
        <Label>Device</Label>
        <Select
          value={deviceId}
          onValueChange={(v) => {
            setDeviceId(v);
            setStId("");
          }}
          disabled={!!editing}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Choose device" />
          </SelectTrigger>
          <SelectContent>
            {devices.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Folder</Label>
        <FolderPicker deviceId={deviceId || undefined} value={path} onChange={pickPath} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="folder-name">Name</Label>
        <Input
          id="folder-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameTouched(true);
          }}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="folder-limit">Limit</Label>
        <div className="flex gap-2">
          <Input
            id="folder-limit"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            className="flex-1"
          />
          <Select value={unit} onValueChange={(v) => setUnit(v as "GB" | "TB")}>
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="GB">GB</SelectItem>
              <SelectItem value="TB">TB</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {over && over.excess > 0 ? (
        <Alert>
          <TriangleAlert className="text-warning" />
          <AlertTitle>Overcommitted volume</AlertTitle>
          <AlertDescription>
            Limits on {over.mount} would exceed free space by {formatBytes(over.excess, 0)}.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Label>Enforcement</Label>
        <RadioGroup value={mode} onValueChange={(v) => setMode(v as EnforcementMode)} className="gap-2">
          {MODES.map((m) => {
            const disabled = m.value === "hard" && windows;
            return (
              <label
                key={m.value}
                className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3 ${
                  mode === m.value ? "border-primary bg-primary/5" : ""
                } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
              >
                <RadioGroupItem value={m.value} disabled={disabled} className="mt-0.5" />
                <span className="min-w-0 text-sm">
                  <span className="block font-medium">{m.title}</span>
                  <span className="block text-muted-foreground">
                    {m.desc}
                    {disabled ? " Not available on Windows devices." : ""}
                  </span>
                </span>
              </label>
            );
          })}
        </RadioGroup>
      </div>

      {mode === "pause-sync" ? (
        <div className="space-y-2">
          <Label>Syncthing folder</Label>
          <Select value={stId} onValueChange={setStId} disabled={stUnavailable}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={stUnavailable ? "Syncthing unavailable" : "Choose folder"} />
            </SelectTrigger>
            <SelectContent>
              {stFolders.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.label || f.id} · {f.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {stUnavailable ? (
            <p className="text-xs text-muted-foreground">
              Syncthing is not reachable on this device, so sync pausing cannot be configured right now.
            </p>
          ) : null}
        </div>
      ) : null}

      {mode === "hard" && !windows ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2 rounded-2xl bg-muted p-3">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">{hardCmd}</code>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Copy command"
              onClick={() => {
                void navigator.clipboard?.writeText(hardCmd).then(
                  () => toast.success("Command copied"),
                  () => toast.error("Could not copy"),
                );
              }}
            >
              <Copy />
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || busy}>
          {busy ? "Saving…" : editing ? "Save changes" : "Add limit"}
        </Button>
      </div>
    </form>
  );
}
