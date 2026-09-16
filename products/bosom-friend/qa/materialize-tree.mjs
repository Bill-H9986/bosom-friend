#!/usr/bin/env node
/**
 * 树物化器：逐项解引用符号链接/junction，生成纯实体目录树（打包用）。
 * 用法：node products/bosom-friend/qa/materialize-tree.mjs <src> <dst>
 */
import { copyFileSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

const [, , src, dst] = process.argv
if (!src || !dst) {
  console.error('用法：materialize-tree.mjs <src> <dst>')
  process.exit(2)
}

function walk(from, to) {
  let real
  let stat
  try {
    real = realpathSync(from)
    stat = statSync(real)
  } catch {
    // 坏链接：运行时永不解析，跳过不复制
    return
  }
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(real)) {
      walk(join(real, name), join(to, name))
    }
  } else {
    copyFileSync(real, to)
  }
}

walk(src, dst)
console.log('MATERIALIZED ' + dst)
