<#
.SYNOPSIS
  Switch the served frontend between the source build and a packaged release build.

.DESCRIPTION
  The dev runtime serves project/bosom-friend-electron/dist. This script swaps that
  directory with the frontend shipped in a release (default 0.2.31, which the product
  owner treats as the reference design), or rebuilds it from source.

  Usage:
    powershell -File use-frontend-build.ps1 -Version 0.2.31   # serve the packaged design
    powershell -File use-frontend-build.ps1 -Source           # rebuild from source

  The previous dist is kept at dist.<stamp>.bak next to it.

  Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 without BOM as ANSI.
#>
param(
  [string]$Version = '0.2.31',
  [switch]$Source
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# scripts -> launcher -> bosom-friend -> products -> repository root
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here)))
$dist = Join-Path $repo 'products\bosom-friend\project\bosom-friend-electron\dist'

if ($Source) {
  Write-Host '==> rebuild frontend from source'
  $posix = ($repo -replace '\\', '/')
  & 'C:\Program Files\Git\bin\bash.exe' -lc "cd '$posix/products/bosom-friend/project/bosom-friend-electron' && npx vite build" 2>&1 | Select-Object -Last 4
  exit $LASTEXITCODE
}

$src = Join-Path $repo ("products\bosom-friend\desktop\release\" + $Version + "\win-unpacked\resources\frontend-dist")
if (-not (Test-Path $src)) { throw "release frontend not found: $src" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (Test-Path $dist) {
  Move-Item $dist ("$dist.$stamp.bak") -Force
  Write-Host "==> previous dist kept at dist.$stamp.bak"
}
New-Item -ItemType Directory -Path $dist -Force | Out-Null
robocopy $src $dist /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $LASTEXITCODE" }

$index = Join-Path $dist 'index.html'
$assets = (Get-ChildItem (Join-Path $dist 'assets') -File | Measure-Object).Count
Write-Host ("==> now serving release " + $Version + " frontend (" + $assets + " assets)")
Get-Content $index | Select-String -Pattern 'assets/' | Select-Object -First 2 | ForEach-Object { '   ' + $_.Line.Trim() }
