"use client";

import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SettingsApi } from "./use-settings";

export function SaveBar({ api }: { api: Pick<SettingsApi, "saving" | "save" | "draft"> }) {
  return (
    <div className="flex justify-end">
      <Button disabled={!api.draft || api.saving} onClick={() => void api.save()}>
        {api.saving ? <Loader2 className="animate-spin" /> : <Save />}
        Save
      </Button>
    </div>
  );
}
