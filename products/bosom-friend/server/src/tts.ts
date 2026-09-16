/**
 * 文字转语音（配音）：数字人口播的声音来源。
 *
 * 用微软 Edge 的 Read Aloud 接口（`msedge-tts`，MIT）：免费、无需 API Key、中文音色自然，
 * 对「用户本机只有一把普通钥匙」的产品形态是唯一现实的选择——云端 TTS 要再收一份钱和一份实名。
 * 代价是它依赖微软在线服务：断网/被拦时这里如实返回失败原因，绝不静默换成机器音冒充同一个 IP 的声音。
 * @module @deepseek-ai/dsh-bosom-friend-server/tts
 */

import { writeFileSync } from 'node:fs'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { probeDurationSeconds } from './ffmpeg.ts'

/** 一次配音的结果：落盘文件与它的真实时长。 */
export interface SpeechResult {
  file: string
  /** 音频真实时长（秒），由 ffmpeg 读出，不用字数估算。 */
  seconds: number
}

/** 配音超时预算：一段 12 秒的语音正常几秒内返回，超过这个数按失败处理，避免任务永久挂住。 */
const SYNTHESIS_TIMEOUT_MS = 60_000

/** 合成选项。 */
export interface SpeechOptions {
  /**
   * 是否读出音频真实时长（需要本机 ffmpeg）。
   *
   * 分段生成必须读：字幕时间轴与拼接对时都以真实秒数为准。只要一段音频字节的场景
   * （如音色试听）关掉它，就不必为了一个播放器不需要的数字依赖 ffmpeg。
   */
  probeDuration?: boolean
}

/**
 * 把一段文字合成为 mp3。
 *
 * @param text - 要念的文字（调用方已清理成可朗读文本）。
 * @param voice - Edge TTS 音色 ShortName；未知音色由服务端按默认音色处理。
 * @param outFile - 落盘的 mp3 绝对路径（目录需已存在）。
 * @param options - 合成选项；缺省读出真实时长。
 * @returns 文件路径与真实秒数（未读出时长时为 0）；失败返回错误原因，由调用方决定怎么如实告知用户。
 */
export async function synthesizeSpeech(
  text: string,
  voice: string,
  outFile: string,
  options: SpeechOptions = {},
): Promise<{ ok: true, result: SpeechResult } | { ok: false, error: string }> {
  if (text.trim() === '') return { ok: false, error: '配音文本为空' }
  const tts = new MsEdgeTTS()
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    const audio = await withTimeout(collect(tts.toStream(text).audioStream), SYNTHESIS_TIMEOUT_MS)
    if (audio.length === 0) return { ok: false, error: '配音服务返回了空音频' }
    writeFileSync(outFile, audio)
    if (options.probeDuration === false) return { ok: true, result: { file: outFile, seconds: 0 } }
    const seconds = await probeDurationSeconds(outFile)
    if (seconds <= 0) return { ok: false, error: '配音文件写出后读不出时长（本机缺少 ffmpeg？）' }
    return { ok: true, result: { file: outFile, seconds } }
  }
  catch (error) {
    return { ok: false, error: '配音失败（Edge 语音服务不可达或音色无效）：' + describe(error) }
  }
  finally {
    // 关闭失败只影响连接回收，不影响已落盘的音频。
    try { tts.close() } catch { /* 连接已断开 */ }
  }
}

/** 收齐音频流的所有分片。 */
async function collect(stream: AsyncIterable<Buffer | Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

/** 给任意 promise 加超时；超时抛错，由调用方统一转成人话。 */
function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('配音超时（' + String(timeoutMs) + 'ms）')), timeoutMs)
    task.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

/** 错误对象转可读原因。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
