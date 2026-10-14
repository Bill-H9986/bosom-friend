#!/usr/bin/env node
/**
 * pre-commit 检查的 Node 实现（DEF-296）。
 *
 * 为什么不用 lefthook 的 shell 执行：lefthook 在 Windows 上用
 * `C:\Program Files\Git\usr\bin\sh.exe` 跑每个 job，而本机这个 cygwin sh 起不来
 * （`fatal error - NtCreateDirectoryObject`）——只要有一个 job 真要执行，提交就被
 * 莫名其妙地拦下。这里把 lefthook.yml 里同一批检查用 Node 直接跑：不经过 sh，
 * 判据与本仓库的 lefthook.yml 一一对应（改那边记得同步这边）。
 *
 * 用法（由 .git/dsh-hooks/pre-commit 调用）：node scripts/pre-commit.mjs
 * 退出码：0 = 放行；1 = 有 job 判红（提交被拦）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const tsx = ['--import', 'tsx/esm']

/** 跑一条命令，返回 { ok, label }；不经 shell，避免 cygwin sh。 */
function run(label, command, args) {
  process.stdout.write('  ' + label + ' …\n')
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env })
  if (result.error !== undefined) {
    process.stdout.write('  ' + label + ' ✗ ' + result.error.message + '\n')
    return false
  }
  if (result.status !== 0) {
    process.stdout.write('  ' + label + ' ✗ 退出码 ' + String(result.status) + '\n')
    return false
  }
  return true
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout : ''
}

/** 暂存的变更文件（相对仓库根，/ 分隔）。 */
function stagedFiles() {
  return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .split('\0')
    .filter(name => name !== '')
}

/** 把 lefthook 风格的 glob 收成一条正则（** / * / {a,b} / ? 四个够用）。 */
function globToRegExp(glob) {
  let out = '^'
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1
        if (glob[index + 1] === '/') { index += 1; out += '(?:.*/)?' } else out += '.*'
      } else out += '[^/]*'
      continue
    }
    if (char === '?') { out += '[^/]'; continue }
    if (char === '{') {
      const close = glob.indexOf('}', index)
      if (close > 0) {
        out += '(?:' + glob.slice(index + 1, close).split(',').map(part => part.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'
        index = close
        continue
      }
    }
    out += char.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}

const THIRD_PARTY_GLOBS = [
  'package.json', '*/package.json', '*/*/package.json', '*/*/*/package.json', '*/*/*/*/package.json',
  'pnpm-workspace.yaml', '*/*/pnpm-workspace.yaml', 'pnpm-lock.yaml', 'vendor/README.md',
  'python/*/pyproject.toml', 'scripts/gen-third-party-notices.ts', 'scripts/browser-bundled-externals.ts',
  'scripts/build-exe-for-python-sdk.ts', 'tsconfig.base*.json', 'packages/*/*/src/**/*',
  'packages/*/*/tsdown.config.ts', 'packages/client/tsdown.client.ts', 'apps/*/src/**/*',
  'apps/*/vite.config.ts',
]

const files = stagedFiles()
/**
 * lefthook 的 `glob` 匹配的是「路径里的一段」，所以 `*.{ts,tsx}` 命中 `src/a.ts`：
 * 整路径与 basename 都要试一次——只试整路径会让 `scripts/x.mjs` 这类多级路径静默漏检
 * （那正是 DEF-296 同类的"静默失效"，不能留）。
 */
const matches = (globs, file) => globs.some((glob) => {
  const pattern = globToRegExp(glob)
  const base = file.slice(file.lastIndexOf('/') + 1)
  return pattern.test(file) || pattern.test(base)
})
const jobs = []

// 1) translation pairing（配对记录）
const pairing = files.filter(file => matches(['*.i18n.yaml'], file) && !file.startsWith('.agents/notes/archived/'))
if (pairing.length > 0) {
  jobs.push(['translation pairing (staged records)', () => run('translation pairing', process.execPath, [...tsx, 'scripts/verify-translation-pairing.ts', '--cached', ...pairing])])
}

// 2) archived agent notes
if (files.some(file => file.startsWith('.agents/notes/archived/'))) {
  jobs.push(['archived agent notes', () => run('archived agent notes', process.execPath, [...tsx, 'scripts/verify-archived-agent-notes.ts'])])
}

// 3) lint（暂存的 ts/tsx/mts/cts/mjs；跑完把自动修复的文件重新入暂存）
const lintFiles = files.filter(file => matches(['*.{ts,tsx,mts,cts,mjs}'], file) && !globToRegExp('vendor/*/src/**').test(file))
if (lintFiles.length > 0) {
  jobs.push(['lint (staged)', () => {
    const ok = run('lint (staged)', process.execPath, [...tsx, 'scripts/run-oxlint.ts', '--config', '.oxlintrc.staged.json', '--fix', '--no-error-on-unmatched-pattern', ...lintFiles])
    // lefthook 的 stage_fixed：把 --fix 改过的文件重新入暂存，避免"修了但没提交"。
    spawnSync('git', ['add', '--', ...lintFiles], { cwd: root, stdio: 'ignore' })
    return ok
  }])
}

// 4) 第三方声明（依赖或构建输入变了就重新生成并重新入暂存）
if (files.some(file => matches(THIRD_PARTY_GLOBS, file))) {
  jobs.push(['third-party notices (staged)', () => {
    const ok = run('third-party notices', process.execPath, [...tsx, 'scripts/gen-third-party-notices.ts'])
    if (ok) spawnSync('git', ['add', 'THIRD_PARTY_NOTICES.md'], { cwd: root, stdio: 'ignore' })
    return ok
  }])
}

// 5) 行尾空白（lefthook.yml 的 whitespace，无 glob：每次都查）
jobs.push(['whitespace (staged)', () => run('whitespace (staged)', 'git', ['diff', '--cached', '--check'])])

// 6) vendor 清单守卫（原本是 .sh；用能跑的 bash 显式执行，找不到就跳过并提示）
const vendorGuard = join(root, 'scripts', 'check-vendor-manifest.sh')
if (existsSync(vendorGuard)) {
  jobs.push(['vendor manifest guard', () => {
    const bash = ['/c/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe']
      .find(candidate => process.platform !== 'win32' || existsSync(candidate))
    if (bash === undefined) {
      process.stdout.write('  vendor manifest guard … 跳过（本机没有可用的 bash）\n')
      return true
    }
    return run('vendor manifest guard', bash, [vendorGuard])
  }])
}

process.stdout.write('pre-commit（Node 版，' + String(jobs.length) + ' 项检查）\n')
let failed = 0
for (const [label, execute] of jobs) {
  if (!execute()) failed += 1
}
if (failed > 0) {
  process.stdout.write('\npre-commit 失败：' + String(failed) + ' 项检查未通过，提交被拦下。\n')
  process.exit(1)
}
process.stdout.write('pre-commit 通过。\n')
