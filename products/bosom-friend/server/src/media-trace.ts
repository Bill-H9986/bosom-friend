/**
 * 媒体留痕（D3）：把能力面报来的观察写进产品账本。
 *
 * 为什么分两层：能力面只负责**报出来**（输入、产出、耗时、失败分类，见 \`media/observation\`），
 * "记到哪儿、记成什么"是产品的事——同一个观察，桌面版记本机账本，别的部署可能记 telemetry。
 * 这一层因此只有一个职责：把一条观察写成一行人能读、事后能对账的记录，出口与文本留痕同一个
 * （\`ai-logs.json\`，见 api.ts 的 \`log()\`），不另起一套账。
 *
 * @module dsh-bosom-friend-server/media-trace
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MediaObservation } from '@deepseek-ai/dsh-media'
import { nowIso } from './store-helper.ts'
import type { ZyStore } from './store.ts'

/** 媒体留痕的 kind：与文本留痕的 kind 并列，检索时一眼分得开。 */
export const MEDIA_LOG_KIND = 'media'

/** 操作名的中文说法：账本是给人和复盘看的。 */
const OPERATION_LABELS: Record<MediaObservation['operation'], string> = {
  generateImage: '图片生成',
  submitVideo: '视频下单',
  pollVideo: '视频轮询',
}

/**
 * 字节数写成人能读的大小。
 *
 * @param bytes - 字节数。
 * @returns 形如 \`812 B\` / \`1.2 MB\`；非有限值按 0 处理。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return String(Math.round(bytes)) + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/**
 * 把一条观察写成一行账。
 *
 * 只写这次调用的**事实**：哪个操作、走哪条路由、用哪个模型、花了多久、输入多大、产出多大、
 * 失败是哪种分类。刻意不写提示词原文——账本是索引不是内容库，正文在会话与生成记录里。
 *
 * @param observation - 能力面报来的一次厂商往返。
 * @returns 一行人能读的记录。
 */
export function describeMediaObservation(observation: MediaObservation): string {
  const outcome = observation.ok
    ? '成功'
    : '失败（' + (observation.errorCode ?? '未分类')
      + (observation.status === undefined ? '' : ' HTTP ' + String(observation.status)) + '）'
  const parts = [
    OPERATION_LABELS[observation.operation],
    outcome,
    observation.provider === '' ? '' : '路由 ' + observation.provider,
    observation.model === '' ? '' : '模型 ' + observation.model,
    String(observation.durationMs) + 'ms',
  ].filter(part => part !== '')
  if (observation.input.textChars > 0) parts.push('输入 ' + String(observation.input.textChars) + ' 字')
  if (observation.input.imageCount > 0) parts.push('参考图 ' + String(observation.input.imageCount) + ' 张')
  if (observation.input.audioCount > 0) parts.push('参考音 ' + String(observation.input.audioCount) + ' 段')
  if (observation.input.count !== undefined) parts.push(String(observation.input.count) + ' 张')
  if (observation.input.durationSeconds !== undefined) parts.push('时长 ' + String(observation.input.durationSeconds) + 's')
  if (observation.input.resolution !== undefined) parts.push(String(observation.input.resolution))
  if (observation.output !== undefined) {
    parts.push('产出 ' + formatBytes(observation.output.bytes))
    if (observation.output.artifacts !== undefined) parts.push(String(observation.output.artifacts) + ' 件')
    if (observation.output.jobId !== undefined) parts.push('任务 ' + observation.output.jobId)
  }
  return parts.join(' · ')
}

/**
 * 追加一条媒体留痕。
 *
 * 与文本留痕同一条留存规则（最多 500 条，最新的在最前）：账本是环形缓冲，不是无限日志——
 * 无限增长的文件迟早变成一次启动读取几百毫秒的负担。
 *
 * @param files - 产品的落盘文件集合（\`store.files\`）。
 * @param observation - 能力面报来的一次厂商往返。
 */
export function appendMediaObservation(files: ZyStore['files'], observation: MediaObservation): void {
  const logs = files.logs.load()
  logs.unshift({ date: nowIso(), kind: MEDIA_LOG_KIND, detail: describeMediaObservation(observation).slice(0, 200) })
  files.logs.save(logs.slice(0, 500))
}

/**
 * 订阅能力面的观察，并把每一条写进账本。
 *
 * 写盘失败**只报不改**：一次已经成功的厂商调用不该因为账本写不进去而变成失败
 * （那会让调用方重试一次已经付过费、已经拿到产物的调用）。订阅本身走 `ctx.on`，
 * 随宿主 fiber 一起释放。
 *
 * @param ctx - 宿主上下文（能力面在上面报观察）。
 * @param files - 产品的落盘文件集合（`store.files`）。
 */
export function traceMediaObservations(ctx: Context, files: ZyStore['files']): void {
  ctx.on('media/observation', observation => {
    try {
      appendMediaObservation(files, observation)
    }
    catch (error) {
      console.error('[MEDIA_TRACE_ERR] 媒体留痕写入失败（不影响这次调用）：' + String(error))
    }
  })
}
