#!/usr/bin/env node
/**
 * cordis 补丁一致性：两个运行时的补丁层挂同一个插件时，实例 id 与共享配置必须一致。
 *
 * 背景：dev/web 运行时走 bundle/app/cordis.patch.yml（dsh-base + dsh-web-app + app），
 * 桌面运行时走 bundle/desktop/cordis.patch.yml（dsh-base + kernel + desktop-bundle）。
 * 同一份产品服务插件因此被声明两次——历史上两次声明的 id 还不一样
 * （bosom-server-api / bosom-friend-server-api），配置也各写一遍。
 * 两个运行时不会同时加载，漂移平时看不出来，直到某一边少了一个配置项；
 * 这里把"必须一致"变成门禁断言。
 *
 * 用法：node products/bosom-friend/qa/verify-cordis-patches.mjs
 * 退出码：0 = 一致；1 = 有漂移。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const productRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 允许只在桌面层出现的配置键：桌面运行时独有，不算漂移。 */
const DESKTOP_ONLY_KEYS = new Set(['frontendDist'])
const LAYERS = [
  { label: 'dev/web', file: join(productRoot, 'bundle', 'app', 'cordis.patch.yml') },
  { label: 'desktop', file: join(productRoot, 'bundle', 'desktop', 'cordis.patch.yml') },
]

/**
 * 解析补丁文件里的 `- id / name / config` 条目。
 *
 * @param text - 补丁文件内容。
 * @returns 插件名到 { id, config } 的映射；config 只收一层缩进的标量行。
 */
function parseEntries(text) {
  const entries = new Map()
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const idMatch = /^\s*-\s*id:\s*(\S+)\s*$/.exec(lines[i])
    if (idMatch === null) continue
    let name = ''
    const config = new Map()
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]
      if (/^\s*-\s*id:/.test(line)) break
      const nameMatch = /^\s*name:\s*'?"?([^'"]+)'?"?\s*$/.exec(line)
      if (nameMatch !== null && name === '') { name = nameMatch[1]; continue }
      const configKey = /^\s{8}([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
      if (configKey !== null) config.set(configKey[1], configKey[2].trim())
    }
    if (name !== '') entries.set(name, { id: idMatch[1], config })
  }
  return entries
}

const layers = LAYERS.map(layer => ({ ...layer, entries: parseEntries(readFileSync(layer.file, 'utf8')) }))
const failures = []
const shared = []
for (const [name, first] of layers[0].entries) {
  const other = layers[1].entries.get(name)
  if (other === undefined) continue
  shared.push(name)
  if (first.id !== other.id) failures.push(name + ' 的实例 id 不一致：' + layers[0].label + '=' + first.id + '，' + layers[1].label + '=' + other.id)
  const keys = new Set([...first.config.keys(), ...other.config.keys()])
  for (const key of keys) {
    if (DESKTOP_ONLY_KEYS.has(key)) continue
    const a = first.config.get(key)
    const b = other.config.get(key)
    if (a !== b) failures.push(name + '.' + key + ' 不一致：' + layers[0].label + '=' + String(a) + '，' + layers[1].label + '=' + String(b))
  }
}
if (shared.length === 0) failures.push('两层没有任何共同插件：补丁结构可能已改，请复核本检查')

for (const name of shared) console.log('  [OK] ' + name + ' 两层一致（id 与共享配置）')
console.log(failures.length === 0 ? 'CORDIS_PATCHES PASS shared=' + shared.length : 'CORDIS_PATCHES FAIL:\n  - ' + failures.join('\n  - '))
process.exit(failures.length === 0 ? 0 : 1)
