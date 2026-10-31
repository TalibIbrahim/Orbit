"use client";

import type { DeviceRecord, DeviceRole, DeviceSummary } from "@orbit/shared";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiSend } from "@/lib/api";

function EditForm({ device, onDone, onCancel }: { device: DeviceSummary; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(device.name);
  const [role, setRole] = useState<DeviceRole>(device.role);
  const [lan, setLan] = useState(device.immichLanUrl ?? "");
  const [ts, setTs] = useState(device.immichTailscaleUrl ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await apiSend<DeviceRecord>("PATCH", `/api/devices/${device.id}`, {
        name: name.trim(),
        role,
        immichLanUrl: lan.trim() || null,
        immichTailscaleUrl: ts.trim() || null,
      });
      toast.success("Device updated");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update device");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void save();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="dev-name">Name</Label>
        <Input id="dev-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label>Role</Label>
        <Select value={role} onValueChange={(v) => setRole(v as DeviceRole)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="primary">Primary</SelectItem>
            <SelectItem value="standby">Standby</SelectItem>
            <SelectItem value="replica">Replica</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {role === "primary" ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="dev-lan">Immich LAN URL</Label>
            <Input id="dev-lan" value={lan} onChange={(e) => setLan(e.target.value)} placeholder="http://192.168.1.20:2283" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dev-ts">Immich Tailscale URL</Label>
            <Input id="dev-ts" value={ts} onChange={(e) => setTs(e.target.value)} placeholder="http://pc.tailnet.ts.net:2283" />
          </div>
        </>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function EditDeviceDialog({ device, onClose, onDone }: { device: DeviceSummary | null; onClose: () => void; onDone: () => void }) {
  return (
    <Dialog open={!!device} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit device</DialogTitle>
          <DialogDescription>Rename or change the role of {device?.name}.</DialogDescription>
        </DialogHeader>
        {device ? (
          <EditForm
            device={device}
            onCancel={onClose}
            onDone={() => {
              onClose();
              onDone();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function RemoveDeviceDialog({ device, onClose, onDone }: { device: DeviceSummary | null; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  async function remove() {
    if (!device) return;
    setBusy(true);
    try {
      await apiSend("DELETE", `/api/devices/${device.id}`);
      toast.success("Device removed");
      onClose();
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove device");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={!!device} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {device?.name}?</DialogTitle>
          <DialogDescription>
            The device is forgotten by the hub and its token stops working. Files on the device are not touched.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
