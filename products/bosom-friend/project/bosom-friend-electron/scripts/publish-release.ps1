# 发布 v0.11.0 到 Bill-H986/zhiyin（可续传：同名等大小资产自动跳过；先draft后公开）
$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
$ota = Join-Path $proj 'release\ota-0.11.0'

$cred = 'protocol=https' + "`n" + 'host=github.com' + "`n" + "`n"
$token = (($cred | git credential fill 2>&1 | Out-String) | Select-String 'password=(.+)$').Matches.Groups[1].Value.Trim()
if (-not $token) { throw '未取得 GitHub 凭据' }
$h = @{ Authorization = 'Bearer ' + $token; 'User-Agent' = 'zhiyin-release' }

# 1. 找/建 Release（先 draft）
$rel = $null
try { $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/Bill-H9986/zhiyin/releases/tags/v0.11.0' -Headers $h -TimeoutSec 30 } catch {}
if (-not $rel) {
  $body = @{
    tag_name = 'v0.11.0'; target_commitish = 'master'
    name = '知音 0.11.0'
    body = "稳定性大修：根治反复启动导致的进程堆积；内置GitHub直连更新体系；随包后端启动器优化；全量测试通过。"
    draft = $true; prerelease = $false
  } | ConvertTo-Json
  $rel = Invoke-RestMethod -Method Post -Uri 'https://api.github.com/repos/Bill-H9986/zhiyin/releases' -Headers $h -Body ($body) -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
}
Write-Output ('Release id: ' + $rel.id + ' (draft=' + $rel.draft + ')')

# 2. 逐资产上传（同名且等大小则跳过 = 可续传）
$assets = @('update.json','latest.yml','ZhiYin-0.11.0.exe.blockmap','zhiyin-latest.exe.blockmap','ZhiYin-0.11.0.exe','zhiyin-latest.exe')
foreach ($name in $assets) {
  $file = Join-Path $ota $name
  if (-not (Test-Path $file)) { Write-Output ("跳过缺失: " + $name); continue }
  $size = (Get-Item $file).Length
  $exist = $rel.assets | Where-Object { $_.name -eq $name }
  if ($exist -and $exist.size -eq $size) { Write-Output ("已存在跳过: " + $name); continue }
  if ($exist) { Invoke-RestMethod -Method Delete -Uri ('https://api.github.com/repos/Bill-H9986/zhiyin/releases/assets/' + $exist.id) -Headers $h -TimeoutSec 30 | Out-Null; Write-Output ("删除不完整旧资产: " + $name) }
  $ok = $false
  for ($attempt = 1; $attempt -le 3 -and -not $ok; $attempt++) {
    Write-Output ("上传 " + $name + " 第" + $attempt + "次 (" + [math]::Round($size/1MB,1) + " MB)...")
    try {
      curl.exe -sS -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/octet-stream" --data-binary "@$file" ("https://uploads.github.com/repos/Bill-H9986/zhiyin/releases/" + $rel.id + "/assets?name=" + [uri]::EscapeDataString($name)) | Out-Null
      if ($LASTEXITCODE -eq 0) { $ok = $true; Write-Output ("完成: " + $name) }
    } catch { Write-Output ("异常: " + $_.Exception.Message) }
    if (-not $ok) { Start-Sleep -Seconds 10 }
  }
  if (-not $ok) { throw ("资产上传失败: " + $name) }
}

# 3. 公开 Release
Invoke-RestMethod -Method Patch -Uri ('https://api.github.com/repos/Bill-H9986/zhiyin/releases/' + $rel.id) -Headers $h -Body '{"draft": false}' -ContentType 'application/json' -TimeoutSec 30 | Out-Null
Write-Output 'RELEASE_PUBLISHED'
