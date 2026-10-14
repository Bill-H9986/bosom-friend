#!/usr/bin/env node
/**
 * M2 桥接冒烟（无需 Electron 图形环境）：
 * 在纯 Node 下用与主进程同一套 kernel-host 代码完成官方 SDK 握手，再协议关闭。
 */
const { createKernelHost } = require('./kernel-host.cjs')

async function main() {
  const host = await createKernelHost()
  try {
    const info = await host.start()
    console.log('M2_KERNEL_HOST_OK ' + JSON.stringify(info))
  }
  finally {
    await host.close()
  }
}

main().catch((error) => {
  console.error('M2_KERNEL_HOST_FAIL ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
})
