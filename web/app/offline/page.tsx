import { WifiOff } from "lucide-react";
import { PageHeader } from "@/components/page-header";

export const metadata = { title: "Offline" };

export default function OfflinePage() {
  return (
    <div className="flex flex-col items-start gap-4">
      <WifiOff className="size-10 text-muted-foreground" />
      <PageHeader
        title="You are offline"
        description="Orbit cannot reach the hub right now. Pages you have already opened will show their last known data."
      />
    </div>
  );
}