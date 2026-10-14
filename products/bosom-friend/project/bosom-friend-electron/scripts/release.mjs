/**
 * 知音发布打包：自动升版本号 → 构建前端 → 打 NSIS 安装包 → 整理 OTA 发布产物。
 *
 * 用法（在 project/aitoearn-electron 目录执行）：
 *   npm run release              # 版本号 patch 位自动 +1（0.9.1 → 0.9.2）
 *   npm run release -- 0.10.0    # 显式指定版本号
 *
 * 产物目录：release/ota-<版本>/
 *   1. update.json            版本策略清单（version/force/rollout/notes，上传前可改）
 *   2. latest.yml             electron-updater 元数据
 *   3. 知音-<版本>.exe         完整安装包
 *   4. 知音-<版本>.exe.blockmap 差分更新数据（老用户增量下载靠它）
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundledBackend } from './build-backend.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptsDir, '..');
const pkgPath = path.join(projectDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

function bumpPatch(version) {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
  let patch = (parts[2] || 0) + 1;
  let minor = parts[1] || 0;
  // 十进制逢 10 进 1：补丁到 9 后进位到次版本，避免出现 0.9.10
  if (patch >= 10) {
    minor += 1;
    patch = 0;
  }
  return `${parts[0] || 0}.${minor}.${patch}`;
}

function run(command, options = {}) {
  execSync(command, { cwd: projectDir, stdio: 'inherit', ...options });
}

/**
 * 打包前强制校验随包后端配置已本地化（127.0.0.1）。
 *
 * 历史教训（0.9.3）：ai/config.yaml 残留 Docker 主机名（redis/mongodb/
 * zhiyin-server/rustfs.local），随包本地后端连不上数据库 → ai(3010) 健康检查
 * 超时 → nginx(8080) 网关未启动 → 前端所有 API 请求打空 → 功能页面全挂。
 * 打包环节必须有这道闸门，绝不允许 Docker 时代配置再次进入安装包。
 */
function validateBackendConfig() {
  const backendDir = path.join(projectDir, 'resources', 'backend');
  if (!fs.existsSync(backendDir))
    return;
  const dockerHosts = [
    /\bhost:\s*redis\b/,
    /\bhost:\s*mongodb\b/,
    /mongodb:\/\/admin:password@mongodb/,
    /zhiyin-server:3002/,
    /rustfs\.local/,
    /@mongodb:27017/,
  ];
  const apps = ['server', 'ai'];
  const offenders = [];
  for (const app of apps) {
    const file = path.join(backendDir, app, 'config.yaml');
    if (!fs.existsSync(file))
      continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of dockerHosts) {
      if (pattern.test(content)) {
        offenders.push(`${path.relative(projectDir, file)} 命中 Docker 残留: ${pattern}`);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `[release] 打包中止：随包后端配置存在 Docker 时代残留，必须改为本地 127.0.0.1 后才能打包。\n` +
      offenders.join('\n'),
    );
  }
  console.log('[release] 配置校验通过：随包后端 server/ai config.yaml 均为本地 127.0.0.1 配置');
}

const requested = process.argv.slice(2).find((arg) => /^\d+\.\d+\.\d+/.test(arg));
const nextVersion = requested || bumpPatch(pkg.version);

if (nextVersion === pkg.version && !requested) {
  throw new Error(`无法自动升级版本号：${pkg.version}，请显式指定版本，例如 npm run release -- 0.9.2`);
}

console.log('[release] 第零步：构建并同步随包后端');
buildBundledBackend();

console.log(`[release] 版本 ${pkg.version} → ${nextVersion}`);
pkg.version = nextVersion;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

// 打包前置校验：随包后端配置必须已本地化，防止 Docker 残留再次进入安装包（0.9.3 教训）
validateBackendConfig();

console.log('[release] 第一步：构建前端与主进程产物');
run('npx vite build');

console.log('[release] 第二步：打 NSIS 安装包（本步骤最耗时）');
run('npx electron-builder --win nsis --publish never', {
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});

const outDir = path.join(projectDir, 'release', nextVersion);
const stageDir = path.join(projectDir, 'release', `ota-${nextVersion}`);
fs.mkdirSync(stageDir, { recursive: true });

const artifactBase = `ZhiYin-${nextVersion}.exe`;
const stableArtifactBase = 'zhiyin-latest.exe';
const stableBlockmapBase = `${stableArtifactBase}.blockmap`;
for (const name of [artifactBase, `${artifactBase}.blockmap`, 'latest.yml']) {
  const src = path.join(outDir, name);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(stageDir, name));
  }
  else {
    console.warn(`[release] 未找到产物，已跳过：${name}`);
  }
}

const stableArtifactSource = [artifactBase, `-${nextVersion}.exe`]
  .map(name => path.join(outDir, name))
  .find(candidate => fs.existsSync(candidate));
const stableBlockmapSource = [`${artifactBase}.blockmap`, `-${nextVersion}.exe.blockmap`]
  .map(name => path.join(outDir, name))
  .find(candidate => fs.existsSync(candidate));

if (stableArtifactSource) {
  fs.copyFileSync(stableArtifactSource, path.join(stageDir, stableArtifactBase));
  console.log(`[release] 已生成稳定下载名：${stableArtifactBase}`);
}
if (stableBlockmapSource) {
  fs.copyFileSync(stableBlockmapSource, path.join(stageDir, stableBlockmapBase));
}

const latestYmlPath = path.join(stageDir, 'latest.yml');
if (fs.existsSync(latestYmlPath)) {
  const latestYml = fs.readFileSync(latestYmlPath, 'utf8')
    .replace(/^(\s+- url: ).*$/m, `$1${stableArtifactBase}`)
    .replace(/^path: .*$/m, `path: ${stableArtifactBase}`);
  fs.writeFileSync(latestYmlPath, latestYml, 'utf8');
  console.log('[release] latest.yml 已指向稳定下载名 zhiyin-latest.exe');
}

const updateJson = {
  version: nextVersion,
  force: false,
  rollout: 100,
  notes: '请在此填写本次更新说明',
  releaseDate: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(stageDir, 'update.json'),
  `${JSON.stringify(updateJson, null, 2)}\n`,
  'utf8',
);

console.log('');
console.log('[release] 打包完成，OTA 发布目录：', stageDir);
console.log('把该目录里的 4 个文件上传到更新服务器根目录即可：');
console.log(`  1. update.json（版本策略，可改 force/rollout/notes 后上传）`);
console.log(`  2. latest.yml`);
console.log(`  3. ${stableArtifactBase}`);
console.log(`  4. ${stableBlockmapBase}（差分更新用，务必保留）`);
