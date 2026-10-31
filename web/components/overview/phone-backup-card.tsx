"use client";

import type { BackupVerifyResponse } from "@orbit/shared";
import Link from "next/link";
import { Smartphone } from "lucide-react";
import { CopyRow, formatDate, ReasonList, StatusChip, VerifyButton } from "@/components/offload/verify-parts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function PhoneBackupCard({
  data,
  busy,
  onVerify,
}: {
  data: BackupVerifyResponse | undefined;
  busy: boolean;
  onVerify: () => void;
}) {
  const latest = data?.latest ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="size-4" /> Phone backup
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!data ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : !data.configured ? (
          <p className="text-sm text-muted-foreground">
            Phone backup verification is not set up.{" "}
            <Link href="/settings?tab=immich" className="font-medium text-primary hover:underline">
              Settings → Immich
            </Link>
          </p>
        ) : !latest ? (
          <>
            <p className="text-sm text-muted-foreground">No verification has run yet.</p>
            <VerifyButton busy={busy} onClick={onVerify} />
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip state={latest.state} />
              <span className="text-xs text-muted-foreground">
                Verified through {formatDate(latest.watermark)}
                {latest.newestAsset ? `, newest upload ${formatDate(latest.newestAsset)}` : ""}
              </span>
            </div>
            <ReasonList reasons={latest.reasons} />
            {latest.error ? <p className="text-sm text-destructive">{latest.error}</p> : null}
            {latest.copies.map((c) => (
              <CopyRow key={c.deviceId} copy={c} />
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <VerifyButton busy={busy} onClick={onVerify} />
              <Link href="/offload" className="text-sm font-medium text-primary hover:underline">
                Offload guide
              </Link>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
