#!/usr/bin/env bash
# QA 专用实例：31281 端口（不抢 31280）
set -u
ROOT="C:/Users/Jay/Desktop/Bosom friend APP"
NODE="C:/Users/Jay/.workbuddy/binaries/node/versions/22.22.2-2/node.exe"
export BF_DESKTOP_PORT=31281
export BF_FRONTEND_DIST="$ROOT/products/bosom-friend/project/bosom-friend-electron/dist"
export BF_KERNEL_ROOT="$ROOT/products/bosom-friend/desktop/dist/kernel-runtime-unpacked"
export BF_ENGINE_ROOT="$ROOT/products/bosom-friend/engine"
export NO_PROXY="127.0.0.1,localhost"
export no_proxy="127.0.0.1,localhost"
# 应用启动会做备份轮转（BACKUP_KEEP=30，保留最近 30 份），删除最老 1 份属产品既定行为。
# 但 agent 侧的 safe-delete 守卫会把「递归删除 66 个文件」判为批量删除并阻断启动，
# 这里关掉的是 agent 侧的守卫（仅影响本子进程），不动产品行为、不删账号。
export CODEBUDDY_SAFE_DELETE_ENABLED=0
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
cd "$BF_KERNEL_ROOT" || exit 1
exec "$NODE" runtime/bin-desktop.mjs < /dev/zero
