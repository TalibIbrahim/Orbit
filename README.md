# Orbit

Self-hosted storage and server dashboard, delivered as a mobile-first PWA. It watches a small fleet (an Oracle Always Free Arm VM called "arm-free", a Windows PC, optional extra replicas), keeps an Immich photo library replicated with Syncthing, and gives you one place to see usage, replication health, backups and failover.

## Choose a mode

The setting `primaryMode` decides where Immich runs. Choose it when you install arm-free (`install-arm-free.sh --mode device|arm-free`, env `ORBIT_PRIMARY_MODE`, default `device`). It is shown and editable in Settings -> General, but changing it there does not move data or reconfigure Immich/Syncthing.

| | Device primary (`device`, default) | arm-free primary (`arm-free`) |
|---|---|---|
| Where Immich runs | Home PC (Docker Desktop) | Permanently on arm-free |
| What arm-free does | Standby replica; Immich starts only on Promote | Primary: Immich + hub + Syncthing (Send Only) |
| Other devices | PC is the Send Only source | PC, laptop, extras are Receive Only replicas (any drive), no Docker |
| Failover | Promote / Switch back buttons | Manual [disaster recovery](docs/failover-restore.md#disaster-recovery-arm-free-primary) on a replica with Docker |
| Keep-alive | Recommended, on by default | Optional, off by default (Immich load usually keeps the VM busy) |
| Storage limit | Library size follows the PC disk; arm-free holds a replica | 200 GB Oracle block storage in total (boot volume included) caps the library |

**Device mode**

```
 iPhone (Immich app + Orbit PWA) ---- Tailscale (no public ports) ----+
                                                                      |
 PRIMARY: Windows PC                         STANDBY: "arm-free" (Oracle A1.Flex 2 OCPU / 12 GB)
 +--------------------------+  Syncthing   +------------------------------------------------+
 | Immich (Docker Desktop)  |  Send Only   | Syncthing (Receive Only + versioning)          |
 | full library, source of  | -----------> |   immich-library, immich-db-dumps              |
 | truth                    |  immich-     | Orbit hub :3000  <-- polls every agent /60 s   |
 | daily Postgres dump 02:30|  library     | Orbit agent :7420 (systemd, host)              |
 | Orbit agent :7420        |  immich-db-  | Your own services (optional, tracked)          |
 +--------------------------+  dumps       | Immich standby stack (started ONLY by Promote) |
                                           +------------------------------------------------+
 Extra replicas (Linux/Windows) are added with Devices -> Add device and receive the same folders.
```

Single source of truth is the PC. The standby is a replica until you press Promote.

**arm-free mode**

```
 iPhone (Immich app + Orbit PWA) ---- Tailscale (no public ports) ----+
                                                                      |
 PRIMARY: "arm-free" (Oracle A1.Flex 2 OCPU / 12 GB)            REPLICAS: PC, laptop, extras
 +------------------------------------------------+  Syncthing  +---------------------------+
 | Immich :2283 (server, Postgres, ML; bound to   |  Send Only  | Syncthing (Receive Only + |
 |   the Tailscale IP), /srv/orbit/immich-library | ----------> |   staggered versioning)   |
 | daily Postgres dump 02:30 -> immich-db-dumps   |  immich-    | Orbit agent :7420         |
 | Orbit hub :3000, agent :7420, Syncthing        |  library,   | no Docker, no Immich      |
 +------------------------------------------------+  immich-db- +---------------------------+
                                                     dumps
```

Single source of truth is arm-free; every other device is a copy you can restore from. Sections below say **device mode** or **arm-free mode** where they differ.

## Contents

0. [Choose a mode](#choose-a-mode)
1. [Overview and features](#1-overview-and-features)
2. [Set up arm-free](#2-set-up-arm-free) (migrating from device mode: [2.7](#27-migrating-an-existing-device-mode-install-to-arm-free-mode))
3. [Set up the PC and replicas](#3-set-up-the-pc-and-replicas)
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
| Devices / Add device | Wizard creates a device and token and shows a one-line install command. Agents enroll themselves and the hub pairs Syncthing. In arm-free mode the roles are Primary host (arm-free, set up by the installer) and Replica (everything else). |
| Replication health | Per replica and folder: up to date / syncing / offline, completion, lag, versioning type. |
| Backups | Job cards (Immich dump, restic, prune, your own commands) with last run, next run, output size, "Run backup now". |
| Promote standby (device mode) | One button (Settings -> Standby) starts Immich on arm-free from the latest dump. Switch-back instructions on the same tab. In arm-free mode this tab shows a disaster-recovery card instead. |
| Keep-alive | Toggle that runs NeverIdle on arm-free to avoid Oracle idle reclamation (recommended in device mode, optional in arm-free mode). |
| LAN mode | Device mode: the Immich link picks the LAN URL at home, the Tailscale URL away, or the standby URL after a promote. arm-free mode: it opens the arm-free URL (`ORBIT_IMMICH_URL`). |
| PWA | Installable on the iPhone home screen, offline page, light/dark theme. |
| Auto-updates | Containers via a daily systemd timer; agents self-update from the hub. |

How the hub works: it polls every agent every 60 s and caches the last good response in SQLite, so an offline device shows "offline, last seen X" instead of errors. Alerts go to a Discord webhook and/or SMTP email (Settings -> Alerts):

| Alert | Mode | Default threshold |
|---|---|---|
| Replica behind | both | more than 24 h |
| Primary offline (arm-free mode points to [disaster recovery](docs/failover-restore.md#disaster-recovery-arm-free-primary)) | both | more than 3 days |
| Disk / RAM | both | disk over 80%, RAM over 90% |
| Immich library volume nearly full (`library-near-limit`) | arm-free | volume holding `immich-library` at 90% (`thresholds.libraryPercent`), or the Oracle quota, or full within ~14 days |
| Service down, idle risk, folder limit, failed backup | both | n/a |

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

Same steps in both modes; only the install command and what it starts differ.

### 2.1 Create the VM

1. OCI console -> Compute -> Create instance. Shape `VM.Standard.A1.Flex`, **2 OCPU / 12 GB** (this is exactly what the Always Free allowance covers, see [verified facts](#verified-facts-oct-2026)). Image: Ubuntu 24.04 (aarch64). The installer also accepts 22.04.
2. Storage: the Always Free limit is 200 GB total for boot plus block volumes. Suggested split: **50 GB boot + 150 GB block volume**. Only up to five volume backups are free.
3. Add your SSH public key, create the instance, then attach the block volume to it.
4. VCN security list: ingress for **TCP 22 only** (from your IP if you can). Nothing else. Nothing in the stacks is published except on the Tailscale IP. The installer's only iptables change is an INPUT accept for TCP 7420 from Docker bridges (`br+`, `docker0`), so the `orbit-web` container can reach the host agent past the OCI image's final REJECT rule; it is saved with `netfilter-persistent` (skip with `SKIP_IPTABLES=1`).

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
# device mode (default; Immich lives on your PC, arm-free is the standby):
sudo ORBIT_HUB_URL=http://arm-free.<tailnet>.ts.net:3000 /opt/orbit-src/deploy/arm-free/scripts/install-arm-free.sh
# arm-free mode (Immich runs here permanently):
sudo ORBIT_HUB_URL=http://arm-free.<tailnet>.ts.net:3000 /opt/orbit-src/deploy/arm-free/scripts/install-arm-free.sh --mode arm-free
```

Flags: `--mode device|arm-free` (or `ORBIT_PRIMARY_MODE`), `--no-ml` (or `IMMICH_ML=0`; arm-free mode, no machine learning, so no smart search or face recognition). The installer is idempotent and never overwrites existing config; re-run with a different `--mode` / `--no-ml` to switch (the mode is stored in `deploy/arm-free/.env`). Optional environment variables:

| Variable | Effect |
|---|---|
| `ORBIT_HUB_URL` | Written to `deploy/arm-free/.env` and the agent config (default `http://<tailscale ip>:3000`). Use the MagicDNS name. |
| `ORBIT_PRIMARY_MODE`, `IMMICH_ML` | Same as `--mode` / `--no-ml`. |
| `ORBIT_DEVICE_ID` | Device id in `/etc/orbit/agent.json` (default `arm-free`). |
| `TS_AUTHKEY` | If Tailscale is not logged in, runs `tailscale up --ssh --authkey ... --hostname arm-free`. |
| `SKIP_NEVERIDLE=1` | Do not download NeverIdle. |
| `SKIP_START=1` | Install units and files but do not start the agent, timer or compose stack. |
| `ORBIT_ROOT` (via lib.sh) | Data root, default `/srv/orbit`. The shipped agent config and compose files hardcode `/srv/orbit`, so leave it. |

Both modes: installs Docker, Tailscale, Node 22, restic, zstd, jq, NeverIdle (`/opt/orbit/bin/NeverIdle`), creates `/srv/orbit/{immich-library,immich-db-dumps,immich-standby-db,immich-db,immich-ml-cache,syncthing-config,orbit-data,replicas}` (with a `*.partial` `.stignore` in `immich-db-dumps`), symlinks `/opt/orbit/deploy` to the repo, writes `/etc/orbit/agent.json` (mode 640, group 1000), installs `orbit-agent.service`, `orbit-update.service` and `orbit-update.timer`, creates `deploy/arm-free/immich/.env` and `immich-config.json`, and starts the hub stack with `docker compose up -d --build` when Tailscale is up.

| | Device mode | arm-free mode |
|---|---|---|
| Agent config | from `agent.example.json` (role standby) | from `agent.primary.example.json` (role primary, keep-alive off by default, job `immich-db`) |
| Immich | Not started (Promote does it). DB dir `/srv/orbit/immich-standby-db`. | Started by the installer from `deploy/arm-free/immich` (compose project `immich`), fresh database, no dump restore. Library `/srv/orbit/immich-library`, DB `/srv/orbit/immich-db`, port 2283 bound to the Tailscale IP only. |
| `immich/.env` | You set `IMMICH_POSTGRES_IMAGE` and `DB_PASSWORD` to match the PC | Random `DB_PASSWORD` generated; default Postgres image is fine |
| Machine learning | Off | On (`COMPOSE_PROFILES=ml`) unless `--no-ml`; limits `IMMICH_SERVER_CPUS=1.5`, `IMMICH_ML_CPUS=1.0`, `IMMICH_ML_MEM=3g`; job concurrency 1 via `immich/immich-config.json` |
| Stored URL | n/a | `ORBIT_IMMICH_URL=http://arm-free.<tailnet>.ts.net:2283` in `deploy/arm-free/.env` |

`immich-config.json` is loaded through `IMMICH_CONFIG_FILE`, which makes the settings it covers (ML on/off, job concurrency) **read-only in the Immich admin UI**. Edit the file instead and run `docker compose up -d` in `deploy/arm-free/immich`, or comment out `IMMICH_CONFIG_FILE` in `immich/.env` to manage them in the UI.

### 2.4 Review the .env files

`/opt/orbit-src/deploy/arm-free/.env` (created by the installer, mode 600):

| Key | Meaning |
|---|---|
| `TAILSCALE_IP` | Output of `tailscale ip -4`. The hub (3000) binds to it. |
| `ORBIT_HUB_URL` | URL other devices use to reach the hub. |
| `ORBIT_PRIMARY_MODE` | `device` or `arm-free`; set by the installer. |
| `ORBIT_IMMICH_URL` | arm-free mode: URL behind the Immich link; filled by the installer from the MagicDNS name. |
| `ORBIT_PASSWORD` | Optional dashboard password. Empty = rely on Tailscale ACLs. |
| `DISCORD_WEBHOOK_URL` | Optional; hub alerts and `update.sh` notifications. |

`deploy/arm-free/immich/.env`: see [section 5](#5-immich-syncthing-and-restic).

If you edit either file later: `cd /opt/orbit-src/deploy/arm-free && docker compose up -d --build`.

### 2.5 Open the hub

Browse to `http://arm-free.<tailnet>.ts.net:3000` from any device on your tailnet. arm-free's own agent is registered automatically: the compose file mounts `/etc/orbit/agent.json` read-only into `orbit-web` (`ORBIT_LOCAL_AGENT_CONFIG=/run/orbit/agent.json`, `ORBIT_LOCAL_AGENT_URL=http://<TAILSCALE_IP>:7420`). You do not add it by hand, even though the installer prints a deviceId/token banner.

Syncthing GUI is loopback-only: `ssh -L 8384:127.0.0.1:8384 ubuntu@arm-free`, then open `http://127.0.0.1:8384`. Normally you never need it, the hub pairs folders.

### 2.6 First run

Open Overview: the **Getting started** checklist walks through the first steps.

- **Device mode:** add the PC, pair folders, enable keep-alive (marked **Recommended**: a standby mostly idles, see [section 10](#10-keep-alive-and-idle-risk-meter) and Settings -> Standby), set up alerts.
- **arm-free mode:** open `http://arm-free.<tailnet>.ts.net:2283` in a browser and create the Immich admin account first, then add replicas ([section 3.2](#32-replicas-add-device)), set up the phone ([section 6](#6-iphone-setup)) and alerts. Keep-alive is optional.

### 2.7 Migrating an existing device-mode install to arm-free mode

Moves Immich from the PC to arm-free and keeps your photos, albums and users (the PC's last database dump is restored on arm-free). Afterwards the PC is a Receive Only replica. Plan for a short upload pause between steps 1 and 7.

1. **Final sync from the PC.** In Orbit -> Backups run the PC's **Immich DB dump** job (Run now). Wait until Replication shows both folders **Up to date** on arm-free, then stop Immich on the PC so nothing new is uploaded: `cd C:\Immich; docker compose down`. Note the PC's `DB_PASSWORD`, `DB_USERNAME` and the Postgres image line from `C:\Immich\.env` / `docker-compose.yml`.
2. **Remove the PC from the hub.** Devices -> PC -> Remove. Roles cannot be changed in place (the device's agent config and Syncthing folders depend on the role); the PC is added back as a Replica in step 6.
3. **Switch arm-free.**

   ```bash
   cd /opt/orbit-src && sudo git pull
   # RESTIC_REPOSITORY only if you use restic (also needs /etc/orbit/restic-password)
   sudo RESTIC_REPOSITORY=<repo> /opt/orbit-src/deploy/arm-free/scripts/install-arm-free.sh --mode arm-free   # add --no-ml to skip ML
   ```

   The installer backs up `/etc/orbit/agent.json` to `agent.json.bak-<timestamp>` and migrates it in place: deviceId, token, hubUrl and listen are kept; role becomes `primary`; leftover Minecraft services/jobs and the promote block are removed; the 02:30 `immich-db` dump job is added (`prune-dumps` is kept); the restic job is kept only if `/etc/orbit/restic-password` exists and a repository is set. It also adds the iptables rule for port 7420 from Docker bridges, restarts the agent and the hub (which re-reads the role), and starts a **fresh** Immich. Re-running it is safe.
4. **Restore the PC's database on arm-free** (replaces the fresh, empty database):

   ```bash
   cd /opt/orbit/deploy/arm-free/immich
   # set DB_PASSWORD / DB_USERNAME / IMMICH_POSTGRES_IMAGE to the PC's values from step 1
   sudo nano .env
   sudo docker compose down
   sudo rm -rf /srv/orbit/immich-db && sudo mkdir /srv/orbit/immich-db
   sudo docker compose up -d database && sleep 15
   DUMP=$(ls -t /srv/orbit/immich-db-dumps/*.sql.gz | head -n 1); echo "$DUMP"
   gunzip -c "$DUMP" | sudo docker exec -i immich_postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres'
   sudo docker compose up -d
   ```

   The library at `/srv/orbit/immich-library` is already the PC's library (it was the standby replica), so the restored database finds every file. Log in at `http://arm-free.<tailnet>.ts.net:2283` with your existing account and spot-check old and new photos.
5. **Turn arm-free into the source.** Nothing to do by hand: when the first replica pairs, the hub switches arm-free's `immich-library` and `immich-db-dumps` folders to **Send Only** (and replicas to **Receive Only**). Agents update themselves from the hub within a few minutes of the `git pull`; check Devices for the new agent version first.
6. **Add the PC back as a Replica.** Devices -> Add device -> Replica, Windows. Choose the folder paths (the PC's existing Syncthing folders keep their current location). Run the command in an elevated PowerShell: it backs up the PC's old `C:\ProgramData\Orbit\agent.json` (role primary) and replaces it, restarts the agent, and the hub pairs it. The PC's folders become Receive Only with versioning. Docker Desktop and `C:\Immich` are no longer needed on the PC; remove them once you are happy (keep `C:\Immich\.env` until then).
7. **Phones:** Immich app -> server URL `http://arm-free.<tailnet>.ts.net:2283` ([section 6](#6-iphone-setup)).
8. **Check:** Devices shows no warnings (a role mismatch or missing replica paths is flagged on the device card); Replication shows each replica as **Receive Only** with **Versioning: staggered**; Backups shows `immich-db` succeeding after 02:30. Then delete the old standby database: `sudo rm -rf /srv/orbit/immich-standby-db`.

If the hub still lists arm-free as Standby after step 3, `docker restart orbit-web`. If a replica folder shows "type unknown" or "No versioning", the Replication page shows the likely reason under the folder.

## 3. Set up the PC and replicas

### 3.1 The PC (device mode only)

In arm-free mode skip this; the PC is just a replica ([3.2](#32-replicas-add-device)).

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

### 3.2 Replicas (Add device)

Devices -> Add device creates a device and shows a one-line command to run on it (elevated PowerShell on Windows, `sudo` on Linux).

- **Roles:** in device mode arm-free is the standby and the PC is the Primary. In arm-free mode the wizard offers **Primary host** (arm-free itself: set up by the installer, auto-registered, no command) and **Replica** (every other device, including your PC).
- **Folder paths:** you choose where each replica folder lives, on any drive, for example `D:\Orbit\immich-library` and `D:\Orbit\immich-db-dumps`.
- **Direction (arm-free mode):** arm-free's `immich-library` and `immich-db-dumps` are **Send Only**; each replica gets them as **Receive Only** with versioning (library staggered, dumps simple, keep 10). The hub pairs them automatically and retries while a device is offline. Local edits on a replica never propagate back.
- **Versioning age:** the staggered `maxAge` is set in Settings -> General -> Replica versioning (default 30 days, range 1 to 3650). It is applied when a replica is (re)paired, so it does not change existing pairs. Old versions land in `.stversions` inside the replica folder.
- **The replica installer adds only** Tailscale, Syncthing, Node 22 and the Orbit agent. No Docker, no virtualization, no Immich.

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

How replication works (**device mode**; arm-free mode is described after the `.env` tables below):

1. Immich on the PC writes to `UPLOAD_LOCATION`. Syncthing (Send Only) ships it to arm-free over Tailscale.
2. A daily job on the PC (agent job `immich-db`, 02:30) runs `immich-db-dump.ps1`: `pg_dumpall --clean --if-exists` inside `immich_postgres`, gzipped, `docker cp` out, written as `immich-YYYYMMDD-HHmm.sql.gz`, last 14 kept. That folder is the Send Only `immich-db-dumps`.
3. On arm-free both folders are Receive Only. Hub-created defaults (Settings -> General, "shared folders"): `immich-library` staggered versioning (`maxAge` 30 days), `immich-db-dumps` simple versioning (`keep` 10). Versions land in `.stversions` inside each replica folder. Local edits on a Receive Only folder never propagate back.
4. `prune-dumps.sh` on arm-free (04:45) keeps the newest 14 dumps (`KEEP_DUMPS`, `ORBIT_DUMP_DIR` override).
5. Orbit shows lag and completion per folder; it alerts when a replica is more than 24 h behind.

**Standby Immich `.env`, device mode** (`deploy/arm-free/immich/.env`) must match the PC, otherwise a restore can fail:

| Key | Value |
|---|---|
| `IMMICH_POSTGRES_IMAGE` | Copy the exact `image:` of the `database` service from `C:\Immich\docker-compose.yml` (tag@sha256 digest). Required, compose refuses to start without it. |
| `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE_NAME` | Same as in `C:\Immich\.env` (the installer generated a random `DB_PASSWORD`). |
| `IMMICH_VERSION` | `v3` (same major as the PC). |
| `UPLOAD_LOCATION` / `DB_DATA_LOCATION` | `/srv/orbit/immich-library` / `/srv/orbit/immich-standby-db` (set by the installer). |
| `TAILSCALE_IP` | Filled by the installer. |

The standby has no machine-learning container. After promoting, also disable ML in Immich (Administration -> Settings -> Machine Learning), because the restored DB carries the PC's settings. Also compare the `redis` image in `immich/docker-compose.yml` (`valkey/valkey:9`) with the PC's compose and match it.

**arm-free mode.** The direction is reversed:

1. Immich on arm-free writes to `/srv/orbit/immich-library`; Syncthing (Send Only) ships it to every replica.
2. The agent job `immich-db` (02:30) runs `scripts/immich-dump.sh`: `pg_dumpall --clean --if-exists | gzip` into `/srv/orbit/immich-db-dumps/immich-YYYYMMDD-HHmm.sql.gz`, written as `.partial` and renamed when complete (the folder's `.stignore` with `*.partial` keeps half-written files off the wire). `prune-dumps.sh` then keeps the newest 14 (`KEEP_DUMPS`).
3. Replicas hold Receive Only copies of both folders. Orbit shows lag per replica and alerts at more than 24 h.

**Immich `.env`, arm-free mode** (`deploy/arm-free/immich/.env`, mode 600, created by the installer):

| Key | Value |
|---|---|
| `DB_PASSWORD` | Random, generated by the installer. Keep a copy: [disaster recovery](docs/failover-restore.md#disaster-recovery-arm-free-primary) may need it. |
| `IMMICH_VERSION`, `IMMICH_POSTGRES_IMAGE` | `v3` and the default image; change together when you change major. |
| `UPLOAD_LOCATION` / `DB_DATA_LOCATION` | `/srv/orbit/immich-library` / `/srv/orbit/immich-db` |
| `COMPOSE_PROFILES` | `ml` runs the machine-learning container; empty = off (`--no-ml`). |
| `IMMICH_SERVER_CPUS`, `IMMICH_ML_CPUS`, `IMMICH_ML_MEM` | `1.5`, `1.0`, `3g` |
| `IMMICH_CONFIG_FILE` | `/config/immich.json` (the generated `immich-config.json`; its settings are read-only in the admin UI) |

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

**arm-free mode**

1. Install the **Tailscale** app, sign in to the same tailnet and keep it on (VPN On Demand) so background backup works.
2. Create the Immich admin account first, in a browser at `http://arm-free.<tailnet>.ts.net:2283`.
3. Install the **Immich** app with the same server URL (the MagicDNS name; the installer stores it as `ORBIT_IMMICH_URL`). One URL works at home and away, no automatic switching needed.
4. Enable backup in Immich. Add Orbit to the Home Screen as in step 4 below.

**Device mode**

1. Install the **Tailscale** app and sign in to the same tailnet.
2. Install the **Immich** app. Server URL: `http://<pc-lan-ip>:2283` (home) first. Then Settings -> Networking -> **Automatic URL switching**: enable it, set your home Wi-Fi **SSID** and the local URL `http://<pc-lan-ip>:2283`, and add the external URL `http://<pc>.<tailnet>.ts.net:2283` (external URLs are tried in order). It needs the Location permission to read the SSID. Give the PC a DHCP reservation so the LAN IP is stable.
3. Enable backup in Immich. Uploads queue while the PC is off and run when it is reachable (iOS background limits apply: opening the app periodically helps with large backlogs).
4. Orbit on the Home Screen: open `http://arm-free.<tailnet>.ts.net:3000` in Safari -> Share -> **Add to Home Screen**.
5. LAN mode (device mode): the Orbit "Open Immich" link probes the PC's LAN URL (`/api/server/ping`, 1.5 s). If Orbit is served over `https` the `http://` probe is blocked as mixed content and it falls back to the Tailscale URL. There is a manual override (Auto / LAN / Tailscale) next to the link, saved per browser. Set the LAN and Tailscale URLs on the PC device in Devices.
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
| Immich DB dump (`immich-db`) | device mode: PC, `immich-db-dump.ps1`; arm-free mode: arm-free, `scripts/immich-dump.sh` | `30 2 * * *` | last 14 dumps (script) |
| Prune Immich DB dumps (`prune-dumps`) | arm-free (device mode job; in arm-free mode `immich-dump.sh` prunes itself) | `45 4 * * *` | last 14 (`KEEP_DUMPS`) |
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

**arm-free mode:** there are no Promote / Switch back buttons and `promote-standby.sh` / `switch-back.sh` refuse to run. If arm-free is lost, follow the manual [Disaster recovery (arm-free primary)](docs/failover-restore.md#disaster-recovery-arm-free-primary): restore Immich on a replica that has Docker from its library copy and the newest dump.

**Device mode.** **Promote** (hub: Settings -> Standby -> Promote, type `PROMOTE`; or `sudo /opt/orbit/deploy/arm-free/scripts/promote-standby.sh [--force]` on arm-free). It does, in order:

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

**Device mode:** a standby mostly idles (Immich only runs after a promote), so Syncthing and the hub use little CPU, memory and network. Expect the meter to show **at risk** until you add load or keep-alive.

**arm-free mode:** Immich's memory use (server + Postgres + ML) normally keeps the VM above the 20% memory threshold, so keep-alive is optional and off by default (`defaultEnabled: false` in `agent.primary.example.json`). Turn it on in Settings if the idle-risk card warns.

Keep-alive is the `keepalive` block in `/etc/orbit/agent.json`: `/opt/orbit/bin/NeverIdle -c 2h -m 2 -n 4h` (downloaded by the installer; see the NeverIdle README for flag meanings). The agent spawns it at nice 19, restarts it after 30 s if it dies, and remembers the toggle. With `"defaultEnabled": true` (device-mode `agent.example.json`) the agent turns it on at first boot unless you switched it off. It is recommended on the standby: manage it in Settings -> Standby (Keep-alive card), and the Overview **Getting started** checklist links to it. The network percentage is computed against `networkBandwidthMbps` (2000 in the example config).

## 11. Auto-updates

- **Containers:** `orbit-update.timer` runs `scripts/update.sh` daily at 04:30 (random delay up to 30 min). It pulls the main stack (Syncthing `2`, plus the locally built hub), recreates changed services, updates the Immich stack (arm-free mode: always; device mode: only while it is running after a promote), prunes images and posts changed images (or failures) to `DISCORD_WEBHOOK_URL`. Optional overrides go in `/etc/orbit/update.env` (`DISCORD_WEBHOOK_URL=...`, `ORBIT_AUTO_BUILD=1`). The `orbit-web` image is built locally, so it is rebuilt only with `ORBIT_AUTO_BUILD=1`, or manually after `git pull`: `cd /opt/orbit-src/deploy/arm-free && docker compose up -d --build`. Check: `systemctl list-timers orbit-update.timer`, `journalctl -u orbit-update`.
- **Immich** is pinned to the major (`IMMICH_VERSION=v3`), so only minor/patch updates arrive. To move to a new major: read its release notes, update the PC first (`IMMICH_VERSION` in `C:\Immich\.env`, `docker compose pull; docker compose up -d`), let a fresh dump sync, then set the same value and the new `IMMICH_POSTGRES_IMAGE`/valkey tags in `immich/.env` and compose, and rehearse a promote ([restore test](docs/failover-restore.md)). In arm-free mode there is no PC to update first: after reading the release notes and taking a fresh dump, change `IMMICH_VERSION` and the image tags in `immich/.env` / compose, then `cd deploy/arm-free/immich && docker compose pull && docker compose up -d`.
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
  arm-free/             docker-compose.yml, .env.example, agent.example.json (device mode), agent.primary.example.json (arm-free mode),
                        immich/ (compose, .env.example, immich-config.example.json), scripts/ (incl. immich-dump.sh), systemd/
  windows/              install-pc.ps1, orbit-agent-runner.ps1, immich-db-dump.ps1
  install/              linux.sh.tmpl, windows.ps1.tmpl (served by the hub wizard)
  pc/agent.example.json
docs/                   long-form guides
```

Hub environment: `ORBIT_DATA_DIR`, `ORBIT_HUB_URL`, `ORBIT_PASSWORD`, `DISCORD_WEBHOOK_URL`, `ORBIT_LOCAL_AGENT_CONFIG`, `ORBIT_LOCAL_AGENT_URL`, `ORBIT_AGENT_DIST`, `ORBIT_INSTALL_TEMPLATES`. Agent: `--config <path>` or `ORBIT_AGENT_CONFIG`.

## 13. Security notes

- Nothing is exposed publicly. The hub, agent and Immich bind to the Tailscale IP; Syncthing's GUI is `127.0.0.1:8384`. Windows opens 7420 only for `100.64.0.0/10`.
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
| arm-free mode: Immich ML / job concurrency greyed out in the admin UI | Expected: `immich-config.json` is mounted via `IMMICH_CONFIG_FILE`. Edit `deploy/arm-free/immich/immich-config.json`, then `docker compose up -d`. |
| Promote fails at restore (device mode) | `IMMICH_POSTGRES_IMAGE` or `DB_*` differ from the PC; see `docker logs immich_postgres`. |

## Verified facts (Oct 2026)

- **Oracle Always Free:** Ampere A1 allowance is the first 1,500 OCPU-hours and 9,000 GB-hours per month, which equals 2 OCPU + 12 GB running continuously. 200 GB total boot plus block storage, at most five volume backups. Idle reclamation: an instance is flagged when, over 7 days, CPU 95th percentile, network and memory utilisation are all under 20% (the memory criterion applies to A1 shapes only). Source: <https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>
- **Immich:** v3.3.0 (7 Oct 2026; v3.0 in July 2026), <https://immich.app/blog>. Official `ghcr.io/immich-app` images publish `linux/arm64`, <https://github.com/orgs/immich-app/packages/container/package/immich-server>. iOS app: Settings -> Networking -> Automatic URL switching (local Wi-Fi SSID + local URL, external URLs tried in order, needs Location permission): <https://linuxiac.com/immich-1-122-brings-hdr-video-support-in-the-mobile-app/>, <https://github.com/immich-app/immich/discussions/31865>.
- **Syncthing:** v2.1.x (2.1.6 in Oct 2026), <https://www.versio.io/en/product-release-end-of-life-eol-syncthing-foundation-syncthing.html>. Folder types `sendreceive`, `sendonly`, `receiveonly`, `receiveencrypted`; `paused`; versioning `trashcan`, `simple`, `staggered`, `external`; `minDiskFree`: <https://docs.syncthing.net/users/config.html>, <https://docs.syncthing.net/users/versioning.html>. REST: `X-API-Key` header, `PATCH /rest/config/folders/{id}` with `{"paused":true}`, `/rest/db/completion`: <https://docs.syncthing.net/dev/rest.html>, <https://docs.syncthing.net/rest/config.html>.
