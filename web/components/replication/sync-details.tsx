import type { ReplicaSyncDetail } from "@orbit/shared";
import { formatBytes } from "@/lib/format";

const n = (v: number | null | undefined) => (v == null ? "-" : v.toLocaleString());
const b = (v: number | null | undefined) => (v == null ? "-" : formatBytes(v));
const pct = (v: number | null | undefined) => (v == null ? "unknown" : `${Math.floor(v * 10) / 10}%`);

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </>
  );
}

/** Raw Syncthing numbers behind a folder's state, so sync problems can be diagnosed from the UI. */
export function SyncDetails({ label, detail }: { label?: string; detail: ReplicaSyncDetail }) {
  const { local, remote } = detail;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">
        Details{label ? `: ${label}` : ""}
      </summary>
      <div className="mt-1.5 grid gap-2 rounded-lg bg-background/60 p-2">
        <p className="text-muted-foreground">
          State decided from {detail.source === "replica" ? "this device's own Syncthing" : detail.source === "host" ? "arm-free's view of this device" : "no Syncthing data"}.
          {detail.pauseReason ? ` Pause reason: ${detail.pauseReason}.` : ""}
        </p>
        <div>
          <p className="font-medium">This device (/rest/db/status)</p>
          {local ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3">
              <Row k="state" v={local.state + (local.paused ? " (paused)" : "")} />
              <Row k="global" v={`${b(local.globalBytes)}, ${n(local.globalItems)} items`} />
              <Row k="local" v={b(local.localBytes)} />
              <Row k="need" v={`${b(local.needBytes)}, ${n(local.needItems)} items`} />
            </dl>
          ) : (
            <p className="text-muted-foreground">not reported (agent offline, Syncthing unreachable or folder not shared)</p>
          )}
        </div>
        <div>
          <p className="font-medium">arm-free&apos;s view (/rest/db/completion)</p>
          {remote ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3">
              <Row k="connection" v={remote.connected ? "connected" : "disconnected"} />
              <Row k="device paused" v={remote.devicePaused ? "yes" : "no"} />
              <Row k="completion" v={pct(remote.completion)} />
              <Row k="global" v={`${b(remote.globalBytes)}, ${n(remote.globalItems)} items`} />
              <Row k="need" v={`${b(remote.needBytes)}, ${n(remote.needItems)} items`} />
              {remote.error ? <Row k="error" v={remote.error} /> : null}
            </dl>
          ) : (
            <p className="text-muted-foreground">not reported (arm-free offline or this device not in the folder)</p>
          )}
          {detail.hostFolderPaused != null ? (
            <p className="text-muted-foreground">arm-free&apos;s folder: {detail.hostFolderPaused ? "paused" : "running"}</p>
          ) : null}
        </div>
      </div>
    </details>
  );
}
