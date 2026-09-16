# Bosom Friend 纯净版绿色包打包脚本
# 产物：desktop/release/BosomFriend-纯净版-v<版本>（代码树 + lib + 前端 dist，无 node_modules / .venv / 测试数据 / 账号 / API Key）
# 目标机三步：1) 安装 Node.js 22.19+；2) 双击 安装依赖.bat（联网）；3) 双击 启动BosomFriend.bat
# 可选：需要真实平台登录/发布/同步时，先安装 Python 3.12 再双击 安装平台引擎.bat
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ElectronPkg = Join-Path $RepoRoot 'products\bosom-friend\project\bosom-friend-electron\package.json'
$Version = (Get-Content $ElectronPkg -Raw | ConvertFrom-Json).version
if (-not $Version) { $Version = '0.13.5' }

$StageName = "BosomFriend-纯净版-v$Version"
$ReleaseDir = Join-Path $RepoRoot 'products\bosom-friend\desktop\release'
$StageDir = Join-Path $ReleaseDir $StageName
$ZipPath = Join-Path $ReleaseDir "$StageName.zip"

# 安全校验：只允许在 release 目录内重建，防止误删
if (-not $StageDir.StartsWith($ReleaseDir)) { throw "非法输出目录: $StageDir" }

Write-Host '[pack] 清理旧产物' -ForegroundColor Cyan
if (Test-Path $StageDir) { Remove-Item -LiteralPath $StageDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

$CommonExcludeDirs = @('node_modules', '.venv', '__pycache__', '_exam_evidence', '_probe_shots', 'qa', '.git', 'dist-electron', 'release', 'logs')
$CommonExcludeFiles = @('*.log', '*.tsbuildinfo', 'bosom-run.*')

function Copy-Tree([string]$Source, [string]$Target) {
  if (-not (Test-Path $Source)) { return }
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  $xdArgs = @('/E')
  foreach ($d in $CommonExcludeDirs) { $xdArgs += '/XD'; $xdArgs += $d }
  foreach ($f in $CommonExcludeFiles) { $xdArgs += '/XF'; $xdArgs += $f }
  robocopy $Source $Target @xdArgs /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败: $Source" }
  $global:LASTEXITCODE = 0
}

Write-Host '[pack] 复制工作区核心（vendor/packages/native）' -ForegroundColor Cyan
Copy-Tree (Join-Path $RepoRoot 'vendor') (Join-Path $StageDir 'vendor')
Copy-Tree (Join-Path $RepoRoot 'packages') (Join-Path $StageDir 'packages')
Copy-Tree (Join-Path $RepoRoot 'native\landlock-run') (Join-Path $StageDir 'native\landlock-run')

Write-Host '[pack] 复制产品层（launcher/bundle/shim/server）' -ForegroundColor Cyan
foreach ($sub in @('launcher', 'bundle', 'shim', 'server')) {
  Copy-Tree (Join-Path $RepoRoot "products\bosom-friend\$sub") (Join-Path $StageDir "products\bosom-friend\$sub")
}

Write-Host '[pack] 复制平台引擎（不含 .venv）' -ForegroundColor Cyan
$EngineSrc = Join-Path $RepoRoot 'products\bosom-friend\engine'
$EngineDst = Join-Path $StageDir 'products\bosom-friend\engine'
New-Item -ItemType Directory -Force -Path $EngineDst | Out-Null
foreach ($item in @('worker.py', 'interactions.py', 'setup.ps1', 'VENDORED.md', 'VENDORED_RECEPTION.md')) {
  Copy-Item -LiteralPath (Join-Path $EngineSrc $item) -Destination $EngineDst -Force
}
Copy-Tree (Join-Path $EngineSrc 'social-auto-upload') (Join-Path $EngineDst 'social-auto-upload')

Write-Host '[pack] 复制前端 dist' -ForegroundColor Cyan
$DistSrc = Join-Path $RepoRoot 'products\bosom-friend\project\bosom-friend-electron\dist'
$DistDst = Join-Path $StageDir 'products\bosom-friend\project\bosom-friend-electron\dist'
Copy-Tree $DistSrc $DistDst
Copy-Item -LiteralPath $ElectronPkg -Destination (Join-Path $StageDir 'products\bosom-friend\project\bosom-friend-electron\package.json') -Force

Write-Host '[pack] 复制根清单文件' -ForegroundColor Cyan
foreach ($file in @('package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'LICENSE')) {
  $src = Join-Path $RepoRoot $file
  if (Test-Path $src) { Copy-Item -LiteralPath $src -Destination $StageDir -Force }
}
Copy-Item -LiteralPath (Join-Path $RepoRoot 'products\bosom-friend\README.md') -Destination (Join-Path $StageDir 'products\bosom-friend\README.md') -Force -ErrorAction SilentlyContinue
Set-Content -LiteralPath (Join-Path $StageDir 'VERSION.txt') -Value "Bosom Friend 纯净版 v$Version`r`n$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))" -Encoding UTF8

Write-Host '[pack] 写入启动/安装脚本与说明' -ForegroundColor Cyan
$installBat = @'
@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/3] 检查 Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js 22.19 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)
echo [2/3] 安装依赖（需要联网，首次约 3-10 分钟）...
corepack pnpm install --ignore-scripts
if errorlevel 1 (
  echo 依赖安装失败，请检查网络后重试。
  pause
  exit /b 1
)
echo [3/3] 生成插件解析链接...
node products\bosom-friend\launcher\scripts\setup-fallback.mjs
echo.
echo 安装完成！现在可以双击 启动BosomFriend.bat
pause
'@
Set-Content -LiteralPath (Join-Path $StageDir '安装依赖.bat') -Value $installBat -Encoding Default

$engineBat = @'
@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在初始化平台登录/发布引擎（需要 Python 3.12 和联网）...
powershell -NoProfile -ExecutionPolicy Bypass -File "products\bosom-friend\engine\setup.ps1"
if errorlevel 1 (
  echo 引擎安装失败，请确认已安装 Python 3.12 并加入 PATH。
  pause
  exit /b 1
)
echo 平台引擎就绪！
pause
'@
Set-Content -LiteralPath (Join-Path $StageDir '安装平台引擎.bat') -Value $engineBat -Encoding Default

$startBat = @'
@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 依赖尚未安装，请先双击 安装依赖.bat
  pause
  exit /b 1
)
if not exist "products\bosom-friend\launcher\config\node_modules\@deepseek-ai" (
  node products\bosom-friend\launcher\scripts\setup-fallback.mjs
)
start "" http://127.0.0.1:3080/bosom-friend/
node products\bosom-friend\launcher\lib\types\bin.js --port 3080 --no-open
echo.
echo 服务已退出。
pause
'@
Set-Content -LiteralPath (Join-Path $StageDir '启动BosomFriend.bat') -Value $startBat -Encoding Default

$stopBat = (@(
  '@echo off',
  'chcp 65001 >nul',
  'powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue; if ($c) { Stop-Process -Id $c.OwningProcess -Force; Write-Host ''3080 服务已停止'' } else { Write-Host ''3080 服务未在运行'' }; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match ''bosom-friend\\engine\\worker.py'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Write-Host ''清理完成''"',
  'pause'
) -join "`r`n")
Set-Content -LiteralPath (Join-Path $StageDir '停止BosomFriend.bat') -Value $stopBat -Encoding Default

$readme = (@(
  "Bosom Friend 纯净版 v$Version（绿色便携包）",
  '==========================================',
  '',
  '本包为交付干净状态：不含任何账号 Cookie、API Key、测试数据。',
  '所有业务数据在首次启动后保存于 当前用户目录\.bosom-friend\，删除即完全清除。',
  '',
  '【安装步骤（普通用户）】',
  '1. 安装 Node.js 22.19 或更高版本：https://nodejs.org/',
  '2. 双击 安装依赖.bat（首次需要联网，约 3-10 分钟）',
  '3. 双击 启动BosomFriend.bat，浏览器会自动打开',
  '   地址：http://127.0.0.1:3080/bosom-friend/',
  '',
  '【真实平台登录/发布/同步（可选）】',
  '1. 安装 Python 3.12 并加入 PATH：https://www.python.org/downloads/',
  '2. 双击 安装平台引擎.bat（首次需要联网，下载依赖与浏览器）',
  '3. 在 APP 的 添加频道 页面扫码登录小红书/抖音即可使用',
  '',
  '【停止】',
  '双击 停止BosomFriend.bat；或直接关闭启动窗口。',
  '',
  '【数据】',
  '- 数据目录：当前用户目录\.bosom-friend\',
  '- 备份数据：复制整个 .bosom-friend 目录即可',
  '- 完全卸载：删除本包目录 + 删除 .bosom-friend 目录',
  '',
  '【说明】',
  '- 服务仅监听 127.0.0.1，本机使用，不出网。',
  '- AI 能力使用你自己配置的模型服务（设置 → 配置大模型）。',
  '- 本包不含任何账号/密钥/历史数据，首次使用请自行登录与配置。'
) -join "`r`n")
Set-Content -LiteralPath (Join-Path $StageDir 'README-使用说明.txt') -Value $readme -Encoding UTF8

Write-Host "[pack] 打包目录完成：$StageDir" -ForegroundColor Green

if (-not $SkipInstallCheck) {
  Write-Host '[pack] 在打包目录执行依赖安装校验（联网）...' -ForegroundColor Cyan
  Push-Location $StageDir
  try {
    corepack pnpm install --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "依赖安装校验失败" }
    node products\bosom-friend\launcher\scripts\setup-fallback.mjs
    Write-Host '[pack] 启动纯净包自检（端口 3099，临时数据根）...' -ForegroundColor Cyan
    $env:BOSOM_FRIEND_HOME = Join-Path $StageDir '.selfcheck-home'
    $selfOut = Join-Path $StageDir 'selfcheck.out.log'
    $selfErr = Join-Path $StageDir 'selfcheck.err.log'
    $proc = Start-Process -FilePath 'node' -ArgumentList 'products\bosom-friend\launcher\lib\types\bin.js','--port','3099','--no-open' -WorkingDirectory $StageDir -WindowStyle Hidden -RedirectStandardOutput $selfOut -RedirectStandardError $selfErr -PassThru
    try {
      $ok = $false
      for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        if ($proc.HasExited) { break }
        try {
          $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3099/bosom-friend/' -TimeoutSec 5 -UseBasicParsing
          if ($resp.StatusCode -eq 200) { $ok = $true; break }
        } catch {}
      }
      if (-not $ok) {
        $logTail = ''
        if (Test-Path $selfErr) { $logTail = (Get-Content $selfErr -Raw -ErrorAction SilentlyContinue) }
        if (Test-Path $selfOut) { $logTail += (Get-Content $selfOut -Raw -ErrorAction SilentlyContinue) }
        throw "纯净包自检失败：首页未返回 200（进程退出=$($proc.HasExited) 日志=$logTail）"
      }
      Write-Host '[pack] 自检通过：HTTP 200' -ForegroundColor Green
    }
    finally {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      Remove-Item Env:BOSOM_FRIEND_HOME -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $selfOut -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $selfErr -Force -ErrorAction SilentlyContinue
  }
  finally {
    Pop-Location
  }
}

Write-Host '[pack] 清理校验产物（node_modules / 回退链接 / 自检数据）' -ForegroundColor Cyan
$nmDirs = Get-ChildItem -LiteralPath $StageDir -Recurse -Directory -Filter 'node_modules' -Force -ErrorAction SilentlyContinue
foreach ($d in $nmDirs) { Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath (Join-Path $StageDir 'products\bosom-friend\launcher\config\node_modules') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $StageDir '.selfcheck-home') -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[pack] 压缩安装包：$ZipPath" -ForegroundColor Cyan
if (Test-Path $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
Compress-Archive -Path $StageDir -DestinationPath $ZipPath -CompressionLevel Optimal

Write-Host '[pack] 完成' -ForegroundColor Green
Write-Host "  目录：$StageDir"
Write-Host "  安装包：$ZipPath"
