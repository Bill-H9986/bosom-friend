#!/usr/bin/env node
/**
 * 内核工具注册冒烟（白盒、免 API Key）：只挂 dsh-base + 内核插件（过滤掉 JSON-RPC 服务端，
 * 避免测试进程占用 stdio），检查 bosom_kernel_ping 是否真的注册进官方工具运行时。
 */
import { boot, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openProductStore, resolveDataRoot } from '../../../bosom-friend/kernel/src/data.ts'
import { saveDraftRecord } from '../../../bosom-friend/kernel/src/drafts.ts'

process.env.DSH_HOME = process.env.BOSOM_FRIEND_HOME && process.env.BOSOM_FRIEND_HOME.trim() !== ''
  ? process.env.BOSOM_FRIEND_HOME.trim()
  : join(homedir(), '.bosom-friend')

const require = createRequire(import.meta.url)
const patches = []
for (const pkg of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-bosom-friend-kernel']) {
  const file = require.resolve(pkg + '/cordis.patch.yml')
  const layer = loadOptionalPatches('bosom-friend-kernel-tools', file) ?? []
  for (const entry of layer) {
    if (Array.isArray(entry.insert)) {
      entry.insert = entry.insert.filter((row) => row.name !== '@deepseek-ai/dsh-sdk-jsonrpc-server')
    }
  }
  patches.push(...layer)
}

const config = fileURLToPath(new URL('../config/kernel.cordis.yml', import.meta.url))
const ctx = await boot('bosom-friend-kernel-tools', config, patches)
const toolNames = [
  'bosom_kernel_ping',
  'bosom_platform_list_accounts',
  'bosom_reception_list_pending',
  'bosom_material_list',
  'bosom_data_dashboard',
  'bosom_platform_login_status',
  'bosom_platform_sync_works',
  'bosom_content_list_drafts',
  'bosom_content_generate_script',
  'bosom_job_list',
]
const missing = toolNames.filter((n) => ctx.get('tools')?.get(n) === undefined)
console.log(missing.length === 0 ? `KERNEL_TOOLS_OK ${toolNames.length} tools` : `KERNEL_TOOLS_MISSING ${missing.join(',')}`)
const dataRoot = resolveDataRoot()
const store = openProductStore(dataRoot)
console.log(
  'KERNEL_DATA accounts='
  + store.files.accounts.load().length
  + ' pending='
  + store.files.receptionPending.load().length,
)
const tempRoot = mkdtempSync(join(tmpdir(), 'bf-kernel-'))
const saved = saveDraftRecord(tempRoot, { title: '冒烟草稿', content: '正文', prompt: '测试', kind: 'image-text' })
const backRaw = JSON.parse(readFileSync(join(tempRoot, 'draft-generations.json'), 'utf8'))
const back = backRaw.schemaVersion === 1 ? backRaw.value : backRaw
const draftOk = Array.isArray(back) && back.length === 1 && back[0].id === saved.id && back[0].status === 'success'
console.log(draftOk ? 'KERNEL_DRAFT_OK 原子写入/回读一致' : 'KERNEL_DRAFT_MISMATCH')
rmSync(tempRoot, { recursive: true, force: true })
await ctx.fiber.dispose()
process.exit(missing.length === 0 && draftOk ? 0 : 1)
