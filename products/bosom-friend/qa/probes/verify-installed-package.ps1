<#
  Installed-package acceptance for a built Bosom Friend setup (DEF-046 / DEF-055 closure evidence).

  Why: several releases shipped a package that "built fine" but could not start on the target
  machine, and the defect ledger kept the wording "装包实测待出包后补" because that check was a
  manual one-off every time. This probe makes it repeatable: it inspects the built artifacts and,
  when asked, installs the package and verifies the installed result.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File qa\probes\verify-installed-package.ps1
    ... -Install              # also run the setup silently (/S) and check the installed result
    ... -Setup <path.exe> -StagedResources <dir> -ExpectVersion 0.2.48

  Checks that need no install:
    exe exists, size, FileVersion, SHA256; staged win-unpacked resources carry kernel-unzip.cjs
    (hash must equal the repository copy) and runtime\node.exe; the installer's own unpacker
    command (node.exe + kernel-unzip.cjs + zip -> target) actually unpacks into a temp target.
  Checks with -Install:
    silent install exit code; registry DisplayName; installed exe FileVersion; kernel runtime
    marker + file count; absence of kernel-extract.log (a failure log means the runtime was not
    produced by the installer).

  Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
#>
[CmdletBinding()]
param(
  [string]$Setup = '',
  [string]$StagedResources = '',
  [string]$ExpectVersion = '',
  [switch]$Install
)

$ErrorActionPreference = 'Continue'
# qa\probes -> qa -> bosom-friend -> products -> repository root (four levels up).
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$desktop = Join-Path $repoRoot 'products\bosom-friend\desktop'
# package.json is UTF-8; Windows PowerShell 5.1 reads it as ANSI and ConvertFrom-Json then throws on
# the Chinese description (the build script learned the same lesson and shells out to Node as well).
if ([string]::IsNullOrWhiteSpace($ExpectVersion)) {
  $ExpectVersion = (& node -e "process.stdout.write(require(process.argv[1]).version)" (Join-Path $desktop 'package.json')).Trim()
}
if ([string]::IsNullOrWhiteSpace($ExpectVersion)) {
  Write-Output 'FAIL: could not read the version from desktop/package.json (node missing?)'
  exit 1
}
if ([string]::IsNullOrWhiteSpace($Setup)) { $Setup = Join-Path $desktop ('release\' + $ExpectVersion + '\BosomFriend-Setup-' + $ExpectVersion + '.exe') }
if ([string]::IsNullOrWhiteSpace($StagedResources)) { $StagedResources = Join-Path $env:USERPROFILE ('bf-build-' + $ExpectVersion + '\release\' + $ExpectVersion + '\win-unpacked\resources') }

$checks = New-Object System.Collections.Generic.List[object]
function Check([string]$name, [bool]$ok, [string]$detail) {
  $checks.Add([pscustomobject]@{ Name = $name; Ok = $ok; Detail = $detail }) | Out-Null
  Write-Output (($(if ($ok) { 'PASS ' } else { 'FAIL ' })) + $name + ' | ' + $detail)
}

Write-Output "== installed-package acceptance for $ExpectVersion =="
Write-Output "setup           : $Setup"
Write-Output "staged resources: $StagedResources"
Write-Output ''

# ---- 1. the built setup itself ----
if (-not (Test-Path -LiteralPath $Setup)) {
  # Fail fast and loud: with a missing setup every later check would report nonsense.
  Check 'setup exists' $false $Setup
  Write-Output ''
  Write-Output 'INSTALLED_PACKAGE FAIL checks=1 fail=1'
  exit 1
}
else {
  $exe = Get-Item -LiteralPath $Setup
  $version = $exe.VersionInfo.FileVersion
  $hash = (Get-FileHash -LiteralPath $Setup -Algorithm SHA256).Hash
  Check 'setup exists' $true ('{0:N1} MB' -f ($exe.Length / 1MB))
  Check 'setup FileVersion matches desktop/package.json' ($version -eq $ExpectVersion) "exe=$version expect=$ExpectVersion"
  Check 'setup SHA256 recorded' ($hash.Length -eq 64) $hash
  $targetDir = Join-Path (Split-Path $Setup -Parent) 'sha256.txt'
  Set-Content -Path $targetDir -Value $hash -Encoding ASCII
}

# ---- 2. staged resources: the installer must be able to reach the built-in unpacker ----
$stagedUnzip = Join-Path $StagedResources 'kernel-unzip.cjs'
$stagedNode = Join-Path $StagedResources 'runtime\node.exe'
$stagedZip = Join-Path $StagedResources 'kernel-runtime.zip'
$repoUnzip = Join-Path $desktop 'electron\kernel-unzip.cjs'
if (Test-Path -LiteralPath $stagedUnzip) {
  $stagedHash = (Get-FileHash -LiteralPath $stagedUnzip -Algorithm SHA256).Hash
  $repoHash = (Get-FileHash -LiteralPath $repoUnzip -Algorithm SHA256).Hash
  Check 'staged resources carry the built-in unpacker' $true 'kernel-unzip.cjs'
  Check 'shipped unpacker equals the repository copy' ($stagedHash -eq $repoHash) $stagedHash
}
else {
  Check 'staged resources carry the built-in unpacker' $false $stagedUnzip
}
Check 'staged resources carry runtime\node.exe' (Test-Path -LiteralPath $stagedNode) $stagedNode

# ---- 3. run the installer's own unpacker command (verbatim) against a temp target ----
if ((Test-Path -LiteralPath $stagedNode) -and (Test-Path -LiteralPath $stagedUnzip) -and (Test-Path -LiteralPath $stagedZip)) {
  $out = Join-Path $env:TEMP ('bf-pkg-unzip-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
  $started = Get-Date
  & $stagedNode $stagedUnzip $stagedZip $out | Select-Object -Last 1
  $code = $LASTEXITCODE
  $minutes = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
  $marker = Join-Path $out 'runtime\bin-desktop.mjs'
  Check 'shipped unpacker unpacks the shipped zip' ($code -eq 0 -and (Test-Path -LiteralPath $marker)) "exit=$code minutes=$minutes"
  Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
}
else {
  Check 'shipped unpacker unpacks the shipped zip' $false 'staged resources incomplete'
}

# ---- 4. optional: install silently and inspect the installed result ----
if ($Install) {
  $proc = Start-Process -FilePath $Setup -ArgumentList '/S' -Wait -PassThru
  Check 'silent install exit 0' ($proc.ExitCode -eq 0) "exit=$($proc.ExitCode)"

  $regHit = reg.exe query 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall' /s /f ('Bosom Friend ' + $ExpectVersion) /d 2>$null
  # reg.exe returns an array of lines; -match on an array returns the matching lines (an Object[]),
  # which cannot bind to the [bool] parameter of Check. Join first, then compare.
  $regText = [string]::Join([string][char]10, [string[]]$regHit)
  $regOk = [bool]($regText -match [regex]::Escape('Bosom Friend ' + $ExpectVersion))
  Check 'registry DisplayName carries the version' $regOk $regText.Substring(0, [Math]::Min(160, $regText.Length))

  $appExe = Join-Path $env:LOCALAPPDATA 'Programs\Bosom Friend\Bosom Friend.exe'
  if (Test-Path -LiteralPath $appExe) {
    $appVersion = (Get-Item -LiteralPath $appExe).VersionInfo.FileVersion
    Check 'installed exe FileVersion' ($appVersion -eq $ExpectVersion) "exe=$appVersion"
    $installedUnzip = Join-Path $env:LOCALAPPDATA 'Programs\Bosom Friend\resources\kernel-unzip.cjs'
    Check 'installed resources carry the unpacker' (Test-Path -LiteralPath $installedUnzip) $installedUnzip
  }
  else {
    Check 'installed exe FileVersion' $false $appExe
  }

  $marker = Join-Path $env:APPDATA 'Bosom Friend\kernel-runtime\runtime\bin-desktop.mjs'
  $runtimeFiles = 0
  if (Test-Path -LiteralPath $marker) {
    $runtimeFiles = @(Get-ChildItem (Split-Path (Split-Path $marker -Parent) -Parent) -Recurse -File -ErrorAction SilentlyContinue).Count
  }
  Check 'kernel runtime unpacked by the installer' ((Test-Path -LiteralPath $marker) -and $runtimeFiles -gt 150000) "files=$runtimeFiles"
  $log = Join-Path $env:APPDATA 'Bosom Friend\kernel-extract.log'
  Check 'no extraction-failure log (runtime came from the installer)' (-not (Test-Path -LiteralPath $log)) $log
}

$failed = @($checks | Where-Object { -not $_.Ok })
Write-Output ''
Write-Output ('INSTALLED_PACKAGE ' + $(if ($failed.Count -eq 0) { 'PASS' } else { 'FAIL' }) + ' checks=' + $checks.Count + ' fail=' + $failed.Count)
exit $(if ($failed.Count -eq 0) { 0 } else { 1 })
