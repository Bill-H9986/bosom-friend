<#
.SYNOPSIS
  One-click launcher for Bosom Friend (desktop shortcut target).

.DESCRIPTION
  Fast path: the product page already answers on 127.0.0.1:31280 -> just open it.
  Booting path: a runtime process exists but the port is not answering yet -> wait for it.
  Cold path: nothing is running -> run dev-web.ps1 next to this file (build packages, stop a
  stale runtime, start the source runtime) and open the page once the port is listening.

  The desktop shortcut "Bosom Friend" points at this file and takes its icon from
  products/bosom-friend/desktop/build/icon.ico.

.PARAMETER Probe
  Report the runtime state and exit without starting anything or opening a browser.

.NOTES
  Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, and
  non-ASCII bytes here corrupt parsing (same constraint as dev-web.ps1). Chinese messages
  therefore belong in the README, not in this file.
#>
param([switch]$Probe)

$ErrorActionPreference = 'Stop'
$port = 31280
$url = 'http://127.0.0.1:' + $port + '/bosom-friend/'
$here = if ($PSScriptRoot -ne '' -and $PSScriptRoot -ne $null) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
# scripts -> launcher -> bosom-friend -> products -> repository root
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here)))
$devWeb = Join-Path $here 'dev-web.ps1'

# 200 means the product page is served; any other answer (or a refused connection) is "not up".
function Test-Serving {
  try {
    $response = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 8
    return ($response.StatusCode -eq 200)
  }
  catch {
    return $false
  }
}

# A refused port does NOT mean "no runtime": a start in progress has not bound the port yet.
function Get-RuntimeProcesses {
  try {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match 'bin-desktop' })
  }
  catch {
    # WMI enumeration can be denied in a restricted sandbox: treat it as "nothing running",
    # which costs at most one extra start attempt.
    return @()
  }
}

$serving = Test-Serving
if ($Probe) {
  $procs = @(Get-RuntimeProcesses)
  Write-Host ('serving=' + $serving + ' runtimeProcesses=' + $procs.Count + ' url=' + $url)
  exit 0
}

Write-Host '== Bosom Friend =='
if ($serving) {
  Write-Host ('==> runtime already up, opening ' + $url)
  Start-Process $url
  exit 0
}

# Double-clicking while a start is still in flight must not kill it: dev-web.ps1 stops every
# existing runtime first, so a second launch during the cold start turned into a restart loop
# and the page kept reporting "local service unreachable" (observed 2026-09-21).
$starting = @(Get-RuntimeProcesses)
if ($starting.Count -gt 0) {
  Write-Host ('==> runtime process already present (' + $starting.Count + '), waiting up to 180s for it to serve')
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Serving) {
      Write-Host ('==> ready: ' + $url)
      Start-Process $url
      exit 0
    }
    if (@(Get-RuntimeProcesses).Count -eq 0) {
      Write-Host '==> that runtime exited before serving; starting a fresh one'
      break
    }
  }
}

if (-not (Test-Path $devWeb)) {
  Write-Warning ('dev-web.ps1 not found next to this launcher: ' + $devWeb)
  Read-Host 'Press Enter to close'
  exit 1
}

Write-Host '==> runtime not running: starting it now (first start takes 2-3 minutes)'
Set-Location $repo
& $devWeb

if (-not (Test-Serving)) {
  Write-Warning ('runtime did not answer on ' + $url)
  Write-Warning ('logs: ' + (Join-Path $repo 'dev-web.out.log') + ' / ' + (Join-Path $repo 'dev-web.err.log'))
  Read-Host 'Press Enter to close'
  exit 1
}

Write-Host ('==> ready: ' + $url)
Start-Process $url
