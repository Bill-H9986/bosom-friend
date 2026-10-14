<#
  Installed-build runtime-logging acceptance (DEF-101 / DEF-102 / DEF-103 closure evidence).

  Why: the packaged app used to write no runtime log at all, so a site report of "network error /
  generation failed" could not be reconstructed afterwards (the kernel simply vanished and nothing
  recorded when or why). This probe makes the new evidence chain repeatable on any machine that has
  the build installed, instead of a manual one-off each release.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File qa\probes\verify-installed-logging.ps1
    ... -KillKernel        # also kill the kernel child and require a recorded recovery
    ... -WaitSeconds 90    # how long to wait for log lines after the kill

  Checks:
    1. userData\logs exists and today's log exists;
    2. the main process recorded boot facts, the kernel spawn and the health monitor;
    3. the product side wrote its own log ([boot] server ...);
    4. (with -KillKernel) the exit and the automatic restart are recorded.

  Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so non-ASCII
  bytes here corrupt parsing (measured 2026-09-18). Chinese log markers are therefore matched with
  .NET \uXXXX escapes:
    U+5185 U+6838 U+5B50 U+8FDB U+7A0B U+5DF2 U+9000 U+51FA  = kernel child exited
    U+91CD U+542F U+5185 U+6838                            = restart kernel
#>
[CmdletBinding()]
param(
  [switch]$KillKernel,
  [int]$WaitSeconds = 90
)

$ErrorActionPreference = 'Continue'
$userData = Join-Path $env:APPDATA 'Bosom Friend'
$logDir = Join-Path $userData 'logs'
$dataRootLogs = Join-Path $env:USERPROFILE '.bosom-friend\bosom-friend\logs'
$today = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
$kernelExited = '[\u5185\u6838] .*\u5DF2\u9000\u51FA'
$kernelRestart = '\u91CD\u542F\u5185\u6838'

$checks = New-Object System.Collections.Generic.List[object]
function Check([string]$name, [bool]$ok, [string]$detail) {
  $checks.Add([pscustomobject]@{ Name = $name; Ok = $ok; Detail = $detail }) | Out-Null
  Write-Output (($(if ($ok) { 'PASS ' } else { 'FAIL ' })) + $name + ' | ' + $detail)
}
function Read-LogText([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return '' }
  $files = @(Get-ChildItem -LiteralPath $dir -File -Filter '*.log' -ErrorAction SilentlyContinue)
  if ($files.Count -eq 0) { return '' }
  return (($files | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 }) -join [Environment]::NewLine)
}

Write-Output '== installed-build runtime logging acceptance =='
Write-Output ("log dir        : " + $logDir)
Write-Output ("data root logs : " + $dataRootLogs)
Write-Output ''

$mainLog = Join-Path $logDir ($today + '.log')
Check 'log dir exists' (Test-Path -LiteralPath $logDir) $logDir
Check 'today log exists' (Test-Path -LiteralPath $mainLog) $mainLog

$text = Read-LogText $logDir
Check 'main boot recorded' ($text -match '\[boot\] .*=') 'expect a [boot] line'
Check 'kernel spawn recorded' ($text -match '\[kernel\] .*') 'expect a [kernel] line'
Check 'health monitor recorded' ($text -match '\[health\] .*') 'expect a [health] line'

$kernelText = Read-LogText $logDir
if ($kernelText -notmatch '\[boot\] server') {
  $kernelText = Read-LogText $dataRootLogs
}
Check 'product side log recorded' ($kernelText -match '\[boot\] server') 'expect [boot] server ... in the kernel log'

if ($KillKernel) {
  # Kill the kernel child (node.exe running bin-desktop) and require the app to notice, restart and
  # record it. The old build stayed dead silently; that silence is exactly what this probe forbids.
  $kernel = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'bin-desktop' -and $_.CommandLine -notmatch 'tsx' })
  if ($kernel.Count -eq 0) {
    $kernel = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match 'bin-desktop' })
  }
  Check 'kernel process found' ($kernel.Count -gt 0) ('matched=' + $kernel.Count)
  if ($kernel.Count -gt 0) {
    foreach ($row in $kernel) {
      Write-Output ('   killing pid ' + $row.ProcessId)
      & taskkill.exe /PID $row.ProcessId /T /F | Out-Null
    }
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    $sawExit = $false
    $sawRestart = $false
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 5
      $now = Read-LogText $logDir
      if ($now -match $kernelExited) { $sawExit = $true }
      if ($now -match $kernelRestart) { $sawRestart = $true }
      if ($sawExit -and $sawRestart) { break }
    }
    Check 'kernel exit recorded' $sawExit 'expect [kernel] <child exited>'
    Check 'automatic restart recorded' $sawRestart 'expect <restart kernel>'
  }
}

$failed = @($checks | Where-Object { -not $_.Ok })
Write-Output ''
Write-Output ('INSTALLED_LOGGING ' + $(if ($failed.Count -eq 0) { 'PASS' } else { 'FAIL' }) + ' checks=' + $checks.Count + ' fail=' + $failed.Count)
exit $(if ($failed.Count -eq 0) { 0 } else { 1 })
