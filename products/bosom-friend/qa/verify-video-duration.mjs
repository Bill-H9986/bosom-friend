#!/usr/bin/env node
/**
 * 视频时长规划的行为验收：所有档位都必须落在 Agnes 官方区间内，且成片时长等于所选档位。
 *
 * 背景：官方单次下单 seconds 只收 "4"~"12"，而产品要支持 30 秒 / 1 分钟。规划错了在端到端里
 * 极难发现（合成成功、时长却不对），所以规划必须可离线逐条验收。
 *
 * 断言：
 *   1. 现有 4~12 档位规划结果与既有行为完全一致（单片、不合成）——证明改动不会碰坏在用流程；
 *   2. 30 / 60 档位切成多片，每片都在官方 4~12 内，且各片之和**恒等于**目标时长；
 *   3. 对 13~300 秒的每个整数目标做全量不变量检查（无遗漏、无越界）；
 *   4. 成片时长与目标的收敛判定：0.5 秒内不动，超出按裁齐 / 补足给方向；
 *   5. 耗时预估与片段数一致。
 *
 * 用法：node products/bosom-friend/qa/verify-video-duration.mjs
 * 退出码：0 = 通过；1 = 失败；2 = 缺少构建产物。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const qaDir = dirname(fileURLToPath(import.meta.url))
const productRoot = join(qaDir, '..')
const built = join(productRoot, 'server', 'lib', 'types', 'video-duration.js')

if (!existsSync(built)) {
  console.error('缺少构建产物，请先执行 pnpm --filter @deepseek-ai/dsh-bosom-friend-server build')
  console.error('VIDEO_DURATION SKIP missing=' + built)
  process.exit(2)
}

const mod = await import(pathToFileURL(built).href)
const { planClipSeconds, planTotalSeconds, conformAction, estimateMinutes, PRODUCT_VIDEO_GEARS, COMPOSED_VIDEO_GEARS } = mod
const OFFICIAL_MIN = 4
const OFFICIAL_MAX = 12
const checks = []
/** @param name - 断言名。 @param ok - 是否通过。 @param detail - 失败证据。 */
function check(name, ok, detail) { checks.push({ name, ok, detail: detail ?? '' }) }

// 1) 现有档位零变化
for (const gear of PRODUCT_VIDEO_GEARS) {
  const plan = planClipSeconds(gear)
  check('档位 ' + gear + 's 仍是单片', plan.composed === false && plan.clips.length === 1 && plan.clips[0] === gear, JSON.stringify(plan))
}

// 2) 多片档位
{
  const p30 = planClipSeconds(30)
  check('30s 切成多片', p30.composed === true && p30.clips.length > 1, JSON.stringify(p30.clips))
  check('30s 各片之和 = 30', planTotalSeconds(p30) === 30, String(planTotalSeconds(p30)))
  check('30s 每片都在官方 4~12', p30.clips.every(c => c >= OFFICIAL_MIN && c <= OFFICIAL_MAX), JSON.stringify(p30.clips))
  const p60 = planClipSeconds(60)
  check('60s 各片之和 = 60', planTotalSeconds(p60) === 60, String(planTotalSeconds(p60)))
  check('60s 每片都在官方 4~12', p60.clips.every(c => c >= OFFICIAL_MIN && c <= OFFICIAL_MAX), JSON.stringify(p60.clips))
  check('60s 按 4 秒切片（15 片）', p60.clips.every(c => c === 4), JSON.stringify(p60.clips))
  const p13 = planClipSeconds(13)
  check('13s = 4+4+5', JSON.stringify(p13.clips) === JSON.stringify([4, 4, 5]), JSON.stringify(p13.clips))
}

// 3) 全量不变量（13~300）
{
  let bad = ''
  for (let target = 13; target <= 300; target += 1) {
    const plan = planClipSeconds(target)
    const sum = planTotalSeconds(plan)
    if (sum !== target) { bad = target + ' sum=' + sum; break }
    if (!plan.clips.every(c => c >= OFFICIAL_MIN && c <= OFFICIAL_MAX)) { bad = target + ' clips=' + JSON.stringify(plan.clips); break }
    if (plan.clips.length < 2) { bad = target + ' not composed'; break }
  }
  check('13~300 秒全量不变量', bad === '', bad)
}

// 4) 收敛判定
check('10.14s vs 10s 不动（容差内）', conformAction(10.14, 10).action === 'none', JSON.stringify(conformAction(10.14, 10)))
check('31.2s vs 30s 判裁齐', conformAction(31.2, 30).action === 'trim', JSON.stringify(conformAction(31.2, 30)))
check('28.4s vs 30s 判补足', conformAction(28.4, 30).action === 'pad', JSON.stringify(conformAction(28.4, 30)))
check('裁齐秒数正确', Math.abs(conformAction(31.2, 30).deltaSeconds - 1.2) < 1e-9, String(conformAction(31.2, 30).deltaSeconds))

// 5) 耗时预估
{
  const e60 = estimateMinutes(60)
  check('60s 预估片段数 15', e60.clips === 15, JSON.stringify(e60))
  check('60s 预估区间单调', e60.minMinutes >= 1 && e60.maxMinutes >= e60.minMinutes, JSON.stringify(e60))
  const e5 = estimateMinutes(5)
  check('5s 预估单片', e5.clips === 1, JSON.stringify(e5))
}

// 6) 档位集合自身的一致性
check('单次档位与合成档位不重叠', PRODUCT_VIDEO_GEARS.every(g => !COMPOSED_VIDEO_GEARS.includes(g)), '')
check('单次档位全在官方区间', PRODUCT_VIDEO_GEARS.every(g => g >= OFFICIAL_MIN && g <= OFFICIAL_MAX), JSON.stringify(PRODUCT_VIDEO_GEARS))

const failed = checks.filter(c => !c.ok)
for (const c of checks)
  console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok ? '' : '  -> ' + c.detail))
console.log('VIDEO_DURATION ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' checks=' + checks.length + ' fail=' + failed.length)
process.exit(failed.length === 0 ? 0 : 1)
