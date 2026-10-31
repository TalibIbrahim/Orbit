<#
  orbit-agent-runner.ps1 - keeps the Orbit agent alive on Windows.

  The agent self-updates by replacing orbit-agent.mjs and EXITING; this loop notices the
  exit, waits 5 seconds and starts it again on the new bundle. Registered as the
  "Orbit Agent" scheduled task (at startup, as SYSTEM).
  Logs: C:\ProgramData\Orbit\logs\agent.log (rotated at 10 MB, 3 files kept).
#>
param(
  [string]$Bundle = "C:\Program Files\Orbit\orbit-agent.mjs",
  [string]$Config = "C:\ProgramData\Orbit\agent.json",
  [string]$LogDir = "C:\ProgramData\Orbit\logs"
)

$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$log = Join-Path $LogDir "agent.log"
$maxBytes = 10MB

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
}

function Rotate-Log {
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt $maxBytes)) {
    foreach ($i in 2, 1) {
      $src = if ($i -eq 1) { $log } else { "$log.$($i - 1)" }
      if (Test-Path $src) { Move-Item -Force $src "$log.$i" }
    }
  }
}

# Make `docker` (CLI) and `node` resolvable for the SYSTEM account.
$env:Path = "$env:ProgramFiles\nodejs;$env:ProgramFiles\Docker\Docker\resources\bin;$env:Path"
$env:ORBIT_AGENT_CONFIG = $Config

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Log "node.exe not found in PATH"; exit 1 }
Write-Log "runner started (node: $node)"

while ($true) {
  Rotate-Log
  if (-not (Test-Path $Bundle)) { Write-Log "bundle missing: $Bundle; retry in 30 s"; Start-Sleep -Seconds 30; continue }
  if (-not (Test-Path $Config)) { Write-Log "config missing: $Config; retry in 30 s"; Start-Sleep -Seconds 30; continue }
  Write-Log "starting agent"
  # Redirect through cmd so stdout+stderr stream to the log without PowerShell's NativeCommandError wrapping.
  $cmd = '"{0}" "{1}" --config "{2}" >> "{3}" 2>&1' -f $node, $Bundle, $Config, $log
  & cmd.exe /d /c $cmd
  $code = $LASTEXITCODE
  Write-Log "agent exited with code $code; restarting in 5 s (normal after a self-update)"
  Start-Sleep -Seconds 5
}
