#!/usr/bin/env bash
# Tests deploy/arm-free/scripts/migrate-agent-json.jq against tests/fixtures/.
set -u
if ! command -v jq >/dev/null 2>&1; then echo "SKIP: jq not installed"; exit 0; fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILTER="$ROOT/deploy/arm-free/scripts/migrate-agent-json.jq"
TPL="$ROOT/deploy/arm-free/agent.primary.example.json"
FIX="$ROOT/tests/fixtures/old-standby.agent.json"
FAIL=0
check() { # name, jq-bool-expr, file
  if jq -e "$2" "$3" >/dev/null; then echo "ok   - $1"; else echo "FAIL - $1"; FAIL=1; fi
}
run() { # resticOk, input
  jq -f "$FILTER" --slurpfile tpl "$TPL" --argjson resticOk "$1" --arg repo "b2:test-bucket:orbit" \
     --argjson missing '["/opt/orbit/old/game-backup.sh"]' --argjson containers '["immich_server","orbit-web"]' \
     --argjson units '[]' "$2"
}
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
run false "$FIX" > "$T/a.json"
run true "$FIX" > "$T/b.json"
check "role primary" '.role == "primary"' "$T/a.json"
check "no promote" 'has("promote") | not' "$T/a.json"
check "stale job removed" 'all(.jobs[]; .id != "game-backup")' "$T/a.json"
check "stale service removed" 'all(.services[]; .name != "game-server")' "$T/a.json"
check "immich and orbit services kept" '[.services[].name] | index("immich") != null and index("orbit") != null' "$T/a.json"
check "immich-db first, prune-dumps second" '[.jobs[0].id, .jobs[1].id] == ["immich-db","prune-dumps"]' "$T/a.json"
check "existing prune-dumps kept" '.jobs[1].schedule == "0 5 * * *"' "$T/a.json"
check "no restic when resticOk=false" 'all(.jobs[]; .id != "restic")' "$T/a.json"
check "restic present with repo when resticOk=true" '.jobs[-1].id == "restic" and .jobs[-1].env.RESTIC_REPOSITORY == "b2:test-bucket:orbit"' "$T/b.json"
check "identity fields unchanged" '.deviceId == "device-test-1" and .token == "test-token-0123456789abcdef" and .hubUrl == "http://hub.example.test:3000" and .listen == {"host":"100.64.0.10","port":7420}' "$T/a.json"
check "keepalive default off" '.keepalive.defaultEnabled == false' "$T/a.json"
for v in a b; do
  ok=$([ "$v" = a ] && echo false || echo true)
  run "$ok" "$T/$v.json" > "$T/$v.2.json"
  if cmp -s <(jq -S . "$T/$v.json") <(jq -S . "$T/$v.2.json"); then echo "ok   - idempotent ($v)"; else echo "FAIL - idempotent ($v)"; FAIL=1; fi
done
# missing prune-dumps is added from the template
jq 'del(.jobs[] | select(.id == "prune-dumps"))' "$FIX" > "$T/np.json"
run false "$T/np.json" > "$T/np.out.json"
check "prune-dumps added when absent" '[.jobs[0].id, .jobs[1].id] == ["immich-db","prune-dumps"] and .jobs[1].schedule == "45 4 * * *"' "$T/np.out.json"
# hostUpdate: added from the template when missing, existing repoDir wins
check "hostUpdate added" '.hostUpdate.unit == "orbit-update.service" and .hostUpdate.timer == "orbit-update.timer" and .hostUpdate.statusFile == "/var/lib/orbit/update-status.json"' "$T/a.json"
jq '.hostUpdate = {unit: "orbit-update.service", timer: "orbit-update.timer", statusFile: "/var/lib/orbit/update-status.json", repoDir: "/home/me/orbit"}' "$FIX" > "$T/hu.json"
run false "$T/hu.json" > "$T/hu.out.json"
check "existing hostUpdate.repoDir kept" '.hostUpdate.repoDir == "/home/me/orbit"' "$T/hu.out.json"
exit $FAIL
