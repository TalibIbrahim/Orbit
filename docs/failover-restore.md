# Failover, switch back and restore tests

All commands run on arm-free (`ssh ubuntu@arm-free`) unless marked PC. Scripts live in `/opt/orbit/deploy/arm-free/scripts/` (symlink to the repo).

## Promote (failover)

Use when the PC is down for long. Hub: Settings -> Standby -> Promote (type `PROMOTE`), or:

```bash
sudo /opt/orbit/deploy/arm-free/scripts/promote-standby.sh        # add --force to redo the restore
```

Prerequisites: `deploy/arm-free/immich-standby/.env` has the PC's `IMMICH_POSTGRES_IMAGE`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE_NAME`; at least one dump in `/srv/orbit/immich-db-dumps`.

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

## Switch back

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

## Restore test checklist (every ~3 months, and after upgrading Immich major)

### A. Database dump restore on the standby stack

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
- [ ] `tar -I zstd -tf /tmp/restore-test/srv/orbit/minecraft-backups/daily/<newest>.tar.zst >/dev/null` succeeds (or `30min/`).
- [ ] `/tmp/restore-test/etc/orbit/agent.json` is present and parses (`jq . ...`).
- [ ] `rm -rf /tmp/restore-test`.

### C. Syncthing versioning (deleted file recovery)

Versions are kept next to the replica folder in `.stversions`. Defaults from the hub: `immich-library` staggered (30 days), `immich-db-dumps` simple (keep 10).

- [ ] On the PC create `test-orbit.txt` in the `immich-db-dumps` folder (not the library), wait for it to appear on arm-free, delete it on the PC, wait for the sync.
- [ ] On arm-free: `ls /srv/orbit/immich-db-dumps/.stversions/` contains `test-orbit~YYYYMMDD-HHMMSS.txt`.
- [ ] Restore: `cp /srv/orbit/immich-db-dumps/.stversions/test-orbit~<stamp>.txt /tmp/test-orbit.txt` and read it. Copy restored files **out** of the replica folder; writing into a Receive Only folder shows as a local change.
- [ ] Remove the test file versions afterwards.
