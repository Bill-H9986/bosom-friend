<#
  Bosom Friend 现场修复（内核运行时解压失败）：一次做完 A + B。

  A = 开启 Windows 长路径支持（LongPathsEnabled=1，需要管理员，会弹一次 UAC）
  B = 用应用自带的 Node + kernel-unzip.cjs 把 resources\kernel-runtime.zip 解到
      %APPDATA%\Bosom Friend\kernel-runtime（走 \\?\ 前缀，不受 MAX_PATH 260 限制）

  为什么两件都要做：解压只需要 B；但内核进程（Node/Electron）**读取**运行时里超过 260 字符的
  路径同样需要 A。0.2.47 在这一步失败过两次（DEF-045 / DEF-055），详情见仓库
  docs/工程经验/02-启动链路与内核运行时.md。

  判定口径只有一个：%APPDATA%\Bosom Friend\kernel-runtime\runtime\bin-desktop.mjs 是否在位。
  它已经在位时不做任何多余动作（安装器解压成功后会删掉 zip，此时"zip 缺失"不是故障）。

  用法：双击同目录下的「修复内核运行时.cmd」，或
        powershell -NoProfile -ExecutionPolicy Bypass -File run-repair.ps1
  可选参数：
        -AppDir <安装目录>   默认 %LOCALAPPDATA%\Programs\Bosom Friend
        -UserData <数据目录> 默认 %APPDATA%\Bosom Friend
        -SkipRegistry        只做 B（不碰注册表，不弹 UAC）
        -NoStart             修好后不要自动启动应用
        -Force               运行时已存在也重新解压（需要 resources\kernel-runtime.zip 还在）

  解压阶梯、环境事实都在同目录的 repair-kernel-runtime.ps1（与仓库同一份，逐字复制），
  本脚本只负责 A（提权开长路径）、判定口径与收尾提示。
#>
[CmdletBinding()]
param(
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'Programs\Bosom Friend'),
  [string]$UserData = (Join-Path $env:APPDATA 'Bosom Friend'),
  [string]$UnzipScript = '',
  [switch]$SkipRegistry,
  [switch]$NoStart,
  [switch]$Force
)

$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($here)) { $here = (Get-Location).Path }
$marker = Join-Path (Join-Path $UserData 'kernel-runtime') 'runtime\bin-desktop.mjs'

Write-Output '=============================================='
Write-Output ' Bosom Friend 内核运行时修复（A 长路径 + B 解压）'
Write-Output '=============================================='
Write-Output ''

$ladder = Join-Path $here 'repair-kernel-runtime.ps1'
if (-not (Test-Path $ladder)) {
  Write-Output '失败：同目录缺少 repair-kernel-runtime.ps1（解压阶梯脚本），修复包不完整。'
  Write-Output '     请重新拷贝整个修复文件夹（不要只拷其中一个文件）。'
  exit 1
}
if ([string]::IsNullOrWhiteSpace($UnzipScript)) { $UnzipScript = Join-Path $here 'kernel-unzip.cjs' }
if (-not (Test-Path $UnzipScript)) {
  Write-Output '失败：同目录缺少 kernel-unzip.cjs（自带解压器），修复包不完整。'
  exit 1
}

<#  启动应用：只在运行时在位、且用户没要求 -NoStart 时做一次。#>
function Start-RepairedApp {
  if ($NoStart) { return }
  $exe = Join-Path $AppDir 'Bosom Friend.exe'
  if (Test-Path $exe) {
    Write-Output ''
    Write-Output '正在启动 Bosom Friend（首次启动还要装载内核，慢一点是正常的）…'
    Start-Process -FilePath $exe
  }
  else {
    Write-Output "没有找到 $exe，请从开始菜单启动 Bosom Friend。"
  }
}

# ---------- A：开启长路径支持（提权只做这一件事，解压留在当前窗口，用户能看到全过程）----------
$current = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
if ($null -eq $current) { $current = 0 }

if ($SkipRegistry) {
  Write-Output "[A] 已按 -SkipRegistry 跳过注册表设置（当前 LongPathsEnabled=$current）。"
}
elseif ($current -eq 1) {
  Write-Output '[A] 本机已开启长路径支持（LongPathsEnabled=1），无需改动。'
}
else {
  Write-Output "[A] 本机未开启长路径支持（LongPathsEnabled=$current），需要管理员权限开启，正在请求 UAC 授权…"
  Write-Output '    （只弹一次；拒绝也不影响下一步的解压，只是内核读取深路径文件仍有风险）'
  try {
    $elevated = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -Type DWord -Force"
    )
    $current = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
    if ($null -eq $current) { $current = 0 }
    if ($current -eq 1) {
      Write-Output '[A] 已开启：LongPathsEnabled=1（该值按进程缓存，修好后请完全退出应用再启动；保险起见可重启一次系统）'
    }
    else {
      Write-Output "[A] 没能写入（提权窗口退出码 $($elevated.ExitCode)）。可以稍后手动执行："
      Write-Output '    reg add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f'
    }
  }
  catch {
    Write-Output "[A] 未获得管理员授权（$($_.Exception.Message)）。继续执行 B；如果之后内核仍启动失败，"
    Write-Output '    请用管理员身份重新运行本修复，或手动执行：'
    Write-Output '    reg add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f'
  }
}
Write-Output ''

# ---------- B：判定位 → 解压 ----------
if ((Test-Path $marker) -and (-not $Force)) {
  Write-Output '[B] 内核运行时本来就在位，无需解压。'
  Write-Output "    $marker"
  Start-RepairedApp
  exit 0
}

& $ladder -AppDir $AppDir -UserData $UserData -UnzipScript $UnzipScript -Force:$Force
$ladderCode = $LASTEXITCODE
Write-Output ''

if (-not (Test-Path $marker)) {
  Write-Output "修复未完成（解压阶梯退出码 $ladderCode，运行时入口仍不在位）。"
  Write-Output '请把上面的完整输出、以及 %APPDATA%\Bosom Friend\kernel-extract.log（如果存在）发给开发者。'
  exit 1
}

if ($ladderCode -ne 0) {
  Write-Output "注意：解压阶梯退出码 $ladderCode。上面那句 FAIL 通常是 resources\kernel-runtime.zip 已经被删掉"
  Write-Output '      （安装期解压成功才会删），但内核运行时现在确实在位，所以不需要再做别的。'
}
Write-Output '修复完成：内核运行时就位。'
Write-Output "  $marker"
Start-RepairedApp
exit 0
