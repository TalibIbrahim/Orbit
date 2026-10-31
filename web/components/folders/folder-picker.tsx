"use client";

import type { FsListResponse } from "@orbit/shared";
import { ChevronRight, Folder, FolderUp, HardDrive } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { agentGet } from "@/lib/api";
import { usePoll } from "@/lib/use-poll";

/** Split a Windows or POSIX path into clickable breadcrumb segments. */
export function pathCrumbs(path: string): { label: string; path: string }[] {
  if (!path) return [];
  if (/^[A-Za-z]:/.test(path)) {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    return parts.map((p, i) => ({
      label: p,
      path: i === 0 ? `${p}\\` : parts.slice(0, i + 1).join("\\"),
    }));
  }
  const parts = path.split("/").filter(Boolean);
  return parts.map((p, i) => ({ label: p, path: `/${parts.slice(0, i + 1).join("/")}` }));
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export interface FolderPickerProps {
  deviceId: string | undefined;
  /** Currently selected path (shown in the text input). */
  value: string;
  onChange: (path: string) => void;
}

export function FolderPicker({ deviceId, value, onChange }: FolderPickerProps) {
  const [current, setCurrent] = useState("");
  const { data: res, error: fetchError, loading } = usePoll(
    () =>
      deviceId
        ? agentGet<FsListResponse>(deviceId, `/fs?path=${encodeURIComponent(current)}`)
        : Promise.resolve(null),
    0,
    [deviceId, current],
  );
  const listing = res?.data ?? null;
  const failure = fetchError
    ? fetchError.message
    : res && !res.data
      ? (res.error ?? "Device is offline")
      : res && !res.online
        ? "Device is offline - showing cached listing."
        : null;

  if (!deviceId) return <p className="text-sm text-muted-foreground">Choose a device first.</p>;

  const crumbs = pathCrumbs(listing?.path ?? current);
  const error = listing?.error ?? failure;

  return (
    <div className="space-y-2">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste a path, e.g. D:\Immich or /srv/photos"
        className="font-mono text-xs"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      <div className="rounded-2xl border bg-muted/30 p-2">
        <div className="mb-1 flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!listing || listing.path === ""}
            onClick={() => setCurrent(listing?.parent ?? "")}
          >
            <FolderUp /> Up
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-xs text-muted-foreground">
            <button type="button" className="shrink-0 hover:text-foreground" onClick={() => setCurrent("")}>
              Roots
            </button>
            {crumbs.map((c) => (
              <span key={c.path} className="flex shrink-0 items-center gap-0.5">
                <ChevronRight className="size-3" />
                <button type="button" className="hover:text-foreground" onClick={() => setCurrent(c.path)}>
                  {c.label}
                </button>
              </span>
            ))}
          </div>
        </div>
        <ScrollArea className="h-44">
          {loading && !listing ? (
            <div className="space-y-1 p-1">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : (
            <ul className="p-0.5">
              {listing?.entries.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    onClick={() => setCurrent(e.path)}
                    className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm hover:bg-muted"
                  >
                    {listing.path === "" ? (
                      <HardDrive className="size-4 text-primary" />
                    ) : (
                      <Folder className="size-4 text-primary" />
                    )}
                    <span className="truncate">{e.name}</span>
                  </button>
                </li>
              ))}
              {listing && listing.entries.length === 0 && !error ? (
                <li className="px-2 py-3 text-sm text-muted-foreground">No subfolders</li>
              ) : null}
            </ul>
          )}
        </ScrollArea>
        {error ? <p className="px-2 pt-1 text-xs text-destructive">{error}</p> : null}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-2 w-full"
          disabled={!listing || listing.path === ""}
          onClick={() => listing && onChange(listing.path)}
        >
          Select this folder
        </Button>
      </div>
    </div>
  );
}
