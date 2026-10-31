"use client";

import { PageHeader } from "@/components/page-header";
import { AlertSettingsForm } from "@/components/settings/alert-settings-form";
import { AlertsList } from "@/components/settings/alerts-list";
import { GeneralTab } from "@/components/settings/general-tab";
import { StandbyTab } from "@/components/settings/standby-tab";
import { useSettings } from "@/components/settings/use-settings";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function SettingsPage() {
  const api = useSettings();

  return (
    <div>
      <PageHeader title="Settings" description="Alerts, keep-alive and standby promotion" />
      <Tabs defaultValue="alerts">
        <TabsList>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="standby">Standby</TabsTrigger>
          <TabsTrigger value="general">General</TabsTrigger>
        </TabsList>
        <TabsContent value="alerts" className="mt-3 space-y-4">
          <AlertsList />
          <AlertSettingsForm api={api} />
        </TabsContent>
        <TabsContent value="standby" className="mt-3">
          <StandbyTab />
        </TabsContent>
        <TabsContent value="general" className="mt-3">
          <GeneralTab api={api} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
