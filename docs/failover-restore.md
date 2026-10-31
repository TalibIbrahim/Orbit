# Failover, switch back and restore tests

All commands run on arm-free (`ssh ubuntu@arm-free`) unless marked PC. Scripts live in `/opt/orbit/deploy/arm-free/scripts/` (symlink to the repo).

Two modes (`primaryMode`, see the README): **device mode** (Immich on a PC, arm-free is the standby) uses Promote / Switch back below. **arm-free mode** (Immich runs on arm-free) has no such buttons; jump to [Disaster recovery (arm-free primary)](#disaster-recovery-arm-free-primary).

## Promote (failover, device mode)

Use when the PC is down for long. Hub: Settings -> Standby -> Promote (type `PROMOTE`), or:

```bash
sudo /opt/orbit/deploy/arm-free/scripts/promote-standby.sh        # add --force to redo the restore
```

Prerequisites: `deploy/arm-free/immich/.env` has the PC's `IMMICH_POSTGRES_IMAGE`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE_NAME`; at least one dump in `/srv/orbit/immich-db-dumps`.

| Step | Action |
|---|---|
| 1/7 | Pause Syncthing folders `immich-library`, `immich-db-dumps` (env `PROMOTE_FOLDERS`; uses the API key from `/srv/orbit/syncthing-config/config.xml`) |
| 2/7 | Choose the newest dump (`ORBIT_DUMP_FILE` or newest `*.sql.gz`/`*.sql` in `ORBIT_DUMP_DIR`), verify gzip |
| 3/7 | `docker compose up -d database` in the standby project, wait for `pg_isready` (max 120 s) |
| 4/7 | Stop `immich-server`, pipe the dump into `psql` (search_path line patched per Immich's restore procedure) |
| 5/7 | `docker compose up -d` (server + redis + database, no ML); writes `/var/lib/orbit/promoted-at` |
| 6/7 | Wait up to 3 min for `http://<TAILSCALE_IP>:2283/api/server/ping` = `pong` |
| 7/7 | Print URL, dump age, DATA LAG warning; Discord notification |

Afterwards:

1. In Immich (standby): Administration -> Settings -> Machine Learning -> disable.
2. On the phone: Immich app -> change the server URL to `http://arm-free.<tailnet>.ts.net:2283`.
3. Remember the lag: edits and uploads on the PC after the last dump are missing; uploads you make now exist only on arm-free until switch-back. If the PC's disk is gone, this replica (`immich-library`, with `.stversions`) is your copy: keep it, do not run switch-back.

## Switch back (device mode)

Preconditions: PC is online, Docker Desktop and Immich are running there, Syncthing on the PC is running with `immich-library` as **Send Only** and connected to arm-free. If the PC lost its data, restore its library first and decide which side is authoritative before reverting: switch-back makes arm-free mirror the PC and discards anything written locally on the standby.

1. Run it:

```bash
sudo /opt/orbit/deploy/arm-free/scripts/switch-back.sh            # prompts; --yes to skip the prompt
# --skip-export  : do not copy standby uploads
```

2. What it does: (1) `docker compose down` on the standby stack (Postgres data dir `/srv/orbit/immich-standby-db` kept; the next promote overwrites it), (2) copies files under `<UPLOAD_LOCATION>/upload` newer than `/var/lib/orbit/promoted-at` into `/srv/orbit/standby-uploads-<YYYYMMDD>`, (3) sets `immich-library` and `immich-db-dumps` to `receiveonly` and calls `POST /rest/db/revert?folder=<id>`, (4) resumes the folders and deletes the promotion marker, Discord notification.
3. Re-upload the exported files to the PC's Immich:

```bash
# from a machine with the Immich CLI (npm i -g @immich/cli), after: immich login <PC-URL> <API-KEY>
immich upload --recursive /srv/orbit/standby-uploads-<YYYYMMDD>
```

   or copy the folder to the phone/PC and upload via the app. Check for duplicates (Immich skips identical checksums).
4. Phone: Immich app -> server URL back to the PC LAN/Tailscale URLs (automatic URL switching entries from the README).
5. Orbit -> Replication: wait until both folders show up to date. Remove `/srv/orbit/standby-uploads-*` once verified.

## Disaster recovery (arm-free primary)

Use when arm-free (VM, block volume or Immich) is lost for good, or for long. Immich keeps running only on arm-free, so recovery means running it on one of the replicas. Every replica holds a Receive Only copy of `immich-library` and `immich-db-dumps` (older file versions are in `.stversions`). Orbit raises a "primary offline" alert pointing here; there are no Promote / Switch back buttons in this mode and `promote-standby.sh` / `switch-back.sh` refuse to run.

Expect data loss up to the last sync plus up to ~24 h of database changes (the dump runs at 02:30). Pick the replica that is most up to date (Orbit -> Replication) and has the most free disk.

1. **Install Docker** on the chosen replica (Docker Desktop with WSL 2 on Windows, Docker Engine on Linux). The replica installer does not install it.
2. **Stop Syncthing replication of the library to that machine** so Receive Only does not revert your changes: either stop Syncthing, or in the Syncthing GUI change the `immich-library` and `immich-db-dumps` folders to **Send & Receive** (or remove them). Without this, Immich uploads and the restored database layout would be reverted as "local changes". Keep a copy of the folders if unsure.
3. **Copy the stack:** copy `deploy/arm-free/immich/docker-compose.yml` and `.env.example` from the repo to a new folder, e.g. `D:\Orbit\immich` (Windows) or `/srv/immich`. Create `.env` from the example and set:
   - `IMMICH_VERSION` and `IMMICH_POSTGRES_IMAGE`: the same as on arm-free (check `deploy/arm-free/immich/.env` in your repo or `docker ps` history). A mismatching Postgres/vector image can make the restore fail.
   - `DB_USERNAME`, `DB_DATABASE_NAME`: same as on arm-free (defaults `postgres`, `immich`).
   - `DB_PASSWORD`: the arm-free value from `deploy/arm-free/immich/.env` if you still have it. The dump is a `pg_dumpall --clean` and restores the roles including the original password, so after the restore that password is the one that applies. If you no longer have it, use any value now and reset it after the restore (step 6).
   - `UPLOAD_LOCATION`: the replica's `immich-library` folder (for example `D:\Orbit\immich-library`). `DB_DATA_LOCATION`: a new empty folder, for example `D:\Orbit\immich-db`.
   - `TAILSCALE_IP`: this machine's Tailscale IP (`tailscale ip -4`). Set `COMPOSE_PROFILES=` (no ML) to start light, or `ml` if the machine can take it.
   - Compose bind-mounts `./immich-config.json`: copy `immich-config.example.json` to `immich-config.json` next to the compose file (edit `machineLearning.enabled` to match), or remove that volume line and `IMMICH_CONFIG_FILE`. On Windows also replace the `/etc/localtime` volume and the ML cache path `/srv/orbit/immich-ml-cache` with local paths (or remove them).
4. **Start only the database:**

```bash
docker compose up -d database
docker exec immich_postgres pg_isready          # repeat until it accepts connections
```

5. **Restore the newest dump** (from the replica's `immich-db-dumps` folder). Adapt the user if `DB_USERNAME` differs:

```bash
gunzip -c /path/to/immich-db-dumps/immich-YYYYMMDD-HHmm.sql.gz | docker exec -i immich_postgres psql -U postgres -d postgres
```

   On Windows, run it in Git Bash or WSL, or copy the file in with `docker cp` and run `gunzip -c ... | psql` inside the container. Errors such as "role already exists" are expected; the dump drops and recreates objects.
6. **If you did not have the arm-free `DB_PASSWORD`:** the restored role carries the old password, so set it to what is in `.env`: `docker exec -i immich_postgres psql -U postgres -c "ALTER USER postgres PASSWORD '<value from .env>';"` (use your `DB_USERNAME`).
7. **Start the rest:** `docker compose up -d`, then open `http://<replica>.<tailnet>.ts.net:2283` and log in with your existing accounts. Check recent photos and a few old originals. Run **Administration -> Jobs** only if thumbnails are missing.
8. **Point phones at the new URL:** Immich app -> server URL `http://<replica>.<tailnet>.ts.net:2283`. Keep Tailscale on.
9. **Later, rebuild arm-free:** create a new VM, mount the volume, run `install-arm-free.sh --mode arm-free` (fresh Immich, new `DB_PASSWORD`). Stop Immich on the new arm-free (`cd deploy/arm-free/immich && docker compose down`), copy the library from the replica into `/srv/orbit/immich-library` (for example `rsync -a` over `tailscale ssh`), then restore a current dump as in steps 4 to 6 (take a fresh one first with `docker exec immich_postgres sh -c 'pg_dumpall --clean --if-exists -U "$POSTGRES_USER"' | gzip > dump.sql.gz`) and set `DB_PASSWORD` accordingly. Start Immich, re-point phones to the arm-free URL, then re-pair the replicas (Add device) so `immich-library` flows arm-free -> replicas again. Re-created Receive Only folders on a replica that holds changed files will show them as local changes; use "Revert local changes" in Syncthing or point them at an empty folder after you have copied the data you need.

Deleted or overwritten files on a replica (not yet reverted) are recoverable from `<folder>/.stversions` (library: staggered, default 30 days, Settings -> General -> Replica versioning; dumps: keep 10). Copy them out; do not write inside a Receive Only folder.

## Restore test checklist (every ~3 months, and after upgrading Immich major)

Section A is device mode only; in arm-free mode rehearse the [disaster recovery](#disaster-recovery-arm-free-primary) steps on a spare replica instead (do not let it overwrite the real replica folders). B and C apply to both modes.

### A. Database dump restore on the standby stack (device mode)

This rehearses a promote; the PC stays primary. Do not point the phone at the standby.

- [ ] `ls -lh /srv/orbit/immich-db-dumps | tail` shows a dump from the last 24 h, size plausible (> 1 MB).
- [ ] `sudo /opt/orbit/deploy/arm-free/scripts/promote-standby.sh` completes (7/7).
- [ ] Open `http://arm-free.<tailnet>.ts.net:2283`, log in with your PC credentials; the timeline shows your recent photos.
- [ ] Open a random old photo and a video from the grid at full size (proves the Syncthing library replica matches the DB).
- [ ] `sudo /opt/orbit/deploy/arm-free/scripts/switch-back.sh --yes --skip-export` (tears the standby down, reverts and resumes the replica folders).
- [ ] Orbit -> Replication shows both folders syncing/up to date; `docker ps` shows no `immich_*` containers.

### B. restic

```bash
export RESTIC_REPOSITORY=<same as in /etc/orbit/agent.json>
export RESTIC_PASSWORD_FILE=/etc/orbit/restic-password
restic snapshots --tag orbit | tail
restic check
rm -rf /tmp/restore-test && restic restore latest --target /tmp/restore-test
ls -R /tmp/restore-test | head -50
```

- [ ] Latest snapshot is under 36 h old.
- [ ] If you run a custom archive job: `tar -I zstd -tf /tmp/restore-test/srv/orbit/app-backups/<newest>.tar.zst >/dev/null` succeeds.
- [ ] `/tmp/restore-test/etc/orbit/agent.json` is present and parses (`jq . ...`).
- [ ] `rm -rf /tmp/restore-test`.

### C. Syncthing versioning (deleted file recovery)

Versions are kept next to the replica folder in `.stversions`. Defaults from the hub: `immich-library` staggered (30 days), `immich-db-dumps` simple (keep 10).

- [ ] On the PC create `test-orbit.txt` in the `immich-db-dumps` folder (not the library), wait for it to appear on arm-free, delete it on the PC, wait for the sync.
- [ ] On arm-free: `ls /srv/orbit/immich-db-dumps/.stversions/` contains `test-orbit~YYYYMMDD-HHMMSS.txt`.
- [ ] Restore: `cp /srv/orbit/immich-db-dumps/.stversions/test-orbit~<stamp>.txt /tmp/test-orbit.txt` and read it. Copy restored files **out** of the replica folder; writing into a Receive Only folder shows as a local change.
- [ ] Remove the test file versions afterwards.
