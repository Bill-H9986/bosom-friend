import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const webDir = join(root, 'products', 'bosom-friend', 'project', 'bosom-friend-web', 'src')
const serverDir = join(root, 'products', 'bosom-friend', 'server', 'src')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const frontendPaths = new Map()
for (const file of walk(webDir)) {
  const src = readFileSync(file, 'utf8')
  const re = /(?:http\.(get|post|put|delete|patch)|fetch)\s*\(\s*[`'"]((?:[^`'"]|\$\{[^}]+\})*)[`'"]/g
  let m
  while ((m = re.exec(src))) {
    const path = m[2]
    if (path.startsWith('http')) continue
    if (!path.includes('/')) continue
    const key = path.replace(/\$\{[^}]+\}/g, ':p')
    if (!frontendPaths.has(key)) frontendPaths.set(key, [])
    frontendPaths.get(key).push(relative(webDir, file))
  }
}

const routes = []
for (const file of walk(serverDir)) {
  const src = readFileSync(file, 'utf8')
  const re = /p:\s*'([^']+)'/g
  let m
  while ((m = re.exec(src))) routes.push({ path: m[1], file: relative(serverDir, file) })
}

function matchRoute(frontendPath) {
  const clean = frontendPath.replace(/^\/+|\/+$/g, '')
  for (const route of routes) {
    const rp = route.path.replace(/^\/+|\/+$/g, '')
    const fSegs = clean.split('/')
    const rSegs = rp.split('/')
    if (fSegs.length !== rSegs.length) continue
    let ok = true
    for (let i = 0; i < fSegs.length; i++) {
      if (rSegs[i].startsWith(':')) continue
      if (rSegs[i] !== fSegs[i]) { ok = false; break }
    }
    if (ok) return route
  }
  return null
}

const unmatched = []
for (const [path, files] of frontendPaths) {
  if (!path.includes(':')) {
    if (!matchRoute(path)) unmatched.push({ path, files: [...new Set(files)] })
  }
}

const emptyStubs = []
const stubRe = /writeOk\s*\(\s*res,\s*(?:\[\]|\{\s*(?:words|items|list|records|data)\s*:\s*\[\]\s*\}|\{\s*available\s*:\s*false[\s\S]{0,80}?\})/g
for (const file of walk(serverDir)) {
  const src = readFileSync(file, 'utf8')
  const lines = src.split('\n')
  lines.forEach((line, idx) => {
    if (stubRe.test(line)) emptyStubs.push({ file: relative(serverDir, file), line: idx + 1, text: line.trim().slice(0, 120) })
  })
}

console.log('=== 前端调用但后端没有匹配路由（可能404/功能死掉） ===')
console.log(JSON.stringify(unmatched, null, 1))
console.log('=== 后端明显空/占位返回 ===')
console.log(JSON.stringify(emptyStubs, null, 1))
console.log(`frontendPaths=${frontendPaths.size} routes=${routes.length} unmatched=${unmatched.length} stubs=${emptyStubs.length}`)
