# Migrates an existing /etc/orbit/agent.json to arm-free primary mode (used by install-arm-free.sh).
# Input (stdin/file): the current agent.json.
# Args:
#   --slurpfile tpl   deploy/arm-free/agent.primary.example.json (template; $tpl[0])
#   --argjson resticOk  true if restic job should be kept/added
#   --arg repo          restic repository to set when resticOk
#   --argjson missing   array of script paths referenced by jobs that no longer exist
#   --argjson containers array of existing container names, or null if unknown
#   --argjson units     array of existing systemd unit names, or null if unknown
# Output order of jobs: immich-db, prune-dumps, other kept jobs, restic. Idempotent.
def staleJob: [(.command // empty), (.args // [] | .[] | select(type == "string"))] | any(. as $f | $missing | any(. == $f));
def gone($have; $want): $have != null and ($want | length) > 0
  and ($want | all(. as $p | $have | all(startswith($p) | not)));
def staleSvc: ((.containers // []) | length) + ((.systemdUnits // []) | length) > 0
  and ((.containers // []) | length == 0 or gone($containers; .))
  and ((.systemdUnits // []) | length == 0 or gone($units; .));
def isRestic: .kind == "restic" or .id == "restic";
$tpl[0] as $t
| .role = "primary"
| del(.promote)
| (if .keepalive then .keepalive.defaultEnabled = false else . end)
| .services = ([$t.services[] | select(.name == "immich")]
    + [(.services // [])[] | select((staleSvc | not) and .name != "immich")]
    | . as $s | $s + [$t.services[] | select(.name as $n | any($s[]; .name == $n) | not)])
| .jobs = ((.jobs // []) as $j
    | [$j[] | select((staleJob | not) and (isRestic | not) and .id != "immich-db" and .id != "prune-dumps")] as $keep
    | ([$j[] | select(.id == "prune-dumps" and (staleJob | not))][0:1]
        | if length > 0 then . else [$t.jobs[] | select(.id == "prune-dumps")] end) as $prune
    | [$t.jobs[] | select(.id == "immich-db")]
      + $prune
      + $keep
      + (if $resticOk then
           ([$j[] | select(isRestic)] | if length > 0 then . else [$t.jobs[] | select(isRestic)] end)
           | map(.env = ((.env // {}) + {RESTIC_REPOSITORY: $repo, RESTIC_PASSWORD_FILE: (.env.RESTIC_PASSWORD_FILE // "/etc/orbit/restic-password")}))
         else [] end))
