"use client";

import { ChevronDown, Undo2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

export const SWITCH_BACK_COMMAND = "sudo /opt/orbit/deploy/arm-free/scripts/switch-back.sh";

const STEPS = [
  "Make sure the PC is back, Immich runs there, and its Syncthing folder immich-library is Send Only and connected to arm-free.",
  "Stop the standby Immich stack (the script runs docker compose down).",
  "Export the uploads made on the standby during the outage (files newer than the promotion time are copied to /srv/orbit/standby-uploads-<date>).",
  "Re-upload that export on the PC via the Immich app or the CLI: immich upload --recursive <dir>. The PC database does not know about them.",
  "Reset the replica folders to Receive Only and Revert Local Changes so the standby mirrors the PC again (anything written locally on the standby is discarded, hence step 3 first).",
  "Resume Syncthing on the replica folders.",
];

export function SwitchBackCard() {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Button variant="ghost" className="-ml-2 h-auto px-2 text-base" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <Undo2 />
            Switch back to the PC
            <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
          </Button>
        </CardTitle>
      </CardHeader>
      {open ? (
        <CardContent>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            {STEPS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <p className="text-sm">Run on arm-free (steps 2, 3, 5 and 6 are automated by the script; options: --yes, --skip-export):</p>
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-container-high p-3">
            <code className="min-w-0 flex-1 font-mono text-xs break-all">{SWITCH_BACK_COMMAND}</code>
            <CopyButton text={SWITCH_BACK_COMMAND} />
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}
