<#
  从 GitHub Release 取回回滚包 BosomFriend-Setup-0.2.51.exe（当前唯一保留版）

  为什么需要它：2026-09-16 按用户口径清理成了「只留最新版」，本地只有 0.2.51 一份，
  而 GitHub Release（公开下载仓）里也挂着同一份 —— 于是把它作为回滚包的**第二份来源**：
  本机这份丢了，可以用本脚本取回并逐字节核对 SHA256。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File products/bosom-friend/qa/probes/fetch-release-installer.ps1
    powershell ... -File ... -Dest D:\外置盘\BosomFriend-Releases     # 取到别处（例如外置盘副本）
    powershell ... -File ... -VerifyOnly                                # 只核对本地已有文件，不下载

  退出码：0 = 通过（下载并核对成功，或本地文件已一致）；1 = 失败（下载失败 / 大小或哈希不一致）。
#>
[CmdletBinding()]
param(
  [string]$Version = '0.2.51',
  [string]$Dir = 'C:\Users\Jay\BosomFriend-Releases',
  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$repo = 'Bill-H9986/zhiyin'
$file = "BosomFriend-Setup-$Version.exe"
$local = Join-Path $Dir $file
$url = "https://github.com/$repo/releases/download/v$Version/$file"

# 期望值来自基线（唯一权威），不再手抄一遍
$baselinePath = Join-Path $PSScriptRoot '..\baseline\installer-checksums.json'
$baseline = Get-Content -LiteralPath $baselinePath -Raw -Encoding UTF8 | ConvertFrom-Json
$expect = $baseline.files | Where-Object { $_.name -eq $file } | Select-Object -First 1
if (-not $expect) { throw "基线里没有 $file，先确认版本号或先更新基线" }

function Assert-File([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { throw "文件不存在：$path" }
  $len = (Get-Item -LiteralPath $path).Length
  if ($len -ne $expect.sizeBytes) { throw "大小不符：$len != $($expect.sizeBytes)" }
  $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
  if ($hash -ne $expect.sha256) { throw "SHA256 不符：$hash != $($expect.sha256)" }
  Write-Output "OK $file  $len B  SHA256 $hash"
}

if ($VerifyOnly) { Assert-File $local; exit 0 }

if (Test-Path -LiteralPath $local) {
  try { Assert-File $local; Write-Output '本地已有一致副本，无需下载'; exit 0 }
  catch { Write-Output ("本地副本不一致，改为重新下载：" + $_.Exception.Message) }
}

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$tmp = "$local.part"
Write-Output "下载 $url"
Write-Output "目标 $local"
$env:GIT_TERMINAL_PROMPT = '0'
# curl 对 1GB 大文件比 Invoke-WebRequest 稳；-L 跟 302 到实际资源
curl.exe -L --fail --retry 3 --retry-delay 5 -o $tmp $url
if ($LASTEXITCODE -ne 0) { throw "curl 下载失败，退出码 $LASTEXITCODE" }
Assert-File $tmp
Move-Item -LiteralPath $tmp -Destination $local -Force
Write-Output "已就位：$local"
