$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\Jay\Desktop\Bosom friend APP'
"== 1/8 build server + kernel packages =="
pnpm --filter @deepseek-ai/dsh-bosom-friend-server --filter @deepseek-ai/dsh-bosom-friend-kernel build
"== 2/8 sync lib into the kernel runtime =="
# pnpm 11 materializes the runtime by deploying products/bosom-friend/bundle/kernel. It links
# only the deploy root's DIRECT dependencies under node_modules\@deepseek-ai (measured: 130
# packages); everything else - including the server, which dsh-bosom-friend-kernel pulls in -
# lives in the .pnpm virtual store. Sync into every physical copy that exists:
#   node_modules\@deepseek-ai\<pkg>\lib                            (top-level link, if any)
#   node_modules\.pnpm\<dir>\node_modules\@deepseek-ai\<pkg>\lib (the real copies)
#   node_modules\.pnpm\node_modules\@deepseek-ai\<pkg>\lib       (public hoist link)
# Copies are matched by CONTENT (the package's own lib dir), never by directory name: pnpm
# shortens long names to "@deepseek-ai+dsh-bosom-frie_<hash>", so a name filter matches nothing.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# and non-ASCII bytes here break parsing (they silently shift line numbers).
$runtime = 'products\bosom-friend\desktop\dist\kernel-runtime-unpacked'
$runtimeScope = Join-Path $runtime 'node_modules\@deepseek-ai'
$runtimeStore = Join-Path $runtime 'node_modules\.pnpm'
foreach ($pkg in @(
  @{ name = 'dsh-bosom-friend-server'; src = 'products\bosom-friend\server\lib' },
  @{ name = 'dsh-bosom-friend-kernel'; src = 'products\bosom-friend\kernel\lib' }
)) {
  $candidates = New-Object System.Collections.Generic.List[string]
  $direct = Join-Path $runtimeScope $pkg.name
  if (Test-Path (Join-Path $direct 'lib')) { $candidates.Add($direct) }
  if (Test-Path $runtimeStore) {
    foreach ($dir in Get-ChildItem $runtimeStore -Directory -ErrorAction SilentlyContinue) {
      $pkgDir = Join-Path $dir.FullName ('node_modules\@deepseek-ai\' + $pkg.name)
      if (Test-Path (Join-Path $pkgDir 'lib')) { $candidates.Add($pkgDir) }
    }
    $hoistedDir = Join-Path $runtimeStore ('node_modules\@deepseek-ai\' + $pkg.name)
    if (Test-Path (Join-Path $hoistedDir 'lib')) { $candidates.Add($hoistedDir) }
  }
  # A directory junction carries the ReparsePoint attribute and points at the same physical
  # files as one real copy. Writing through all of them copies one file several times in a
  # row and Windows starts failing with 'being used by another process' (measured 2026-09-16).
  # Keep the real copies; fall back to the junctions only if no real copy exists.
  $targets = @($candidates | Where-Object { ((Get-Item $_).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 })
  if ($targets.Count -eq 0) { $targets = $candidates }
  if ($targets.Count -eq 0) { throw "the kernel runtime holds no $($pkg.name) copy; deploy the kernel bundle first" }
  foreach ($pkgDir in $targets) {
    $destLib = Join-Path $pkgDir 'lib'
    # pnpm hard-links the deployed files to the workspace build output (measured nlink = 10 on
    # 2026-09-16: one inode shared by server/lib, several .pnpm copies and the runtime).
    # Copy-Item -Force onto such a file fails with 'being used by another process' because
    # source and destination are the same file, so drop the destination entries first --
    # Remove-Item only unlinks this name, the build output keeps its content.
    if (Test-Path $destLib) { Remove-Item $destLib -Recurse -Force }
    # The directory must exist before copying: with a single-file source directory
    # (kernel/lib holds only index.js) Copy-Item -Destination <missing path> creates a FILE
    # named 'lib' instead of a directory, and the runtime then fails with
    # Cannot find module '...\dsh-bosom-friend-kernel\lib\index.js' (measured 2026-09-16).
    New-Item -ItemType Directory -Path $destLib -Force | Out-Null
    Copy-Item -Path (Join-Path $pkg.src '*') -Destination $destLib -Recurse -Force
    "  synced $($pkg.name) <- $($pkg.src) ($pkgDir)"
  }
}
"== 3/8 verify runtime dependencies =="
# Step 2 syncs CODE (lib) only, never DEPENDENCIES: the runtime is the product of an
# earlier materialization (pnpm deploy). Measured 2026-09-14: after the server gained
# msedge-tts the package was absent from the runtime, the kernel died with
# ERR_MODULE_NOT_FOUND, and the installed app could not open at all while step 2
# reported success. The check resolves every server dependency the way Node does,
# starting from each physical copy of the server.
# Parsing package.json is left to Node: Windows PowerShell 5.1 ConvertFrom-Json throws on
# this file, and the check must not depend on which PowerShell host runs the build.
node 'products\bosom-friend\desktop\verify-runtime-deps.mjs' 'C:\Users\Jay\Desktop\Bosom friend APP'
if ($LASTEXITCODE -ne 0) { throw 'kernel runtime is missing server dependencies (see message above)' }
"  runtime dependencies OK"
# The runtime loads cordis.patch.yml from each bundle. Injected workspace packages are keyed by
# (name, version, peers), so an edited config keeps its OLD content until the package version
# changes and pnpm install runs -- the runtime then silently boots the previous config
# (DEF-060). Compare bytes and versions against the workspace before packing.
node 'products\bosom-friend\desktop\verify-runtime-config-drift.mjs' 'C:\Users\Jay\Desktop\Bosom friend APP'
if ($LASTEXITCODE -ne 0) { throw 'the runtime carries stale bundle config (bump the bundle version, run pnpm install, redeploy)' }
"  runtime config drift OK"
"== 4/8 assemble the portable platform engine =="
& powershell -NoProfile -ExecutionPolicy Bypass -File 'products\bosom-friend\desktop\build-engine-portable.ps1'
"== 5/8 repack kernel-runtime.zip =="
# repack_kernel.py used to live in dist\, a build-output directory that cleanup actions
# delete wholesale; it was already gone when 0.2.43 was built on 2026-09-14. It now lives
# in desktop\ and receives dist\ as the data directory to pack. Paths are absolute on
# purpose: this file must stay ASCII-only because Windows PowerShell 5.1 reads a BOM-less
# .ps1 as ANSI, and non-ASCII bytes here silently break parsing (learned the hard way).
$repoRoot = 'C:\Users\Jay\Desktop\Bosom friend APP'
$distDir = Join-Path $repoRoot 'products\bosom-friend\desktop\dist'
& "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" (Join-Path $repoRoot 'products\bosom-friend\desktop\repack_kernel.py') $distDir
if ($LASTEXITCODE -ne 0) { throw "repack_kernel.py failed with exit=$LASTEXITCODE" }
$newZip = Join-Path $distDir 'kernel-runtime.zip.new'
if (-not (Test-Path $newZip)) { throw 'repack produced no kernel-runtime.zip.new' }
"== 6/8 boot the kernel from the extracted new zip =="
# The zip is what reaches the user machine, and zip cannot store the directory junctions pnpm
# deploys with, so the source tree can look perfect while the extracted runtime is not.
# Measured 2026-09-16: a 24741-entry zip extracted to a runtime whose top-level packages held
# only .bin, and the kernel died on Cannot find package 'js-yaml'. Extract the way the
# installer does (tar.exe) and answer a real initialize handshake from the extracted copy,
# which is the only evidence that matters.
$extractDir = Join-Path $distDir 'kernel-runtime-extract-check'
if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
New-Item -ItemType Directory -Path $extractDir | Out-Null
& "$env:SystemRoot\System32\tar.exe" -xf $newZip -C $extractDir
if ($LASTEXITCODE -ne 0) { throw "tar.exe could not extract the new zip (exit=$LASTEXITCODE)" }
node (Join-Path $repoRoot 'products\bosom-friend\qa\probes\handshake-kernel.mjs') $extractDir
$handshake = $LASTEXITCODE
Remove-Item $extractDir -Recurse -Force
if ($handshake -ne 0) { throw 'the extracted kernel runtime failed the initialize handshake (see message above)' }
"== 7/8 swap in the new zip =="
Set-Location $distDir
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Move-Item kernel-runtime.zip ("kernel-runtime.zip.bak-" + $stamp) -Force
Move-Item kernel-runtime.zip.new kernel-runtime.zip -Force
"zip size MB=" + [math]::Round((Get-Item kernel-runtime.zip).Length/1MB,1)
Set-Location $repoRoot
"== 8/8 rebuild the installer =="
& 'C:\Program Files\Git\bin\bash.exe' -lc "cd '/c/Users/Jay/Desktop/Bosom friend APP/products/bosom-friend/desktop' && bash build-win.sh"
"DONE"
