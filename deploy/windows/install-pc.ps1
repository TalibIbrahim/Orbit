<#
  install-pc.ps1 - set up the PRIMARY Windows PC for Orbit (Immich + Syncthing + Orbit agent).

  Run in an ELEVATED Windows PowerShell 5.1:
    powershell -ExecutionPolicy Bypass -File .\install-pc.ps1 -HubUrl http://arm-free.<tailnet>.ts.net:3000 `
        -Token <token> -DeviceId <id>

  Idempotent: re-running keeps existing .env / agent.json values and only fills in what is missing.
#>
param(
  [Parameter(Mandatory = $true)][string]$HubUrl,
  [string]$Token,
  [string]$DeviceId,
  [string]$DeviceName = $env:COMPUTERNAME,
  [string]$LibraryPath = "D:\Immich\library",
  [string]$DumpPath = "D:\Immich\db-dumps",
  [string]$ImmichDir = "C:\Immich",
  [string]$ImmichVersion = "v3"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Step([string]$m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Utf8NoBom([string]$path, [string]$text) {
  # Node's JSON.parse rejects a BOM, and Set-Content -Encoding UTF8 writes one on PS 5.1.
  [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
function Have([string]$cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Winget-Install([string]$id, [string]$probeCmd) {
  if ($probeCmd -and (Have $probeCmd)) { Write-Host "  $id already installed"; return }
  $listed = & winget list --id $id -e --accept-source-agreements 2>$null | Out-String
  if ($listed -match [regex]::Escape($id)) { Write-Host "  $id already installed"; return }
  Write-Host "  installing $id"
  & winget install --id $id -e --accept-package-agreements --accept-source-agreements --silent
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { Write-Warning "winget exit code $LASTEXITCODE for $id" }
}

# --- preflight ---------------------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Run this script in an elevated (Administrator) PowerShell." }
if (-not (Have "winget")) { throw "winget not found. Install 'App Installer' from the Microsoft Store." }
$HubUrl = $HubUrl.TrimEnd("/")
if (-not $Token) { $Token = -join ((1..24) | ForEach-Object { "{0:x2}" -f (Get-Random -Maximum 256) }) }
if (-not $DeviceId) { $DeviceId = [guid]::NewGuid().ToString() }

# --- packages ----------------------------------------------------------------------------
Step "Installing prerequisites (winget)"
Winget-Install "Docker.DockerDesktop" "docker"
Winget-Install "Tailscale.Tailscale" "tailscale"
Winget-Install "Syncthing.Syncthing" "syncthing"
Winget-Install "OpenJS.NodeJS.LTS" "node"
Refresh-Path

# --- folders -----------------------------------------------------------------------------
Step "Creating folders"
foreach ($d in @($ImmichDir, $LibraryPath, $DumpPath, "$env:ProgramFiles\Orbit", "$env:ProgramData\Orbit", "$env:ProgramData\Orbit\logs")) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}

# --- Immich compose + .env ---------------------------------------------------------------
Step "Fetching Immich docker-compose.yml and example.env (latest release)"
$base = "https://github.com/immich-app/immich/releases/latest/download"
$composePath = Join-Path $ImmichDir "docker-compose.yml"
$envPath = Join-Path $ImmichDir ".env"
if (-not (Test-Path $composePath)) { Invoke-WebRequest "$base/docker-compose.yml" -OutFile $composePath -UseBasicParsing }
else { Write-Host "  docker-compose.yml exists, keeping it (delete it to refresh)" }
if (-not (Test-Path $envPath)) { Invoke-WebRequest "$base/example.env" -OutFile $envPath -UseBasicParsing }
else { Write-Host "  .env exists, keeping DB password etc." }

function Set-EnvVar([string]$file, [string]$key, [string]$value) {
  $lines = @(Get-Content -Path $file)
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*#?\s*$([regex]::Escape($key))=") { $lines[$i] = "$key=$value"; $found = $true; break }
  }
  if (-not $found) { $lines += "$key=$value" }
  Write-Utf8NoBom $file (($lines -join "`n") + "`n")
}
Set-EnvVar $envPath "UPLOAD_LOCATION" ($LibraryPath -replace "\\", "/")
Set-EnvVar $envPath "DB_DATA_LOCATION" "./postgres"   # keep Postgres on a Docker-managed path (NTFS bind mounts of the DB are slow/fragile)
Set-EnvVar $envPath "IMMICH_VERSION" $ImmichVersion
# example.env ships DB_PASSWORD=postgres; replace once with a random one on a fresh install.
if ((Get-Content $envPath | Where-Object { $_ -match "^DB_PASSWORD=postgres\s*$" }) -and -not (Test-Path (Join-Path $ImmichDir "postgres"))) {
  Set-EnvVar $envPath "DB_PASSWORD" ((-join ((1..20) | ForEach-Object { "{0:x2}" -f (Get-Random -Maximum 256) })))
}

Step "Starting Immich"
$dockerOk = $false
if (Have "docker") { & docker info *> $null; $dockerOk = ($LASTEXITCODE -eq 0) }
if ($dockerOk) {
  Push-Location $ImmichDir
  try { & docker compose up -d } finally { Pop-Location }
} else {
  Write-Warning "Docker is not running yet (first install needs a reboot / WSL2 setup)."
  Write-Host "  Start Docker Desktop, then run:  cd $ImmichDir ; docker compose up -d"
}

# --- agent files -------------------------------------------------------------------------
Step "Installing the Orbit agent"
$orbitDir = "$env:ProgramFiles\Orbit"
$bundle = Join-Path $orbitDir "orbit-agent.mjs"
Invoke-WebRequest "$HubUrl/agent/orbit-agent.mjs" -OutFile $bundle -UseBasicParsing
Copy-Item -Force (Join-Path $PSScriptRoot "orbit-agent-runner.ps1") $orbitDir
Copy-Item -Force (Join-Path $PSScriptRoot "immich-db-dump.ps1") $orbitDir

# Locate syncthing.exe (winget installs a portable package; PATH may not be refreshed).
$syncExe = (Get-Command syncthing.exe -ErrorAction SilentlyContinue).Source
if (-not $syncExe) {
  $syncExe = Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet\Packages", "$env:ProgramFiles\Syncthing", "${env:ProgramFiles(x86)}\Syncthing" `
      -Recurse -Filter syncthing.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}

# Tailscale IP, if already logged in (else bind everywhere; the firewall rule restricts access anyway).
$tsIp = "0.0.0.0"
if (Have "tailscale") { $ip = (& tailscale ip -4 2>$null | Select-Object -First 1); if ($ip) { $tsIp = $ip } }

$cfgPath = "$env:ProgramData\Orbit\agent.json"
if (-not (Test-Path $cfgPath)) {
  $syncCfg = Join-Path $env:LOCALAPPDATA "Syncthing\config.xml"   # Syncthing runs as the installing user
  $cfg = [ordered]@{
    deviceId = $DeviceId
    name = $DeviceName
    role = "primary"
    token = $Token
    listen = [ordered]@{ host = $tsIp; port = 7420 }
    hubUrl = $HubUrl
    dataDir = "$env:ProgramData\Orbit\data"
    sampleIntervalSec = 60
    sizeIntervalMin = 10
    retentionDays = 35
    autoUpdate = $true
    services = @(
      [ordered]@{ name = "immich"; category = "photos"; containers = @("immich_"); paths = @($LibraryPath) }
    )
    syncthing = [ordered]@{ url = "http://127.0.0.1:8384"; configPath = $syncCfg }
    jobs = @(
      [ordered]@{
        id = "immich-db"; name = "Immich DB dump"; kind = "pgdump"; schedule = "30 2 * * *"
        command = "powershell.exe"
        args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$orbitDir\immich-db-dump.ps1", "-DumpPath", $DumpPath)
        outputDir = $DumpPath; retention = "last 14 dumps"; timeoutMin = 30
      }
      # Optional offsite backup - uncomment by adding a job like:
      # { "id": "restic", "name": "Restic", "kind": "restic", "schedule": "0 3 * * *", "command": "restic",
      #   "args": ["backup", "D:\\Immich\\db-dumps", "--tag", "orbit"],
      #   "env": { "RESTIC_REPOSITORY": "...", "RESTIC_PASSWORD_FILE": "C:\\ProgramData\\Orbit\\restic-password" } }
    )
  }
  Write-Utf8NoBom $cfgPath ($cfg | ConvertTo-Json -Depth 10)
  # Restrict the config (contains the Bearer token) to SYSTEM + Administrators.
  & icacls.exe $cfgPath /inheritance:r /grant:r "SYSTEM:(F)" "Administrators:(F)" | Out-Null
  Write-Host "  wrote $cfgPath"
} else {
  Write-Host "  $cfgPath exists, keeping it"
}

# --- scheduled tasks ---------------------------------------------------------------------
Step "Registering scheduled tasks"
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$agentAction = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$orbitDir\orbit-agent-runner.ps1`""
$agentTrigger = New-ScheduledTaskTrigger -AtStartup
$agentPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$agentSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "Orbit Agent" -Action $agentAction -Trigger $agentTrigger -Principal $agentPrincipal -Settings $agentSettings -Force | Out-Null
Start-ScheduledTask -TaskName "Orbit Agent"
Write-Host "  task 'Orbit Agent' registered and started (runner restarts the agent after self-updates)"

if ($syncExe) {
  # Syncthing runs at logon of THIS user (it needs the user profile for its config.xml).
  # Alternatives: SyncTrayzor (tray UI, autostart) or the "Syncthing Windows Setup" service installer.
  $stAction = New-ScheduledTaskAction -Execute $syncExe -Argument "--no-browser --no-console"
  $stTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $stPrincipal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $stSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName "Syncthing" -Action $stAction -Trigger $stTrigger -Principal $stPrincipal -Settings $stSettings -Force | Out-Null
  Start-ScheduledTask -TaskName "Syncthing"
  Write-Host "  task 'Syncthing' registered at logon of $env:USERNAME ($syncExe)"
} else {
  Write-Warning "syncthing.exe not found; open a new shell and re-run this script, or install SyncTrayzor."
}

# --- firewall ----------------------------------------------------------------------------
Step "Firewall: TCP 7420 only from Tailscale (100.64.0.0/10)"
Get-NetFirewallRule -DisplayName "Orbit Agent (Tailscale)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "Orbit Agent (Tailscale)" -Direction Inbound -Protocol TCP -LocalPort 7420 `
    -RemoteAddress "100.64.0.0/10" -Action Allow -Profile Any | Out-Null

# --- summary -----------------------------------------------------------------------------
Step "Done"
Write-Host "  deviceId : $DeviceId"
Write-Host "  token    : $Token"
Write-Host "  config   : $cfgPath"
Write-Host ""
Write-Host "NEXT STEPS" -ForegroundColor Yellow
Write-Host "  1. Reboot if Docker Desktop / WSL2 was just installed, start Docker Desktop (enable 'Start when you sign in')."
Write-Host "  2. Run 'tailscale up' (or sign in via the tray icon)."
Write-Host "  3. Add this device in the Orbit hub (Add device) with the deviceId + token above if not done yet."
Write-Host "  4. Syncthing (http://127.0.0.1:8384): share '$LibraryPath' as folder id 'immich-library' and '$DumpPath' as"
Write-Host "     'immich-db-dumps', both type SEND ONLY (add '*.partial' to .stignore of the dump folder). The hub can pair arm-free."
Write-Host "  5. Immich (http://localhost:2283): create the admin user, then in the iPhone app add the LAN URL"
Write-Host "     (http://<pc-lan-ip>:2283) as primary and the Tailscale URL (http://<pc-tailnet-name>:2283) as external."
Write-Host "  6. If you want Immich reachable over Tailscale only, allow TCP 2283 from 100.64.0.0/10 in the Windows firewall."
