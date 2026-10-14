# 暂存 v0.11.0 OTA 四件套（镜像 release.mjs 的 staging 逻辑）
$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
$src = Join-Path $proj 'release\0.11.0'
$dst = Join-Path $proj 'release\ota-0.11.0'
New-Item -ItemType Directory -Path $dst -Force | Out-Null

Copy-Item (Join-Path $src 'ZhiYin-0.11.0.exe') (Join-Path $dst 'ZhiYin-0.11.0.exe') -Force
Copy-Item (Join-Path $src 'ZhiYin-0.11.0.exe.blockmap') (Join-Path $dst 'ZhiYin-0.11.0.exe.blockmap') -Force
Copy-Item (Join-Path $src 'ZhiYin-0.11.0.exe') (Join-Path $dst 'zhiyin-latest.exe') -Force
Copy-Item (Join-Path $src 'ZhiYin-0.11.0.exe.blockmap') (Join-Path $dst 'zhiyin-latest.exe.blockmap') -Force

$yml = Get-Content (Join-Path $src 'latest.yml') -Raw
$yml = $yml -replace '(?m)^(\s+- url: ).*$', '$1zhiyin-latest.exe'
$yml = $yml -replace '(?m)^path: .*$', 'path: zhiyin-latest.exe'
Set-Content (Join-Path $dst 'latest.yml') -Value $yml -Encoding UTF8

$update = @{
  version = '0.11.0'; force = $false; rollout = 100
  notes = '稳定性大修：根治反复启动导致的进程堆积；内置GitHub直连更新体系；随包后端启动器优化；全量测试通过。'
  releaseDate = (Get-Date).ToUniversalTime().ToString('o')
}
Set-Content (Join-Path $dst 'update.json') -Value ($update | ConvertTo-Json) -Encoding UTF8

Get-ChildItem $dst | Select-Object Name, @{N='MB';E={[math]::Round($_.Length/1MB,1)}} | Format-Table -AutoSize | Out-String
