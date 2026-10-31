// Shared contract between the Orbit agent (one per device) and the Orbit hub (Next.js on arm-free).
// All byte values are integers in bytes, all timestamps are Unix epoch milliseconds,
// all rates are bytes/second, all CPU values are percentages 0..100 of the whole machine.

export const AGENT_API_VERSION = 1;
export const DEFAULT_AGENT_PORT = 7420;

// ───────────────────────────── Oracle Always Free (Step 0, verified 2026-10) ─────────────────────────────
// https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
export const ORACLE_LIMITS = {
  a1Ocpus: 2,
  a1MemoryGB: 12,
  blockStorageGB: 200, // boot + block volumes combined, home region
  idle: {
    windowDays: 7,
    cpuP95Percent: 20, // 95th percentile CPU < 20%
    networkPercent: 20, // network utilisation < 20%
    memoryPercent: 20, // memory utilisation < 20% (A1 shapes only)
  },
  // A1 Flex network bandwidth scales 1 Gbps per OCPU.
  networkMbpsPerOcpu: 1000,
} as const;

// ───────────────────────────── Devices ─────────────────────────────
export type DeviceRole = "primary" | "standby" | "replica";
/**
 * Where Immich (the primary) runs.
 *  - "device":   Immich on a home PC (role primary); arm-free is a standby replica that can be promoted.
 *  - "arm-free": Immich runs permanently on arm-free (role primary); every other device is a Receive Only replica.
 */
export type PrimaryMode = "device" | "arm-free";
export const PRIMARY_MODES: PrimaryMode[] = ["device", "arm-free"];
export type Platform = "windows" | "linux" | "darwin";

export interface AgentHealth {
  apiVersion: number;
  agentVersion: string;
  deviceId: string;
  name: string;
  role: DeviceRole;
  hostname: string;
  platform: Platform;
  arch: string;
  uptimeSec: number; // OS uptime
  startedAt: number; // agent process start
}

// ───────────────────────────── Live status ─────────────────────────────
export interface DiskInfo {
  mount: string; // "/" or "C:"
  fs: string;
  total: number;
  used: number;
  free: number;
}

export type ContainerState = "running" | "exited" | "restarting" | "paused" | "created" | "dead" | "unknown";

export interface ContainerStat {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  service: string | null; // configured service it belongs to (e.g. "immich")
  cpu: number;
  memUsed: number;
  netRx: number; // bytes/s
  netTx: number;
}

// A service is whatever the device's agent.json "services" list says: any set of Docker
// containers (name prefixes) and/or systemd units (Linux), plus directories counted as its disk usage.
export interface ServiceStat {
  name: string;
  category: ServiceCategory;
  cpu: number;
  memUsed: number;
  netRx: number; // containers only; systemd units report 0 unless IPAccounting=yes
  netTx: number;
  diskUsed: number | null; // sum of configured paths, null until first measurement
  running: number; // matched containers + systemd units currently running
  expected: number; // matched containers (running or not) + configured systemd units
  up: boolean; // expected > 0 && running === expected
}

export interface TailscaleInfo {
  available: boolean;
  online: boolean;
  ip: string | null; // 100.x
  dnsName: string | null; // host.tailnet.ts.net
}

export interface AgentStatus {
  ts: number;
  health: AgentHealth;
  cpu: number;
  cpuCount: number;
  memUsed: number; // total - available
  memTotal: number;
  netRx: number; // bytes/s, all non-loopback interfaces
  netTx: number;
  disks: DiskInfo[];
  primaryDisk: DiskInfo | null; // disk holding dataDir / largest data disk
  dockerAvailable: boolean;
  containers: ContainerStat[];
  services: ServiceStat[];
  tailscale: TailscaleInfo;
  keepalive: KeepaliveState;
}

// ───────────────────────────── Metrics history ─────────────────────────────
export type MetricsRange = "1h" | "24h" | "7d" | "30d";

// Bucket sizes the agent uses for each range.
export const RANGE_BUCKET_SEC: Record<MetricsRange, number> = {
  "1h": 60,
  "24h": 300,
  "7d": 1800,
  "30d": 7200,
};

export interface MetricPoint {
  ts: number; // bucket start
  cpu: number; // avg %
  cpuMax: number; // max % in bucket
  memUsed: number; // avg
  memTotal: number;
  netRx: number; // avg bytes/s
  netTx: number;
  diskUsed: number; // last value in bucket
  diskTotal: number;
}

export interface ServiceMetricPoint {
  ts: number;
  cpu: number;
  memUsed: number;
  netRx: number;
  netTx: number;
  diskUsed: number | null;
}

export interface MetricsResponse {
  range: MetricsRange;
  bucketSec: number;
  from: number;
  to: number;
  total: MetricPoint[];
  services: Record<string, ServiceMetricPoint[]>; // key = service name
}

// ───────────────────────────── Idle risk (Oracle reclamation) ─────────────────────────────
export interface IdleMetric {
  key: "cpu" | "network" | "memory";
  label: string;
  value: number; // percent
  threshold: number; // percent
  statistic: string; // e.g. "p95 over 7d", "avg over 7d"
  belowThreshold: boolean; // true = this metric looks idle
}

export interface IdleRisk {
  windowDays: number;
  windowStart: number;
  coverage: number; // 0..1 fraction of the window with samples
  metrics: IdleMetric[];
  atRisk: boolean; // ALL metrics below threshold -> Oracle may reclaim
  networkBandwidthMbps: number; // denominator used for network %
}

// ───────────────────────────── Storage breakdown (quota card) ─────────────────────────────
export type ServiceCategory = "photos" | "services";
// photos = services with category "photos"; services = all other configured service paths;
// system = everything else on the disks (OS, Docker images, logs, ...).
export type StorageCategory = ServiceCategory | "system";

export interface StorageBreakdown {
  ts: number;
  quotaBytes: number | null; // e.g. 200 GB Oracle block storage; null if not configured
  provisionedBytes: number; // sum of disk totals
  usedBytes: number; // sum of disk used
  categories: { category: StorageCategory; label: string; bytes: number }[]; // system = used - photos - services
  growthBytesPerDay: number | null; // linear regression over last 7d of total used
  daysUntilFull: number | null; // vs quota (or provisioned if no quota); null if not growing
}

// ───────────────────────────── Folder storage limits ─────────────────────────────
export type EnforcementMode = "alert" | "pause-sync" | "hard";

export interface FolderLimitInput {
  name: string;
  path: string;
  limitBytes: number;
  mode: EnforcementMode;
  syncthingFolderId?: string | null; // required for "pause-sync"
}

export type FolderLimitState = "ok" | "warning" | "full" | "paused" | "unknown";

export interface FolderLimit extends FolderLimitInput {
  id: string;
  createdAt: number;
  usedBytes: number | null; // null until first measurement
  measuredAt: number | null;
  percent: number | null;
  growthBytesPerDay: number | null; // linear regression over last 7d
  daysUntilFull: number | null;
  state: FolderLimitState;
  pausedByOrbit: boolean; // agent paused the syncthing folder
  volume: string | null; // mount the folder lives on
  history: { ts: number; bytes: number }[]; // up to 30d, downsampled to <= 120 points
}

export interface FolderLimitsResponse {
  folders: FolderLimit[];
  volumes: {
    mount: string;
    total: number;
    free: number;
    limitsSum: number; // sum of limits of folders on this volume
    usedByLimited: number; // sum of current usage of those folders
    // limitsSum - usedByLimited > free  => overcommitted
    overcommitted: boolean;
  }[];
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: true;
}
export interface FsListResponse {
  path: string; // "" = roots (drive letters on Windows, "/" on Linux)
  parent: string | null;
  entries: FsEntry[];
  error?: string;
}

// ───────────────────────────── Syncthing / replication ─────────────────────────────
export type SyncthingFolderType = "sendreceive" | "sendonly" | "receiveonly" | "receiveencrypted";

export interface SyncthingPeerProgress {
  deviceId: string;
  name: string;
  connected: boolean;
  lastSeen: number | null;
  completion: number; // 0..100
  needItems: number;
  needBytes: number;
}

export interface SyncthingFolderSummary {
  id: string;
  label: string;
  path: string;
  type: SyncthingFolderType;
  paused: boolean;
  state: string; // idle | scanning | syncing | error | ...
  globalBytes: number;
  localBytes: number;
  needItems: number; // what THIS device still needs
  needBytes: number;
  stateChanged: number | null;
  versioning: string; // "" | simple | staggered | trashcan | external
  peers: SyncthingPeerProgress[];
}

export interface SyncthingSummary {
  available: boolean;
  error?: string;
  myDeviceId: string | null;
  version: string | null;
  folders: SyncthingFolderSummary[];
}

export interface SyncthingPairRequest {
  remoteDeviceId: string;
  remoteName: string;
  remoteAddress?: string; // e.g. "tcp://100.64.0.2:22000"; default "dynamic"
  folders: {
    id: string;
    label: string;
    path: string; // local path (created if missing) — ignored when the folder already exists locally; "" = must already exist
    type: SyncthingFolderType;
    versioning?: { type: "simple" | "staggered" | "trashcan"; params: Record<string, string> };
  }[];
}

// ───────────────────────────── Backups / jobs ─────────────────────────────
export type JobKind = "pgdump" | "restic" | "command";

export interface JobRun {
  id: number;
  job: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  ok: boolean | null; // null while running
  outputTail: string; // last ~4KB of stdout/stderr
}

export interface ResticSnapshotInfo {
  id: string;
  time: number;
  paths: string[];
  totalSize: number | null; // restic stats latest (restore-size)
  snapshotCount: number;
}

export interface JobSummary {
  id: string;
  name: string;
  kind: JobKind;
  schedule: string | null; // cron expression
  nextRunAt: number | null;
  retention: string | null; // human text, e.g. "48 x 30-min, 14 daily"
  outputDir: string | null;
  outputBytes: number | null; // size of outputDir
  latestArtifact: { name: string; bytes: number; mtime: number } | null;
  lastRun: JobRun | null;
  running: boolean;
  restic: ResticSnapshotInfo | null;
}

export interface BackupsResponse {
  jobs: JobSummary[];
}

// ───────────────────────────── Keep-alive / promote ─────────────────────────────
export interface KeepaliveState {
  supported: boolean; // configured on this device
  recommended: boolean; // true on the standby VM (Oracle idle reclamation)
  enabled: boolean;
  running: boolean;
  pid: number | null;
  since: number | null;
  command: string | null;
}

export type PromoteState = "idle" | "running" | "done" | "failed";

export interface PromoteStatus {
  supported: boolean;
  state: PromoteState;
  startedAt: number | null;
  finishedAt: number | null;
  immichUrl: string | null;
  dumpFile: string | null; // Postgres dump used for the restore
  dumpTime: number | null;
  log: string; // tail
}

// ───────────────────────────── Self update ─────────────────────────────
export interface AgentUpdateInfo {
  version: string;
  sha256: string;
  url: string; // relative to hub, e.g. "/agent/orbit-agent.mjs"
}

// ───────────────────────────── Agent HTTP API (all require Authorization: Bearer <token>) ─────────────────────────────
// GET    /v1/health                              -> AgentHealth          (no auth)
// GET    /v1/status                              -> AgentStatus
// GET    /v1/metrics?range=1h|24h|7d|30d         -> MetricsResponse
// GET    /v1/idle-risk                           -> IdleRisk
// GET    /v1/storage                             -> StorageBreakdown
// GET    /v1/fs?path=<abs path>                  -> FsListResponse
// GET    /v1/folders                             -> FolderLimitsResponse
// POST   /v1/folders            FolderLimitInput -> FolderLimit
// PATCH  /v1/folders/:id  Partial<FolderLimitInput> -> FolderLimit
// DELETE /v1/folders/:id                         -> { ok: true }
// POST   /v1/folders/:id/measure                 -> FolderLimit   (measure now)
// GET    /v1/syncthing                           -> SyncthingSummary
// POST   /v1/syncthing/pair     SyncthingPairRequest -> SyncthingSummary
// GET    /v1/backups                             -> BackupsResponse
// POST   /v1/backups/:job/run                    -> JobRun (started)
// GET    /v1/keepalive                           -> KeepaliveState
// POST   /v1/keepalive          { enabled: boolean } -> KeepaliveState
// GET    /v1/promote                             -> PromoteStatus
// POST   /v1/promote            { confirm: true } -> PromoteStatus
// POST   /v1/update                              -> { updating: boolean; from: string; to: string | null }
// Errors: non-2xx with ApiError body.
export interface ApiError {
  error: string;
  detail?: string;
}

// ───────────────────────────── Hub HTTP API (Next.js route handlers on arm-free) ─────────────────────────────
// Every agent-backed GET goes through the hub proxy, which caches the last good response per device+path
// so offline devices render "offline, last seen X" instead of errors.
export interface Cached<T> {
  data: T | null; // last known data (null if never fetched)
  online: boolean; // agent answered this request
  stale: boolean; // data comes from cache
  fetchedAt: number | null; // when `data` was fetched from the agent
  lastSeen: number | null; // device last seen by the hub poller
  error?: string;
}

export interface DeviceRecord {
  id: string;
  name: string;
  role: DeviceRole;
  platform: Platform | null;
  agentUrl: string | null; // http://100.x.y.z:7420 — null until enrolled
  enrolled: boolean;
  createdAt: number;
  lastSeen: number | null;
  syncthingDeviceId: string | null;
  immichLanUrl: string | null; // e.g. http://192.168.1.20:2283 (primary)
  immichTailscaleUrl: string | null; // e.g. http://pc.tailnet.ts.net:2283
  /** Replica only: shared folder id -> local path chosen in Add device (any drive). Missing = platform default. */
  replicaPaths: Record<string, string>;
}

export interface DeviceSummary extends DeviceRecord {
  online: boolean;
  status: AgentStatus | null; // last known
  statusFetchedAt: number | null;
  agentRole: DeviceRole | null;
  enrollError: string | null; // last failed enroll attempt with this device's token
  enrollAttemptAt: number | null; // last enroll attempt (ok or not) // role the agent itself reports (agent.json); differs from `role` after a relabel or stale config
  warnings: string[]; // configuration problems worth showing on the device card
}

// GET    /api/devices                                   -> DeviceSummary[]
// POST   /api/devices      { name, role, platform, replicaPaths? } -> AddDeviceResponse
// GET    /api/devices/:id                               -> DeviceSummary
// PATCH  /api/devices/:id  Partial<Pick<DeviceRecord,"name"|"role"|"agentUrl"|"immichLanUrl"|"immichTailscaleUrl"|"replicaPaths">> -> DeviceRecord
// DELETE /api/devices/:id                               -> { ok: true }
// ANY    /api/devices/:id/agent/<agent path without /v1> -> GET: Cached<T>; other methods: T (proxied, 503 ApiError if offline)
//        e.g. GET /api/devices/arm-free/agent/metrics?range=24h -> Cached<MetricsResponse>
// POST   /api/enroll       EnrollRequest (Bearer <device token>) -> EnrollResponse
// GET    /api/replication                               -> ReplicationHealth
// GET    /api/alerts                                    -> AlertsResponse
// GET    /api/settings                                  -> HubSettings (secrets masked)
// PUT    /api/settings     Partial<HubSettings>          -> HubSettings
// POST   /api/settings/test-alert                       -> { ok: boolean; error?: string }
// GET    /api/immich                                    -> ImmichLinks
// GET    /api/agent/version                             -> AgentUpdateInfo
// GET    /agent/orbit-agent.mjs                         -> bundled agent (application/javascript)
// GET    /install/:token/linux.sh | /install/:token/windows.ps1 -> install script with token baked in

export interface AddDeviceResponse {
  device: DeviceRecord;
  token: string; // shown once
  linuxCommand: string; // curl -fsSL <hub>/install/<token>/linux.sh | sudo bash
  windowsCommand: string; // irm <hub>/install/<token>/windows.ps1 | iex   (elevated PowerShell)
}

export interface EnrollRequest {
  agentUrl: string;
  hostname: string;
  platform: Platform;
  agentVersion: string;
  syncthingDeviceId: string | null;
  deviceId?: string; // from agent.json (diagnostics; the token decides which device this is)
  role?: DeviceRole; // from agent.json
}
export interface EnrollResponse {
  device: DeviceRecord;
  paired: boolean; // hub paired it with the primary's shared folders
  pairError?: string;
}

export type ReplicaState = "up-to-date" | "syncing" | "offline" | "unknown";

export interface ReplicaHealth {
  deviceId: string; // hub device id
  name: string;
  role: DeviceRole;
  online: boolean;
  lastSeen: number | null;
  folders: {
    folderId: string;
    label: string;
    state: ReplicaState;
    completion: number | null;
    needItems: number | null;
    needBytes: number | null;
    lastInSyncAt: number | null; // last time completion hit 100%
    lagMs: number | null; // now - lastInSyncAt (0 when up to date)
    versioning: string | null; // replica-side versioning type
    replicaType: SyncthingFolderType | null;
    issue: string | null; // likely reason when type is unknown / not Receive Only / no versioning
  }[];
  warnings: string[]; // same as DeviceSummary.warnings
}

export interface ReplicationHealth {
  primary: { deviceId: string; name: string; online: boolean; lastSeen: number | null } | null;
  sharedFolders: { id: string; label: string; type: SyncthingFolderType; globalBytes: number }[];
  replicas: ReplicaHealth[];
  generatedAt: number;
}

export type AlertKind =
  | "replica-behind"
  | "primary-offline"
  | "disk-high"
  | "ram-high"
  | "service-down"
  | "idle-risk"
  | "folder-limit"
  | "device-offline"
  | "update-available"
  | "backup-failed"
  | "library-near-limit" // arm-free mode: the volume holding immich-library is nearly full
  | "backup-verify"; // phone backup verification found missing / mismatched files

export interface AlertEvent {
  key: string; // dedupe key, e.g. "disk-high:arm-free:/"
  kind: AlertKind;
  severity: "info" | "warning" | "critical";
  deviceId: string | null;
  title: string;
  message: string;
  firstSeen: number;
  lastSeen: number;
  resolvedAt: number | null;
  notifiedAt: number | null;
}

export interface AlertsResponse {
  active: AlertEvent[];
  recent: AlertEvent[]; // resolved, last 7 days
}

export interface HubSettings {
  primaryMode: PrimaryMode; // default "device"; installer sets ORBIT_PRIMARY_MODE, editable in Settings
  versioningMaxAgeDays: number; // staggered versioning maxAge on replicas (default 30)
  hubUrl: string; // URL agents/install scripts use, e.g. http://arm-free.tailnet.ts.net:3000
  discordWebhookUrl: string | null;
  email: {
    enabled: boolean;
    smtpHost: string;
    smtpPort: number;
    secure: boolean;
    user: string;
    password: string | null; // masked as "••••" on GET
    from: string;
    to: string;
  } | null;
  thresholds: {
    replicaBehindHours: number; // 24
    primaryOfflineDays: number; // 3
    diskPercent: number; // 80
    ramPercent: number; // 90
    libraryPercent: number; // 90 - arm-free mode: volume holding immich-library
  };
  sharedFolders: { id: string; label: string; replicaPath: string; versioning: "simple" | "staggered" | "trashcan" }[];
  // ^ what new replicas get. replicaPath = the folder's path on arm-free: the standby copy in device mode,
  //   the Send Only source in arm-free mode. Other replicas use DeviceRecord.replicaPaths / defaultReplicaPath.
  tailscaleAuthKey: string | null; // optional, baked into install scripts (masked on GET)
  immich: ImmichVerifySettings; // phone backup verification (Settings -> Immich)
}

export interface ImmichLinks {
  lanUrl: string | null;
  tailscaleUrl: string | null;
  standbyUrl: string | null; // set after promote
  primaryOnline: boolean;
  promoted: boolean;
  primaryMode: PrimaryMode;
}

// ───────────────────────────── helpers ─────────────────────────────
export const GB = 1024 ** 3;
export const TB = 1024 ** 4;

/** Default replica folder path for a shared folder on a given platform. */
export function defaultReplicaPath(folderId: string, platform: Platform | null): string {
  return platform === "windows" ? `C:\\OrbitReplicas\\${folderId}` : `/srv/orbit/replicas/${folderId}`;
}

/** An enroll attempt the hub rejected because the token is unknown (agent with a stale agent.json). */
export interface RejectedEnroll {
  at: number;
  hostname: string;
  deviceId: string | null; // what the agent's agent.json says
  agentUrl: string | null;
  reason: string;
}
// GET    /api/enroll                                    -> { rejected: RejectedEnroll[] } (last 30 min)

// ───────────────────────────── Phone backup verification (read-only) ─────────────────────────────
// Orbit only verifies and advises. No code path deletes, moves or modifies photos anywhere.

/** One file of the Immich originals tree on a device (agent manifest). */
export interface ManifestEntry {
  path: string; // relative to the Syncthing folder root, "/" separators, e.g. "library/admin/2026/2026-10-31/IMG_0001.HEIC"
  size: number;
  mtimeMs: number;
  sha1: string | null; // lowercase hex, only when hashed (cached by path+size+mtime)
}

export interface ManifestStatus {
  folderId: string; // Syncthing folder id, e.g. "immich-library"
  root: string | null; // local path of that folder on the device
  available: boolean; // folder found and readable
  error?: string;
  files: number;
  bytes: number;
  hashed: number; // entries with a cached sha1
  builtAt: number | null; // when the last complete scan finished
  building: boolean;
  scanned: number; // files seen by the scan in progress
  generation: number; // increments on every complete scan
}

export interface ManifestPage {
  entries: ManifestEntry[]; // sorted by path (byte order)
  next: string | null; // pass as ?after= for the next page; null = done
  generation: number;
}

export interface ManifestHashRequest {
  folderId: string;
  paths: string[]; // relative paths to hash (max 2000 per call)
}
export interface ManifestHashResponse {
  hashes: { path: string; sha1: string | null; error?: string }[];
  pending: string[]; // not hashed within the time budget; ask again
}

// Agent routes (Bearer):
// GET  /v1/manifest?folder=<id>                      -> ManifestStatus (starts a scan if none is fresh)
// POST /v1/manifest/refresh  { folderId }            -> ManifestStatus (starts an incremental rescan)
// GET  /v1/manifest/entries?folder=<id>&after=<path>&limit=<n<=5000> -> ManifestPage
// POST /v1/manifest/hash     ManifestHashRequest     -> ManifestHashResponse

/** A file Immich says must exist (from the Immich API). */
export interface ExpectedFile {
  path: string; // relative to the library root (same form as ManifestEntry.path)
  assetId: string;
  ownerId: string;
  deviceId?: string; // not exposed by the Immich v3 API (kept optional for older servers)
  kind: "photo" | "video" | "sidecar";
  size: number | null; // from Immich exif when known
  sha1: string | null; // Immich checksum as lowercase hex (originals only)
  createdAt: number; // upload time (Immich asset createdAt), ms
}

export type CopyProblemKind = "missing" | "size-mismatch" | "hash-mismatch" | "extra";
export interface CopyProblem {
  kind: CopyProblemKind;
  path: string;
  detail?: string;
  createdAt?: number;
}

export interface CopyVerification {
  deviceId: string; // hub device id
  name: string;
  isHost: boolean; // arm-free / the Immich host itself
  online: boolean;
  lastSeen: number | null;
  expectedFiles: number;
  presentFiles: number; // expected files found with matching size (and hash where checked)
  files: number; // manifest files
  bytes: number;
  hashed: number; // files whose hash was compared
  missing: number;
  sizeMismatch: number;
  hashMismatch: number;
  extra: number; // files not known to Immich (informational)
  problems: CopyProblem[]; // first 50
  syncOk: boolean; // Syncthing: 100%, 0 needed, no errors, not paused, versioning on (replicas)
  syncIssues: string[];
  watermark: number | null; // every expected file created at or before this time is verified on this copy
  verifiedAt: number | null;
  error?: string;
}

export type OffloadState = "safe" | "not-yet" | "unknown";

/**
 * Uploads per Immich user. Immich v3 no longer exposes the uploading device on assets, so sources are
 * per user (the API key owner plus partners who share their timeline with them).
 */
export interface PhoneSource {
  ownerId: string;
  ownerName: string;
  photos: number;
  videos: number;
  livePhotoVideos: number; // motion parts of Live Photos (hidden assets)
  bytes: number; // sum of known file sizes
  newestUpload: number | null;
}

export type VerifyTrigger = "manual" | "schedule" | "upload";

export interface VerificationRunSummary {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  trigger: VerifyTrigger;
  state: OffloadState;
  watermark: number | null; // overall verified-through
  reasons: string[];
  error?: string;
}
export interface VerificationRun extends VerificationRunSummary {
  copies: CopyVerification[];
  sources: PhoneSource[];
  newestAsset: number | null;
  newestDump: number | null;
}

export interface BackupVerifyResponse {
  configured: boolean; // Immich URL + API key set
  running: boolean;
  latest: VerificationRun | null;
  history: VerificationRunSummary[]; // newest first, max 50
  recommendedCutoff: number | null; // date to use in the phone app (start of the watermark day)
}

/** Settings -> Immich (part of HubSettings). apiKey is write-only: GET returns "••••" when set. */
export interface ImmichVerifySettings {
  url: string; // e.g. http://arm-free.<tailnet>.ts.net:2283 (no /api)
  apiKey: string | null;
  sourceUserIds: string[]; // Immich user ids to track; [] = every user the key can see
  minCopies: number; // verified copies required (default 2)
  requireNonHostCopy: boolean; // at least one copy that is not arm-free (default true)
  hashRecentDays: number; // hash every file uploaded in the last N days (default 7)
  samplePercent: number; // plus a random sample of older files (default 2)
  scheduleHours: number; // scheduled run interval, 0 = off (default 6)
  notifyWatermark: boolean; // "all copies verified through <date>"
  notifyProblems: boolean; // missing / mismatched files
}

// Hub routes:
// GET  /api/backup-verify              -> BackupVerifyResponse
// POST /api/backup-verify/run          -> { started: boolean }   (the only action besides settings)
// GET  /api/backup-verify/runs/:id     -> VerificationRun
// GET  /api/immich/users               -> { id: string; name: string; email: string }[] (users the key can see)
// POST /api/immich/test  { url?, apiKey? } -> { ok: boolean; error?: string; version?: string }
