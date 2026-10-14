import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'tsdown'

/**
 * 把非代码资源（随包字幕字体）从源码目录复制到构建产物。
 *
 * `tsc` 只处理 TypeScript，`.ttf` 不会被搬到 `lib/`；而运行时解析的是**编译产物**旁边的路径。
 * 不复制的话装机版会静默退化成系统字体（实测踩过：`[COMPOSE_WARN] 缺少随包字幕字体`）。
 */
function copyAssets(): void {
  const target = join(import.meta.dirname, 'lib/assets')
  mkdirSync(target, { recursive: true })
  copyFileSync(
    join(import.meta.dirname, 'src/assets/SourceHanSansCN-Regular.ttf'),
    join(target, 'SourceHanSansCN-Regular.ttf'),
  )
}

export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  hooks: {
    'build:done': () => { copyAssets() },
  },
})
