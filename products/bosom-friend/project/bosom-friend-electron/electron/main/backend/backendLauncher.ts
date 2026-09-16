/**
 * 随包后端启动器：内测版双击即用，不依赖 Docker。
 *
 * 组件（全部为 Windows 单文件进程，随安装包分发）：
 *  - mongod.exe       单机模式，数据目录 userData/backend-data/mongo
 *  - redis-server.exe 无密码，端口 6379
 *  - minio.exe        本地 S3 对象存储，端口 9001，凭据 rustfsadmin
 *  - nginx.exe        统一网关 8080（/api 分流 server/ai）+ 9000（S3 上传代理）
 *  - server(3002)/ai(3010)：复用 Electron 自带 Node 运行时执行编译产物
 *
 * 启动顺序：mongod → redis → minio → 初始化(默认用户+bucket) → server → ai → nginx。
 * 前端零改动：就绪后写 backend-config.json，preload 既有机制注入 8080 网关地址。
 */
import { app } from 'electron';
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../global/log';

/**
 * 随包后端使用独立的 Node 24 运行时，支持 `windowsPriority` 提升子进程优先级；
 * 当前 @types/node 22 类型定义尚未包含该字段，这里只做类型扩展，不改运行时行为。
 */
type BundledNodeSpawnOptions = SpawnOptions & {
  windowsPriority?: 'idle' | 'belownormal' | 'normal' | 'abovenormal' | 'high' | 'realtime';
};

const SERVER_PORT = 3002;
const AI_PORT = 3010;
const MONGO_PORT = 27017;
const REDIS_PORT = 6379;
const MINIO_PORT = 9001;
const NGINX_PORT = 8080;

let children: ChildProcess[] = [];
let started = false;

/** AI 服务子进程（独立引用：模型配置变更后热重启，实现“保存即生效”） */
let aiChild: ChildProcess | undefined;

function backendRoot(): string {
  return path.join(process.resourcesPath, 'backend');
}

function binDir(): string {
  return path.join(backendRoot(), 'bin');
}

function dataDir(): string {
  const dir = path.join(app.getPath('userData'), 'backend-data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 打包时依赖被打成 vendor.zip（规避 electron-builder 排除 node_modules 与 NSIS 文件数限制），
 *  首次运行解压并恢复为 node_modules 供 Node 解析。 */
function ensureDepsDir(): void {
  const vendorZip = path.join(backendRoot(), 'vendor.zip');
  const nodeModules = path.join(backendRoot(), 'node_modules');
  if (fs.existsSync(nodeModules))
    return;
  if (fs.existsSync(vendorZip)) {
    try {
      const sevenZip = path.join(binDir(), '7za.exe');
      const result = spawnSync(sevenZip, ['x', vendorZip, `-o${backendRoot()}`, '-y'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5 * 60 * 1000,
      });
      const vendor = path.join(backendRoot(), 'vendor');
      if (result.status === 0 && fs.existsSync(vendor)) {
        fs.renameSync(vendor, nodeModules);
        logger.info('[backend] 依赖已解压恢复为 node_modules');
      }
      else {
        logger.error('[backend] 依赖解压失败:', result.error ?? `status ${result.status}`);
      }
    }
    catch (e) {
      logger.error('[backend] 恢复依赖目录失败:', e);
    }
  }
}

/** 安装包内是否带有完整后端产物 */
export function isBundledBackend(): boolean {
  return (
    fs.existsSync(path.join(backendRoot(), 'server', 'src', 'main.js'))
    && fs.existsSync(path.join(backendRoot(), 'ai', 'src', 'main.js'))
    && fs.existsSync(path.join(binDir(), 'mongod.exe'))
  );
}

/** 读取打包时写入的密钥文件（AGNES_*_API_KEY、SMTP_PASS），注入子进程环境 */
function loadSecrets(): Record<string, string> {
  const secrets: Record<string, string> = {};
  try {
    const file = path.join(backendRoot(), 'secrets.env');
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const idx = line.indexOf('=');
        if (idx > 0) {
          const key = line.slice(0, idx).trim();
          const value = line.slice(idx + 1).trim();
          if (key && value)
            secrets[key] = value;
        }
      }
    }
  }
  catch (e) {
    logger.warn('[backend] 读取密钥文件失败:', e);
  }
  return secrets;
}

function spawnChild(
  bin: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): ChildProcess {
  const child = spawn(bin, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.on('data', (d) => logger.info(`[backend] ${String(d).trimEnd()}`));
  child.stderr?.on('data', (d) => logger.warn(`[backend] ${String(d).trimEnd()}`));
  return child;
}

/** 用随包独立 Node 24 运行时执行后端编译产物（后端依赖 Node 22+ 的 require ESM 能力） */
function spawnNode(
  entry: string,
  cwd: string,
  args: string[],
  env: Record<string, string>,
): ChildProcess {
  const nodeBin = path.join(binDir(), 'node', 'node.exe');
  const child = spawn(nodeBin, [entry, ...args], {
    cwd,
    env: {
      ...process.env,
      NODE_OPTIONS: '--dns-result-order=ipv4first',
      // 随包后端与桌面端在同机运行，必须访问 127.0.0.1 上的 APP 控制 MCP。
      ZHIYIN_APP_CONTROL_URL: 'http://127.0.0.1:3457/mcp',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // 高优先级：启动阶段 server/ai 需加载 300MB+ node_modules，易被
    // Windows Defender 实时扫描 + 主进程后台任务拖慢（实测手动 4s vs
    // APP 内 60s+）。设为 HIGH 让后端更快抢到 CPU/IO，显著缩短 splash 等待。
    windowsPriority: 'high',
  } as BundledNodeSpawnOptions);
  child.stdout?.on('data', (d) => logger.info(`[backend] ${String(d).trimEnd()}`));
  child.stderr?.on('data', (d) => logger.warn(`[backend] ${String(d).trimEnd()}`));
  return child;
}

function startMongod(): ChildProcess {
  const mongoData = path.join(dataDir(), 'mongo');
  fs.mkdirSync(mongoData, { recursive: true });
  return spawnChild(
    path.join(binDir(), 'mongod.exe'),
    // 单节点副本集：@Transactional（17处核心方法）依赖事务，事务必须 RS；见 ensureReplicaSet
    ['--dbpath', mongoData, '--port', String(MONGO_PORT), '--bind_ip', '127.0.0.1', '--quiet', '--replSet', 'zhiyin-rs'],
  );
}

/**
 * 单节点副本集初始化（幂等）：
 * 服务端 @Transactional 装饰器（账号增删改/分组/凭证/OAuth绑定/发布任务等17处）依赖 MongoDB 事务，
 * 事务在单机 mongod 上直接抛 "Transaction numbers are only allowed on a replica set member"。
 * 首次启动以 rs.initiate 将本机提升为单成员 RS，之后秒回。
 */
async function ensureReplicaSet(): Promise<void> {
  const rsName = 'zhiyin-rs';
  const scriptPath = path.join(backendRoot(), 'server', 'rs-init.cjs');
  const script = [
    "const { MongoClient } = require('mongodb');",
    '(async () => {',
    '  const port = process.env.RS_PORT || 27017;',
    `  const client = new MongoClient('mongodb://127.0.0.1:' + port + '/?directConnection=true', { serverSelectionTimeoutMS: 8000 });`,
    '  await client.connect();',
    "  const admin = client.db('admin');",
    "  const memberCfg = { _id: 'zhiyin-rs', members: [{ _id: 0, host: '127.0.0.1:' + port }] };",
    '  try {',
    '    const st = await admin.command({ replSetGetStatus: 1 });',
    "    if (st.set) console.log('[rs-init] already=' + st.set);",
    '  } catch (e) {',
    '    const msg = String((e && e.message) || e);',
    '    if (/not yet initialized/i.test(msg)) {',
    '      try {',
    '        await admin.command({ replSetInitiate: memberCfg });',
    "        console.log('[rs-init] initiated');",
    '      } catch (e2) {',
    "        if (!/already initialized/i.test(String(e2 && e2.message))) console.error('[rs-init] initiate-err:', String(e2 && e2.message).slice(0, 120));",
    '      }',
    '    } else if (/InvalidReplicaSetConfig|does not match|no replset config/i.test(msg)) {',
    '      console.error(\'[rs-init] invalid-config:\' + msg.slice(0, 120));',
    '      try {',
    '        await admin.command(Object.assign({ replSetReconfig: memberCfg, force: true }));',
    "        console.log('[rs-init] force-reconfigured');",
    '      } catch (e3) {',
    "        console.error('[rs-init] reconfig-fail:', String(e3 && e3.message).slice(0, 120));",
    '      }',
    '    } else if (/NoReplicationEnabled|not started with --replSet/i.test(msg)) {',
    "      console.error('[rs-init] foreign-mongod-on-port'); process.exit(3);",
    '    } else {',
    "      console.error('[rs-init] status-err:', msg.slice(0, 120));",
    '    }',
    '  }',
    '  for (let i = 1; i <= 150; i++) {',
    '    await new Promise(r => setTimeout(r, 1000));',
    '    try {',
    '      const s = await admin.command({ replSetGetStatus: 1 });',
    '      const states = (s.members || []).map(m => m.stateStr).join(\',\');',
    '      if ((s.members || []).some(m => m.stateStr === \'PRIMARY\')) {',
    "        console.log('[rs-init] PRIMARY after ' + i + 's');",
    '        await client.close(); process.exit(0);',
    '    }',
    '      if (i % 15 === 0) console.log(\'[rs-init] waiting:\' + states);',
    '    } catch (e4) { if (i % 15 === 0) console.log(\'[rs-init] poll:\' + String(e4 && e4.message).slice(0, 60)); }',
    '  }',
    "  console.error('[rs-init] PRIMARY timeout');",
    '  process.exit(2);',
    '})().catch(e => { console.error("[rs-init] fail:", e.message); process.exit(1); });',
  ].join('\n');
  fs.writeFileSync(scriptPath, script, 'utf8');
  await new Promise<void>((resolve) => {
    let out = '';
    const child = spawnNode(
      scriptPath,
      path.join(backendRoot(), 'server'),
      ['--max-old-space-size=256'],
      { RS_PORT: String(MONGO_PORT) },
    );
    child.stdout?.on('data', (d) => { out += String(d); });
    child.stderr?.on('data', (d) => { out += String(d); });
    child.on('exit', (code) => {
      logger.info(`[backend] 副本集初始化(${rsName}) exit=${code} ${out.trim().slice(-200)}`);
      resolve();
    });
    child.on('error', () => resolve());
  });
}

function startRedis(): ChildProcess {
  // Redis 仅作队列/缓存，无需持久化：
  // - 关闭 RDB 快照（--save ""）：否则每 60s 尝试往 cwd 写 dump.rdb，
  //   安装在 Program Files 下无写权限 → MISCONF 禁写 → BullMQ 全挂 → 启动极慢（0.9.3 教训）
  // - 显式指定 dir 到用户数据目录（可写），防止任何落盘动作打到安装目录
  const redisData = path.join(dataDir(), 'redis');
  fs.mkdirSync(redisData, { recursive: true });
  return spawnChild(
    path.join(binDir(), 'redis-server.exe'),
    [
      '--port', String(REDIS_PORT),
      '--bind', '127.0.0.1',
      '--save', '',
      '--appendonly', 'no',
      '--dir', redisData,
    ],
  );
}

function startMinio(): ChildProcess {
  return spawnChild(
    path.join(binDir(), 'minio.exe'),
    ['server', path.join(dataDir(), 'files'), '--address', `127.0.0.1:${MINIO_PORT}`, '--console-address', ':19001', '--quiet'],
    {
      env: {
        MINIO_ROOT_USER: 'rustfsadmin',
        MINIO_ROOT_PASSWORD: 'rustfsadmin',
      },
    },
  );
}

let nginxPid: number | undefined;

function startNginx(): ChildProcess {
  for (const tmp of ['client_body_temp', 'proxy_temp', 'fastcgi_temp', 'uwsgi_temp', 'scgi_temp']) {
    fs.mkdirSync(path.join(backendRoot(), 'nginx', 'temp', tmp), { recursive: true });
  }
  const child = spawnChild(
    path.join(binDir(), 'nginx', 'nginx-1.26.2', 'nginx.exe'),
    ['-p', path.join(backendRoot(), 'nginx'), '-c', 'conf/nginx.conf'],
  );
  nginxPid = child.pid;
  return child;
}

/** 启动自愈：清掉上次异常退出遗留的本应用 nginx 进程（仅匹配随包路径，绝不误伤其他 nginx） */
function sweepStaleNginx(): void {
  try {
    const exe = path.join(binDir(), 'nginx', 'nginx-1.26.2', 'nginx.exe');
    const ps = `Get-CimInstance Win32_Process -Filter "Name='nginx.exe'" | Where-Object { $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => {});
  }
  catch {
    // 自愈失败不阻塞启动
  }
}

async function waitHttp(url: string, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        logger.info(`[backend] ${label} 就绪: ${url}`);
        return true;
      }
    }
    catch {
      // 未就绪，继续等待
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  logger.error(`[backend] ${label} 启动超时: ${url}`);
  return false;
}

async function waitTcp(port: number, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const probe = spawn(
          process.execPath,
          [
            '-e',
            `const net=require('net');const s=net.connect(${port},'127.0.0.1');s.setTimeout(1500,()=>process.exit(1));s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));`,
          ],
          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true },
        );
        probe.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`port ${port} 未就绪`))));
      });
      logger.info(`[backend] ${label} 就绪（端口 ${port}）`);
      return true;
    }
    catch {
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  logger.error(`[backend] ${label} 启动超时（端口 ${port}）`);
  return false;
}

/** 首次启动初始化：写入默认用户 + 创建对象存储桶 */
async function runInit(secrets: Record<string, string>): Promise<void> {
  const initJs = path.join(backendRoot(), 'server', 'init.mjs');
  if (!fs.existsSync(initJs))
    return;
  await new Promise<void>((resolve) => {
    const child = spawnNode(
      initJs,
      path.join(backendRoot(), 'server'),
      [],
      {
        MONGO_URI: `mongodb://127.0.0.1:${MONGO_PORT}`,
        DB_NAME: 'zhiyin',
        S3_ENDPOINT: `http://127.0.0.1:${MINIO_PORT}`,
        ...secrets,
      },
    );
    child.on('exit', () => resolve());
  });
}

/**
 * 启动随包后端。返回是否全部就绪。
 * 开发模式或安装包未内置后端产物时返回 false，调用方保持原有外部后端行为。
 */
export async function startBundledBackend(): Promise<boolean> {
  if (started)
    return true;
  if (!isBundledBackend()) {
    logger.info('[backend] 安装包未内置后端产物，保持外部后端模式');
    return false;
  }

  started = true;
  sweepStaleNginx();
  const secrets = loadSecrets();
  try {
    ensureDepsDir();
    children.push(startMongod());
    children.push(startRedis());
    children.push(startMinio());

    const [mongoOk, redisOk, minioOk] = await Promise.all([
      waitTcp(MONGO_PORT, 60_000, 'mongod'),
      waitTcp(REDIS_PORT, 30_000, 'redis'),
      waitTcp(MINIO_PORT, 60_000, 'minio'),
    ]);
    if (!mongoOk || !redisOk || !minioOk)
      return false;

    // 必须先于 runInit：init 与服务端的一切写操作都可能走事务
    await ensureReplicaSet();

    await runInit(secrets);

    const root = backendRoot();
    children.push(spawnNode(
      path.join(root, 'server', 'src', 'main.js'),
      path.join(root, 'server'),
      ['-c', 'config.yaml'],
      secrets,
    ));
    aiChild = spawnNode(
      path.join(root, 'ai', 'src', 'main.js'),
      path.join(root, 'ai'),
      ['-c', 'config.yaml'],
      secrets,
    );
    children.push(aiChild);

    // 冷启动等待放宽到 180 秒：server/ai 需加载 300MB+ node_modules，
    // 冷启动实测 120-150 秒（Defender 扫描 + IO 竞争）。原 120 秒超时会在
    // server 恰好就绪前判定失败 → 子进程被清理 → 前端全挂（0.9.3 教训）。
    const [serverOk, aiOk] = await Promise.all([
      waitHttp(`http://127.0.0.1:${SERVER_PORT}/health`, 180_000, 'server'),
      waitHttp(`http://127.0.0.1:${AI_PORT}/health`, 180_000, 'ai'),
    ]);
    if (!serverOk || !aiOk)
      return false;

    children.push(startNginx());
    await waitHttp(`http://127.0.0.1:${NGINX_PORT}/_nhealth`, 30_000, 'nginx');

    writeRuntimeConfig();
    logger.info('[backend] 随包后端全部就绪（网关 8080）');
    return true;
  }
  catch (e) {
    logger.error('[backend] 随包后端启动异常:', e);
    return false;
  }
}

/** 把 8080 网关地址写入 backend-config.json：preload 既有机制自动注入渲染层 */
function writeRuntimeConfig(): void {
  try {
    const file = path.join(app.getPath('userData'), 'backend-config.json');
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        JSON.stringify({ apiBaseUrl: `http://127.0.0.1:${NGINX_PORT}/api` }, null, 2),
        'utf8',
      );
    }
  }
  catch (e) {
    logger.warn('[backend] 写入运行时后端配置失败:', e);
  }
}

/** APP 退出时停止所有随包子进程 */
export function stopBundledBackend(): void {
  if (nginxPid) {
    try {
      // nginx 在 Windows 下 kill 主进程不会传播到 worker，必须整树强杀。
      // 同步执行且必须先于通用 child.kill()——否则 master 先死，taskkill 扑空导致 worker 泄漏。
      spawnSync('taskkill', ['/PID', String(nginxPid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 8000,
        windowsHide: true,
      });
    }
    catch {
      // 已退出或超时
    }
    nginxPid = undefined;
  }
  // 随包子进程整树强杀：Windows 下 child.kill() 对 mongod/redis/minio 等原生进程
  // 不生效（软信号被忽略），必须 taskkill /T /F 连子树一起终止，否则退出后残留。
  for (const child of children) {
    const pid = child.pid;
    if (!pid)
      continue
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 8000,
        windowsHide: true,
      });
    }
    catch {
      // 已退出或超时
    }
  }
  children = [];
  aiChild = undefined;
  started = false;

  // 兜底：按安装路径精确清扫一切残留（只对随包 bin 目录，绝不误伤系统进程）
  try {
    const binEsc = path.join(backendRoot(), 'bin').replace(/\\/g, '\\\\')
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${binEsc}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { stdio: 'ignore', timeout: 8000, windowsHide: true })
  }
  catch {
    // 清扫失败不阻塞退出
  }
}

/**
 * 热重启 AI 服务子进程（保存自定义大模型配置后调用，使新 Key/模型/BaseURL 立即生效）。
 * 只重启 AI(3010)，不动 mongo/redis/minio/server/nginx。
 * 非随包后端模式或未启动时返回 false（无操作）。
 */
export async function restartAiService(): Promise<boolean> {
  if (!started || !aiChild) {
    return false;
  }
  try {
    aiChild.kill();
  }
  catch {
    // 进程可能已退出
  }
  const index = children.indexOf(aiChild);
  if (index >= 0)
    children.splice(index, 1);
  aiChild = undefined;

  const root = backendRoot();
  const secrets = loadSecrets();
  aiChild = spawnNode(
    path.join(root, 'ai', 'src', 'main.js'),
    path.join(root, 'ai'),
    ['-c', 'config.yaml'],
    secrets,
  );
  children.push(aiChild);
  logger.info('[backend] AI 服务已重启（模型配置变更生效）');
  return await waitHttp(`http://127.0.0.1:${AI_PORT}/health`, 120_000, 'ai(restart)');
}
