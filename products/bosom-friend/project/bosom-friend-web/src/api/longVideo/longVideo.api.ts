/**
 * 长视频产出与数字人形象库接口。
 *
 * 后端只有一条长视频工作流（写稿 → 切段 → 逐段生成 → 拼接），
 * 内容形式的差别全在 `producer` 字段上：`digital-human`（数字人口播）与 `scene`（场景呈现）。
 * 前端因此只对接一个生成入口，新增内容形式不需要改这里的调用方式。
 *
 * @module @web/api/longVideo
 */
import { WEB_API_BASE_URL } from '@web/config/api'
import http from '@web/utils/request'

/** 固定 AI 数字人形象（带货 IP）：一张形象图 + 一个固定音色。 */
export interface DigitalHuman {
  id: string
  name: string
  avatarUrl: string
  voice: string
  seed: number
  createdAt: string
  updatedAt: string
}

/** 配音音色选项。 */
export interface VoiceOption {
  id: string
  name: string
  gender: 'female' | 'male'
}

/** 可选的内容形式（后端的片段生成器注册表）。 */
export interface LongVideoProducerInfo {
  kind: string
  name: string
  description: string
}

/** 成片的一段。 */
export interface LongVideoSegment {
  index: number
  text: string
  audioSeconds: number
  videoUrl?: string
}

/** 一条长视频任务。 */
export interface LongVideoTask {
  id: string
  producer: string
  producerRef?: string
  topic: string
  targetSeconds: number
  resolution: string
  aspectRatio: string
  withSubtitles?: boolean
  status: 'generating' | 'success' | 'failed'
  doneSegments: number
  totalSegments: number
  segments: LongVideoSegment[]
  /** 生成这条成片用的稿件正文（长度校准后的最终稿）。 */
  scriptText?: string
  /** 稿件字数（含标点）。 */
  scriptChars?: number
  videoUrl?: string
  errorMessage?: string
  createdAt: string
  updatedAt: string
}

/** 音色试听的默认样音文本；与后端 VOICE_PREVIEW_TEXT 一致，试听听到的就是成片里的语气。 */
export const VOICE_PREVIEW_TEXT = '姐妹们，这款面霜我自己用了三个月，干皮救急真的顶用，今天直播间直降一百。'

/** 读数字人形象列表。 */
export function listDigitalHumans() {
  return http.get<{ list: DigitalHuman[] }>('digital-humans', undefined, true)
}

/** 读可选音色与默认音色。 */
export function listVoices() {
  return http.get<{ list: VoiceOption[], defaultVoice: string }>('digital-humans/voices', undefined, true)
}

/**
 * 音色试听地址：后端按需合成样音并缓存，返回可直接播放的音频地址。
 *
 * 这个地址给 `<audio src>` 用（不走 http 客户端）：请求体是音频流，不是 JSON 信封。
 * 地址不带随机串，同一音色重复试听直接命中后端缓存与浏览器缓存（响应带 max-age）。
 *
 * @param voiceId - Edge TTS 音色 ShortName。
 * @param text - 试听文本；缺省用后端内置样音。
 * @returns 可直接播放的音频地址。
 */
export function voicePreviewUrl(voiceId: string, text = ''): string {
  const query = text === '' ? '' : '?text=' + encodeURIComponent(text)
  return WEB_API_BASE_URL + '/digital-humans/voices/' + encodeURIComponent(voiceId) + '/preview' + query
}

/** 新建数字人形象。 */
export function createDigitalHuman(body: { name: string, avatarUrl: string, voice?: string }) {
  return http.post<DigitalHuman>('digital-humans', body, true)
}

/** 删除数字人形象。 */
export function deleteDigitalHuman(id: string) {
  return http.delete<{ removed: number }>(`digital-humans/${encodeURIComponent(id)}`, undefined, true)
}

/** 读可选内容形式。 */
export function listProducers() {
  return http.get<{ list: LongVideoProducerInfo[] }>('long-videos/producers', undefined, true)
}

/** 起一条长视频任务（立即返回任务 id，进度靠轮询）。 */
export function startLongVideo(body: {
  producer: string
  producerRef?: string
  topic: string
  targetSeconds: number
  aspectRatio?: string
  /** 是否把口播文本烧成画面字幕；缺省烧。 */
  withSubtitles?: boolean
}) {
  return http.post<{ taskId: string }>('long-videos', body, true)
}

/** 读任务进度。 */
export function getLongVideoTask(taskId: string) {
  return http.get<LongVideoTask>(`long-videos/${encodeURIComponent(taskId)}`, undefined, true)
}

/** 读最近的长视频任务（也用于「生成记录」：刷新后仍能看到历史与进行中的任务）。 */
export function listLongVideoTasks() {
  return http.get<{ list: LongVideoTask[] }>('long-videos', undefined, true)
}

/**
 * 把一句大白话增强成专业创作要求。
 *
 * 只返回文本、不建任务：用户看清结果、确认后才去生成。
 * 未接入大模型或调用失败时后端返回非零码与原因，调用方如实提示。
 */
export function enhanceLongVideoTopic(topic: string) {
  return http.post<{ topic: string }>('long-videos/enhance-topic', { topic }, true)
}
