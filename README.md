# Orbit

Self-hosted storage and server dashboard, delivered as a mobile-first PWA. It watches a small fleet (a Windows PC, an Oracle Always Free Arm VM, optional extra replicas), keeps an Immich photo library replicated with Syncthing, and gives you one place to see usage, replication health, backups and failover.

```
 iPhone (Immich app + Orbit PWA) ---- Tailscale (no public ports) ----+
                                                                      |
 PRIMARY: Windows PC                         STANDBY: "arm-free" (Oracle A1.Flex 2 OCPU / 12 GB)
 +--------------------------+  Syncthing   +------------------------------------------------+
 | Immich (Docker Desktop)  |  Send Only   | Syncthing (Receive Only + versioning)          |
 | full library, source of  | -----------> |   immich-library, immich-db-dumps              |
 | truth                    |  immich-     | Orbit hub :3000  <-- polls every agent /60 s   |
 | daily Postgres dump 02:30|  library     | Orbit agent :7420 (systemd, host)              |
 | Orbit agent :7420        |  immich-db-  | Your own services (optional, tracked)         |
 +--------------------------+  dumps       | Immich standby stack (started ONLY by Promote) |
                                           +------------------------------------------------+
 Extra replicas (Linux/Windows) are added with Devices -> Add device and receive the same folders.
```

Single source of truth is the PC. The standby is a replica until you press Promote.

## Contents

1. [Overview and features](#1-overview-and-features)
2. [Set up arm-free](#2-set-up-arm-free)
3. [Set up the PC](#3-set-up-the-pc)
4. [Tailscale notes](#4-tailscale-notes)
5. [Immich, Syncthing and restic](#5-immich-syncthing-and-restic)
6. [iPhone setup](#6-iphone-setup)
7. [Folder storage limits](#7-folder-storage-limits)
8. [Backups](#8-backups)
9. [Promote standby, switch back, restore test](#9-promote-standby-switch-back-restore-test) (details in [docs/failover-restore.md](docs/failover-restore.md))
10. [Keep-alive and idle-risk meter](#10-keep-alive-and-idle-risk-meter)
11. [Auto-updates](#11-auto-updates)
12. [Development](#12-development)
13. [Security notes](#13-security-notes)
14. [Troubleshooting](#14-troubleshooting)
15. [Verified facts (Oct 2026)](#verified-facts-oct-2026)

## 1. Overview and features

Pages: Overview, Usage, Folders, Devices (bottom bar); Replication, Backups, Settings (More).

| Feature | What it does |
|---|---|
| Usage tracker | Per-device CPU, RAM, network, disk, per-service (Immich, Orbit and any service you add) charts for 1 h / 24 h / 7 d / 30 d. Agents keep 35 days of samples. |
| Idle-risk meter | Compares 7-day CPU p95, network and memory against Oracle's reclamation thresholds (all three under 20% = at risk). See [section 10](#10-keep-alive-and-idle-risk-meter). |
| Storage quota | Used vs the 200 GB Oracle allowance (`storageQuotaGB`), split Photos / Services / System, growth per day and days until full. |
| Folder limits | Per-folder size limit with three enforcement modes: `alert`, `pause-sync`, `hard`. See [section 7](#7-folder-storage-limits). |
| Devices / Add device | Wizard creates a device and token and shows a one-line install command. Agents enroll themselves and the hub pairs Syncthing. |
| Replication health | Per replica and folder: up to date / syncing / offline, completion, lag, versioning type. |
| Backups | Job cards (Immich dump, restic, prune, your own commands) with last run, next run, output size, "Run backup now". |
| Promote standby | One button (Settings -> Standby) starts Immich on arm-free from the latest dump. Switch-back instructions on the same tab. |
| Keep-alive | Toggle that runs NeverIdle on arm-free to avoid Oracle idle reclamation. |
| LAN mode | The Immich link picks the LAN URL at home, the Tailscale URL away, or the standby URL after a promote. |
| PWA | Installable on the iPhone home screen, offline page, light/dark theme. |
| Auto-updates | Containers via a daily systemd timer; agents self-update from the hub. |

How the hub works: it polls every agent every 60 s and caches the last good response in SQLite, so an offline device shows "offline, last seen X" instead of errors. Alerts go to a Discord webhook and/or SMTP email (Settings -> Alerts): replica more than 24 h behind, PC offline more than 3 days, disk over 80%, RAM over 90%, service down, idle risk, folder limit, failed backup.

### Tracking your own services

Per-service charts and the disk split come from the `services` list in `agent.json`. Add any Docker container or systemd unit; no code changes needed, restart the agent afterwards (`sudo systemctl restart orbit-agent`).

| Field | Meaning |
|---|---|
| `name` | Label in charts. |
| `category` | `photos` or `services` (default `services`). |
| `containers` | Docker container name prefixes (`"nextcloud"` matches `nextcloud-app-1`). |
| `systemdUnits` | Linux unit names (Linux agents only). |
| `paths` | Directories whose size counts as this service's disk usage. |

```json
"services": [
  { "name": "immich", "category": "photos", "containers": ["immich_"], "systemdUnits": [], "paths": ["/srv/orbit/immich-library"] },
  { "name": "nextcloud", "category": "services", "containers": ["nextcloud"], "systemdUnits": [], "paths": ["/srv/nextcloud"] },
  { "name": "game-server", "category": "services", "containers": [], "systemdUnits": ["gameserver.service"], "paths": ["/srv/gameserver"] }
]
```

Measured: containers report CPU, RAM and network; systemd units report CPU and RAM, and network only if the unit has `IPAccounting=yes` (`systemctl edit <unit>`, add `[Service]` / `IPAccounting=yes`). Disk usage comes only from `paths`. The Storage quota view splits usage into **Photos** (services in the photos category), **Services** (everything else you track) and **System** (the rest of the disk).

## 2. Set up arm-free

### 2.1 Create the VM

1. OCI console -> Compute -> Create instance. Shape `VM.Standard.A1.Flex`, **2 OCPU / 12 GB** (this is exactly what the Always Free allowance covers, see [verified facts](#verified-facts-oct-2026)). Image: Ubuntu 24.04 (aarch64). The installer also accepts 22.04.
2. Storage: the Always Free limit is 200 GB total for boot plus block volumes. Suggested split: **50 GB boot + 150 GB block volume**. Only up to five volume backups are free.
3. Add your SSH public key, create the instance, then attach the block volume to it.
4. VCN security list: ingress for **TCP 22 only** (from your IP if you can). Nothing else. The installer does not touch iptables and nothing in the stacks is published except on the Tailscale IP.

### 2.2 Format and mount the block volume at /srv/orbit

`install-arm-free.sh` does not partition disks. Everything lives under `ORBIT_ROOT` (default `/srv/orbit`), so mount the volume there **before** running the installer.

```bash
lsblk                                   # identify the new disk, e.g. /dev/sdb (or /dev/oracleoci/oraclevdb)
sudo mkfs.ext4 -L orbit /dev/sdb
sudo mkdir -p /srv/orbit
sudo blkid /dev/sdb                     # copy the UUID
echo 'UUID=<uuid> /srv/orbit ext4 defaults,noatime,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a && df -h /srv/orbit
```

If you skip the block volume, `/srv/orbit` is simply a directory on the boot volume.

### 2.3 Tailscale, clone, install

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname arm-free      # open the printed URL
# From your PC/phone verify:  tailscale ssh ubuntu@arm-free   -> then remove the port-22 ingress rule in OCI.

sudo git clone <your-repo-url> /opt/orbit-src
sudo ORBIT_HUB_URL=http://arm-free.<tailnet>.ts.net:3000 /opt/orbit-src/deploy/arm-free/scripts/install-arm-free.sh
```

The installer is idempotent and never overwrites existing config. Optional environment variables:

| Variable | Effect |
|---|---|
| `ORBIT_HUB_URL` | Written to `deploy/arm-free/.env` and the agent config (default `http://<tailscale ip>:3000`). Use the MagicDNS name. |
| `ORBIT_DEVICE_ID` | Device id in `/etc/orbit/agent.json` (default `arm-free`). |
| `TS_AUTHKEY` | If Tailscale is not logged in, runs `tailscale up --ssh --authkey ... --hostname arm-free`. |
| `SKIP_NEVERIDLE=1` | Do not download NeverIdle. |
| `SKIP_START=1` | Install units and files but do not start the agent, timer or compose stack. |
| `ORBIT_ROOT` (via lib.sh) | Data root, default `/srv/orbit`. The shipped agent config and compose files hardcode `/srv/orbit`, so leave it. |

It installs Docker, Tailscale, Node 22, restic, zstd, jq, NeverIdle (`/opt/orbit/bin/NeverIdle`), creates `/srv/orbit/{immich-library,immich-db-dumps,immich-standby-db,syncthing-config,orbit-data,replicas}`, symlinks `/opt/orbit/deploy` to the repo, writes `/etc/orbit/agent.json` (mode 640, group 1000), installs `orbit-agent.service`, `orbit-update.service` and `orbit-update.timer`, and runs `docker compose up -d --build` when Tailscale is up.

### 2.4 Review the .env files

`/opt/orbit-src/deploy/arm-free/.env` (created by the installer, mode 600):

| Key | Meaning |
|---|---|
| `TAILSCALE_IP` | Output of `tailscale ip -4`. The hub (3000) binds to it. |
| `ORBIT_HUB_URL` | URL other devices use to reach the hub. |
| `ORBIT_PASSWORD` | Optional dashboard password. Empty = rely on Tailscale ACLs. |
| `DISCORD_WEBHOOK_URL` | Optional; hub alerts and `update.sh` notifications. |

`deploy/arm-free/immich-standby/.env`: see [section 5](#5-immich-syncthing-and-restic).

If you edit either file later: `cd /opt/orbit-src/deploy/arm-free && docker compose up -d --build`.

### 2.5 Open the hub

Browse to `http://arm-free.<tailnet>.ts.net:3000` from any device on your tailnet. arm-free's own agent is registered automatically: the compose file mounts `/etc/orbit/agent.json` read-only into `orbit-web` (`ORBIT_LOCAL_AGENT_CONFIG=/run/orbit/agent.json`, `ORBIT_LOCAL_AGENT_URL=http://<TAILSCALE_IP>:7420`). You do not add it by hand, even though the installer prints a deviceId/token banner.

Syncthing GUI is loopback-only: `ssh -L 8384:127.0.0.1:8384 ubuntu@arm-free`, then open `http://127.0.0.1:8384`. Normally you never need it, the hub pairs folders.

### 2.6 First run

Open Overview: the **Getting started** checklist walks through the first steps (add the PC, pair folders, enable keep-alive, set up alerts). The keep-alive step is marked **Recommended**: a fresh arm-free mostly idles, so see [section 10](#10-keep-alive-and-idle-risk-meter) and Settings -> Standby.

## 3. Set up the PC

1. Sign in to the hub and open Devices -> Add device. Name `pc`, role **Primary**, platform Windows. Note the **deviceId** and **token** (shown once).
2. In an **elevated** Windows PowerShell 5.1, from a checkout of this repo on the PC:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\windows\install-pc.ps1 `
  -HubUrl http://arm-free.<tailnet>.ts.net:3000 -Token <token> -DeviceId <deviceId>
```

Parameters:

| Parameter | Default |
|---|---|
| `-HubUrl` (required) | none |
| `-Token`, `-DeviceId` | random token / new GUID if omitted (then add them manually in the wizard's "I already installed the agent" mode) |
| `-DeviceName` | `$env:COMPUTERNAME` |
| `-LibraryPath` | `D:\Immich\library` (becomes `UPLOAD_LOCATION`) |
| `-DumpPath` | `D:\Immich\db-dumps` |
| `-ImmichDir` | `C:\Immich` (compose + `.env`) |
| `-ImmichVersion` | `v3` |

The script installs (winget) Docker Desktop, Tailscale, Syncthing and Node LTS; downloads the latest Immich `docker-compose.yml` and `example.env` into `C:\Immich`; sets `UPLOAD_LOCATION`, `DB_DATA_LOCATION=./postgres`, `IMMICH_VERSION`, and a random `DB_PASSWORD` on a fresh install; writes `C:\ProgramData\Orbit\agent.json` (ACL: SYSTEM + Administrators); copies the agent bundle, `orbit-agent-runner.ps1` and `immich-db-dump.ps1` to `C:\Program Files\Orbit`; registers scheduled tasks **Orbit Agent** (at startup, SYSTEM) and **Syncthing** (at your logon); and opens TCP 7420 only from `100.64.0.0/10`. Re-running keeps existing files.

3. Reboot if Docker Desktop/WSL2 was just installed. Docker Desktop -> Settings -> General: **Use the WSL 2 based engine** and **Start Docker Desktop when you sign in**. Then `cd C:\Immich; docker compose up -d` if the script could not.
4. `tailscale up` (or the tray icon). Restart the agent task or wait: it retries enrollment.
5. Immich: open `http://localhost:2283`, create the admin user.
6. Syncthing (`http://127.0.0.1:8384`): add two folders, both type **Send Only**, with these exact folder IDs:

| Folder ID | Path | Notes |
|---|---|---|
| `immich-library` | the `UPLOAD_LOCATION` (`D:\Immich\library`) | |
| `immich-db-dumps` | `D:\Immich\db-dumps` | `.stignore` with `*.partial` |

The hub pairs arm-free and creates the matching Receive Only folders on the replica side. If the PC is offline at that moment, pairing retries automatically.

`.stignore` for `immich-db-dumps` (the dump script writes `*.partial` and renames when complete):

```
*.partial
```

7. **Keep the PC awake.** Settings -> System -> Power: Sleep "Never" on AC (or `powercfg /change standby-timeout-ac 0`), and make sure the PC signs in after a reboot (Syncthing starts at logon, Docker Desktop starts at sign-in). The Orbit Agent task runs at boot as SYSTEM.
8. **Firewall for Immich** (LAN and Tailscale), elevated PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Immich 2283 (LAN+Tailscale)" -Direction Inbound -Protocol TCP -LocalPort 2283 `
  -RemoteAddress "LocalSubnet","100.64.0.0/10" -Action Allow -Profile Any
```

The installer only opens 7420. Docker Desktop publishes 2283 on all interfaces, so restrict it like this and do not port-forward on your router.

## 4. Tailscale notes

- Enable MagicDNS in the admin console. Use `arm-free.<tailnet>.ts.net` and `<pc>.<tailnet>.ts.net` everywhere (hub URL, Immich external URL).
- Disable key expiry for arm-free and the PC (Machines -> ... -> Disable key expiry), otherwise an expired key silently takes the standby offline.
- Suggested ACL (tag the servers, allow your user devices to reach them, and let servers talk to each other for Syncthing and the hub):

```json
{
  "tagOwners": { "tag:orbit": ["autogroup:admin"] },
  "acls": [
    { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:orbit:3000,2283,22"] },
    { "action": "accept", "src": ["tag:orbit"], "dst": ["tag:orbit:3000,7420,22000,2283"] }
  ],
  "ssh": [
    { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:orbit"], "users": ["autogroup:nonroot", "root"] }
  ]
}
```

Tag arm-free with `sudo tailscale up --ssh --advertise-tags=tag:orbit --hostname arm-free` (re-run `tailscale up` with all its previous flags). The hub (running on arm-free) polls agents on port 7420 and pairs Syncthing on 22000, so the `tag:orbit` to `tag:orbit` rule is required. Adjust if your PC is not tagged: it then needs its own rule from arm-free.

## 5. Immich, Syncthing and restic

How replication works:

1. Immich on the PC writes to `UPLOAD_LOCATION`. Syncthing (Send Only) ships it to arm-free over Tailscale.
2. A daily job on the PC (agent job `immich-db`, 02:30) runs `immich-db-dump.ps1`: `pg_dumpall --clean --if-exists` inside `immich_postgres`, gzipped, `docker cp` out, written as `immich-YYYYMMDD-HHmm.sql.gz`, last 14 kept. That folder is the Send Only `immich-db-dumps`.
3. On arm-free both folders are Receive Only. Hub-created defaults (Settings -> General, "shared folders"): `immich-library` staggered versioning (`maxAge` 30 days), `immich-db-dumps` simple versioning (`keep` 10). Versions land in `.stversions` inside each replica folder. Local edits on a Receive Only folder never propagate back.
4. `prune-dumps.sh` on arm-free (04:45) keeps the newest 14 dumps (`KEEP_DUMPS`, `ORBIT_DUMP_DIR` override).
5. Orbit shows lag and completion per folder; it alerts when a replica is more than 24 h behind.

**Standby Immich `.env`** (`deploy/arm-free/immich-standby/.env`) must match the PC, otherwise a restore can fail:

| Key | Value |
|---|---|
| `IMMICH_POSTGRES_IMAGE` | Copy the exact `image:` of the `database` service from `C:\Immich\docker-compose.yml` (tag@sha256 digest). Required, compose refuses to start without it. |
| `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE_NAME` | Same as in `C:\Immich\.env` (the installer generated a random `DB_PASSWORD`). |
| `IMMICH_VERSION` | `v3` (same major as the PC). |
| `UPLOAD_LOCATION` / `DB_DATA_LOCATION` | `/srv/orbit/immich-library` / `/srv/orbit/immich-standby-db` (already set). |
| `TAILSCALE_IP` | Filled by the installer. |

The standby has no machine-learning container. After promoting, also disable ML in Immich (Administration -> Settings -> Machine Learning), because the restored DB carries the PC's settings. Also compare the `redis` image in `immich-standby/docker-compose.yml` (`valkey/valkey:9`) with the PC's compose and match it.

### restic

The `restic` job in `/etc/orbit/agent.json` runs daily at 03:00 on arm-free: `restic backup /srv/orbit/immich-db-dumps /etc/orbit/agent.json --tag orbit`. Note `agent.json` contains the agent token and the restic password file lives in `/etc/orbit`, so store that password in your password manager too. Set it up:

```bash
sudo sh -c 'openssl rand -hex 24 > /etc/orbit/restic-password && chmod 600 /etc/orbit/restic-password'
# edit /etc/orbit/agent.json -> jobs[id=restic].env.RESTIC_REPOSITORY, e.g. b2:bucket:orbit or sftp:user@host:/path
# (add provider credentials such as B2_ACCOUNT_ID / B2_ACCOUNT_KEY to the same "env" object)
sudo systemctl restart orbit-agent
sudo RESTIC_REPOSITORY=<repo> RESTIC_PASSWORD_FILE=/etc/orbit/restic-password restic init
```

Add more paths (for example your own app backups) to the job `args` if you want them offsite. The default config does not back up the photo library itself offsite.

## 6. iPhone setup

1. Install the **Tailscale** app and sign in to the same tailnet.
2. Install the **Immich** app. Server URL: `http://<pc-lan-ip>:2283` (home) first. Then Settings -> Networking -> **Automatic URL switching**: enable it, set your home Wi-Fi **SSID** and the local URL `http://<pc-lan-ip>:2283`, and add the external URL `http://<pc>.<tailnet>.ts.net:2283` (external URLs are tried in order). It needs the Location permission to read the SSID. Give the PC a DHCP reservation so the LAN IP is stable.
3. Enable backup in Immich. Uploads queue while the PC is off and run when it is reachable (iOS background limits apply: opening the app periodically helps with large backlogs).
4. Orbit on the Home Screen: open `http://arm-free.<tailnet>.ts.net:3000` in Safari -> Share -> **Add to Home Screen**.
5. LAN mode: the Orbit "Open Immich" link probes the PC's LAN URL (`/api/server/ping`, 1.5 s). If Orbit is served over `https` the `http://` probe is blocked as mixed content and it falls back to the Tailscale URL. There is a manual override (Auto / LAN / Tailscale) next to the link, saved per browser. Set the LAN and Tailscale URLs on the PC device in Devices.
6. After a promote the link and the instructions point to the standby URL (`http://arm-free.<tailnet>.ts.net:2283`); change the Immich app's server URL accordingly.

## 7. Folder storage limits

Folders -> add a folder (device, path, limit, mode). Usage is measured every `sizeIntervalMin` (10 min). Alerts fire at 80% and 100%.

| Mode | Behaviour | Platforms |
|---|---|---|
| `alert` | Warns at 80% and 100% (Discord/email/dashboard). Nothing is blocked. | all |
| `pause-sync` | Requires a Syncthing folder ID. At 100% the agent pauses that Syncthing folder (`PATCH /rest/config/folders/{id}` `{"paused":true}`); it resumes automatically when usage drops below 95% (hysteresis). Changing the mode or deleting the limit resumes a folder Orbit paused. | all |
| `hard` | Folder sits on a size-capped volume, so writes beyond the cap fail with ENOSPC. | Linux only (Windows rejects it) |

**Important:** in the agent, `hard` currently only alerts when the limit is reached (see `agent/src/folders.ts`); the actual cap comes from the volume you create with the script:

```bash
sudo /opt/orbit/deploy/arm-free/scripts/make-capped-folder.sh /srv/orbit/app-backups 20            # empty or new path
sudo /opt/orbit/deploy/arm-free/scripts/make-capped-folder.sh /srv/orbit/app-backups 20 --migrate  # path has data: stop writers first
```

It fallocates `/srv/orbit/.capped/<name>.img`, formats ext4 (`-m 0`), adds `<img> <path> ext4 loop,nofail,noatime 0 0` to `/etc/fstab` and mounts it. The old directory is kept as `<path>.premigrate-<pid>`; delete it after checking. The space is reserved immediately.

Alternative without image files: **project quotas**. XFS: mount with `prjquota`, then `echo "42:/srv/orbit/app-backups" >> /etc/projects; echo "apb:42" >> /etc/projid; xfs_quota -x -c 'project -s apb' /srv; xfs_quota -x -c 'limit -p bhard=20g apb' /srv`. ext4: `tune2fs -O project,quota /dev/XXX`, mount with `prjquota`, `chattr -p 42 +P <dir>`, `setquota -P 42 0 30G 0 0 /srv`. The Oracle boot volume usually has neither option, which is why the loopback approach is the default.

**Overcommit warning:** the Folders page flags a volume as overcommitted when the sum of limits minus current usage of limited folders exceeds free space. Loopback caps are allocated up front, so the sum of all caps must fit in the 200 GB allowance (boot + block).

## 8. Backups

| Job (id) | Where | Schedule | Retention |
|---|---|---|---|
| Immich DB dump (`immich-db`) | PC, `immich-db-dump.ps1` | `30 2 * * *` | last 14 dumps (script) |
| Prune Immich DB dumps (`prune-dumps`) | arm-free | `45 4 * * *` | last 14 (`KEEP_DUMPS`) |
| Restic (`restic`) | arm-free | `0 3 * * *` | per your repo |

### Backup jobs

Jobs live in the `jobs` array of `agent.json`; add your own without code changes. Each entry:

| Field | Meaning |
|---|---|
| `id` | Unique, stable id (used by `POST /v1/backups/:job/run`). |
| `name` | Label on the Backups card. |
| `kind` | `pgdump` (Immich database dump on the PC), `restic` (offsite repository), or `command` (any program). |
| `schedule` | Cron expression (5 fields). |
| `command`, `args` | Executable and its arguments (no shell; wrap pipes in a script). |
| `env` | Extra environment variables (for example `RESTIC_REPOSITORY`). |
| `outputDir` | Folder the job writes to; the card shows its size and newest file. |
| `retention` | Free-text label shown on the card (your script does the pruning). |
| `timeoutMin` | Kill the job after this many minutes. |

`pgdump` and `restic` are the built-in kinds shipped in the example configs (the Immich dump on the PC, offsite restic on arm-free). Example custom job: a nightly tarball of an app's data directory, made by your own script:

```json
{
  "id": "app-data",
  "name": "App data tarball",
  "kind": "command",
  "schedule": "30 3 * * *",
  "command": "/usr/local/bin/backup-app.sh",
  "args": ["/srv/myapp/data", "/srv/orbit/app-backups"],
  "outputDir": "/srv/orbit/app-backups",
  "retention": "last 7 archives",
  "timeoutMin": 30
}
```

Backups page (or `POST /v1/backups/:job/run` on the agent): **Run backup now** on any job card.

## 9. Promote standby, switch back, restore test

**Promote** (hub: Settings -> Standby -> Promote, type `PROMOTE`; or `sudo /opt/orbit/deploy/arm-free/scripts/promote-standby.sh [--force]` on arm-free). It does, in order:

1. Pauses the Syncthing folders `immich-library` and `immich-db-dumps` (`PROMOTE_FOLDERS`).
2. Picks the newest `*.sql.gz`/`*.sql` in `/srv/orbit/immich-db-dumps` (or `ORBIT_DUMP_FILE`) and tests the gzip.
3. Starts only the standby Postgres and waits for `pg_isready`.
4. Restores the dump (`pg_dumpall --clean --if-exists` format, drops and recreates objects).
5. Starts the rest of the Immich stack (no ML).
6. Waits for `/api/server/ping` = `pong` on `http://<TAILSCALE_IP>:2283`.
7. Prints the URL and a **data lag warning**, records the time in `/var/lib/orbit/promoted-at`, notifies Discord.

Data lag: anything changed on the PC after the dump (default: up to ~24 h) is not in the database, and the library is as of the last sync. Uploads to the standby exist only there until you switch back. Point the phone's Immich server URL at `http://arm-free.<tailnet>.ts.net:2283`.

**Switch back** (PC is up, Immich running, its `immich-library` folder Send Only and connected): `sudo /opt/orbit/deploy/arm-free/scripts/switch-back.sh [--yes] [--skip-export]`. It stops the standby stack, exports files uploaded since the promotion to `/srv/orbit/standby-uploads-<date>`, sets the replica folders back to Receive Only and reverts local changes, resumes them, and removes the promotion timestamp. Then re-upload the exported files on the PC (Immich app, or `immich upload --recursive /srv/orbit/standby-uploads-<date>` with the Immich CLI), and set the phone back to the PC URLs.

The full step lists, a restore-test checklist (dump restore, restic, Syncthing versioning) and verification commands are in **[docs/failover-restore.md](docs/failover-restore.md)**. Run the restore test every few months.

## 10. Keep-alive and idle-risk meter

Oracle may reclaim an Always Free A1 instance when, over 7 days, CPU p95 is under 20%, network under 20% **and** memory under 20% (all three). The Usage page shows each metric against its threshold; "at risk" appears only when all three are below. The meter needs history: coverage is low for the first week, so do not trust it before about 7 days of samples.

A fresh arm-free mostly idles: the Immich standby stack only runs after a promote, so Syncthing and the hub use little CPU, memory and network. Expect the meter to show **at risk** until you add load or keep-alive.

Keep-alive is the `keepalive` block in `/etc/orbit/agent.json`: `/opt/orbit/bin/NeverIdle -c 2h -m 2 -n 4h` (downloaded by the installer; see the NeverIdle README for flag meanings). The agent spawns it at nice 19, restarts it after 30 s if it dies, and remembers the toggle. With `"defaultEnabled": true` (the shipped arm-free config) the agent turns it on at first boot unless you switched it off. It is recommended on the standby: manage it in Settings -> Standby (Keep-alive card), and the Overview **Getting started** checklist links to it. The network percentage is computed against `networkBandwidthMbps` (2000 in the example config).

## 11. Auto-updates

- **Containers:** `orbit-update.timer` runs `scripts/update.sh` daily at 04:30 (random delay up to 30 min). It pulls the main stack (Syncthing `2`, plus the locally built hub), recreates changed services, updates the Immich standby stack only if it is running, prunes images and posts changed images (or failures) to `DISCORD_WEBHOOK_URL`. Optional overrides go in `/etc/orbit/update.env` (`DISCORD_WEBHOOK_URL=...`, `ORBIT_AUTO_BUILD=1`). The `orbit-web` image is built locally, so it is rebuilt only with `ORBIT_AUTO_BUILD=1`, or manually after `git pull`: `cd /opt/orbit-src/deploy/arm-free && docker compose up -d --build`. Check: `systemctl list-timers orbit-update.timer`, `journalctl -u orbit-update`.
- **Immich** is pinned to the major (`IMMICH_VERSION=v3`), so only minor/patch updates arrive. To move to a new major: read its release notes, update the PC first (`IMMICH_VERSION` in `C:\Immich\.env`, `docker compose pull; docker compose up -d`), let a fresh dump sync, then set the same value and the new `IMMICH_POSTGRES_IMAGE`/valkey tags in `immich-standby/.env` and compose, and rehearse a promote ([restore test](docs/failover-restore.md)).
- **Agents** self-update: they poll `GET /api/agent/version` on the hub (version + sha256), download `/agent/orbit-agent.mjs`, replace the bundle and exit; systemd (`Restart=always`) or the Windows runner restarts them. Rebuilding the hub image ships new agents to every device (`docker compose up -d --build`).
- **Windows:** scheduled task `Orbit Agent` runs `orbit-agent-runner.ps1`, a loop that restarts the agent 5 s after it exits (log `C:\ProgramData\Orbit\logs\agent.log`, 10 MB rotation). Docker Desktop and Tailscale update themselves; Syncthing is installed by winget (`winget upgrade Syncthing.Syncthing`).

## 12. Development

Requires Node >= 22.13.

```bash
npm install                                  # root, npm workspaces: packages/shared, agent, web
ORBIT_DATA_DIR=./.data npm run dev           # hub on http://localhost:3000 (SQLite in ./.data)
npm run build                                # agent bundle (agent/dist) then Next.js build
npm run typecheck                            # agent + web
```

The hub serves the agent bundle from `../agent/dist` and install templates from `../deploy/install` when run from `web/` (override with `ORBIT_AGENT_DIST`, `ORBIT_INSTALL_TEMPLATES`), so run `npm run build:agent` once before testing the Add device wizard.

Run an agent locally: create `agent/agent.dev.json` (the file `npm run dev -w agent` loads), for example:

```json
{
  "deviceId": "dev-agent", "name": "dev", "role": "replica",
  "token": "dev-token-dev-token-dev-token",
  "listen": { "host": "127.0.0.1", "port": 7420 },
  "hubUrl": "http://localhost:3000", "dataDir": "./.agent-data",
  "sampleIntervalSec": 60, "sizeIntervalMin": 10, "retentionDays": 35,
  "services": [], "jobs": [], "autoUpdate": false
}
```

Create a device with the same id and token via Add device -> "I already installed the agent" (agent URL `http://127.0.0.1:7420`), then `npm run dev -w agent`. `token` must be at least 16 characters.

```
packages/shared/        API contract types (src/index.ts)
agent/                  per-device agent (Node 22) -> agent/dist/orbit-agent.mjs
  src/config.ts         agent.json schema
web/                    Next.js 16 hub: dashboard + API routes (app/api), SQLite cache
deploy/
  web.Dockerfile        hub image (context = repo root; also carries agent bundle + install templates)
  arm-free/             docker-compose.yml, .env.example, agent.example.json, immich-standby/, scripts/, systemd/
  windows/              install-pc.ps1, orbit-agent-runner.ps1, immich-db-dump.ps1
  install/              linux.sh.tmpl, windows.ps1.tmpl (served by the hub wizard)
  pc/agent.example.json
docs/                   long-form guides
```

Hub environment: `ORBIT_DATA_DIR`, `ORBIT_HUB_URL`, `ORBIT_PASSWORD`, `DISCORD_WEBHOOK_URL`, `ORBIT_LOCAL_AGENT_CONFIG`, `ORBIT_LOCAL_AGENT_URL`, `ORBIT_AGENT_DIST`, `ORBIT_INSTALL_TEMPLATES`. Agent: `--config <path>` or `ORBIT_AGENT_CONFIG`.

## 13. Security notes

- Nothing is exposed publicly. The hub, agent and Immich standby bind to the Tailscale IP; Syncthing's GUI is `127.0.0.1:8384`. Windows opens 7420 only for `100.64.0.0/10`.
- Each device has a random Bearer token (shown once in the wizard, stored in `agent.json`: mode 640/600 on Linux, SYSTEM+Administrators on Windows). Install tokens are single use (the install URL returns 410 once enrolled). The install scripts embed the token and an optional Tailscale auth key; do not paste those URLs into chat.
- The Linux agent on arm-free **runs as root** because it needs the Docker socket (container stats, promote) and `du` across folders owned by different users. A compromised agent is root, so keep it tailnet-only and the token secret. Replicas installed by the wizard run the agent as a systemd service with the default user (root) too.
- `ORBIT_PASSWORD` adds a login page (cookie) to the dashboard and API. `/api/enroll`, `/api/agent/version`, `/agent/*` and `/install/*` stay open so agents can enroll and update. Use it if other people share your tailnet.
- Use the Tailscale ACL in [section 4](#4-tailscale-notes) to limit who can reach ports 3000/2283.

## 14. Troubleshooting

| Symptom | Check |
|---|---|
| Device shows offline | `systemctl status orbit-agent` / Windows task "Orbit Agent" and `C:\ProgramData\Orbit\logs\agent.log`. From the hub host: `curl http://<device-ip>:7420/v1/health`. Is Tailscale up on both? Windows firewall rule "Orbit Agent (Tailscale)". The agent `listen.host` must be the device's current Tailscale IP. |
| "Syncthing API key not found" | The agent reads the key from `syncthing.configPath`. arm-free: `/srv/orbit/syncthing-config/config.xml` (start the container once). Replica: `/var/lib/orbit-sync/syncthing/config.xml`. PC: `%LOCALAPPDATA%\Syncthing\config.xml` of the user that runs Syncthing (the one who ran `install-pc.ps1`). Or set `syncthing.apiKey` in agent.json. |
| Immich dump job fails: Docker not running for the SYSTEM task | The task runs as SYSTEM and needs Docker Desktop's engine up (start at sign-in, user logged in). The script uses `\\.\pipe\dockerDesktopLinuxEngine`. Check the Backups card's output tail; Run backup now after starting Docker Desktop. |
| Pairing never happens | The PC must be online with Syncthing running (it starts at logon). The hub retries on each poll. Enroll from the device's own agent; check `docker logs orbit-web`. |
| Idle-risk coverage low | Normal during the first week: the meter needs 7 days of samples. |
| Promote fails at restore | `IMMICH_POSTGRES_IMAGE` or `DB_*` differ from the PC; see `docker logs immich_postgres`. |

## Verified facts (Oct 2026)

- **Oracle Always Free:** Ampere A1 allowance is the first 1,500 OCPU-hours and 9,000 GB-hours per month, which equals 2 OCPU + 12 GB running continuously. 200 GB total boot plus block storage, at most five volume backups. Idle reclamation: an instance is flagged when, over 7 days, CPU 95th percentile, network and memory utilisation are all under 20% (the memory criterion applies to A1 shapes only). Source: <https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>
- **Immich:** v3.3.0 (7 Oct 2026; v3.0 in July 2026), <https://immich.app/blog>. Official `ghcr.io/immich-app` images publish `linux/arm64`, <https://github.com/orgs/immich-app/packages/container/package/immich-server>. iOS app: Settings -> Networking -> Automatic URL switching (local Wi-Fi SSID + local URL, external URLs tried in order, needs Location permission): <https://linuxiac.com/immich-1-122-brings-hdr-video-support-in-the-mobile-app/>, <https://github.com/immich-app/immich/discussions/31865>.
- **Syncthing:** v2.1.x (2.1.6 in Oct 2026), <https://www.versio.io/en/product-release-end-of-life-eol-syncthing-foundation-syncthing.html>. Folder types `sendreceive`, `sendonly`, `receiveonly`, `receiveencrypted`; `paused`; versioning `trashcan`, `simple`, `staggered`, `external`; `minDiskFree`: <https://docs.syncthing.net/users/config.html>, <https://docs.syncthing.net/users/versioning.html>. REST: `X-API-Key` header, `PATCH /rest/config/folders/{id}` with `{"paused":true}`, `/rest/db/completion`: <https://docs.syncthing.net/dev/rest.html>, <https://docs.syncthing.net/rest/config.html>.
