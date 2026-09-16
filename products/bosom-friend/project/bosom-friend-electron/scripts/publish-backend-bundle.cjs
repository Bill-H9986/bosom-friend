/**
 * 把刚生成的 backend-bundle.zip 上传到 GitHub Releases 的 backend-bundle tag。
 *
 * 需要先安装并登录 GitHub CLI：
 *   winget install GitHub.cli
 *   gh auth login
 *
 * 也可以用 GH_REPO 指定仓库，例如：
 *   $env:GH_REPO = "owner/repo"
 *   node scripts/publish-backend-bundle.cjs
 */
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const electronDir = path.resolve(__dirname, '..')
const bundlePath = path.join(electronDir, 'release', 'backend-bundle', 'backend-bundle.zip')
const tag = 'backend-bundle'
const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY

if (!fs.existsSync(bundlePath)) {
  throw new Error(`bundle 不存在，请先运行: node scripts/create-backend-bundle.cjs (${bundlePath})`)
}

function run(command) {
  execSync(command, { stdio: 'inherit' })
}

run('gh auth status')

const repoArg = repo ? ` --repo ${repo}` : ''
const releaseExists = (() => {
  try {
    run(`gh release view ${tag}${repoArg} --json tagName`)
    return true
  }
  catch {
    return false
  }
})()

if (!releaseExists) {
  run(`gh release create ${tag} --title "知音随包后端 bundle" --notes "GitHub Actions 打包时使用的完整后端资源，包含 Windows 二进制、依赖与配置。"${repoArg}`)
}

run(`gh release upload ${tag} ${bundlePath} --clobber${repoArg}`)
console.log(`[backend-bundle] 已上传: ${bundlePath}`)
