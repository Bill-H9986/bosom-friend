$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\Jay\Desktop\Bosom friend APP'

# ---- packaging authorization gate (HARD RULE, never remove) ----
# Product owner, 2026-10-12: "Do NOT package without my explicit command!"
# No automation -- including any AI agent -- may start a build on its own.
# The gate exists because an agent tried to package while the product was far
# from done. Two deliberate ways to authorize, both owned by the product owner:
#   a) set env BF_PACKAGE_AUTHORIZED=yes
#   b) create products/bosom-friend/.package-authorized (owner + timestamp inside)
$bfAuthFile = Join-Path $PSScriptRoot '..\.package-authorized'
if ($env:BF_PACKAGE_AUTHORIZED -ne 'yes' -and -not (Test-Path -LiteralPath $bfAuthFile)) {
  Write-Host ''
  Write-Host 'BLOCKED: packaging is NOT authorized.'
  Write-Host '  Hard rule: do not package without the product owner explicit command.'
  Write-Host '  Nothing is broken -- the build simply refuses to start.'
  Write-Host '  To authorize (product owner only):'
  Write-Host '    a) $env:BF_PACKAGE_AUTHORIZED = "yes"  then re-run'
  Write-Host '    b) create products/bosom-friend/.package-authorized'
  Write-Host ''
  exit 3
}

# ---- free-space gate (DEF-284, decided by the product owner 2026-10-12) ----
# The first packaging attempt of that day died on a full disk halfway through.
# A build needs room for: engine-portable (~1.9 GB), the flattened kernel runtime
# tree, win-unpacked (~1.3 GB) and the NSIS output (~0.8 GB) -- about 4.5 GB.
# 6 GB leaves headroom; below that the build cannot finish, so refuse to start.
$bfNeedGB = 6
$bfFreeGB = [math]::Round((Get-PSDrive C).Free / 1GB, 2)
if ($bfFreeGB -lt $bfNeedGB) {
  Write-Host ''
  Write-Host "BLOCKED: not enough free space on C: ($bfFreeGB GB free, need >= $bfNeedGB GB)."
  Write-Host '  A previous build died on a full disk halfway through (DEF-284).'
  Write-Host '  Free space first -- never start a build that cannot finish.'
  Write-Host ''
  exit 4
}
Write-Host "  free space on C: $bfFreeGB GB (need >= $bfNeedGB GB) -- OK"

# 「先测试，再打包」（2026-10-12 产品负责人要求）：门禁红了就拒绝打包。
# 这一层挡的是"把本该在开发版上发现的问题带进 773 MB 的安装包"——2026-10-12 凌晨
# 连打十代包（0.3.0 -> 0.3.9）就是这么来的：每代打完装机再发现问题，再改、再打。
"== 0/9 pre-package gate (test first, package once) =="
# Reuse a gate run that just passed (BF_PRE_PACKAGE_GATE=done, set by the caller in the same
# delivery): same code, same machine, minutes old. Without it the gate always runs -- reuse is
# the exception, not the default. ASCII only: PS 5.1 reads a BOM-less .ps1 as ANSI.
if ($env:BF_PRE_PACKAGE_GATE -ne 'done') {
  node 'products\bosom-friend\qa\verify-before-package.mjs'
  if ($LASTEXITCODE -ne 0) { throw 'pre-package gate failed: fix the red items on the dev build first (packaging is not a test)' }
} else {
  "  (reusing the gate run that just passed: BEFORE_PACKAGE_GATE PASS)"
}
$env:BF_PRE_PACKAGE_GATE = 'done'
"== 1/9 build server + kernel packages =="
pnpm --filter @deepseek-ai/dsh-bosom-friend-server --filter @deepseek-ai/dsh-bosom-friend-kernel build
# The kernel bundles its dependencies from SOURCE, and pnpm injects workspace packages as HARD
# LINKS: rewriting a file replaces the inode, breaks the link, and pnpm install then sees an
# unchanged length/mtime and does NOT repair it. Measured 2026-09-21: the injected store.ts was
# 6 days stale, esbuild emitted a 36.2 kB bundle without the fixes (correct: 39.8 kB), and
# nothing failed until a byte-level probe of the artifact. Fail the build instead.
node 'products\bosom-friend\desktop\verify-kernel-bundle-freshness.mjs'
if ($LASTEXITCODE -ne 0) { throw 'the kernel bundle is older than its sources (stale injected copies; see message above)' }
"  kernel bundle freshness OK"
"== 2/9 sync lib into the kernel runtime =="
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
# The desktop bundle carries no lib/: its runtime content IS cordis.patch.yml (the listen host, the
# port, the plugin layers). The runtime loads it through require.resolve(<pkg>/cordis.patch.yml),
# so a stale copy silently changes what the packaged app boots -- measured 2026-09-17: the
# remote-access bind switch was saved as 0.0.0.0 while the socket stayed on 127.0.0.1.
# Candidate detection keys on package.json, NOT on the patch: the patch is exactly the file that can
# be missing. Measured 2026-09-17: the runtime copy held only package.json, so a patch-based test
# found no candidates, this block was a silent no-op, and verify-runtime-config-drift.mjs failed the
# build two steps later with 'runtime is missing cordis.patch.yml'.
$bundleSrc = 'products\bosom-friend\bundle\desktop\cordis.patch.yml'
$bundleCandidates = New-Object System.Collections.Generic.List[string]
$bundleDirect = Join-Path $runtimeScope 'dsh-bosom-friend-desktop-bundle'
if (Test-Path (Join-Path $bundleDirect 'package.json')) { $bundleCandidates.Add($bundleDirect) }
if (Test-Path $runtimeStore) {
  foreach ($dir in Get-ChildItem $runtimeStore -Directory -ErrorAction SilentlyContinue) {
    $pkgDir = Join-Path $dir.FullName 'node_modules\@deepseek-ai\dsh-bosom-friend-desktop-bundle'
    if (Test-Path (Join-Path $pkgDir 'package.json')) { $bundleCandidates.Add($pkgDir) }
  }
  $bundleHoisted = Join-Path $runtimeStore 'node_modules\@deepseek-ai\dsh-bosom-friend-desktop-bundle'
  if (Test-Path (Join-Path $bundleHoisted 'package.json')) { $bundleCandidates.Add($bundleHoisted) }
}
$bundleTargets = @($bundleCandidates | Where-Object { ((Get-Item $_).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 })
if ($bundleTargets.Count -eq 0) { $bundleTargets = $bundleCandidates }
if ($bundleTargets.Count -eq 0) { throw 'the kernel runtime holds no desktop-bundle copy; deploy the kernel bundle first' }
foreach ($pkgDir in $bundleTargets) {
  # File::Copy with absolute paths: Copy-Item's provider layer rejected the destination with
  # "Illegal characters in path" (ItemExistsArgumentError) on paths carrying '+', which the
  # .pnpm store uses. The BCL call has no wildcard/provider semantics at all.
  $destPatch = [System.IO.Path]::GetFullPath((Join-Path $pkgDir 'cordis.patch.yml'))
  # pnpm deploy HARD-LINKS the workspace file into the runtime, so the destination often IS the
  # source: copying a file onto its own hard link makes Windows answer "being used by another
  # process" and the whole rebuild aborts at step 2 (measured 2026-09-23, right after the first
  # deploy that re-materialized the runtime). Content is already identical in that case, so skip;
  # an independent copy gets replaced (delete first: overwriting in place hits the same sharing
  # rule when the file is open for reading).
  $srcPath = (Resolve-Path $bundleSrc).Path
  $sameFile = $false
  try {
    $destItem = Get-Item $destPatch -ErrorAction Stop
    $sameFile = ($destItem.LinkType -eq 'HardLink') -and (@($destItem.Target) -contains $srcPath)
  } catch { $sameFile = $false }
  if ($sameFile) {
    # 已经是同一个 inode（deploy 的硬链接）：内容必然一致，不复制。
  } else {
    if (Test-Path $destPatch) { Remove-Item $destPatch -Force }
    [System.IO.File]::Copy($srcPath, $destPatch, $true)
  }
  if (-not (Test-Path $destPatch)) { throw "desktop-bundle patch did not land at $destPatch" }
  "  synced desktop-bundle/cordis.patch.yml ($pkgDir)"
}
# The kernel bundle's OWN cordis.patch.yml is runtime config as well: it carries the product tool
# surface (which inherited rows are disabled) and the agent-instructions override. The runtime
# loads it through require.resolve('@deepseek-ai/dsh-bosom-friend-kernel/cordis.patch.yml').
# Measured 2026-09-22: nothing synced it. Every runtime copy still held a 1243-byte pre-convergence
# patch while the source was 3292 bytes, so an installer built from this tree would still hand the
# model pwsh/read/write/subagent and let this repository's own AGENTS.md into product sessions.
# Candidate detection keys on package.json for the same reason as the block above.
$kernelPatchSrc = 'products\bosom-friend\kernel\cordis.patch.yml'
$kernelPatchText = (Get-Content $kernelPatchSrc -Raw)
$kernelCandidates = New-Object System.Collections.Generic.List[string]
$kernelDirect = Join-Path $runtimeScope 'dsh-bosom-friend-kernel'
if (Test-Path (Join-Path $kernelDirect 'package.json')) { $kernelCandidates.Add($kernelDirect) }
if (Test-Path $runtimeStore) {
  foreach ($dir in Get-ChildItem $runtimeStore -Directory -ErrorAction SilentlyContinue) {
    $pkgDir = Join-Path $dir.FullName 'node_modules\@deepseek-ai\dsh-bosom-friend-kernel'
    if (Test-Path (Join-Path $pkgDir 'package.json')) { $kernelCandidates.Add($pkgDir) }
  }
  $kernelHoisted = Join-Path $runtimeStore 'node_modules\@deepseek-ai\dsh-bosom-friend-kernel'
  if (Test-Path (Join-Path $kernelHoisted 'package.json')) { $kernelCandidates.Add($kernelHoisted) }
}
$kernelTargets = @($kernelCandidates | Where-Object { ((Get-Item $_).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 })
if ($kernelTargets.Count -eq 0) { $kernelTargets = $kernelCandidates }
if ($kernelTargets.Count -eq 0) { throw 'the kernel runtime holds no dsh-bosom-friend-kernel copy; deploy the kernel bundle first' }
foreach ($pkgDir in $kernelTargets) {
  $destPatch = [System.IO.Path]::GetFullPath((Join-Path $pkgDir 'cordis.patch.yml'))
  # Same hard-link rule as the desktop-bundle block above: after a fresh pnpm deploy the destination
  # IS the source inode, and copying a file onto its own hard link fails with "being used by another
  # process" (measured 2026-09-23 at the kernel patch step, right after the desktop-bundle one).
  $kernelPatchSrcPath = (Resolve-Path $kernelPatchSrc).Path
  $kernelSameFile = $false
  try {
    $destItem = Get-Item $destPatch -ErrorAction Stop
    $kernelSameFile = ($destItem.LinkType -eq 'HardLink') -and (@($destItem.Target) -contains $kernelPatchSrcPath)
  } catch { $kernelSameFile = $false }
  if (-not $kernelSameFile) {
    if (Test-Path $destPatch) { Remove-Item $destPatch -Force }
    [System.IO.File]::Copy($kernelPatchSrcPath, $destPatch, $true)
  }
  # Fail loud on a stale copy: this file decides what the packaged kernel mounts, and a silent
  # mismatch stays invisible until a user's model starts running shell commands on their machine.
  if ((Get-Content $destPatch -Raw) -ne $kernelPatchText) { throw "kernel patch did not land at $destPatch" }
  "  synced kernel/cordis.patch.yml ($pkgDir)"
}
$repoRoot = 'C:\Users\Jay\Desktop\Bosom friend APP'
$distDir = Join-Path $repoRoot 'products\bosom-friend\desktop\dist'
$flatRuntime = Join-Path $distDir 'kernel-runtime-flat'
$python = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
"== 3/9 flatten the deployed runtime into the packaging source =="
# 部署产物里几乎全是目录联接点（实测 32514 个条目里 26322 个是链接，真实文件 1098 个 /
# 22.6 MB）。zip 存不了联接点，所以压缩源必须是「每个包名一份真实文件」的扁平树。
# 直接在部署产物上展开实测 171762 个条目 / 419 MB zip / 1265 秒；扁平树是
# 23291 个条目 / 62.5 MB zip / 17 秒（同一把压缩参数）。
# The flat tree is the packaging source, and it is where a stale runtime silently wins: step 2
# syncs the freshly built lib into kernel-runtime-unpacked, but only the flat tree reaches the zip.
# A flat tree left over from an earlier build keeps its old server code, and its parent directory's
# timestamp does not move when only file contents change, so "does it look old?" cannot answer this.
# Measured 2026-09-21 twice: an installer shipped a NEW frontend with an OLD server, so every
# server-side fix was absent on the user's machine while the build reported DONE. The first repair
# compared one hardcoded symbol, which only protected the change it was written for and missed the
# next one. So: always rebuild the flat tree from the synced deployment. It costs about a minute.
# If this ever becomes too slow, replace it with a full recursive comparison against server/lib --
# never with a sampled symbol check.
# 更早的一道同义信号：部署树里若是旧的构建产物，扁平树就会把旧代码带进 zip。
# （第 4 步的逐字节比对保护的是**扁平树**；这一道在 flatten 之前就判红，少花一分钟、也覆盖
#   "只跑一部分流程"的场景——例如直接对部署树做验收探针。）
node 'products\bosom-friend\desktop\verify-runtime-lib-freshness.mjs' $repoRoot (Join-Path $distDir 'kernel-runtime-unpacked')
if ($LASTEXITCODE -ne 0) { throw 'the deployment runtime carries stale build output (re-run the lib sync step before packaging)' }
"  deployment runtime lib freshness OK"
if (Test-Path $flatRuntime) { Remove-Item $flatRuntime -Recurse -Force }
& $python (Join-Path $repoRoot 'products\bosom-friend\desktop\flatten_kernel_tree.py') (Join-Path $distDir 'kernel-runtime-unpacked') $flatRuntime
if ($LASTEXITCODE -ne 0) { throw "flatten_kernel_tree.py failed with exit=$LASTEXITCODE" }
# Prove the flat tree carries what step 1 just built: every byte of the server's lib must match.
$builtLib = Join-Path $repoRoot 'products\bosom-friend\server\lib'
$flatLib = Join-Path $flatRuntime 'node_modules\@deepseek-ai\dsh-bosom-friend-server\lib'
if (-not (Test-Path $flatLib)) { throw "flat runtime has no dsh-bosom-friend-server lib: $flatLib" }
$builtFiles = Get-ChildItem $builtLib -Recurse -File
$mismatched = 0
foreach ($file in $builtFiles) {
  $rel = $file.FullName.Substring($builtLib.Length).TrimStart('\')
  $dest = Join-Path $flatLib $rel
  if (-not (Test-Path $dest)) { $mismatched += 1; continue }
  if ((Get-FileHash $file.FullName -Algorithm SHA256).Hash -ne (Get-FileHash $dest -Algorithm SHA256).Hash) { $mismatched += 1 }
}
if ($mismatched -gt 0) { throw "flat runtime differs from the freshly built server lib in $mismatched file(s); the package would ship stale server code" }
"  flat runtime matches the freshly built server lib byte for byte ($($builtFiles.Count) files)"
"== 4/9 verify the packaging source =="
# 核对的是**压缩源**（扁平树）：只有扁平树的内容会到用户机器上，部署产物的联接点不会。
# Step 2 syncs CODE (lib) only, never DEPENDENCIES: the runtime is the product of an
# earlier materialization (pnpm deploy). Measured 2026-09-14: after the server gained
# msedge-tts the package was absent from the runtime, the kernel died with
# ERR_MODULE_NOT_FOUND, and the installed app could not open at all while step 2
# reported success. The check resolves every server dependency the way Node does.
# Parsing package.json is left to Node: Windows PowerShell 5.1 ConvertFrom-Json throws on
# this file, and the check must not depend on which PowerShell host runs the build.
node 'products\bosom-friend\desktop\verify-runtime-deps.mjs' $repoRoot $flatRuntime
if ($LASTEXITCODE -ne 0) { throw 'kernel runtime is missing server dependencies (see message above)' }
"  runtime dependencies OK"
# The runtime loads cordis.patch.yml from each bundle. Injected workspace packages are keyed by
# (name, version, peers), so an edited config keeps its OLD content until the package version
# changes and pnpm install runs -- the runtime then silently boots the previous config
# (DEF-060). Compare bytes and versions against the workspace before packing.
node 'products\bosom-friend\desktop\verify-runtime-config-drift.mjs' $repoRoot $flatRuntime
if ($LASTEXITCODE -ne 0) { throw 'the runtime carries stale bundle config (bump the bundle version, run pnpm install, redeploy)' }
"  runtime config drift OK"
# 日志模块必须在包里，而且必须真的被用上：DEF-101 的根因不是"写错了日志"，而是没有任何东西
# 检查日志有没有进包——装机 app.asar 里搜不到 logger/appendFile，现场三侧全都无迹可查。
# 缺文件不会报错，所以这条必须在出包前判红（与 build-win.sh 的前置检查同一份实现）。
node 'products\bosom-friend\desktop\verify-electron-logging.mjs'
if ($LASTEXITCODE -ne 0) { throw 'desktop logging module is missing or unwired (see message above)' }
"  electron logging OK"
"== 5/9 assemble the portable platform engine =="
& powershell -NoProfile -ExecutionPolicy Bypass -File 'products\bosom-friend\desktop\build-engine-portable.ps1'
"== 6/9 zip the flat tree =="
# repack_kernel.py used to live in dist\, a build-output directory that cleanup actions
# delete wholesale; it was already gone when 0.2.43 was built on 2026-09-14. It now lives
# in desktop\ and receives dist\ plus the flat tree to compress.
& $python (Join-Path $repoRoot 'products\bosom-friend\desktop\repack_kernel.py') $distDir $flatRuntime
if ($LASTEXITCODE -ne 0) { throw "repack_kernel.py failed with exit=$LASTEXITCODE" }
$newZip = Join-Path $distDir 'kernel-runtime.zip.new'
if (-not (Test-Path $newZip)) { throw 'repack produced no kernel-runtime.zip.new' }
"== 7/9 boot the kernel from the extracted new zip =="
# The zip is what reaches the user machine. Extract the way the installer does (tar.exe) and
# answer a real initialize handshake from the extracted copy, which is the only evidence
# that matters.
$extractDir = Join-Path $distDir 'kernel-runtime-extract-check'
if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
New-Item -ItemType Directory -Path $extractDir | Out-Null
& "$env:SystemRoot\System32\tar.exe" -xf $newZip -C $extractDir
if ($LASTEXITCODE -ne 0) { throw "tar.exe could not extract the new zip (exit=$LASTEXITCODE)" }
node (Join-Path $repoRoot 'products\bosom-friend\qa\probes\handshake-kernel.mjs') $extractDir
$handshake = $LASTEXITCODE
Remove-Item $extractDir -Recurse -Force
if ($handshake -ne 0) { throw 'the extracted kernel runtime failed the initialize handshake (see message above)' }
"== 8/9 swap in the new zip =="
Set-Location $distDir
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
# 2026-10-12 fix: the previous zip may not exist (first build, or dist/ was cleaned).
# The unconditional Move-Item aborted the whole run with PathNotFound -- even though the
# new zip was already built in step 6, wasting a full pass. The backup is defensive, not
# required: skip it when there is nothing to back up.
if (Test-Path kernel-runtime.zip) {
  Move-Item kernel-runtime.zip ("kernel-runtime.zip.bak-" + $stamp) -Force
} else {
  "  no previous kernel-runtime.zip to back up (first build or dist was cleaned) -- skip"
}
Move-Item kernel-runtime.zip.new kernel-runtime.zip -Force
"zip size MB=" + [math]::Round((Get-Item kernel-runtime.zip).Length/1MB,1)
Set-Location $repoRoot
"== 9/9 rebuild the installer =="
& 'C:\Program Files\Git\bin\bash.exe' -lc "cd '/c/Users/Jay/Desktop/Bosom friend APP/products/bosom-friend/desktop' && bash build-win.sh"
"DONE"
# 把仓库的 presets/ 物化到运行期 home（2026-10-12）：装机链路也要保证运行期副本与源一致，
# 否则装出来的 APP 用的是旧工具面（内核读运行期副本，不读仓库）。
& node (Join-Path $PSScriptRoot '..\launcher\scripts\sync-presets.mjs')
