#!/usr/bin/env node
/**
 * 发布链路防复发门禁：把 2026-09-29 修掉的"发布必失败 / 成功记失败"缺陷钉成可执行断言。
 *
 * 为什么用结构断言：现场（抖音短信验证、多会话抢号、平台会话轮换）无法在 CI 复现，
 * 但"代码里那道闸还在不在"可以精确检查。每条断言都配一个回退样本自检——
 * 把新写法换回旧写法时断言必须判红，否则这条断言等于没写（铁律 #16）。
 *
 * 用法：
 *   node products\bosom-friend\qa\verify-publish-pipeline.mjs
 *   node products\bosom-friend\qa\verify-publish-pipeline.mjs --self-test
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const product = resolve(here, '..')
const read = p => { try { return readFileSync(p, 'utf8') } catch { return '' } }

const ENGINE = 'engine/worker.py'
const UPLOADER = 'engine/social-auto-upload/uploader/douyin_uploader/main.py'
const XHS_UPLOADER = 'engine/social-auto-upload/uploader/xiaohongshu_uploader/main.py'
const LOGIN = 'server/src/platform-login.ts'
const API = 'server/src/api.ts'
const ROUTES = 'server/src/routes-channels.ts'
const DEVWEB = 'launcher/scripts/dev-web.ps1'

/** 单条断言：ok 判"闸还在"，broken 判"改回旧写法会红"。 */
const SPECS = [
  {
    name: '短信验证码等待有上限（超时即失败，不再无限转圈）',
    file: UPLOADER,
    ok: s => s.includes('DOUYIN_SMS_VERIFY_WAIT_SECONDS = float(')
      && s.includes('now - sms_wait_started > DOUYIN_SMS_VERIFY_WAIT_SECONDS'),
    broken: s => s.replace('DOUYIN_SMS_VERIFY_WAIT_SECONDS = float(', 'UNUSED_LIMIT = float(')
      .replace('now - sms_wait_started > DOUYIN_SMS_VERIFY_WAIT_SECONDS', 'False'),
    fix: 'main.py：弹窗出现开始计时，超过 300 秒抛错退出（旧：while True 永久 3.2 秒一轮）',
  },
  {
    name: '验证码超时能穿透发布重试循环',
    file: UPLOADER,
    ok: s => s.includes('class DouyinPublishFatal') && s.includes('except DouyinPublishFatal:'),
    broken: s => s.replace('except DouyinPublishFatal:', 'except NonexistentError:')
      .replace('class DouyinPublishFatal(RuntimeError):', 'class OtherError(RuntimeError):'),
    fix: 'main.py：except DouyinPublishFatal 先于 except Exception 重新抛出（旧：被 except Exception 吞掉）',
  },
  {
    name: '「获取验证码」整次发布只点一次',
    file: UPLOADER,
    ok: s => s.includes('sms_code_requested'),
    broken: s => s.replace(/sms_code_requested/g, 'sms_code_req_disabled'),
    fix: 'main.py：用 sms_code_requested 拦重复点击（旧：每轮循环都可能再点一次）',
  },
  {
    name: '引擎子进程上限小于服务端看门狗（不再留僵尸 worker）',
    file: ENGINE,
    ok: s => {
      const m = s.match(/PUBLISH_COMMAND_TIMEOUT_S\s*=\s*float\(os\.environ\.get\([^,]+,\s*"([\d.]+)"\)\)/)
      return m !== null && Number(m[1]) < 20 * 60
    },
    broken: s => s.replace(/PUBLISH_COMMAND_TIMEOUT_S\s*=\s*float\(os\.environ\.get\([^,]+,\s*"[\d.]+"\)\)/, 'PUBLISH_COMMAND_TIMEOUT_S = float(os.environ.get("BOSOM_PUBLISH_TIMEOUT_S", "1800"))'),
    fix: 'worker.py：默认 1020 秒，与回读预算之和必须小于 platform-login.ts 的 PUBLISH_TASK_BUDGET_MS（旧：1800 秒）',
  },
  {
    name: '引擎输出实时落 worker.log，超时按整棵进程树终止',
    file: ENGINE,
    ok: s => s.includes('def _kill_process_tree') && s.includes('log_file = task_dir / "worker.log"')
      && s.includes('taskkill') && s.includes('_kill_process_tree(proc.pid)'),
    broken: s => s.replace('def _kill_process_tree(pid: int) -> None:', 'def _unused_tree_kill(pid: int) -> None:')
      .replace('_kill_process_tree(proc.pid)', 'proc.kill()'),
    fix: 'worker.py：Popen + 读取线程落盘；超时 taskkill /T /F（旧：capture_output 全在内存、只杀直接子进程）',
  },
  {
    name: '回读作品列表使用引擎刷新后的 cookie',
    file: ENGINE,
    ok: s => s.includes('storage_file = account_file if account_file.exists()'),
    broken: s => s.replace('storage_file = account_file if account_file.exists() and account_file.stat().st_size > 0 else task_dir / "storage.json"', 'storage_file = task_dir / "storage.json"'),
    fix: 'worker.py：用 sau_cli 写回的 account_file（旧：发布前那份 storage.json，必然被判登录失效）',
  },
  {
    name: '回读按「时间窗 + 标题」挑本次作品，不取列表最新一条（DEF-301）',
    file: ENGINE,
    ok: s => s.includes('def _pick_published_work(')
      && s.includes('newest = _pick_published_work(works, expect_title, not_before)')
      && s.includes('readback_deadline = time.monotonic() + READBACK_BUDGET_S')
      && !s.includes('newest = max(works, key=lambda w: str(w.get("publishTime") or ""), default=None) if works else None'),
    broken: s => s.replace('newest = _pick_published_work(works, expect_title, not_before)', 'newest = max(works, key=lambda w: str(w.get("publishTime") or ""), default=None) if works else None'),
    fix: 'worker.py：时间窗（publishTime ≥ 本次开始时间）＋ 标题精确匹配优先，20 分钟墙上时钟预算内每 20 秒重抓一次（旧：发布后立即取列表最新一条；新作品还没刷新时回填历史作品 ID——2026-10-13 实测）',
  },
  {
    name: '回读预算按墙上时钟，且收工前落「已提交」阶段标记（DEF-305）',
    file: ENGINE,
    ok: s => s.includes('readback_deadline = time.monotonic() + READBACK_BUDGET_S')
      && s.includes('READBACK_MAX_ATTEMPTS')
      && s.includes('stage="已提交，等待平台列表回读"')
      && s.includes('回读第 %d 轮：列表 %d 条'),
    broken: s => s.replace('readback_deadline = time.monotonic() + READBACK_BUDGET_S', 'readback_deadline = time.monotonic()'),
    fix: 'worker.py：20 分钟墙上时钟预算（每轮重抓要开一次浏览器，轮数×20 秒是名义值）+ 每轮留痕 + 发布动作完成后先写「已提交，等待平台列表回读」（旧：30 轮名义 10 分钟、实际可跑 30+ 分钟，被服务端看门狗在半路杀掉且无从对质——2026-10-13 现场）',
  },
  {
    name: '预算同一张表：引擎总量（发布步骤 + 回读）小于服务端 PUBLISH_TASK_BUDGET_MS（DEF-305）',
    file: LOGIN,
    ok: s => {
      const engine = read(join(product, 'engine', 'worker.py'))
      const command = engine.match(/PUBLISH_COMMAND_TIMEOUT_S\s*=\s*float\(os\.environ\.get\([^,]+,\s*"([\d.]+)"\)\)/)
      const readback = engine.match(/READBACK_BUDGET_S\s*=\s*(\d+)\s*\*\s*60\b/)
      const budget = s.match(/PUBLISH_TASK_BUDGET_MS\s*=\s*(\d+)\s*\*\s*60_000/)
      if (command === null || readback === null || budget === null) return false
      const engineTotalMs = (Number(command[1]) + Number(readback[1]) * 60) * 1000
      return engineTotalMs < Number(budget[1]) * 60_000
    },
    broken: s => s.replace(/PUBLISH_TASK_BUDGET_MS\s*=\s*45 \* 60_000/, 'PUBLISH_TASK_BUDGET_MS = 20 * 60_000'),
    fix: 'platform-login.ts：PUBLISH_TASK_BUDGET_MS（45 分钟）必须大于引擎的发布步骤上限 + READBACK_BUDGET_S（旧：20 分钟看门狗恰好落在第 21 轮回读中间，平台动作已执行却判超时——2026-10-13 现场；三处预算必须一起改）',
  },
  {
    name: '看门狗也能立刻收「进程已死」的任务，不必等预算耗尽（DEF-305）',
    file: LOGIN,
    ok: s => s.includes('function publishWorkerAlive(')
      && s.includes('const dead = oldEnough && !publishWorkerAlive(taskDir)'),
    broken: s => s.replace('const dead = oldEnough && !publishWorkerAlive(taskDir)', 'const dead = false'),
    fix: 'platform-login.ts：getPublishState 对「state 还在跑、worker.pid 进程已不存在」立即判失败（旧：只有启动时的悬挂回收会收死任务，运行中新死的要卡到预算耗尽）',
  },
  {
    name: '收尸文案统一：可能已发出 → 先同步、不要重复发布（DEF-305）',
    file: LOGIN,
    ok: s => s.includes('export const PUBLISH_RESULT_UNKNOWN_MESSAGE')
      && s.includes('不要重复发布'),
    broken: s => s.replaceAll('PUBLISH_RESULT_UNKNOWN_MESSAGE', 'PUBLISH_RESULT_MESSAGE_RENAMED'),
    fix: 'platform-login.ts：看门狗/超时/悬挂回收统一用 PUBLISH_RESULT_UNKNOWN_MESSAGE（旧：超时文案"请检查账号与平台页面后重试"会诱导重发，把可能已发出的内容再发一遍——DEF-240 教训）',
  },
  {
    name: '发布轮询预算与服务端预算同源（DEF-305）',
    file: ROUTES,
    ok: s => s.includes('const deadline = Date.now() + PUBLISH_TASK_BUDGET_MS')
      && s.includes('PUBLISH_RESULT_UNKNOWN_MESSAGE'),
    broken: s => s.replace('const deadline = Date.now() + PUBLISH_TASK_BUDGET_MS', 'const deadline = Date.now() + 20 * 60 * 1000'),
    fix: 'routes-channels.ts：轮询 deadline 与超时文案都取自 platform-login.ts（旧：各自写死 20 分钟，和引擎预算对不上）',
  },
  {
    name: '小红书发布以响应体判成功/拒发，不再只看 HTTP 200（DEF-305 现场证据）',
    file: XHS_UPLOADER,
    ok: s => s.includes('_xhs_publish_response_verdict') && s.includes('class XhsPublishRejected')
      && s.includes('发布接口响应：POST') && s.includes('except XhsPublishRejected:'),
    broken: s => s.replace('except XhsPublishRejected:', 'except NonexistentError:'),
    fix: 'xiaohongshu_uploader/main.py：发布接口响应体落日志；success:false / code≠0 直接抛 XhsPublishRejected 终止（旧：HTTP 200 即算成功，平台在响应体里拒发会被记成「已发布」——2026-10-13 现场：引擎报成功、账号 22-61 分钟后仍无任何痕迹）',
  },
  {
    name: '失败原因写入 state/记录前先压缩：平台原文优先（DEF-306）',
    file: ENGINE,
    ok: s => s.includes('def _condense_engine_error(')
      && s.includes('error=f"平台发布失败: {_condense_engine_error(exc)}"')
      && s.includes('平台原文：'),
    broken: s => s.replace('error=f"平台发布失败: {_condense_engine_error(exc)}"', 'error=f"平台发布失败: {exc}"'),
    fix: 'worker.py：失败写库前用 _condense_engine_error 压缩——优先响应体里的平台原文 "msg"，否则末 3 行（旧：整段日志连 ANSI 颜色码一起写进记录，真原因挤在最末行——2026-10-13 现场：记录 errorMsg 里「禁言」两字要翻到第 11 行才看得到）',
  },
  {
    name: '发布内容体检：过程叙述本地拒发（DEF-303）',
    file: ENGINE,
    ok: s => s.includes('_process_marks') && s.includes('for mark in _process_marks') && s.includes('发布内容疑似过程叙述'),
    broken: s => s.replace('any(mark in _title_text or mark in _desc_text for mark in _process_marks)', 'False'),
    fix: 'worker.py：标题/正文命中「交给发布管家 / 已经办了 / 剩下的交给」等过程语即本地拒发、不出站（旧：把助手回复当成品文案直接上传——2026-10-13 实测）',
  },
  {
    name: '发布内容体检：服务端弹窗路径与引擎共用同一份过程语清单（DEF-303）',
    file: ROUTES,
    ok: s => {
      const engine = read(join(product, 'engine', 'worker.py'))
      const py = engine.match(/_process_marks = \(([^)]*)\)/)
      const ts = s.match(/const narrationMarks = \[([^\]]*)\]/)
      if (py === null || ts === null) return false
      const pyMarks = [...py[1].matchAll(/"([^"]+)"/g)].map(m => m[1]).sort()
      const tsMarks = [...ts[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort()
      return pyMarks.length > 0 && pyMarks.join('|') === tsMarks.join('|')
    },
    broken: s => s.replace('const narrationMarks = [', 'const narrationMarksUnused = ['),
    fix: 'routes-channels.ts：flows 落库前命中过程语清单即拒（清单与 worker.py 的 _process_marks 必须逐项一致——两处各写一份防漏，门禁校验一致；旧：弹窗路径把助手回复当成品提交，一路到引擎才被拒——2026-10-13 实测）',
  },
  {
    name: '悬挂发布回收：进程已死的 publish 任务在启动时被收掉（DEF-304）',
    file: LOGIN,
    ok: s => s.includes('export function sweepStalePublishTasks') && s.includes('process.kill(pid, 0)'),
    broken: s => s.replace('export function sweepStalePublishTasks', 'function sweepDisabled'),
    fix: 'platform-login.ts：启动时扫 publish 目录——state 仍在跑但 worker 进程不存在（或超过 20 分钟）即判 failed 并回写记录；否则死任务永久占用同账号串行闸门（2026-10-13 实测：一条悬挂把账号后续发布全部挡死）',
  },
  {
    name: '启动接线：悬挂回收跑在排期恢复之前（DEF-304）',
    file: API,
    ok: s => s.includes('sweepStalePublishTasks({ dataRoot: deps.dataRoot') && s.includes('const scheduleResume = resumeScheduledPublishes(deps)'),
    broken: s => s.replace('sweepStalePublishTasks({ dataRoot: deps.dataRoot', 'sweepDisabled({ dataRoot: deps.dataRoot'),
    fix: 'api.ts：装载阶段先回收悬挂发布，再恢复排期（旧：重启后没有任何一轮去看死任务）',
  },
  {
    name: '按账号复用持久档案 + 账号 id 透传',
    file: ENGINE,
    ok: s => s.includes('account_name = str(inp.get("accountId") or "").strip()'),
    broken: s => s.replace('account_name = str(inp.get("accountId") or "").strip() or ("task-" + str(task_dir.name).replace("\\\\", "_").replace("/", "_"))', 'account_name = "task-" + str(task_dir.name)'),
    fix: 'worker.py：accountId 优先（旧：task-<taskId>，每次发布都是新设备登录）',
  },
  {
    name: 'input.json 带 accountId（前端→服务端→引擎）',
    file: LOGIN,
    ok: s => s.includes("{ accountId: input.accountId }"),
    broken: s => s.replace('...(input.accountId === undefined || input.accountId === \'\' ? {} : { accountId: input.accountId }),', ''),
    fix: 'platform-login.ts：把账号 id 写进引擎入参（缺它引擎只能按任务命名档案）',
  },
  {
    name: '看门狗判超时后真正终止 worker 进程树',
    file: LOGIN,
    // PID 落点必须是任务目录（曾写成 cwd=引擎目录，导致超时清理是空操作）：
    // 断言绑"这个文件写在任务目录"，而不是绑某个变量名。
    ok: s => s.includes('function killPublishWorker') && s.includes("join(pidDir, 'worker.pid')")
      && s.includes('killPublishWorker(taskDir)'),
    broken: s => s.replace('killPublishWorker(taskDir)', '// removed')
      .replace("function killPublishWorker(taskDir: string): void {", 'function killPublishWorkerDisabled(taskDir: string): void {'),
    fix: 'platform-login.ts：spawn 记 worker.pid，看门狗超时调用 killPublishWorker 用 taskkill 终止整树（旧：只改 state.json，进程还在跑）',
  },
  {
    name: '同一账号发布串行（不并发抢号）',
    file: ROUTES,
    ok: s => s.includes('function findRunningPublish(')
      && s.includes('const running = findRunningPublish(d, accountId)')
      && s.includes('该账号已有发布任务在进行中'),
    // 只破坏"闸门被接上"这一处：函数定义还在、文案还在，但调度再也不会拒单——
    // 这样才检验得到断言绑的是闸本身，而不是符号名（第一版就是这么假绿的）。
    broken: s => s.replace('const running = findRunningPublish(d, accountId)', 'const running = undefined'),
    fix: 'routes-channels.ts：调度前查同账号在跑任务并拒绝（铁律 #11 第 4 条：不并发轰炸）',
  },
  {
    name: '前端构建前把 TEMP 指到工作区（避免失败构建删空 dist 导致白屏）',
    file: DEVWEB,
    ok: s => s.includes("$env:TEMP = Join-Path $repo 'analysis\\_tmp'"),
    broken: s => s.replace("$env:TEMP = Join-Path $repo 'analysis\\_tmp'", "# removed"),
    fix: 'dev-web.ps1：-Frontend 前设 TEMP/TMP（旧：esbuild 失败会连带删掉整个 dist）',
  },
]

const selfTest = process.argv.includes('--self-test')
const sources = new Map()
for (const spec of SPECS) if (!sources.has(spec.file)) sources.set(spec.file, read(join(product, spec.file)))

let failed = 0
console.log('发布链路防复发门禁（结构断言 + 负向对照）')
console.log('')
for (const spec of SPECS) {
  const src = sources.get(spec.file) ?? ''
  const present = src !== ''
  const forward = present && spec.ok(src)
  const backward = present && spec.ok(spec.broken(src)) === false
  const verdict = forward && backward ? 'PASS' : 'FAIL'
  if (verdict === 'FAIL') failed += 1
  console.log(verdict + '  ' + spec.name)
  console.log('      ' + spec.file)
  if (!present) console.log('      -> 文件不存在或读不到')
  else if (!forward) console.log('      -> 源码里找不到这道闸（回归）')
  else if (!backward) console.log('      -> 负向对照没判红：断言过宽，等于没写（铁律 #16）')
  else if (!selfTest) console.log('      ' + spec.fix)
}
// DEF-301 行为断言（结构断言之外的现场对照）：直接调用引擎里的选择函数跑两组场景。
// 依赖 engine/.venv 的 python；找不到 venv（CI / 无引擎环境）时如实跳过——结构断言仍在守代码里的闸。
{
  const python = join(product, 'engine', '.venv', 'Scripts', 'python.exe')
  if (!existsSync(python)) {
    console.log('SKIP  行为断言：未找到 engine/.venv python（只跑结构断言）')
  } else {
    const code = [
      'import sys; sys.path.insert(0, r"' + join(product, 'engine') + '")',
      'import worker',
      "START = '2026-10-13T13:39:22.104Z'",
      "OLD = {'dataId': 'OLD', 'title': '旧标题', 'publishTime': '2026-10-13T03:30:30+00:00'}",
      "NEW = {'dataId': 'NEW', 'title': '本次标题', 'publishTime': '2026-10-13T13:41:00+00:00'}",
      "a = worker._pick_published_work([OLD], '本次标题', START)",
      "b = worker._pick_published_work([OLD, NEW], '本次标题', START)",
      "print('PICK_OK' if (a is None and b is not None and b.get('dataId') == 'NEW') else 'PICK_FAIL a=%r b=%r' % (a, b))",
    ].join('\n')
    const run = spawnSync(python, ['-c', code], { encoding: 'utf8', timeout: 60000 })
    const ok = (run.stdout ?? '').includes('PICK_OK')
    if (!ok) failed += 1
    console.log((ok ? 'PASS' : 'FAIL') + '  行为断言：旧作品不选 / 本次作品按标题命中')
    if (!ok) console.log('      -> ' + ((run.stdout ?? '') + (run.stderr ?? '')).replace(/\s+/g, ' ').slice(0, 300))
  }
  console.log('')
}
console.log('PUBLISH_PIPELINE checks=' + SPECS.length + ' fail=' + failed)
process.exit(failed === 0 ? 0 : 1)
