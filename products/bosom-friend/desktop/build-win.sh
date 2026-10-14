#!/usr/bin/env bash
# Bosom Friend 桌面端 Windows 安装包构建脚本（0.2.32+）
#
# 背景（务必保留注释，否则下次会重踩）：
# 1. 仓库根是 pnpm workspace（package.json 有 packageManager=pnpm@11.7.0）。
#    electron-builder 会自动探测到 pnpm 并执行 `pnpm list --prod --json --depth Infinity`
#    来收集依赖树。工作区 node_modules 一旦损坏，pnpm 会抛 EMFILE，输出里没有 JSON，
#    构建直接失败：No JSON content found in output。
# 2. 规避办法一：把工程复制到「工作区外」的暂存目录，探测不到 pnpm → 退化为 npm。
#    但 npm 收集器在 Windows 上走 powershell -EncodedCommand，同样可能拿到空输出。
# 3. 规避办法二（本脚本采用）：设置 npm_config_user_agent=traversal/1.0，
#    让探测结果落在 PM.TRAVERSAL 上，该收集器纯目录遍历、不起子进程，最稳。
#    本工程 files 里不含 node_modules，跳过依赖收集完全无副作用。
# 4. electron-builder 在 Windows 上会 emptyDir(win-unpacked/locales)，一次删 65 个文件，
#    触发 WorkBuddy Safe Delete 批量护栏。必须带 CODEBUDDY_SAFE_DELETE_ENABLED=0。
#
# 用法： bash build-win.sh          # 构建并输出到 release/<version>
#        OUTPUT_TO_DESKTOP=0 bash build-win.sh   # 不往桌面复制
set -euo pipefail

# ---- packaging authorization gate (HARD RULE, never remove) ----
# 产品负责人 2026-10-12：「没有我的命令不准打包！！！！！！！！！！」
# 任何自动化（含 AI 智能体）都不许自行发起打包。闸门存在的原因：已有智能体
# 在产品远未做完时试图打包。两种授权方式，都只属于产品负责人：
#   a) BF_PACKAGE_AUTHORIZED=yes bash build-win.sh
#   b) 建 products/bosom-friend/.package-authorized（内容写授权人与时间）
BF_AUTH_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.package-authorized"
if [ "${BF_PACKAGE_AUTHORIZED:-}" != "yes" ] && [ ! -f "$BF_AUTH_FILE" ]; then
  echo ""
  echo "BLOCKED: packaging is NOT authorized."
  echo "  Hard rule: do not package without the product owner explicit command."
  echo "  Nothing is broken -- the build simply refuses to start."
  echo "  To authorize (product owner only):"
  echo "    a) BF_PACKAGE_AUTHORIZED=yes bash build-win.sh"
  echo "    b) create products/bosom-friend/.package-authorized"
  echo ""
  exit 3
fi

# ---- free-space gate (DEF-284, decided by the product owner 2026-10-12) ----
# The first packaging attempt of that day died on a full disk halfway through.
# A build needs about 4.5 GB (engine-portable + kernel runtime + win-unpacked + NSIS).
# 6 GB leaves headroom; below that refuse to start. Same intent as the gate in
# rebuild-kernel-and-installer.ps1 (two implementations because this script runs under Git Bash).
# Note: df in Git Bash reports "available" (measured ~10% above PowerShell's Free on this
# machine); even so, 6 GB here still covers the 4.5 GB the build needs.
BF_NEED_GB=6
BF_FREE_KB="$(df -Pk /c 2>/dev/null | awk 'NR==2 {print $4}' || true)"
if [ -n "${BF_FREE_KB:-}" ]; then
  BF_FREE_GB=$((BF_FREE_KB / 1024 / 1024))
  if [ "$BF_FREE_GB" -lt "$BF_NEED_GB" ]; then
    echo ""
    echo "BLOCKED: not enough free space on C: (${BF_FREE_GB} GB free, need >= ${BF_NEED_GB} GB)."
    echo "  A previous build died on a full disk halfway through (DEF-284)."
    echo "  Free space first -- never start a build that cannot finish."
    echo ""
    exit 4
  fi
  echo "  free space on C: ${BF_FREE_GB} GB (need >= ${BF_NEED_GB} GB) -- OK"
fi

# electron-builder 会 emptyDir(win-unpacked) 批量删文件，本脚本自己也要 rm -rf 暂存目录，
# 两者都会撞 WorkBuddy Safe Delete 批量护栏（阈值 50）。
# 注意：该开关必须作为「命令前缀」内联生效，export 到环境里对 shim 不起作用。
rmrf() { CODEBUDDY_SAFE_DELETE_ENABLED=0 rm -rf "$@"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DESKTOP="$REPO_ROOT/products/bosom-friend/desktop"
PROJECT="$REPO_ROOT/products/bosom-friend/project/bosom-friend-electron"
BUILDER="$PROJECT/node_modules/.bin/electron-builder"

VERSION="$(python -c "import json;print(json.load(open(r'$DESKTOP/package.json',encoding='utf-8'))['version'])" 2>/dev/null \
  || sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DESKTOP/package.json" | head -1)"
STAGE="$HOME/bf-build-$VERSION"
OUTPUT_TO_DESKTOP="${OUTPUT_TO_DESKTOP:-1}"

echo "==> version : $VERSION"
echo "==> stage   : $STAGE"

# --- 0. 「先测试，再打包」(2026-10-12 产品负责人要求) ---
# rebuild-kernel-and-installer.ps1 已在第 0 步跑过全量门禁（并导出 BF_PRE_PACKAGE_GATE=done）；
# 直接从 bash 出包时补跑一次静态 + 产物新鲜度检查，避免绕过门禁打出一个没验证过的安装包。
if [ "${BF_PRE_PACKAGE_GATE:-}" != "done" ]; then
  node "$REPO_ROOT/products/bosom-friend/qa/verify-before-package.mjs" --quick \
    || { echo "!! 打包前置门禁未通过——先在开发版上把红的项修完再打包" >&2; exit 1; }
fi

# --- 1. 前置检查：打包读的是 dist/kernel-runtime.zip，不是 kernel-runtime-unpacked ---
if [ ! -f "$DESKTOP/dist/kernel-runtime.zip" ]; then
  echo "!! 缺少 $DESKTOP/dist/kernel-runtime.zip" >&2; exit 1
fi
for d in "$DESKTOP/dist/runtime" "$PROJECT/dist" "$PROJECT/node_modules/electron/dist"; do
  [ -d "$d" ] || { echo "!! 缺少 $d" >&2; exit 1; }
done
# LOGO 必带：少了 build/icon.ico，electron-builder 会静默回落到 Electron 默认图标
[ -f "$DESKTOP/build/icon.ico" ] || { echo "!! 缺少 $DESKTOP/build/icon.ico（LOGO）" >&2; exit 1; }
# 日志模块必须在包里（DEF-101）：缺文件不报错，装机版会静悄悄零日志——现场三侧全都无迹可查。
# 与 rebuild-kernel-and-installer.ps1 第 3 步调用同一份实现，直接跑 build-win.sh 时也躲不过。
node "$DESKTOP/verify-electron-logging.mjs" || { echo "!! 日志模块缺失或未接线（见上）" >&2; exit 1; }

# --- 2. 造暂存目录（工作区外，避免被 pnpm workspace 探测命中）---
# 不要 rm -rf 整个 $STAGE（里面 release/ 有几百个文件，会撞护栏）。
# 只重建几个小的源目录（每个都远低于 50 个文件阈值），release/ 交给 electron-builder 自己 emptyDir。
rmrf "$STAGE/electron" "$STAGE/renderer" "$STAGE/build"
mkdir -p "$STAGE"
# 注意：目标目录不存在时才 `cp -r A B` 语义正确；预建 B 会变成 B/electron/ 嵌套（app.asar 里就找不到 main.cjs）
cp -r "$DESKTOP/electron" "$STAGE/"
cp -r "$DESKTOP/renderer" "$STAGE/"
mkdir -p "$STAGE/build"
cp "$DESKTOP/build/icon.ico" "$STAGE/build/icon.ico"     # ← LOGO，别漏
[ -f "$DESKTOP/build/icon.png" ] && cp "$DESKTOP/build/icon.png" "$STAGE/build/icon.png"
[ -f "$DESKTOP/build/installer.nsh" ] && cp "$DESKTOP/build/installer.nsh" "$STAGE/build/"
cp    "$DESKTOP/package.json" "$STAGE/package.json"

# Git Bash 里 $REPO_ROOT 是 /c/Users/... 这种 POSIX 路径，electron-builder 在 Windows 上认不出来，
# 必须先转成 C:/Users/...（cygpath -m 正好给正斜杠混合格式，YAML 里也免转义）。
esc() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1" 2>/dev/null || printf '%s' "$1"
  else
    printf '%s' "$1" | sed 's/\\/\\\\/g'
  fi
}
cat > "$STAGE/electron-builder.yml" <<YAML
appId: com.bosomfriend.desktop
productName: Bosom Friend
electronVersion: 33.4.11
npmRebuild: false
artifactName: BosomFriend-Setup-\${version}.exe

directories:
  output: release/\${version}

icon: build/icon.ico

# Electron fuse：焊死运行时里用不到的"以 Node 身份运行/注入调试参数"入口。
# 注意：这份 YAML 是**构建真正使用的那一份**（本脚本自己生成，不读 desktop/electron-builder.yml）。
# 两处必须同步修改，否则静态配置改了、出包却没生效。
electronFuses:
  runAsNode: false
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableCookieEncryption: true

files:
  - electron/**/*
  - renderer/**/*
  - build/icon.ico
  - package.json

extraResources:
  - from: $(esc "$DESKTOP\\dist\\runtime")
    to: runtime
    filter: ["**/*"]
  - from: $(esc "$DESKTOP\\dist\\kernel-runtime.zip")
    to: kernel-runtime.zip
    filter: ["**/*"]
  # 自带解压器：安装器（NSIS 读不到 asar 里的代码）与主进程共用这一份实现。
  # 纯 Node + 显式 \\?\ 前缀，是唯一不依赖 PATH / 系统长路径开关的解压路径（DEF-055）。
  - from: $(esc "$DESKTOP\\electron\\kernel-unzip.cjs")
    to: kernel-unzip.cjs
  - from: $(esc "$PROJECT\\dist")
    to: frontend-dist
    filter: ["**/*"]
  - from: $(esc "$DESKTOP\\dist\\engine-portable")
    to: engine
    filter: ["**/*"]

electronDist: $(esc "$PROJECT\\node_modules\\electron\\dist")

win:
  icon: build/icon.ico
  target:
    - target: nsis
      arch: [x64]

nsis:
  include: build/installer.nsh
  installerIcon: build/icon.ico
  uninstallerIcon: build/icon.ico
  installerHeaderIcon: build/icon.ico
  oneClick: false
  perMachine: false
  allowElevation: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: Bosom Friend
  runAfterFinish: false
  deleteAppDataOnUninstall: false

publish: null
YAML

# --- 3. 构建 ---
# electron-builder 会 emptyDir(win-unpacked)，一次删几百个文件必然撞 Safe Delete 护栏；
# 后台/脚本里没人点确认就会永久挂住。改成先把它「重命名」挪走（rename 不算删除，不触发护栏），
# 这样 builder 拿到的是不存在的目录，emptyDir 直接空转。
if [ -d "$STAGE/release/$VERSION/win-unpacked" ]; then
  mv "$STAGE/release/$VERSION/win-unpacked" \
     "$STAGE/.old-win-unpacked-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
fi
cd "$STAGE"
CODEBUDDY_SAFE_DELETE_ENABLED=0 npm_config_user_agent="traversal/1.0" "$BUILDER" --win --x64

EXE="$STAGE/release/$VERSION/BosomFriend-Setup-$VERSION.exe"
[ -f "$EXE" ] || { echo "!! 构建未产出 $EXE" >&2; exit 1; }

# --- 4. 归档到工程 release/<version> ---
mkdir -p "$DESKTOP/release/$VERSION"
cp "$EXE" "$DESKTOP/release/$VERSION/"
[ -f "$EXE.blockmap" ] && cp "$EXE.blockmap" "$DESKTOP/release/$VERSION/"

# --- 5. 复制到桌面，方便直接双击安装 ---
if [ "$OUTPUT_TO_DESKTOP" = "1" ]; then
  cp "$EXE" "$HOME/Desktop/"
  echo "==> 桌面: $HOME/Desktop/BosomFriend-Setup-$VERSION.exe"
fi

echo "==> 完成: $DESKTOP/release/$VERSION/BosomFriend-Setup-$VERSION.exe"
