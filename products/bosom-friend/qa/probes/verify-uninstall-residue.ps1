<#
  Uninstall-residue acceptance for the installed Bosom Friend build (DEF-042 closure evidence).

  Why: the uninstaller deletes the app tree, shortcuts, registry entries AND the whole
  %APPDATA%\Bosom Friend tree (Chromium profile + caches), while %USERPROFILE%\.bosom-friend
  holds user data and MUST survive. Both halves are easy to break silently, so this probe
  makes the whole cycle repeatable instead of a manual one-off per release.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File qa\probes\verify-uninstall-residue.ps1
    ... -SkipReinstall     # stop after the uninstall assertions
    ... -Setup <path.exe>  # installer used for the reinstall step

  Checks:
    A. before: no app process; install dir, shortcuts, registry entry all present;
    B. uninstall: silent uninstall exit code 0;
    C. after: install dir, both shortcuts, registry entry gone; %APPDATA%\Bosom Friend gone;
       %USERPROFILE%\.bosom-friend byte-identical to the fingerprint taken before;
    D. reinstall: silent install exit code 0; kernel runtime file count matches the packaging
       source; then the app is left installed and runnable.

  Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so non-ASCII
  bytes here corrupt parsing.
#>
[CmdletBinding()]
param(
  [string]$Setup = '',
  [switch]$SkipReinstall
)

$ErrorActionPreference = 'Continue'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$installedDir = Join-Path $env:LOCALAPPDATA 'Programs\Bosom Friend'
$uninstaller = Join-Path $installedDir 'Uninstall Bosom Friend.exe'
$appData = Join-Path $env:APPDATA 'Bosom Friend'
$dataRoot = Join-Path $env:USERPROFILE '.bosom-friend'
$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Bosom Friend.lnk'
$startLnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Bosom Friend.lnk'
if ([string]::IsNullOrWhiteSpace($Setup)) {
  $version = (& node -e "process.stdout.write(require(process.argv[1]).version)" (Join-Path $repoRoot 'products\bosom-friend\desktop\package.json')).Trim()
  $Setup = Join-Path $repoRoot ('products\bosom-friend\desktop\release\' + $version + '\BosomFriend-Setup-' + $version + '.exe')
}

$checks = New-Object System.Collections.Generic.List[object]
function Check([string]$name, [bool]$ok, [string]$detail) {
  $checks.Add([pscustomobject]@{ Name = $name; Ok = $ok; Detail = $detail }) | Out-Null
  Write-Output (($(if ($ok) { 'PASS ' } else { 'FAIL ' })) + $name + ' | ' + $detail)
}

function RegistryEntry() {
  $hit = reg.exe query 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall' /s /f 'Bosom Friend' 2>$null | Out-String
  return $hit
}

function TreeFingerprint([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $files = Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue
  $sum = ($files | Measure-Object Length -Sum).Sum
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $lines = $files | Sort-Object FullName | ForEach-Object { $_.FullName.Substring($path.Length) + '|' + $_.Length }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
  $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', ''
  return [pscustomobject]@{ files = $files.Count; bytes = $sum; sha = $hash }
}

Write-Output '== uninstall-residue acceptance =='
Write-Output ('installer : ' + $Setup)
Write-Output ''

Write-Output '-- A. state before uninstall'
Check 'no app process is running' ((Get-Process -Name 'Bosom Friend' -ErrorAction SilentlyContinue | Measure-Object).Count -eq 0) 'taskkill would hide a real leak'
Check 'installed app present' (Test-Path -LiteralPath $installedDir) $installedDir
Check 'uninstaller present' (Test-Path -LiteralPath $uninstaller) $uninstaller
Check 'desktop shortcut present' (Test-Path -LiteralPath $desktopLnk) $desktopLnk
Check 'start-menu shortcut present' (Test-Path -LiteralPath $startLnk) $startLnk
$regBefore = RegistryEntry
Check 'registry entry present' ($regBefore -match 'Bosom Friend') 'HKCU uninstall key'

$rootBefore = TreeFingerprint $dataRoot
if ($null -eq $rootBefore) { Check 'user data root present' $false $dataRoot } else { Check 'user data root present' $true ('files=' + $rootBefore.files + ' bytes=' + $rootBefore.bytes) }
if (-not (Test-Path -LiteralPath $uninstaller)) { Write-Output ''; Write-Output 'UNINSTALL_RESIDUE FAIL checks=' + $checks.Count + ' fail=1 (no uninstaller)'; exit 1 }

Write-Output ''
Write-Output '-- B. silent uninstall'
$t0 = Get-Date
$p = Start-Process -FilePath $uninstaller -ArgumentList '/S','/currentuser' -PassThru -Wait
$secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
Check 'silent uninstall exit code 0' ($p.ExitCode -eq 0) ('exit=' + $p.ExitCode + ' in ' + $secs + 's')

# The uninstaller deletes a deep tree; give the filesystem a moment to settle.
Start-Sleep -Seconds 8

Write-Output ''
Write-Output '-- C. state after uninstall'
Check 'install dir removed' (-not (Test-Path -LiteralPath $installedDir)) $installedDir
Check 'desktop shortcut removed' (-not (Test-Path -LiteralPath $desktopLnk)) $desktopLnk
Check 'start-menu shortcut removed' (-not (Test-Path -LiteralPath $startLnk)) $startLnk
$regAfter = RegistryEntry
Check 'registry entry removed' (-not ($regAfter -match 'Bosom Friend')) 'HKCU uninstall key'
Check 'APPDATA app tree removed' (-not (Test-Path -LiteralPath $appData)) $appData
Check 'no app process left behind' ((Get-Process -Name 'Bosom Friend' -ErrorAction SilentlyContinue | Measure-Object).Count -eq 0) 'process table'
$rootAfter = TreeFingerprint $dataRoot
if ($null -eq $rootAfter -or $null -eq $rootBefore) {
  Check 'user data root survives byte-identical' $false 'fingerprint unavailable'
} else {
  Check 'user data root survives byte-identical' (($rootAfter.files -eq $rootBefore.files) -and ($rootAfter.bytes -eq $rootBefore.bytes) -and ($rootAfter.sha -eq $rootBefore.sha)) ('files ' + $rootBefore.files + '->' + $rootAfter.files + ' bytes ' + $rootBefore.bytes + '->' + $rootAfter.bytes)
}

if (-not $SkipReinstall) {
  Write-Output ''
  Write-Output '-- D. reinstall'
  if (-not (Test-Path -LiteralPath $Setup)) { Check 'installer available for reinstall' $false $Setup }
  else {
    $t1 = Get-Date
    $q = Start-Process -FilePath $Setup -ArgumentList '/S' -PassThru -Wait
    $secs2 = [math]::Round(((Get-Date) - $t1).TotalSeconds, 1)
    Check 'silent reinstall exit code 0' ($q.ExitCode -eq 0) ('exit=' + $q.ExitCode + ' in ' + $secs2 + 's')
    $marker = Join-Path $appData 'kernel-runtime\runtime\bin-desktop.mjs'
    $runtimeFiles = 0
    if (Test-Path -LiteralPath $marker) {
      $runtimeFiles = @(Get-ChildItem (Split-Path (Split-Path $marker -Parent) -Parent) -Recurse -File -ErrorAction SilentlyContinue).Count
    }
    $expect = Join-Path $repoRoot 'products\bosom-friend\desktop\dist\kernel-runtime-flat'
    $expectFiles = if (Test-Path -LiteralPath $expect) { @(Get-ChildItem -LiteralPath $expect -Recurse -File -Force -ErrorAction SilentlyContinue).Count } else { 0 }
    Check 'runtime marker present after reinstall' (Test-Path -LiteralPath $marker) $marker
    Check 'runtime file count matches the packaging source' (($expectFiles -gt 0) -and ($runtimeFiles -eq $expectFiles)) ('installed=' + $runtimeFiles + ' flat=' + $expectFiles)
    Check 'desktop shortcut restored' (Test-Path -LiteralPath $desktopLnk) $desktopLnk
  }
}

$failed = @($checks | Where-Object { -not $_.Ok })
Write-Output ''
if ($failed.Count -gt 0) {
  Write-Output ('UNINSTALL_RESIDUE FAIL checks=' + $checks.Count + ' fail=' + $failed.Count)
  exit 1
}
Write-Output ('UNINSTALL_RESIDUE PASS checks=' + $checks.Count + ' fail=0')
exit 0