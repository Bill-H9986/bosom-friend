# repair-kernel-runtime.ps1 - re-unpack the bundled kernel runtime on a machine whose app
# cannot start (the splash screen shows a failure and the runtime directory is missing or empty).
#
# Why this exists: the 0.2.42 launcher unpacked with a bare "tar.exe" spawned through PATH, so on a
# machine without a usable tar.exe the app could not repair itself (DEF-045). 0.2.47 then failed
# again on the same machine: no System32\tar.exe, and the bundled Python died with
# "Command failed" because the runtime contains paths over MAX_PATH 260 while Windows long-path
# support is off by default (DEF-055). Extraction ladder, same as the app:
#   1. the app's own unpacker   - resources\kernel-unzip.cjs run by resources\runtime\node.exe.
#                                 Pure Node and it prefixes \\?\ itself, so it does not depend on
#                                 PATH, on the bundled Python, or on LongPathsEnabled.
#   2. %SystemRoot%\System32\tar.exe   (absolute path, never PATH lookup)
#   3. tar.exe from PATH               (Git/msys tar also understands this syntax)
#   4. the portable Python that ships with the app: python -m zipfile -e
# It is read-only with respect to product data: it only writes <userData>\kernel-runtime.
#
# Usage (one command for the user):
#   powershell -NoProfile -ExecutionPolicy Bypass -File products\bosom-friend\qa\probes\repair-kernel-runtime.ps1
# Optional:
#   -AppDir    "D:\Apps\Bosom Friend"   install directory (default %LOCALAPPDATA%\Programs\Bosom Friend)
#   -UserData  "C:\Users\x\AppData\Roaming\Bosom Friend"
#   -UnzipScript "C:\path\kernel-unzip.cjs"  use this copy when the install predates 0.2.48
#   -Force                               re-unpack even when the runtime already looks complete
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, and non-ASCII
# bytes here would be parsed as garbage (they shift line numbers and can break the script).
param(
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'Programs\Bosom Friend'),
  [string]$UserData = (Join-Path $env:APPDATA 'Bosom Friend'),
  [string]$UnzipScript = '',
  [switch]$Force
)

$ErrorActionPreference = 'Continue'
$zip = Join-Path $AppDir 'resources\kernel-runtime.zip'
$target = Join-Path $UserData 'kernel-runtime'
$marker = Join-Path $target 'runtime\bin-desktop.mjs'

Write-Output "== Bosom Friend runtime repair =="
Write-Output "install dir : $AppDir"
Write-Output "user data   : $UserData"
Write-Output "runtime     : $target"

# Environment facts first: on a broken machine these four lines are the whole diagnosis.
$osCaption = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption
$systemTar = Join-Path $env:SystemRoot 'System32\tar.exe'
$pathTar = (Get-Command 'tar.exe' -ErrorAction SilentlyContinue).Source
$longPaths = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
if ($null -eq $longPaths) { $longPaths = 0 }
Write-Output ""
Write-Output "== environment =="
Write-Output "os                : $osCaption"
Write-Output "system tar        : $(if (Test-Path $systemTar) { $systemTar } else { 'MISSING (needs Windows 10 1803 or later)' })"
Write-Output "tar on PATH       : $(if ($pathTar) { $pathTar } else { 'MISSING' })"
Write-Output "LongPathsEnabled  : $longPaths $(if ($longPaths -eq 1) { '(long paths available)' } else { '(long paths NOT available - tar and the bundled Python cannot unpack this runtime)' })"
if (Test-Path $zip) {
  $zipMb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
  Write-Output "zip               : $zipMb MB"
}
else {
  Write-Output "zip               : MISSING"
}
try {
  $drive = (Get-Item $UserData -ErrorAction SilentlyContinue).PSDrive.Name
  if ($drive) { Write-Output "free space        : $([math]::Round((Get-PSDrive $drive).Free / 1GB, 1)) GB on $drive" }
}
catch {
  # Free space is diagnostic only; never fail the repair because it could not be read.
}

$running = @(Get-Process -Name 'Bosom Friend' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Write-Output ""
  Write-Output "FAIL: Bosom Friend is still running (pid $($running.Id -join ', '))."
  Write-Output "      Close it from the tray icon (right click -> quit completely), then run this again."
  exit 1
}

if ((Test-Path $marker) -and (-not $Force)) {
  Write-Output ""
  Write-Output "PASS: the runtime is already in place; nothing to repair."
  Write-Output "      marker: $marker"
  exit 0
}

if (-not (Test-Path $zip)) {
  Write-Output ""
  Write-Output "FAIL: $zip is missing."
  Write-Output "      A finished install deletes that zip on purpose (it saves 417 MB), so this machine has to"
  Write-Output "      be repaired from the installer: run BosomFriend-Setup-*.exe again and choose the same"
  Write-Output "      install directory, then start the app."
  exit 1
}

New-Item -ItemType Directory -Force -Path $target | Out-Null
$zipMb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Output ""
Write-Output "unpacking $zipMb MB into the runtime directory (a few minutes, do not close this window)..."

$unpacked = $false

# Step 1: the app's own unpacker. This is the only step that works on a machine without tar.exe
# AND without long-path support, so it goes first.
$node = Join-Path $AppDir 'resources\runtime\node.exe'
if ($UnzipScript -eq '') { $UnzipScript = Join-Path $AppDir 'resources\kernel-unzip.cjs' }
if ((Test-Path $node) -and (Test-Path $UnzipScript)) {
  Write-Output "step 1/4: $node $UnzipScript"
  & $node $UnzipScript $zip $target | ForEach-Object { if ($_ -match 'UNZIP_PROGRESS 20000|UNZIP_PROGRESS 100000|UNZIP_OK|UNZIP_FAIL') { Write-Output "         $_" } }
  Write-Output "         exit=$LASTEXITCODE"
  if ($LASTEXITCODE -eq 0) { $unpacked = $true }
}
else {
  Write-Output "step 1/4: built-in unpacker not present in this install ($UnzipScript)"
  Write-Output "         pass -UnzipScript <path to kernel-unzip.cjs> to use a copy from the repository"
}

if (-not $unpacked) {
  if (Test-Path $systemTar) {
    Write-Output "step 2/4: $systemTar"
    & $systemTar -xf $zip -C $target
    Write-Output "         exit=$LASTEXITCODE"
    if ($LASTEXITCODE -eq 0) { $unpacked = $true }
  }
  else {
    Write-Output "step 2/4: $systemTar not present (needs Windows 10 1803 or later)"
  }
}

if (-not $unpacked) {
  if ($pathTar) {
    Write-Output "step 3/4: $pathTar"
    & $pathTar -xf $zip -C $target
    Write-Output "         exit=$LASTEXITCODE"
    if ($LASTEXITCODE -eq 0) { $unpacked = $true }
  }
  else {
    Write-Output "step 3/4: no tar.exe on PATH either"
  }
}

if (-not $unpacked) {
  $python = Join-Path $AppDir 'resources\engine\python-base\python.exe'
  if (Test-Path $python) {
    Write-Output "step 4/4: $python -m zipfile -e"
    & $python -m zipfile -e $zip $target
    Write-Output "         exit=$LASTEXITCODE"
    if ($LASTEXITCODE -eq 0) { $unpacked = $true }
  }
  else {
    Write-Output "step 4/4: $python not present"
  }
}

Write-Output ""
if (Test-Path $marker) {
  Write-Output "PASS: runtime unpacked. Start Bosom Friend normally."
  Write-Output "      marker: $marker"
  exit 0
}

Write-Output "FAIL: the runtime is still incomplete (no $marker)."
Write-Output "      If LongPathsEnabled is 0 on this machine, enable long path support as an administrator"
Write-Output "      (reg add HKLM\SYSTEM\CurrentControlSet\Control\FileSystem /v LongPathsEnabled /t REG_DWORD /d 1 /f),"
Write-Output "      reboot, then run this script again - or run BosomFriend-Setup-*.exe to repair the install."
exit 1
