# Bosom Friend 平台引擎一键初始化（幂等，可重复执行）
# 用途：新机器/发布机上安装 Python 依赖与浏览器，之后后端即可真实登录/发布。
$ErrorActionPreference = 'Stop'
$EngineDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvPython = Join-Path $EngineDir '.venv\Scripts\python.exe'
$Mirror = 'https://pypi.tuna.tsinghua.edu.cn/simple'
$BrowserMirror = 'https://registry.npmmirror.com/-/binary/chrome-for-testing'

if (-not (Test-Path $VenvPython)) {
  python -m venv (Join-Path $EngineDir '.venv')
}

& $VenvPython -m pip install -i $Mirror --upgrade pip | Out-Null
& $VenvPython -m pip install -i $Mirror `
  playwright==1.52.0 requests loguru xhs==0.2.13 `
  patchright==1.58.2 opencv-python numpy segno qrcode

# 登录引擎：Playwright 自带 Chromium（v1169）
$env:PLAYWRIGHT_DOWNLOAD_HOST = 'https://cdn.npmmirror.com/binaries/playwright'
& $VenvPython -m playwright install chromium

# 发布引擎：patchright 需要 Chrome for Testing 145（v1208），npmmirror 手动落盘
$CfT = '145.0.7632.6'
$BrowserRoot = Join-Path $env:LOCALAPPDATA 'ms-playwright'
function Install-CfT($Name, $Zip, $Sub) {
  $Target = Join-Path $BrowserRoot $Name
  if (Test-Path (Join-Path $Target $Sub)) { return }
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  $ZipFile = Join-Path $env:TEMP ($Name + '.zip')
  Invoke-WebRequest -Uri ($BrowserMirror + '/' + $CfT + '/win64/' + $Zip) -OutFile $ZipFile -UseBasicParsing
  Expand-Archive -Path $ZipFile -DestinationPath $Target -Force
  New-Item -ItemType File -Force -Path (Join-Path $Target 'INSTALLATION_COMPLETE') | Out-Null
}
Install-CfT 'chromium-1208' 'chrome-win64.zip' 'chrome-win64\chrome.exe'
Install-CfT 'chromium_headless_shell-1208' 'chrome-headless-shell-win64.zip' 'chrome-headless-shell-win64\chrome-headless-shell.exe'

Write-Host '[engine] 平台登录/发布引擎就绪' -ForegroundColor Green
