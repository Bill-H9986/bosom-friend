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

.PARAMETER Port
  Listen port; default 31280 (the primary development runtime). Pass another port to start an
  ISOLATED instance: isolated instances exist for verification that must NOT pollute the
  development instance (negative controls, constructed-failure runs, anything that temporarily
  relaxes a judgement in the running code).

.PARAMETER DataRoot
  DSH home for that isolated instance (default: the real one, ~/.bosom-friend). Pass a temp dir to
  keep the instance's writes out of real user data; the product data root then resolves to
  <DataRoot>/bosom-friend. The real settings.yaml and .credentials.yaml are seeded into it when
  missing, because without them the instance has no model provider at all
  (measured 2026-10-13: "no adapter registered for provider bf-agnes-builtin").

.NOTES
  Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 without BOM as ANSI and
  non-ASCII comments corrupt parsing.
#>
param([switch]$Frontend, [int]$Port = 31280, [string]$DataRoot = '')

$ErrorActionPreference = 'Stop'
# Native tools (vite/pnpm) write progress and warnings to stderr; PS 7's native-command
# error preference would otherwise treat those warnings as terminating errors and abort
# the whole start-up sequence after a successful build.
$PSNativeCommandUseErrorActionPreference = $false
# $PSScriptRoot is always absolute; $MyInvocation.MyCommand.Path keeps whatever form the caller
# used, and a relative one (powershell -File products\...\dev-web.ps1) makes every path derived
# from it relative too -- the runtime then resolves "products/..." against "<repo>\products" and
# dies with ERR_MODULE_NOT_FOUND on "products/products/bosom-friend/...".
$here = if ($PSScriptRoot -ne '' -and $PSScriptRoot -ne $null) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
# scripts -> launcher -> bosom-friend -> products -> repository root
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here)))
Set-Location $repo

if ($Frontend) {
  Write-Host '==> build frontend dist'
  # vite/esbuild fails when TEMP resolves outside the writable tree, and a failed build
  # DELETES the existing dist (2026-09-29: index.html kept pointing at files that no longer
  # existed -> blank page). Point TEMP at a workspace directory before the build starts.
  $env:TEMP = Join-Path $repo 'analysis\_tmp'
  $env:TMP = $env:TEMP
  New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
  $posix = ($repo -replace '\\', '/')
  # --mode=test is the mode the dev server serves and the one that builds cleanly: the default mode
  # fails with "Circular chunk: vendor-utils -> vendor-ui -> vendor-utils" from the manual chunk rules.
  # No 2>&1: vite writes its progress to stderr, and merging that into the pipeline turns each line into
  # an ErrorRecord -- under Windows PowerShell 5.1 (no $PSNativeCommandUseErrorActionPreference) that
  # aborts the whole script at the next statement, so the frontend build "fails" while actually succeeding.
  # stderr now prints live instead; the last lines of stdout still carry the build result.
  & 'C:\Program Files\Git\bin\bash.exe' -lc "cd '$posix/products/bosom-friend/project/bosom-friend-electron' && npx vite build --mode=test" | Select-Object -Last 6
}

# The dev runtime loads the product server/kernel from their built lib/ (package exports point at
# lib/types/*.js), so backend edits need a package build before restart. This takes ~10s.
Write-Host '==> build product packages (server + kernel)'
# Same reason as the vite step above: keep pnpm's stderr out of the pipeline.
pnpm --filter @deepseek-ai/dsh-bosom-friend-server --filter @deepseek-ai/dsh-bosom-friend-kernel build | Select-Object -Last 4

if ($Port -eq 31280) {
  Write-Host '==> stop installed app and any previous dev runtime'
  Get-Process | Where-Object { $_.ProcessName -eq 'Bosom Friend' } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  # WMI enumeration can be denied in a restricted sandbox; best-effort cleanup must not abort startup.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'bin-desktop\.ts' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'worker\.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 4
} else {
  # An isolated instance must never kill the primary runtime (the match above is on the script name,
  # not on the port). Skip the whole stop step instead of narrowing it.
  Write-Host ('==> isolated instance on port ' + $Port + ': skipping the stop step (must not kill the primary runtime)')
}

# The source runtime resolves these packages through node_modules/.pnpm/<id>/node_modules/... and pnpm
# keeps an injected COPY there. A rebuild refreshes file contents in place but never adds new files, so
# the first build that introduces a module (storyboard.ts, agnes.ts) leaves the copy without it and the
# runtime dies with ERR_MODULE_NOT_FOUND on the newest module. Copy the built lib/ over every copy.
# Runs AFTER the stop step: a still-running previous runtime keeps lib/index.js open and the copy fails.

# 把仓库的 presets/ 物化到运行期 home 的 .agent-presets/（2026-10-12）。
# 内核读的工具面来自运行期副本，仓库只是源；此前靠手工复制，漂移过三次
# （steward 少 bosom_task_*、operator 少 sync_now、device 少 login_start）。
# 幂等、失败不阻断启动（脚本自己打 SYNC_PRESETS_FAIL 并退出 1，这里只提示）。
Write-Host '==> sync agent presets to runtime home'
& node (Join-Path $repo 'products\bosom-friend\launcher\scripts\sync-presets.mjs')
Write-Host '==> refresh injected package copies (node_modules/.pnpm)'
# Three packages carry runtime content: two have a built lib/, the desktop bundle carries only its
# cordis.patch.yml (which is itself runtime config -- the bind host, the port, the plugin layers).
# All three must be refreshed, or the runtime loads an old patch layer (2026-09-17: remote access
# saved 0.0.0.0 but the socket stayed on 127.0.0.1 because the copied patch predated the edit).
foreach ($pair in @(
  @('dsh-bosom-friend-server', 'server'),
  @('dsh-bosom-friend-kernel', 'kernel'),
  @('dsh-bosom-friend-desktop-bundle', 'bundle\desktop')
)) {
  $srcPkg = Join-Path $repo ('products\bosom-friend\' + $pair[1])
  $srcLib = Join-Path $srcPkg 'lib'
  if (-not (Test-Path $srcPkg)) { continue }
  $pnpmRoot = Join-Path $repo 'node_modules\.pnpm'
  if (-not (Test-Path $pnpmRoot)) { continue }
  $copies = Get-ChildItem $pnpmRoot -Directory |
    ForEach-Object { Join-Path $_.FullName ('node_modules\@deepseek-ai\' + $pair[0]) } |
    Where-Object { Test-Path $_ }
  $done = 0
  foreach ($copy in $copies) {
    # Remove the destination lib first, then copy the whole tree.
    #
    # Why not a plain Copy-Item over the existing dir: the injected copy and the workspace package
    # share the SAME files as hard links (pnpm injects workspace packages by linking), so copying a
    # source file onto its own hard link fails with "being used by another process" -- every copy got
    # skipped, and any module added since the last install was missing from the copy entirely. The
    # runtime then dies with ERR_MODULE_NOT_FOUND on the newest module (2026-09-17: remote-access.js).
    # Deleting the destination only unlinks those hard links; the workspace source is untouched.
    #
    # A locked file means some stale process still holds it; that copy keeps its old content and the
    # startup continues (the freshly spawned runtime loads the copies that did refresh).
    try {
      if (Test-Path $srcLib) {
        $destLib = Join-Path $copy 'lib'
        Remove-Item -Recurse -Force $destLib -ErrorAction Stop
        Copy-Item -Path $srcLib -Destination $destLib -Recurse -Force -ErrorAction Stop
      }
      $srcPatch = Join-Path $srcPkg 'cordis.patch.yml'
      if (Test-Path $srcPatch) {
        $destPatch = Join-Path $copy 'cordis.patch.yml'
        Remove-Item -Force $destPatch -ErrorAction Stop
        Copy-Item -Path $srcPatch -Destination $destPatch -Force -ErrorAction Stop
      }
      $done = $done + 1
    } catch {
      Write-Host ('    skipped ' + (Split-Path $copy -Leaf) + ': ' + $_.Exception.Message)
    }
  }
  Write-Host ('    ' + $pair[0] + ': ' + $done + '/' + @($copies).Count + ' copies refreshed')
}

# Isolated instance knobs (2026-10-13): set ONLY when the caller asked for isolation, so a plain
# dev-web.ps1 keeps behaving exactly as before (same port, same data root, same stop step).
if ($Port -ne 31280) {
  $env:BF_DESKTOP_PORT = [string]$Port
  Write-Host ('==> BF_DESKTOP_PORT=' + $env:BF_DESKTOP_PORT + ' (isolated instance)')
}
if ($DataRoot -ne '') {
  # BOSOM_FRIEND_HOME plays the role of the real ~/.bosom-friend: bin-desktop.ts resolves
  # DSH_HOME = BOSOM_FRIEND_HOME (launcher/src/bin-desktop.ts:20), and the product data root is
  # dshHomePath('bosom-friend') = <DSH_HOME>/bosom-friend (bundle/desktop/cordis.patch.yml:35).
  # 2026-10-13 fix (DEF-298): the old code set BOSOM_FRIEND_HOME one level too deep
  # (<DataRoot>/bosom-friend) and seeded settings.yaml only to <DataRoot>, so the runtime read
  # <DataRoot>/bosom-friend/settings.yaml, found no provider, and answered
  # "no adapter registered for provider bf-agnes-builtin". The layout now mirrors the real home.
  $env:DSH_HOME = $DataRoot
  $env:BOSOM_FRIEND_HOME = $DataRoot
  $dataRoot = Join-Path $DataRoot 'bosom-friend'
  New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
  New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
  # Three files must exist for the isolated instance to reach a model:
  #   settings.yaml / .credentials.yaml -> DSH home (provider registration + key reference)
  #   llm-user.json                      -> product data root (the user's model choice)
  $realHome = Join-Path $env:USERPROFILE '.bosom-friend'
  $seeds = @(
    @((Join-Path $realHome 'settings.yaml'), (Join-Path $env:DSH_HOME 'settings.yaml')),
    @((Join-Path $realHome '.credentials.yaml'), (Join-Path $env:DSH_HOME '.credentials.yaml')),
    @((Join-Path $realHome 'bosom-friend\llm-user.json'), (Join-Path $dataRoot 'llm-user.json'))
  )
  foreach ($pair in $seeds) {
    if ((Test-Path $pair[0]) -and -not (Test-Path $pair[1])) { Copy-Item $pair[0] $pair[1] -Force; Write-Host ('    seeded ' + $pair[1]) }
  }
  # Fail loud instead of starting an instance that cannot reach a model (that is how DEF-298 hid).
  $missing = @($seeds | Where-Object { -not (Test-Path $_[1]) } | ForEach-Object { $_[1] })
  if ($missing.Count -gt 0) { Write-Warning ('isolated instance will NOT reach a model; missing: ' + ($missing -join ', ')) }
  else { Write-Host '    seed check: settings.yaml / .credentials.yaml / llm-user.json present' }
  # The preset materialization above ran against the REAL home; re-run it for the isolated home so
  # $DSH_HOME/.agent-presets (roles/personas/skills) exists where this instance reads it.
  & node (Join-Path $repo 'products\bosom-friend\launcher\scripts\sync-presets.mjs') --quiet
  Write-Host ('==> DSH_HOME=' + $env:DSH_HOME + ' / BOSOM_FRIEND_HOME=' + $env:BOSOM_FRIEND_HOME + ' (isolated instance)')
}

Write-Host '==> start dev runtime (source, tsx)'
$env:CODEBUDDY_SAFE_DELETE_ENABLED = '0'
# Version authority: the packaged shell injects app.getVersion(); the source runtime injects
# the desktop package version here so the UI never falls back to a stale build-time number.
$desktopPkg = Join-Path $repo 'products\bosom-friend\desktop\package.json'
if (Test-Path $desktopPkg) {
  # -Encoding UTF8 is required: Windows PowerShell 5.1 reads files without BOM as ANSI, and this
  # package.json carries Chinese in "description" -- decoding it as ANSI breaks the JSON and the
  # whole start-up aborts before the server is even spawned.
  $env:BOSOM_FRIEND_VERSION = (Get-Content $desktopPkg -Raw -Encoding UTF8 | ConvertFrom-Json).version
  Write-Host ("==> BOSOM_FRIEND_VERSION=" + $env:BOSOM_FRIEND_VERSION)
}
# The runtime resolves the frontend dir relative to the SERVER MODULE ('../../../project/...'), and the
# source runtime loads the server from node_modules/.pnpm/<id>/node_modules/@deepseek-ai/<pkg>/lib/types,
# where that relative path lands on a directory that does not exist -> every page request answers
# "frontend not built". Point it at the built dist explicitly (same variable the packaged shell uses).
$env:BF_FRONTEND_DIST = Join-Path $repo 'products\bosom-friend\project\bosom-friend-electron\dist'
Write-Host ("==> BF_FRONTEND_DIST=" + $env:BF_FRONTEND_DIST)
# Same reasoning for ffmpeg: the source runtime loads the server from the pnpm injected copy, whose
# module depth does not match the two layouts the resolver assumed, so TTS duration probing failed
# with 'voice file written but duration unreadable (ffmpeg missing?)' and shots stopped.
# The kernel entry is resolved as <BF_KERNEL_ROOT>/runtime/bin-kernel.mjs; without it the client
# falls back to a repo path derived from the module location, and in the source runtime the server
# module lives inside node_modules/.pnpm/... -- that path does not exist, so every fresh long-video
# task died with 'DeepSeek Harness runtime is not running' (resume worked because it needs no LLM).
$kernelRoot = Join-Path $repo 'products\bosom-friend\bundle\kernel'
if (Test-Path (Join-Path $kernelRoot 'runtime\bin-kernel.mjs')) {
  $env:BF_KERNEL_ROOT = $kernelRoot
  Write-Host ("==> BF_KERNEL_ROOT=" + $env:BF_KERNEL_ROOT)
}
# The bundled ffmpeg can be overridden through FFMPEG_PATH; a caller-provided one is kept as-is.
# Measured on this machine: the copy under the project tree is blocked from writing (composition
# fails with Permission denied), while the same binary under the user profile works -- so the
# external injection point stays and moving ffmpeg never requires editing this script.
# This block must stay ASCII-only: Windows PowerShell 5.1 reads this file as ANSI (no BOM),
# and non-ASCII bytes here corrupt parsing ("Test-Path : ... argument is null", 2026-09-28).
$ffmpeg = Join-Path $repo 'products\bosom-friend\desktop\dist\runtime\ffmpeg.exe'
# Prefer a writable copy under the user profile. Measured 2026-10-11: the project-tree binary
# cannot write the data root on this machine (uploads ACL has no sandbox SID), so the slideshow
# fallback failed silently and short-video generation produced no playable file. The same binary
# under the profile works. Keep ASCII-only here (see the note above).
$writableFfmpeg = Join-Path $env:USERPROFILE '.bosom-friend\binaries\ffmpeg.exe'
if ($env:FFMPEG_PATH -and (Test-Path $env:FFMPEG_PATH)) {
  Write-Host ("==> FFMPEG_PATH=" + $env:FFMPEG_PATH + " (external)")
} elseif (Test-Path $writableFfmpeg) {
  $env:FFMPEG_PATH = $writableFfmpeg
  Write-Host ("==> FFMPEG_PATH=" + $env:FFMPEG_PATH + " (writable copy)")
} elseif (Test-Path $ffmpeg) {
  $env:FFMPEG_PATH = $ffmpeg
  Write-Host ("==> FFMPEG_PATH=" + $env:FFMPEG_PATH)
}
# Redirect logs so a failed start is diagnosable instead of silently disappearing.
$logSuffix = if ($Port -eq 31280) { '' } else { '.' + [string]$Port }
$outLog = Join-Path $repo ('dev-web' + $logSuffix + '.out.log')
$errLog = Join-Path $repo ('dev-web' + $logSuffix + '.err.log')
Start-Process -FilePath 'node' -ArgumentList '--import', 'tsx/esm', 'products/bosom-friend/launcher/src/bin-desktop.ts' -WorkingDirectory $repo -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden

# tsx cold start + kernel boot + tool registration takes 2-3 minutes on this machine.
$up = $false
for ($i = 0; $i -lt 150; $i++) {
  Start-Sleep -Seconds 2
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
}
if (-not $up) { throw ('dev runtime did not listen on ' + $Port + ' within 300s') }

try {
  $h = Invoke-WebRequest ('http://127.0.0.1:' + $Port + '/bosom-friend/') -UseBasicParsing -TimeoutSec 15
  Write-Host ("==> dev runtime ready: http://127.0.0.1:{0}/bosom-friend/ (HTTP {1})" -f $Port, $h.StatusCode)
}
catch {
  Write-Warning "dev runtime health check failed: $($_.Exception.Message)"
}
