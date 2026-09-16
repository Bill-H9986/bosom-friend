/**
 * 固定 AI 数字人形象（带货 IP）的可选项：音色目录。
 *
 * 一条带货 IP 靠"同一个形象 + 同一个声音"立住，所以音色是形象的一部分、随形象一起落盘。
 * 长视频的分段与拼接在 `long-video.ts`（通用工作流），本模块只管数字人自己的东西。
 * @module @deepseek-ai/dsh-bosom-friend-server/digital-human
 */

/** 可选中文音色（Edge TTS 的 ShortName，逐个实测可取用）。 */
export const DIGITAL_HUMAN_VOICES: Array<{ id: string, name: string, gender: 'female' | 'male' }> = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（女声·温柔）', gender: 'female' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊（女声·活泼）', gender: 'female' },
  { id: 'zh-CN-YunxiNeural', name: '云希（男声·阳光）', gender: 'male' },
  { id: 'zh-CN-YunyangNeural', name: '云扬（男声·专业）', gender: 'male' },
  { id: 'zh-CN-YunjianNeural', name: '云健（男声·浑厚）', gender: 'male' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏（男声·少年）', gender: 'male' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北（女声·东北）', gender: 'female' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮（女声·陕西）', gender: 'female' },
]

/** 默认音色：口播带货最常用的女声。 */
export const DEFAULT_DIGITAL_HUMAN_VOICE = DIGITAL_HUMAN_VOICES[0]!.id

/**
 * 试听样音文本：按带货口播的真实语气写，听到的就是成片里的语气。
 *
 * 音色名称只说得出"女声·温柔"这类标签，听不出语速与情绪；试听要做的是让用户
 * 在创建形象之前就知道这条声音读自己的文案是什么味道。
 */
export const VOICE_PREVIEW_TEXT = '姐妹们，这款面霜我自己用了三个月，干皮救急真的顶用，今天直播间直降一百。'

/**
 * 音色是否在可选范围内；不在范围内一律回退默认音色。
 * 未知音色发给配音服务会整段失败，宁可回退也不能让一条视频白跑。
 *
 * @param voice - 形象上记录的音色。
 * @returns 可直接使用的音色 id。
 */
export function resolveVoice(voice: string): string {
  return DIGITAL_HUMAN_VOICES.some(item => item.id === voice) ? voice : DEFAULT_DIGITAL_HUMAN_VOICE
}
