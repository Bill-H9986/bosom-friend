<#
  Build the field repair kit for the kernel-runtime unpack failure (DEF-045 / DEF-055).

  Why a kit: the affected machine cannot start the app and has no copy of this repository, so the
  fix has to arrive as one folder the user can double-click. The kit never re-implements the
  extraction ladder - it carries the repository files verbatim:
    qa/repair-kit/*                        (double-click entry, Chinese wrapper, readme)
    qa/probes/repair-kernel-runtime.ps1    (environment facts + extraction ladder, ASCII only)
    desktop/electron/kernel-unzip.cjs      (the built-in unpacker, long-path safe)

  This script stays ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
  and the kit folder contains a Chinese-named entry point, so it is copied by wildcard instead of
  by literal name.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File products\bosom-friend\qa\make-repair-kit.ps1
         [-OutDir <dir>] [-Zip]
#>
param(
  [string]$OutDir = (Join-Path $env:USERPROFILE 'BosomFriend-Repair-Kit'),
  [switch]$Zip
)

$ErrorActionPreference = 'Stop'
$productRoot = Split-Path -Parent $PSScriptRoot
$kitSources = Join-Path $productRoot 'qa\repair-kit'

$single = @(
  @{ From = Join-Path $productRoot 'qa\probes\repair-kernel-runtime.ps1'; To = 'repair-kernel-runtime.ps1' },
  @{ From = Join-Path $productRoot 'desktop\electron\kernel-unzip.cjs'; To = 'kernel-unzip.cjs' }
)

if (-not (Test-Path -LiteralPath $kitSources)) {
  Write-Output "FAIL: missing kit sources: $kitSources"
  exit 1
}
if (@(Get-ChildItem -LiteralPath $kitSources -File).Count -eq 0) {
  Write-Output "FAIL: kit source folder is empty: $kitSources"
  exit 1
}
foreach ($item in $single) {
  if (-not (Test-Path -LiteralPath $item.From)) {
    Write-Output "FAIL: source file missing: $($item.From)"
    exit 1
  }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Get-ChildItem -LiteralPath $kitSources -File | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $OutDir $_.Name) -Force
}
foreach ($item in $single) {
  Copy-Item -LiteralPath $item.From -Destination (Join-Path $OutDir $item.To) -Force
}

# Required members, asserted without Chinese literals: one .cmd entry, one readme.txt, the ASCII
# ladder and the built-in unpacker must all be present or the kit is not shippable.
$missing = @()
foreach ($name in @('run-repair.ps1', 'repair-kernel-runtime.ps1', 'kernel-unzip.cjs')) {
  if (-not (Test-Path -LiteralPath (Join-Path $OutDir $name))) { $missing += $name }
}
if (@(Get-ChildItem -LiteralPath $OutDir -Filter '*.cmd').Count -lt 1) { $missing += '*.cmd entry point' }
if (@(Get-ChildItem -LiteralPath $OutDir -Filter '*.txt').Count -lt 1) { $missing += '*.txt readme' }
if ($missing.Count -gt 0) {
  Write-Output "FAIL: kit is incomplete: $($missing -join ', ')"
  exit 1
}

Write-Output '== Bosom Friend repair kit =='
Write-Output "kit: $OutDir"
foreach ($file in (Get-ChildItem -LiteralPath $OutDir -File | Sort-Object Name)) {
  Write-Output ("  {0,-28} {1,8} bytes" -f $file.Name, $file.Length)
}
$hash = (Get-FileHash -LiteralPath (Join-Path $OutDir 'kernel-unzip.cjs') -Algorithm SHA256).Hash
Write-Output "kernel-unzip.cjs SHA256: $hash"
Write-Output ''
Write-Output 'Next: copy the whole folder to the affected machine, quit Bosom Friend from the tray,'
Write-Output '      then double-click the .cmd entry point there.'

if ($Zip) {
  $zipPath = $OutDir.TrimEnd('\') + '.zip'
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Compress-Archive -Path (Join-Path $OutDir '*') -DestinationPath $zipPath
  Write-Output "zip: $zipPath ($([math]::Round((Get-Item -LiteralPath $zipPath).Length / 1KB, 1)) KB)"
}
