#!/bin/sh
# 一键复现：tsdown workspace 模式把仓库根当构建目标（tsdown@0.22.2）
set -eu

DIR="${1:-tsdown-ws-repro}"
rm -rf "$DIR"
mkdir -p "$DIR/packages/util/thing/src" "$DIR/apps/web/src" "$DIR/apps/web/lib/types" "$DIR/packages/util/thing/lib/types"

cat > "$DIR/package.json" <<'JSON'
{ "name": "@repro/root", "private": true, "type": "module" }
JSON

cat > "$DIR/pnpm-workspace.yaml" <<'YAML'
packages:
  - 'packages/*/*'
  - 'apps/*'
YAML

cat > "$DIR/tsdown.config.ts" <<'TS'
import { defineConfig } from 'tsdown'

export default defineConfig({
  workspace: ['packages/*/*', 'apps/*'],
  entry: ['lib/types/{index,invariant,startup}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
TS

cat > "$DIR/packages/util/thing/package.json" <<'JSON'
{ "name": "@repro/thing", "type": "module", "exports": { ".": "./lib/index.js" } }
JSON
echo 'export const thing = 1' > "$DIR/packages/util/thing/src/index.ts"

cat > "$DIR/apps/web/package.json" <<'JSON'
{ "name": "@repro/web-frontend", "private": true, "type": "module" }
JSON
echo 'export const app = 1' > "$DIR/apps/web/src/main.ts"

# 变体 A：每个被扫到的包都有 lib/types/index.js（含 apps/web）——观察是否通过
printf 'export const x = 1\n' > "$DIR/packages/util/thing/lib/types/index.js"
printf 'export const x = 1\n' > "$DIR/apps/web/lib/types/index.js"

cd "$DIR"
npm install --silent --no-audit --no-fund tsdown@0.22.2
echo '=== 变体 A：所有被扫包都有入口 ==='
npm exec -- tsdown || echo "A EXIT=$?"

# 变体 B：让 apps/web 缺入口（等同真实仓库里 apps/web 是 Vite 应用、没有 lib/types）
rm -f "$DIR/apps/web/lib/types/index.js"
echo '=== 变体 B：apps/web 缺入口 ==='
npm exec -- tsdown || echo "B EXIT=$?"

# 变体 C：排除 apps/web，看失败点是否转移到根包
cat > "$DIR/tsdown.config.ts" <<'TS'
import { defineConfig } from 'tsdown'

export default defineConfig({
  workspace: { include: ['packages/*/*'] },
  entry: ['lib/types/{index,invariant,startup}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
TS
echo '=== 变体 C：include 排除 apps/web ==='
npm exec -- tsdown || echo "C EXIT=$?"
