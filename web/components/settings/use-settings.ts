"use client";

import type { HubSettings } from "@orbit/shared";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { apiGet, apiSend } from "@/lib/api";
import { usePoll } from "@/lib/use-poll";

export type EmailSettings = NonNullable<HubSettings["email"]>;

export const EMPTY_EMAIL: EmailSettings = {
  enabled: false,
  smtpHost: "",
  smtpPort: 587,
  secure: false,
  user: "",
  password: null,
  from: "",
  to: "",
};

/** Loads HubSettings once, keeps an editable draft, and saves it with PUT. */
export function useSettings() {
  const { data, loading, error } = usePoll(() => apiGet<HubSettings>("/api/settings"), 0);
  const [edited, setDraft] = useState<HubSettings | null>(null);
  const draft = edited ?? data ?? null;
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const saved = await apiSend<HubSettings>("PUT", "/api/settings", draft);
      setDraft(saved);
      toast.success("Settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  }, [draft]);

  return { settings: data, draft, setDraft, loading, error, saving, save };
}

export type SettingsApi = ReturnType<typeof useSettings>;
