#!/usr/bin/env node
/** 一次性退役遗留代码：移动（不删除）到 legacy-archive，并写归档说明。 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const productRoot = fileURLToPath(new URL('../..', import.meta.url))
const archive = join(productRoot, 'legacy-archive')
mkdirSync(archive, { recursive: true })

const moves = [
  ['project/bosom-friend-harness', 'bosom-friend-harness'],
  ['bundle/app', 'bundle-app'],
]
for (const [src, name] of moves) {
  const from = join(productRoot, src)
  const to = join(archive, name)
  if (existsSync(from)) {
    renameSync(from, to)
    console.log('archived', src, '->', to)
  } else {
    console.log('skip missing', src)
  }
}

const readme = [
  '# 退役遗留代码归档（2026-09-03）',
  '',
  '本目录中的代码已退役，不再参与任何构建、测试或门禁扫描。',
  '',
  '- bosom-friend-harness/：早期自研 Agent/LLM 直连原型（AgnesLlmClient 直连 /chat/completions）。产品已迁移到官方 DSH 内核（launcher/bin-desktop + dsh-bosom-friend-kernel），该原型无任何运行时引用，直连模型路径违反“AI 必须经官方内核”的门禁。',
  '- bundle-app/：早期 Web 产品组合层（依赖 dsh-web-app）。产品定位于纯桌面 .exe、禁用 DSH Web UI，Web CLI（launcher/src/bin.ts）已退役，此组合层随之退役。',
  '',
  '归档原则：只移动、不删除；如未来需要追溯历史实现，可从此目录恢复。',
  '',
].join('\n')
writeFileSync(join(archive, 'README.md'), readme)
console.log('README written')
