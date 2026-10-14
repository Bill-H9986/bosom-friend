<#
.SYNOPSIS
  收集 Bosom Friend 桌面版"整个 App"的运行日志（诊断用，一键打包）。
.DESCRIPTION
  收集内容：
    1. Electron userData\logs\YYYY-MM-DD.log —— 主进程 + 后端/内核 stdout/stderr（electron-log 按天，10MB 滚动）
    2. userData\知音知识库\运行逻辑\运行事件日志.md —— 智能体事件流
    3. ~\.bosom-friend\bosom-friend\ —— ai-logs.json / contents.json / long-video-tasks.json / sessions.json / logs\llm-config-audit.log 等
    4. ~\.bosom-friend\sessions\**\session.jsonl.zstd —— 内核智能体会话（消息、工具调用、模型用量）
    5. %LOCALAPPDATA%\Bosom Friend\app.log、进程/端口/环境快照
  刻意跳过 node_modules、浏览器配置、上传/视频等大目录；llm-user.json 已脱敏密钥。
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File collect-app-logs.ps1
  powershell -ExecutionPolicy Bypass -File collect-app-logs.ps1 -OutDir D:\tmp -NoZip
#>
param(
  [string]$OutDir = [Environment]::GetFolderPath('Desktop'),
  [switch]$NoZip
)
$ErrorActionPreference = 'SilentlyContinue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest  = Join-Path $OutDir ("BosomFriend-logs-" + $stamp)
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$manifest = New-Object System.Collections.Generic.List[string]
function Note([string]$m) { $manifest.Add($m); Write-Host $m }

# 大目录一律不收集：依赖、浏览器配置、媒体产物
$EXCLUDE_DIRS = @('node_modules', '.git', 'backups', 'backups-held', 'uploads', 'long-video',
                  'voice-previews', 'platform-login', 'browserProfiles', '知音素材库', 'tmp-agent-media')

# 用 robocopy 复制（大目录稳、可按扩展名过滤）；失败退回 Copy-Item
function CopyTree {
  param([string]$Src, [string]$Sub, [string[]]$Files = @('*'))
  if (-not (Test-Path -LiteralPath $Src)) { return }
  $target = Join-Path $dest $Sub
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  $rc = $null
  if (Get-Command robocopy.exe -ErrorAction SilentlyContinue) {
    $rcArgs = @($Src, $target) + $Files + @('/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    foreach ($d in $EXCLUDE_DIRS) { $rcArgs += @('/XD', (Join-Path $Src $d), $d) }
    & robocopy.exe @rcArgs | Out-Null
    $rc = $LASTEXITCODE
  }
  $copied = @(Get-ChildItem -LiteralPath $target -Recurse -File -Force)
  if ($copied.Count -eq 0) { return }
  $bytes = 0; foreach ($c in $copied) { $bytes += $c.Length }
  Note ("  + " + $Sub + "   files=" + $copied.Count + "  MB=" + [math]::Round($bytes / 1MB, 1) + "  robocopy=" + $rc)
}

function CopyOne {
  param([string]$Src, [string]$Sub, [switch]$MaskKeys)
  if (-not (Test-Path -LiteralPath $Src)) { return }
  $target = Join-Path $dest $Sub
  New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($target)) | Out-Null
  if ($MaskKeys) {
    $text = Get-Content -LiteralPath $Src -Raw
    $text = [regex]::Replace($text, '("(?:apiKey|imageApiKey|videoApiKey|token|cookie|password)"\s*:\s*")[^"]*"', '$1***"')
    Set-Content -LiteralPath $target -Value $text -Encoding UTF8
  } else {
    Copy-Item -LiteralPath $Src -Destination $target -Force
  }
  Note ("  + " + $Sub + "   bytes=" + (Get-Item -LiteralPath $target).Length)
}

Note ("# Bosom Friend 运行日志采集  " + (Get-Date).ToString('s'))
Note ("# 主机=" + $env:COMPUTERNAME + "  用户=" + $env:USERNAME)
Note ("# 输出=" + $dest)

# 1) Electron userData：主进程+后端 stdout/stderr、运行事件日志、配置快照
$userDataRoots = @(
  (Join-Path $env:APPDATA 'zhiyin'),
  (Join-Path $env:APPDATA 'Bosom Friend'),
  (Join-Path $env:APPDATA 'bosom-friend-desktop'),
  (Join-Path $env:APPDATA 'bosom-friend-app'),
  (Join-Path $env:LOCALAPPDATA 'Bosom Friend')
)
foreach ($ud in $userDataRoots) {
  if (-not (Test-Path -LiteralPath $ud)) { continue }
  $tag = 'userData-' + [System.IO.Path]::GetFileName($ud).Replace(' ', '_')
  Note ("[userData] " + $ud)
  CopyTree (Join-Path $ud 'logs') ($tag + '/logs') @('*.log')
  CopyTree (Join-Path $ud '知音知识库') ($tag + '/知音知识库') @('*.md')
  CopyOne  (Join-Path $ud 'config.json') ($tag + '/config.json') -MaskKeys
  CopyOne  (Join-Path $ud 'backend-config.json') ($tag + '/backend-config.json')
}

# 2) 产品数据根 ~\.bosom-friend（AI 日志、内容、任务、LLM 审计、诊断日志）
$dataRoot = Join-Path $env:USERPROFILE '.bosom-friend'
Note ("[dataRoot] " + $dataRoot)
CopyTree (Join-Path $dataRoot 'bosom-friend') 'data/bosom-friend' @('*.json', '*.jsonl', '*.log', '*.md')
CopyOne (Join-Path $dataRoot 'bosom-friend\llm-user.json') 'data/bosom-friend/llm-user.masked.json' -MaskKeys

# 3) 内核智能体会话（每次对话 / 工具调用 / 模型用量的完整记录）
CopyTree (Join-Path $dataRoot 'sessions') 'data/sessions' @('*.jsonl', '*.zstd')

# 4) 主进程启动日志（旧版落点）与内核运行时配置
CopyOne (Join-Path $env:LOCALAPPDATA 'Bosom Friend\app.log') 'app.log'
$kr = Join-Path $env:APPDATA 'Bosom Friend\kernel-runtime'
CopyTree $kr 'kernel-runtime-config' @('cordis.yml', 'package.json')
CopyTree (Join-Path $kr 'runtime') 'kernel-runtime-config/runtime' @('*.mjs')

# 5) 进程 / 端口 / 环境快照
$snap = Join-Path $dest 'snapshot'
New-Item -ItemType Directory -Force -Path $snap | Out-Null
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'Bosom|node|electron|python|ffmpeg|msedge' } |
  Select-Object ProcessId, ParentProcessId, Name, CreationDate, CommandLine |
  Format-List | Out-File (Join-Path $snap 'processes.txt') -Encoding UTF8
Get-NetTCPConnection -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess |
  Sort-Object LocalPort | Format-Table -AutoSize | Out-File (Join-Path $snap 'listening-ports.txt') -Encoding UTF8
("OS=" + [Environment]::OSVersion.VersionString + "  PS=" + $PSVersionTable.PSVersion) |
  Out-File (Join-Path $snap 'environment.txt') -Encoding UTF8
Note "  + snapshot/  processes.txt / listening-ports.txt / environment.txt"

# 6) 清单与压缩包
$manifest | Out-File (Join-Path $dest 'MANIFEST.txt') -Encoding UTF8
if (-not $NoZip) {
  $zip = $dest + '.zip'
  Compress-Archive -Path (Join-Path $dest '*') -DestinationPath $zip -Force
  Note ("[zip] " + $zip + "  MB=" + [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1))
}
Write-Host ""
Write-Host ("完成：" + $dest)
Write-Host "把整个文件夹（或同名 .zip）发出来即可；llm-user.masked.json 里的密钥已隐去。"
