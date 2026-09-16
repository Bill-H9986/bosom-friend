import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ffmpegExecutable, probeDurationSeconds, runFfmpeg } from '../../src/ffmpeg.ts'
import { buildAssSubtitles, composeSegments, paginateCues } from '../../src/video-compose.ts'

/**
 * 成片拼接：用真实 ffmpeg 验证「多段拼成一条」。
 *
 * 厂商不同模式/不同素材会返回不同画布（实测同一产品拿到过 720x1280 与 704x1280），
 * 直接 concat 会报错或花屏。这里故意造两段尺寸不同的素材，验证拼接结果被统一到目标画布。
 *
 * 本机没有 ffmpeg 时跳过（开发态 desktop/dist 未构建时就是这种情况，装机版随包内置）。
 */
const FFMPEG = process.env.FFMPEG_PATH ?? ffmpegExecutable()
const HAS_FFMPEG = FFMPEG !== 'ffmpeg' && existsSync(FFMPEG)
let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bf-compose-'))
})
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

/** 造一段指定尺寸的测试视频（含音轨，与厂商成片同规格）。 */
async function makeSegment(file: string, size: string, frequency: number): Promise<void> {
  const result = await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=' + size + ':rate=24:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=' + String(frequency) + ':duration=4',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', file,
  ], 120_000)
  expect(result.ok, '测试素材必须造得出来：' + result.output.slice(-300)).toBe(true)
}

/**
 * 取某一秒解码帧的 MD5。
 *
 * 不比文件字节、也不比导出的 PNG：mp4 容器会写创建时间、PNG 会写 tIME 块，
 * 同一份画面两次转码的字节并不相等。framemd5 只对解码后的像素取哈希，才是"画面变没变"的判据。
 */
async function frameHashAt(video: string, seconds = 1): Promise<string> {
  const result = await runFfmpeg(['-ss', String(seconds), '-i', video, '-frames:v', '1', '-f', 'framemd5', '-'], 60_000)
  const line = result.output.split(/\r?\n/).find(row => /^\d+,\s+\d+,\s+\d+,/.test(row)) ?? ''
  const hash = line.split(',').pop()?.trim() ?? ''
  expect(hash.length, '抽帧哈希必须拿得到：' + result.output.slice(-200)).toBeGreaterThan(0)
  return hash
}

describe.skipIf(!HAS_FFMPEG)('成片拼接（真实 ffmpeg）', () => {
  it('两段不同画布的视频拼成一条，统一到 720x1280 且时长相加', async () => {
    const first = join(dir, 'a.mp4')
    const second = join(dir, 'b.mp4')
    // 故意用两种尺寸：这正是厂商在不同模式下返回的真实差异。
    await makeSegment(first, '720x1280', 440)
    await makeSegment(second, '704x1280', 660)

    const out = join(dir, 'out.mp4')
    const composed = await composeSegments({ segments: [first, second], outFile: out, resolution: '720p', aspectRatio: '9:16' })
    expect(composed.ok, '拼接必须成功：' + (composed.ok ? '' : composed.error)).toBe(true)
    expect(existsSync(out)).toBe(true)
    expect(statSync(out).size).toBeGreaterThan(1000)

    const seconds = await probeDurationSeconds(out)
    expect(seconds, '成片必须覆盖两段，而不是只留最后一段').toBeGreaterThan(7)
    expect(seconds).toBeLessThan(9)

    // 画布必须统一：拼接产物报出的分辨率只有一个。
    const probe = await runFfmpeg(['-hide_banner', '-i', out], 30_000)
    expect(probe.output, '成片画布必须统一到目标尺寸').toContain('720x1280')
    expect(probe.output).not.toContain('704x1280')
  }, 300_000)

  it('单段也要走同一条转码口径，产出规格一致的成片', async () => {
    const only = join(dir, 'only.mp4')
    await makeSegment(only, '704x1280', 440)
    const out = join(dir, 'single.mp4')
    const composed = await composeSegments({ segments: [only], outFile: out, resolution: '720p', aspectRatio: '9:16' })
    expect(composed.ok, '单段拼接同样要成功：' + (composed.ok ? '' : composed.error)).toBe(true)
    const probe = await runFfmpeg(['-hide_banner', '-i', out], 30_000)
    expect(probe.output).toContain('720x1280')
  }, 300_000)

  it('没有任何片段时如实失败，不产出一个空文件', async () => {
    const composed = await composeSegments({ segments: [], outFile: join(dir, 'empty.mp4') })
    expect(composed.ok).toBe(false)
    expect(existsSync(join(dir, 'empty.mp4'))).toBe(false)
  })

  it('字幕真的烧进了画面：无字幕两次一致，加字幕后必不同', async () => {
    const source = join(dir, 'sub-src.mp4')
    await makeSegment(source, '720x1280', 440)
    const cues = [{ text: '姐妹们，这款面霜我自己用了三个月', startSeconds: 0, endSeconds: 4 }]

    const plainA = join(dir, 'plain-a.mp4')
    const plainB = join(dir, 'plain-b.mp4')
    const burned = join(dir, 'burned.mp4')
    expect((await composeSegments({ segments: [source], outFile: plainA, resolution: '720p', aspectRatio: '9:16' })).ok).toBe(true)
    expect((await composeSegments({ segments: [source], outFile: plainB, resolution: '720p', aspectRatio: '9:16' })).ok).toBe(true)
    expect((await composeSegments({ segments: [source], outFile: burned, resolution: '720p', aspectRatio: '9:16', subtitles: cues })).ok).toBe(true)

    const hashA = await frameHashAt(plainA)
    const hashB = await frameHashAt(plainB)
    const hashBurned = await frameHashAt(burned)
    // 对照：同样参数、同样输入的两次转码，画面必须完全一致，否则"有字幕不同"说明不了问题。
    expect(hashB, '无字幕的两次转码画面应完全一致').toBe(hashA)
    expect(hashBurned, '加字幕后同一时间点的画面必须变化').not.toBe(hashA)

    // 成片旁边应留下实际生效的那份字幕文件，便于事后核对文案与时间轴。
    expect(existsSync(join(dir, 'long-video-subs.ass')), '字幕文件必须落在成片同目录').toBe(true)
  }, 300_000)
})

describe('字幕生成：时间轴与字号都由画布决定', () => {
  it('按画布高度定字号与边距，PlayRes 与成片一致', () => {
    const ass = buildAssSubtitles([{ text: '第一句', startSeconds: 0, endSeconds: 4 }], { width: 720, height: 1280 })
    expect(ass).toContain('PlayResX: 720')
    expect(ass).toContain('PlayResY: 1280')
    // 1280 * 4.2% ≈ 54：换到 1080p 画布应等比放大，观感才一致。
    expect(ass).toContain('Style: Default,Microsoft YaHei,54,')
    const hd = buildAssSubtitles([{ text: '第一句', startSeconds: 0, endSeconds: 4 }], { width: 1080, height: 1920 })
    expect(hd).toContain('Style: Default,Microsoft YaHei,81,')
  })

  it('时间戳按秒换算为 H:MM:SS.cc，且只输出有效字幕条', () => {
    const ass = buildAssSubtitles([
      { text: '甲', startSeconds: 0, endSeconds: 4.5 },
      { text: '乙', startSeconds: 65.25, endSeconds: 70 },
      { text: '   ', startSeconds: 70, endSeconds: 75 },
      { text: '丁', startSeconds: 80, endSeconds: 80 },
    ], { width: 720, height: 1280 })
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:04.50,Default,,0,0,0,,甲')
    expect(ass).toContain('Dialogue: 0,0:01:05.25,0:01:10.00,Default,,0,0,0,,乙')
    expect(ass, '空白条不烧').not.toContain('丁')
    expect(ass.match(/Dialogue:/g)).toHaveLength(2)
  })

  it('清掉会被当成特效标签的大括号，换行折成 ASS 换行符', () => {
    const ass = buildAssSubtitles([{ text: '{\\pos(0,0)}正常\n第二行', startSeconds: 0, endSeconds: 3 }], { width: 720, height: 1280 })
    // 花括号是 ASS 的特效标签语法：留在文本里会被 libass 当指令解析，必须去掉。
    expect(ass, '字幕文本里不得再出现花括号').not.toMatch(/Dialogue:[^\n]*[{}]/)
    expect(ass).toContain('正常\\N第二行')
  })

  it('没有字幕条时不产出文件内容', () => {
    expect(buildAssSubtitles([], { width: 720, height: 1280 })).toBe('')
  })

  it('长句按画布分页并手动断行（中文没有空格，libass 不会自己折行）', () => {
    // 720x1280、字号 54、边距 43 → 每行 11 字、每条最多 2 行 = 22 字。
    const long = '姐妹们注意了这款面霜我自己已经用了整整三个月真的特别好用今天直播间直降一百还送小样点下方链接就能拍'
    const cues = paginateCues([{ text: long, startSeconds: 0, endSeconds: 8 }], { width: 720, height: 1280 }, 54, 43)
    expect(cues.length, '49 字应切成 3 条').toBe(3)
    for (const cue of cues) {
      for (const line of cue.text.split('\n'))
        expect(line.length, '每行不得超过每行字数，否则会顶出画面').toBeLessThanOrEqual(11)
      expect(cue.text.split('\n').length, '单条最多两行').toBeLessThanOrEqual(2)
    }
    // 拼接回来必须与原文一字不差：分页只负责断行，不能吞字。
    expect(cues.map(cue => cue.text.replaceAll('\n', '')).join('')).toBe(long)
    // 时间轴连续且覆盖原区间。
    expect(cues[0]!.startSeconds).toBe(0)
    expect(cues[cues.length - 1]!.endSeconds).toBeCloseTo(8, 5)
  })

  it('画布越小每行字数越少，字号随之等比收放', () => {
    const text = '一二三四五六七八九十一二三四五六七八九十'
    const small = paginateCues([{ text, startSeconds: 0, endSeconds: 4 }], { width: 720, height: 1280 }, 54, 43)
    const large = paginateCues([{ text, startSeconds: 0, endSeconds: 4 }], { width: 1080, height: 1920 }, 81, 65)
    expect(small[0]!.text.split('\n')[0]!.length).toBe(11)
    expect(large[0]!.text.split('\n')[0]!.length).toBe(11)
    expect(small.length, '同字数下两种档位的分页条数一致').toBe(large.length)
  })
})
