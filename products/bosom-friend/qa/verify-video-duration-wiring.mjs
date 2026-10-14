#!/usr/bin/env node
/**
 * 视频时长档位的接线验收：从服务端规划到界面合法性判定，整条链必须首尾相接。
 *
 * 为什么单独验收：这条链断在任何一环，界面都**看不出来**——用户点了 30 秒，请求里却是 12 秒
 * （前端夹取），或者请求是 30 秒却被官方拒收（服务端没切片）。两者都表现为"参数没起作用"。
 *
 * 断言：
 *   1. 前端有拼装档位常量，且**两处夹取都放行**它们（sanitizeVideoDuration / clampDuration）；
 *   2. 视频模型类型声明了 longDurations 与耗时预估字段；
 *   3. 界面按 longDurations 渲染档位按钮，且走既有提交回调；
 *   4. 服务端按 planClipSeconds 判定"单片 or 分段"，分段分支走**分段工作流**（写稿 → 分镜 → 逐镜出片 → 拼接）；
 *   5. ≤12 秒的单片分支仍然是原来那一句调用（现有出片路径未被改写）。
 *
 * 用法：node products/bosom-friend/qa/verify-video-duration-wiring.mjs
 * 退出码：0 = 通过；1 = 有缺口。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const qaDir = dirname(fileURLToPath(import.meta.url))
const productRoot = join(qaDir, '..')
const web = join(productRoot, 'project', 'bosom-friend-web', 'src', 'components', 'draft-box', 'components', 'AiBatchGenerateBar')
const checks = []
/** @param name - 断言名。 @param ok - 是否通过。 @param detail - 失败证据。 */
function check(name, ok, detail) { checks.push({ name, ok, detail: detail ?? '' }) }
/** @param rel - 相对路径。 @returns 文件内容；缺失返回空串。 */
function read(rel) {
  const file = join(productRoot, rel)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

const constants = read(join('project', 'bosom-friend-web', 'src', 'components', 'draft-box', 'components', 'AiBatchGenerateBar', 'utils', 'constants.ts'))
const helpers = read(join('project', 'bosom-friend-web', 'src', 'components', 'draft-box', 'components', 'AiBatchGenerateBar', 'utils', 'helpers.ts'))
const types = read(join('project', 'bosom-friend-web', 'src', 'api', 'ai', 'ai.types.ts'))
const component = read(join('project', 'bosom-friend-web', 'src', 'components', 'draft-box', 'components', 'AiBatchGenerateBar', 'components', 'ToolBarInline', 'components', 'VideoModelParamsSelect', 'index.tsx'))
const api = read(join('server', 'src', 'api.ts'))

check('前端有拼装档位常量 [30,60]', /COMPOSED_VIDEO_DURATION_GEARS:\s*readonly number\[\]\s*=\s*\[30,\s*60\]/.test(constants), '')
check('sanitizeVideoDuration 放行拼装档位', /isComposedVideoDuration\(duration\)\s*\)\s*\n\s*return duration/.test(constants), '')
check('clampDuration 放行拼装档位', /isComposedVideoDuration\(value\)\)\s*\n\s*return value/.test(helpers), '')
check('类型声明 longDurations', types.includes('longDurations?: number[]'), '')
check('类型声明耗时预估', types.includes('longDurationEstimates?'), '')
check('界面按 longDurations 渲染档位', component.includes('model.longDurations') && component.includes('onVideoModelDurationCommit(model.name, seconds'), '')
check('服务端按规划判定单片/分段', api.includes('planClipSeconds(request?.duration') && api.includes('clipPlan.composed'), '')
// 旧路径（同一提示词连下 N 片再拼）已删：它既重复又全程无声，必须断言它没有再回来。
check('分段分支走分段工作流（runLongVideoJob + 不登记素材）',
  api.includes('generateSegmentedVideo') && api.includes('registerAsMaterial: false') && !api.includes('generateComposedVideo'), '')
check('单片分支保持原调用（未被改写）', /: await generateAiVideoDirect\(d, mediaPrompt, \{/.test(api), '')
check('拼装档位一并下发给界面', api.includes('longDurations: [...COMPOSED_VIDEO_GEARS]'), '')

const failed = checks.filter(c => !c.ok)
for (const c of checks) console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok ? '' : '  -> ' + c.detail))
console.log('VIDEO_GEARS_WIRING ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' checks=' + checks.length + ' fail=' + failed.length)
process.exit(failed.length === 0 ? 0 : 1)
