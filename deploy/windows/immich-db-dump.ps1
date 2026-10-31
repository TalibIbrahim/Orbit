<#
  immich-db-dump.ps1 - dump the Immich Postgres database on the PC.

  Dumps INSIDE the container to a gzip file, `docker cp`s it out (binary-safe; PowerShell
  pipelines would corrupt the gzip stream), deletes the temp file and keeps the last 14 dumps.
  The $DumpPath folder is shared to arm-free via Syncthing (Send Only, folder id "immich-db-dumps").
  Run by the Orbit agent job "immich-db" (daily 02:30) as SYSTEM.
#>
param(
  [string]$DumpPath = "D:\Immich\db-dumps",
  [string]$Container = "immich_postgres",
  [int]$Keep = 14
)

$ErrorActionPreference = "Stop"
$env:Path = "$env:ProgramFiles\Docker\Docker\resources\bin;$env:Path"
# SYSTEM has no docker context; talk to Docker Desktop's engine pipe directly if needed.
if (-not $env:DOCKER_HOST) {
  if (Test-Path "\\.\pipe\dockerDesktopLinuxEngine") { $env:DOCKER_HOST = "npipe:////./pipe/dockerDesktopLinuxEngine" }
}

if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw "docker.exe not found" }
New-Item -ItemType Directory -Force -Path $DumpPath | Out-Null

$running = (& docker.exe inspect -f "{{.State.Running}}" $Container 2>$null)
if ($running -ne "true") { throw "container '$Container' is not running (is Docker Desktop up?)" }

$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$target = Join-Path $DumpPath "immich-$stamp.sql.gz"
$partial = "$target.partial"
$inside = "/tmp/orbit-dump-$stamp.sql.gz"

try {
  & docker.exe exec $Container sh -c "set -e; pg_dumpall --clean --if-exists --username=postgres | gzip > $inside"
  if ($LASTEXITCODE -ne 0) { throw "pg_dumpall failed (exit $LASTEXITCODE)" }
  & docker.exe cp "${Container}:$inside" $partial
  if ($LASTEXITCODE -ne 0) { throw "docker cp failed (exit $LASTEXITCODE)" }
} finally {
  & docker.exe exec $Container rm -f $inside 2>$null | Out-Null
}

if (-not (Test-Path $partial) -or (Get-Item $partial).Length -lt 1024) {
  Remove-Item -Force -ErrorAction SilentlyContinue $partial
  throw "dump is missing or suspiciously small"
}
# Rename only when complete so Syncthing never ships half a dump (also ignore *.partial there).
Move-Item -Force $partial $target
Write-Output ("dump written: {0} ({1:N1} MB)" -f $target, ((Get-Item $target).Length / 1MB))

Get-ChildItem -Path $DumpPath -Filter "immich-*.sql.gz" -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip $Keep |
  ForEach-Object { Remove-Item -Force $_.FullName; Write-Output "pruned $($_.Name)" }
