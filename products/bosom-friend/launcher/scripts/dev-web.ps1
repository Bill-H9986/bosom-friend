<#
.SYNOPSIS
  Start the Bosom Friend web (source) runtime as the development version.

.DESCRIPTION
  Development loop for this project:

    frontend change  ->  powershell -File dev-web.ps1 -Frontend   (vite build ~1 min)
                         then hard-refresh the browser. No app restart needed.
    server/kernel    ->  powershell -File dev-web.ps1             (restart, tsx reloads modules)
    release only     ->  bash products/bosom-friend/desktop/build-win.sh

  Do NOT rebuild the installer for a development iteration: it copies ~1.9 GB of engine and
  spends 10+ minutes compressing, and it does not make debugging faster.

  Serves http://127.0.0.1:31280/bosom-friend/ from the source tree; data root stays
  ~/.bosom-friend (same as the installed build, so switch between them sequentially).

.PARAMETER Frontend
  Rebuild the frontend dist (project/bosom-friend-electron/dist) before starting.

.NOTES
  Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 without BOM as ANSI and
  non-ASCII comments corrupt parsing.
#>
param([switch]$Frontend)

$ErrorActionPreference = 'Stop'
# Native tools (vite/pnpm) write progress and warnings to stderr; PS 7's native-command
# error preference would otherwise treat those warnings as terminating errors and abort
# the whole start-up sequence after a successful build.
$PSNativeCommandUseErrorActionPreference = $false
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# scripts -> launcher -> bosom-friend -> products -> repository root
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here)))
Set-Location $repo

if ($Frontend) {
  Write-Host '==> build frontend dist'
  $posix = ($repo -replace '\\', '/')
  & 'C:\Program Files\Git\bin\bash.exe' -lc "cd '$posix/products/bosom-friend/project/bosom-friend-electron' && npx vite build" 2>&1 | Select-Object -Last 6
}

# The dev runtime loads the product server/kernel from their built lib/ (package exports point at
# lib/types/*.js), so backend edits need a package build before restart. This takes ~10s.
Write-Host '==> build product packages (server + kernel)'
pnpm --filter @deepseek-ai/dsh-bosom-friend-server --filter @deepseek-ai/dsh-bosom-friend-kernel build 2>&1 | Select-Object -Last 4

Write-Host '==> stop installed app and any previous dev runtime'
Get-Process | Where-Object { $_.ProcessName -eq 'Bosom Friend' } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
# WMI enumeration can be denied in a restricted sandbox; best-effort cleanup must not abort startup.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'bin-desktop\.ts' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'worker\.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 4

Write-Host '==> start dev runtime (source, tsx)'
$env:CODEBUDDY_SAFE_DELETE_ENABLED = '0'
# Version authority: the packaged shell injects app.getVersion(); the source runtime injects
# the desktop package version here so the UI never falls back to a stale build-time number.
$desktopPkg = Join-Path $repo 'products\bosom-friend\desktop\package.json'
if (Test-Path $desktopPkg) {
  $env:BOSOM_FRIEND_VERSION = (Get-Content $desktopPkg -Raw | ConvertFrom-Json).version
  Write-Host ("==> BOSOM_FRIEND_VERSION=" + $env:BOSOM_FRIEND_VERSION)
}
# Redirect logs so a failed start is diagnosable instead of silently disappearing.
$outLog = Join-Path $repo 'dev-web.out.log'
$errLog = Join-Path $repo 'dev-web.err.log'
Start-Process -FilePath 'node' -ArgumentList '--import', 'tsx/esm', 'products/bosom-friend/launcher/src/bin-desktop.ts' -WorkingDirectory $repo -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden

# tsx cold start + kernel boot + tool registration takes 2-3 minutes on this machine.
$up = $false
for ($i = 0; $i -lt 150; $i++) {
  Start-Sleep -Seconds 2
  if (Get-NetTCPConnection -LocalPort 31280 -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
}
if (-not $up) { throw 'dev runtime did not listen on 31280 within 300s' }

try {
  $h = Invoke-WebRequest 'http://127.0.0.1:31280/bosom-friend/' -UseBasicParsing -TimeoutSec 15
  Write-Host ("==> dev runtime ready: http://127.0.0.1:31280/bosom-friend/ (HTTP {0})" -f $h.StatusCode)
}
catch {
  Write-Warning "dev runtime health check failed: $($_.Exception.Message)"
}
