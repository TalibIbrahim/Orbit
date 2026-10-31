"use client";

import type { FolderLimit } from "@orbit/shared";
import { Plus } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { DeviceFolders } from "@/components/folders/device-folders";
import { FolderForm } from "@/components/folders/folder-form";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useDevices } from "@/lib/hooks";

function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(min-width: 768px)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(min-width: 768px)").matches,
    () => false,
  );
}

export default function FoldersPage() {
  const { data: devices, loading } = useDevices();
  const desktop = useIsDesktop();
  const [filter, setFilter] = useState("all");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ deviceId: string; folder: FolderLimit } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const enrolled = (devices ?? []).filter((d) => d.enrolled);
  const shown = filter === "all" ? enrolled : enrolled.filter((d) => d.id === filter);
  const saved = () => {
    setAdding(false);
    setEditing(null);
    setReloadKey((k) => k + 1);
  };

  return (
    <div>
      <PageHeader
        title="Folders"
        description="Storage limits per folder"
        actions={
          <>
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All devices</SelectItem>
                {enrolled.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button disabled={enrolled.length === 0} onClick={() => setAdding(true)}>
              <Plus /> Add folder limit
            </Button>
          </>
        }
      />

      {loading && !devices ? (
        <Skeleton className="h-48 w-full rounded-2xl" />
      ) : enrolled.length === 0 ? (
        <p className="text-sm text-muted-foreground">No enrolled devices yet. Add a device first.</p>
      ) : (
        <div className="space-y-8">
          {shown.map((d) => (
            <DeviceFolders key={d.id} device={d} reloadKey={reloadKey} onEdit={(deviceId, folder) => setEditing({ deviceId, folder })} />
          ))}
        </div>
      )}

      <Sheet open={adding} onOpenChange={setAdding}>
        <SheetContent side={desktop ? "right" : "bottom"} className="max-h-[92dvh] overflow-y-auto rounded-t-3xl md:max-h-none md:rounded-none md:sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Add folder limit</SheetTitle>
            <SheetDescription>Cap how much space a folder may use.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            {adding ? (
              <FolderForm
                devices={enrolled}
                defaultDeviceId={filter === "all" ? undefined : filter}
                onSaved={saved}
                onCancel={() => setAdding(false)}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit folder limit</DialogTitle>
            <DialogDescription>{editing?.folder.name}</DialogDescription>
          </DialogHeader>
          {editing ? <FolderForm devices={enrolled} editing={editing} onSaved={saved} onCancel={() => setEditing(null)} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
