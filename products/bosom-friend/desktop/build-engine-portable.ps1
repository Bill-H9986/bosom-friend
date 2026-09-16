<#
.SYNOPSIS
  Assemble the portable platform engine shipped inside the installer.

.DESCRIPTION
  The packaged app was missing the Python platform engine (no worker.py / patchright /
  social-auto-upload), so real login / publish / sync did not work in the installed build.
  This script assembles a self-contained dist/engine-portable that electron-builder copies
  to resources/engine. Contents:
    - engine sources (worker.py / interactions.py / social-auto-upload) minus caches
    - .venv (all site-packages)
    - python-base (Python 3.12 runtime; pyvenv.cfg is rewritten at runtime)
    - browsers (patchright chromium-1208 + playwright chromium-1169, headless shells, ffmpeg, winldd)
  At runtime desktop/electron/main.cjs injects BF_ENGINE_ROOT, BF_ENGINE_VENDOR_ROOT and
  PLAYWRIGHT_BROWSERS_PATH, then rewrites .venv/pyvenv.cfg home to python-base.

  NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 without BOM as ANSI;
  non-ASCII comments corrupt parsing and merge lines.
#>
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))
$engine = Join-Path $repo 'products\bosom-friend\engine'
$out = Join-Path $here 'dist\engine-portable'
$pythonBaseSrc = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312'
$browsersSrc = Join-Path $env:LOCALAPPDATA 'ms-playwright'

if (-not (Test-Path $engine)) { throw "missing engine dir: $engine" }
if (-not (Test-Path $pythonBaseSrc)) { throw "missing python runtime: $pythonBaseSrc" }

Write-Host "==> target: $out"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out -Force | Out-Null

# cookies / logs / db are development-machine browser profiles and run caches. Shipping them only
# slows install and first launch. cookiesFile is the product's own cookie store: keep it.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, and non-ASCII
# bytes here break parsing ("UnexpectedToken").
$excludeDirs = @('__pycache__', '_exam_evidence', '_probe_shots', '.git', '.pytest_cache')
Write-Host '==> copy engine (with .venv / social-auto-upload)'
robocopy $engine $out /E /NFL /NDL /NJH /NJS /NP /XD @excludeDirs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy engine failed: $LASTEXITCODE" }

# robocopy /XD does not match bare directory names here (cookies/logs/db were still copied),
# so drop them explicitly by name afterwards (~860 MB / 6431 files for cookies alone).
foreach ($junk in @('cookies', 'logs', 'db')) {
  Get-ChildItem -Path $out -Recurse -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq $junk } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host '==> copy python-base'
$pyOut = Join-Path $out 'python-base'
New-Item -ItemType Directory -Path $pyOut -Force | Out-Null
robocopy $pythonBaseSrc $pyOut /E /NFL /NDL /NJH /NJS /NP /XD @('__pycache__', 'Lib\site-packages', 'Scripts', 'Doc', 'tcl') | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy python failed: $LASTEXITCODE" }

# Two browser families ship side by side because the uploaders do not agree on a library:
#   patchright (revision 1208) -> xhs / douyin / ks / tencent / youtube
#   playwright (revision 1169) -> baijiahao / alipay / weibo / hupu / tiktok / xianyu
# Shipping only 1208 left every playwright platform failing at launch with
# "Executable doesn't exist ... chromium_headless_shell-1169".
Write-Host '==> copy platform browsers (patchright 1208 + playwright 1169)'
$brOut = Join-Path $out 'browsers'
New-Item -ItemType Directory -Path $brOut -Force | Out-Null
foreach ($dir in @('chromium-1208', 'chromium_headless_shell-1208', 'chromium-1169', 'chromium_headless_shell-1169', 'ffmpeg-1011', 'winldd-1007')) {
  $src = Join-Path $browsersSrc $dir
  if (Test-Path $src) {
    robocopy $src (Join-Path $brOut $dir) /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy $dir failed: $LASTEXITCODE" }
  }
  else { Write-Warning "missing browser dir: $dir" }
}

# Bilibili publishes through the biliup binary. Shipping it avoids a multi-minute
# GitHub release download on the user's first Bilibili publish.
Write-Host '==> copy biliup binary'
$biliupSrc = Join-Path $env:USERPROFILE '.social-auto-upload\tools\biliup'
$biliupOut = Join-Path $out 'tools\biliup'
if (Test-Path $biliupSrc) {
  New-Item -ItemType Directory -Path $biliupOut -Force | Out-Null
  robocopy $biliupSrc $biliupOut /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy biliup failed: $LASTEXITCODE" }
}
else { Write-Warning "missing biliup dir: $biliupSrc (run a bilibili publish once to fetch it)" }

$cfg = Join-Path $out '.venv\pyvenv.cfg'
if (Test-Path $cfg) {
  $body = Get-Content $cfg -Raw
  $body = $body -replace [char]0xFEFF, ''
  $body = [regex]::Replace($body, 'home\s*=.*', 'home = __BF_PYTHON_BASE__')
  # Write without BOM: Python reads pyvenv.cfg as UTF-8, and a leading BOM would stop
  # the runtime rewrite in main.cjs from matching the 'home' line.
  [System.IO.File]::WriteAllText($cfg, $body, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host '==> pyvenv.cfg home replaced with placeholder (no BOM)'
}

$size = (Get-ChildItem $out -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum)
Write-Host ("==> done: {0} files, {1} MB" -f $size.Count, [math]::Round($size.Sum/1MB,1))
