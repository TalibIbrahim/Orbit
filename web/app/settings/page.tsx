"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { AlertSettingsForm } from "@/components/settings/alert-settings-form";
import { AlertsList } from "@/components/settings/alerts-list";
import { GeneralTab } from "@/components/settings/general-tab";
import { StandbyTab } from "@/components/settings/standby-tab";
import { useSettings } from "@/components/settings/use-settings";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function SettingsInner() {
  const api = useSettings();
  const tabParam = useSearchParams().get("tab");
  const armFree = api.settings?.primaryMode === "arm-free";
  const initial = tabParam === "standby" || tabParam === "general" ? tabParam : "alerts";

  return (
    <div>
      <PageHeader title="Settings" description={armFree ? "Alerts, keep-alive and disaster recovery" : "Alerts, keep-alive and standby promotion"} />
      <Tabs defaultValue={initial}>
        <TabsList>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="standby">{armFree ? "arm-free" : "Standby"}</TabsTrigger>
          <TabsTrigger value="general">General</TabsTrigger>
        </TabsList>
        <TabsContent value="alerts" className="mt-3 space-y-4">
          <AlertsList />
          <AlertSettingsForm api={api} />
        </TabsContent>
        <TabsContent value="standby" className="mt-3">
          <StandbyTab armFree={api.settings ? armFree : undefined} />
        </TabsContent>
        <TabsContent value="general" className="mt-3">
          <GeneralTab api={api} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsInner />
    </Suspense>
  );
}
