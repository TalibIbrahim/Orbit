"use client";

import type { OffloadState, VerificationRun, VerificationRunSummary } from "@orbit/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CopyRow, DumpAction, formatDate, ReasonList, StateNote, StatusChip, VerifyButton } from "@/components/offload/verify-parts";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiGet } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { useBackupVerify } from "@/lib/hooks";
import { Info } from "lucide-react";

const STEPS: { title: string; body: string }[] = [
  {
    title: "Let uploads finish",
    body: 'Open the Immich app on your phone and check that the backup screen shows 0 remaining ("Remainder"). Let new uploads finish first.',
  },
  {
    title: "Review the cleanup scan",
    body: 'In the Immich app open "Free Up Space" (it only removes items that are already backed up to the server). Set the cutoff date to the recommended cutoff below (items on or before that date). Keep favorites if you like, then review the scan result (count and size).',
  },
  {
    title: "Confirm in the app",
    body: 'Confirm in the Immich app. Removed items go to the phone\'s trash. iOS: "Recently Deleted" keeps them for 30 days. Android: the gallery app\'s Trash or Recycle bin (often 30 days, depends on the app). Space is only freed after that trash is emptied.',
  },
  {
    title: "Keep Tailscale on",
    body: "Keep Tailscale on so new photos keep backing up.",
  },
];

function RunDetails({ id }: { id: number }) {
  const [run, setRun] = useState<VerificationRun | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiGet<VerificationRun>(`/api/backup-verify/runs/${id}`)
      .then((r) => !cancelled && setRun(r))
      .catch((e: unknown) => !cancelled && setErr(e instanceof Error ? e.message : "Could not load run"));
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (err) return <p className="text-sm text-destructive">{err}</p>;
  if (!run) return <Skeleton className="h-16 rounded-xl" />;
  return (
    <div className="space-y-2">
      <ReasonList reasons={run.reasons} />
      {run.copies.map((c) => (
        <CopyRow key={c.deviceId} copy={c} />
      ))}
    </div>
  );
}

export default function OffloadPage() {
  const verify = useBackupVerify();
  const [openRun, setOpenRun] = useState<number | null>(null);
  const data = verify.data;
  const latest = data?.latest ?? null;
  const state: OffloadState = latest?.state ?? "unknown";
  const safe = state === "safe";

  return (
    <>
      <PageHeader
        title="Offload"
        description="Check that your photos are safely backed up before you free up phone storage"
        actions={<VerifyButton busy={verify.busy} onClick={() => void verify.verifyNow()} />}
      />
      <div className="grid gap-4">
        <Alert>
          <Info />
          <AlertTitle>Orbit only verifies</AlertTitle>
          <AlertDescription>
            Orbit only verifies. It cannot and does not delete anything from your phone or from any copy. Deleting is
            done by you in the Immich app.
          </AlertDescription>
        </Alert>

        {!data ? (
          <Skeleton className="h-40 rounded-2xl" />
        ) : !data.configured ? (
          <Card>
            <CardContent className="text-sm text-muted-foreground">
              Phone backup verification is not set up.{" "}
              <Link href="/settings?tab=immich" className="font-medium text-primary hover:underline">
                Settings → Immich
              </Link>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Status</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusChip state={state} large />
                  <StateNote note={latest?.stateNote} />
                </div>
                <ReasonList reasons={latest?.reasons ?? []} />
                <DumpAction dump={latest?.dump} />
                {latest?.error ? <p className="text-sm text-destructive">{latest.error}</p> : null}
                <div className="grid gap-1 text-sm sm:grid-cols-2">
                  <div>
                    <span className="text-muted-foreground">Verified through: </span>
                    <span className="font-medium">{formatDate(latest?.watermark)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Newest upload: </span>
                    <span className="font-medium">{formatDate(latest?.newestAsset)}</span>
                  </div>
                </div>
                <div className="rounded-xl bg-surface-container px-3 py-2">
                  <div className="text-xs text-muted-foreground">Recommended cutoff</div>
                  <div className="text-lg font-semibold">{formatDate(data.recommendedCutoff)}</div>
                  <div className="text-xs text-muted-foreground">Use this date as the cutoff in the Immich app.</div>
                </div>
              </CardContent>
            </Card>

            <Card className={safe ? "" : "opacity-60"}>
              <CardHeader>
                <CardTitle>On your phone (iOS and Android)</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                {!safe ? <Badge variant="secondary">Wait until the status is Safe to offload</Badge> : null}
                <ol className="list-decimal space-y-2 pl-5 text-sm">
                  {STEPS.map((s) => (
                    <li key={s.title}>
                      <span className="font-medium">{s.title}.</span>{" "}
                      <span className="text-muted-foreground">{s.body}</span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Uploads per Immich user</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead className="text-right">Photos</TableHead>
                        <TableHead className="text-right">Videos</TableHead>
                        <TableHead className="text-right">Live Photo videos</TableHead>
                        <TableHead className="text-right">Size</TableHead>
                        <TableHead>Newest upload</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(latest?.sources ?? []).map((s) => (
                        <TableRow key={s.ownerId}>
                          <TableCell className="font-medium">{s.ownerName}</TableCell>
                          <TableCell className="text-right tabular-nums">{s.photos.toLocaleString()}</TableCell>
                          <TableCell className="text-right tabular-nums">{s.videos.toLocaleString()}</TableCell>
                          <TableCell className="text-right tabular-nums">{s.livePhotoVideos.toLocaleString()}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatBytes(s.bytes)}</TableCell>
                          <TableCell>{formatDate(s.newestUpload)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <p className="text-xs text-muted-foreground">
                  Immich v3 does not report the uploading device, so counts are per Immich user (the API key owner plus
                  partners sharing their timeline). Locked items are not visible to API keys.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Copies</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                {(latest?.copies ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No copy data yet.</p>
                ) : (
                  latest?.copies.map((c) => (
                    <div key={c.deviceId} className="space-y-2">
                      <CopyRow copy={c} />
                      <div className="px-1 text-xs text-muted-foreground">
                        {c.hashed.toLocaleString()} hashed, {c.extra.toLocaleString()} extra (files on this copy that
                        Immich does not list, such as sidecars or leftovers; informational).
                      </div>
                      {c.problems.length > 0 ? (
                        <ul className="space-y-0.5 px-1 font-mono text-xs">
                          {c.problems.slice(0, 10).map((p, i) => (
                            <li key={i} className="break-all">
                              <span className={p.kind === "extra" ? "text-muted-foreground" : "text-warning"}>{p.kind}</span>{" "}
                              {p.path}
                            </li>
                          ))}
                          {c.problems.length > 10 ? (
                            <li className="text-muted-foreground">and {c.problems.length - 10} more</li>
                          ) : null}
                        </ul>
                      ) : null}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>History</CardTitle>
              </CardHeader>
              <CardContent>
                {data.history.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No runs yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Started</TableHead>
                          <TableHead>Trigger</TableHead>
                          <TableHead>State</TableHead>
                          <TableHead>Verified through</TableHead>
                          <TableHead>First reason</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.history.map((h) => (
                          <HistoryRow key={h.id} h={h} open={openRun === h.id} onToggle={() => setOpenRun(openRun === h.id ? null : h.id)} />
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </>
  );
}

function HistoryRow({
  h,
  open,
  onToggle,
}: {
  h: VerificationRunSummary;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell className="whitespace-nowrap">{new Date(h.startedAt).toLocaleString()}</TableCell>
        <TableCell>{h.trigger}</TableCell>
        <TableCell>
          <StatusChip state={h.state} />
        </TableCell>
        <TableCell className="whitespace-nowrap">{formatDate(h.watermark)}</TableCell>
        <TableCell className="min-w-48 whitespace-normal text-muted-foreground">{h.error ?? h.reasons[0] ?? ""}</TableCell>
      </TableRow>
      {open ? (
        <TableRow>
          <TableCell colSpan={5}>
            <RunDetails id={h.id} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
