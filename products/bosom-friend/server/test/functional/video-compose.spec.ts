import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ffmpegExecutable, probeDurationSeconds, runFfmpeg } from '../../src/ffmpeg.ts'
import { DIP_SECONDS, SUBTITLE_TIMELINE_TOLERANCE_SECONDS, buildAssSubtitles, canvasFor, clampCuesToFilm, composeSegments, paginateCues, subtitleTimelineProblems } from '../../src/video-compose.ts'

/**
 * 成片拼接：用真实 ffmpeg 验证「多段拼成一条」。
 *
 * 厂商不同模式/不同素材会返回不同画布（实测同一产品拿到过 720x1280 与 704x1280），
 * 直接 concat 会报错或花屏。这里故意造两段尺寸不同的素材，验证拼接结果被统一到目标画布。
 *
 * 本机没有 ffmpeg 时跳过（开发态 desktop/dist 未构建时就是这种情况，装机版随包内置）。
 */
const FFMPEG = process.env.FFMPEG_PATH ?? ffmpegExecutable()
/** 随包字幕字体：与 video-compose 引用的是同一个文件（字体名回归要对着它验）。 */
const BUNDLED_FONT_FOR_TEST = join(import.meta.dirname, '../../src/assets/SourceHanSansCN-Regular.ttf')
const HAS_FFMPEG = FFMPEG !== 'ffmpeg' && existsSync(FFMPEG)
let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bf-compose-'))
})
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

/** ASS 时间戳 H:MM:SS.cc → 秒（读回真正烧进画面的那份字幕，而不是调用方手里的中间结果）。 */
function assSeconds(token: string): number {
  const [hours, minutes, seconds] = token.trim().split(':')
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
}

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
    // 黑场过渡不重叠：成片时长 = 各镜之和（4 + 4 = 8 秒），不因过渡被吃掉。
    expect(seconds, '成片必须覆盖两段，而不是只留最后一段').toBeGreaterThan(7)
    expect(seconds).toBeLessThan(9)
    const firstSeconds = await probeDurationSeconds(first)
    const secondSeconds = await probeDurationSeconds(second)
    expect(seconds, '过渡不得缩短成片（交叉溶解会，黑场不会）').toBeCloseTo(firstSeconds + secondSeconds, 1)

    // 画布必须统一：拼接产物报出的分辨率只有一个。
    const probe = await runFfmpeg(['-hide_banner', '-i', out], 30_000)
    expect(probe.output, '成片画布必须统一到目标尺寸').toContain('720x1280')
    expect(probe.output).not.toContain('704x1280')
  }, 300_000)

  it('21:9 的成片画布是 21:9，不退化成 720p 竖屏', async () => {
    // 现场（2026-09-19）：21:9 的七段片段各是 1470x630，拼出来的整条却是 720x1280——
    // 拼装画布取自图片档位表，而那张表没有 21:9（图片模型不支持），未知画幅就回退成了 9:16。
    const first = join(dir, 'wide-a.mp4')
    const second = join(dir, 'wide-b.mp4')
    await makeSegment(first, '1470x630', 440)
    await makeSegment(second, '1470x630', 660)
    const out = join(dir, 'wide-out.mp4')
    const composed = await composeSegments({ segments: [first, second], outFile: out, resolution: '720p', aspectRatio: '21:9' })
    expect(composed.ok, '拼接必须成功：' + (composed.ok ? '' : composed.error)).toBe(true)
    const probe = await runFfmpeg(['-hide_banner', '-i', out], 30_000)
    expect(probe.output, '21:9 的成片必须是 21:9 的画布').toContain('1470x630')
    expect(probe.output, '不得回退成 9:16').not.toContain('720x1280')
  }, 300_000)

  it('画布尺寸随档位与画幅派生，未知组合才回退', () => {
    expect(canvasFor({ resolution: '720p', aspectRatio: '21:9' })).toEqual({ width: 1470, height: 630 })
    expect(canvasFor({ resolution: '1080p', aspectRatio: '21:9' })).toEqual({ width: 2205, height: 945 })
    // 图片档位表里已有的五种照旧走同一份表，不因为上面那张表而分叉。
    expect(canvasFor({ resolution: '720p', aspectRatio: '16:9' })).toEqual({ width: 1280, height: 720 })
    expect(canvasFor({ resolution: '720p', aspectRatio: '9:16' })).toEqual({ width: 720, height: 1280 })
    expect(canvasFor({ resolution: '1080p', aspectRatio: '3:4' })).toEqual({ width: 1080, height: 1440 })
    // 真未知的组合仍然回退到产品默认口径，不编造尺寸。
    expect(canvasFor({ resolution: '720p', aspectRatio: '7:3' })).toEqual({ width: 720, height: 1280 })
    expect(canvasFor({})).toEqual({ width: 720, height: 1280 })
  })

  it('随包字幕字体真的能被选中：字体名写错会被这条断言抓住', async () => {
    // 字体名与文件内部的 family name 对不上时 libass **不报错**，而是静默换成系统字体
    // （实测写成 "Source Han Sans CN" 就回退到了 Microsoft YaHei）。所以只能从渲染器的
    // fontselect 调试输出里验：这里直接把 ASS 与字体放进同一个目录驱动渲染器。
    const probeDir = join(dir, 'font-probe')
    mkdirSync(probeDir, { recursive: true })
    const ass = buildAssSubtitles([{ text: '字体回归', startSeconds: 0, endSeconds: 4 }], { width: 720, height: 1280 })
    writeFileSync(join(probeDir, 'long-video-subs.ass'), ass, 'utf8')
    copyFileSync(BUNDLED_FONT_FOR_TEST, join(probeDir, 'long-video-font.ttf'))

    const rendered = await runFfmpeg([
      '-y', '-f', 'lavfi', '-i', 'color=c=gray:size=720x1280:rate=24:duration=2',
      '-vf', 'ass=long-video-subs.ass:fontsdir=.',
      '-frames:v', '2', '-c:v', 'libx264', '-preset', 'ultrafast', join(probeDir, 'probe.mp4'),
    ], { timeoutMs: 120_000, cwd: probeDir })
    expect(rendered.ok, '渲染必须成功：' + rendered.output.slice(-200)).toBe(true)
    expect(rendered.output, '必须由随包思源黑体渲染').toContain('SourceHanSansCN-Regular')
    expect(rendered.output, '不得静默回退到系统字体').not.toMatch(/\[Parsed_ass_0[^\]]*\] Glyph .* not found/)
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

  it('每镜的字幕窗口就是它那一镜的窗口：拼接层只烧不挪时间轴（DEF-131 的回归）', async () => {
    // 这条断言是 2026-09-22 那次的缺口：调用方按各镜真实时长累加出**绝对**时间轴，
    // 拼接层又按"各镜起点"平移了一次，于是第二条字幕起每晚一整句、末尾十几条落在成片之外。
    // 当时的用例只断言了调用方算出来的中间结果，没有一条看着真正烧进画面的那份 ASS。
    const outDir = join(dir, 'cue-window')
    mkdirSync(outDir, { recursive: true })
    const first = join(outDir, 'a.mp4')
    const second = join(outDir, 'b.mp4')
    await makeSegment(first, '720x1280', 440)
    await makeSegment(second, '720x1280', 660)
    const durations = [await probeDurationSeconds(first), await probeDurationSeconds(second)]
    expect(durations.every(value => value > 0), '两段素材的真实时长必须探得到').toBe(true)
    const [firstSeconds, secondSeconds] = durations as [number, number]
    const composed = await composeSegments({
      segments: [first, second],
      outFile: join(outDir, 'film.mp4'),
      resolution: '720p',
      aspectRatio: '9:16',
      segmentDurations: durations,
      subtitles: [
        { text: '第一镜说的话', startSeconds: 0, endSeconds: firstSeconds },
        { text: '第二镜说的话', startSeconds: firstSeconds, endSeconds: firstSeconds + secondSeconds },
      ],
    })
    expect(composed.ok, composed.ok ? '' : composed.error).toBe(true)

    const ass = readFileSync(join(outDir, 'long-video-subs.ass'), 'utf8')
    const windows = ass.split(/\r?\n/)
      .filter(line => line.startsWith('Dialogue:'))
      .map(line => line.split(',')
        .slice(1, 3)
        .map(assSeconds))
    expect(windows.length, '两镜两句 → 两条字幕').toBe(2)
    expect(windows[0]![0]).toBeCloseTo(0, 2)
    expect(windows[0]![1]).toBeCloseTo(firstSeconds, 1)
    // 关键：第二条从**第一镜结束**处开始，而不是从"第一镜的起点 + 第一镜时长"开始。
    expect(windows[1]![0]).toBeCloseTo(firstSeconds, 2)
    expect(windows[1]![1]).toBeCloseTo(firstSeconds + secondSeconds, 1)
    expect(windows[1]![0], '第二条字幕不得被推到第一镜结束之后').not.toBeCloseTo(firstSeconds * 2, 1)

    // 成片时长也必须等于两镜之和：字幕与画面的时间轴是同一份事实。
    const filmSeconds = await probeDurationSeconds(join(outDir, 'film.mp4'))
    expect(filmSeconds).toBeCloseTo(firstSeconds + secondSeconds, 1)
  }, 300_000)
})

describe('过渡时间轴：黑场过渡不重叠，成片时长与字幕都不受影响', () => {
  it('过渡时长要短：0.18 秒（约 4 帧）足够打断硬切，又不影响节奏', () => {
    expect(DIP_SECONDS).toBeGreaterThan(0)
    expect(DIP_SECONDS).toBeLessThanOrEqual(0.25)
  })

  it('字幕落到成片之外时如实报出来（那是谁都看不到的字幕）', () => {
    // 成片 10 秒（两镜各 5 秒）。第二条字幕的窗口必须是 [5, 10]，
    // 一旦它被当成"相对本镜"再平移一次就成了 [10, 15]——落片外，用户看不到。
    const film = [
      { text: '第一镜', startSeconds: 0, endSeconds: 5 },
      { text: '第二镜', startSeconds: 5, endSeconds: 10 },
    ]
    expect(subtitleTimelineProblems(film, 10)).toEqual([])
    const shifted = subtitleTimelineProblems([
      { text: '第一镜', startSeconds: 0, endSeconds: 5 },
      { text: '第二镜', startSeconds: 10, endSeconds: 15 },
    ], 10)
    expect(shifted.length).toBe(1)
    expect(shifted[0]).toContain('落到成片之外')

    // 容差只用来吸收毫秒级舍入，抓的是"整句错位"这个量级。
    const rounded = [{ text: '第一镜', startSeconds: 0, endSeconds: 10 + SUBTITLE_TIMELINE_TOLERANCE_SECONDS / 2 }]
    expect(subtitleTimelineProblems(rounded, 10)).toEqual([])

    // 时长非正的字幕条永远不会显示，也是确定错。
    expect(subtitleTimelineProblems([{ text: '空的', startSeconds: 3, endSeconds: 3 }], 10)[0]).toContain('时长非正')
    expect(subtitleTimelineProblems([{ text: '反的', startSeconds: 6, endSeconds: 2 }], 10)[0]).toContain('时长非正')
    expect(subtitleTimelineProblems([{ text: '负的', startSeconds: -2, endSeconds: 2 }], 10)[0]).toContain('起点为负')
  })

  it('字幕超出成片时裁到片长内，起点已在片外的整条丢弃', () => {
    const film = 10
    // 完全在片内的原样保留（并且是同一个对象，不做无意义的复制）。
    const inside = { text: '片内', startSeconds: 0, endSeconds: 5 }
    expect(clampCuesToFilm([inside], film)[0]).toBe(inside)
    // 结束时间刚好等于片长是合法的：它在最后一帧结束。
    const exact = { text: '压线', startSeconds: 5, endSeconds: 10 }
    expect(clampCuesToFilm([exact], film)[0]).toBe(exact)
    // 跨过片尾的裁到片长，起点不动（起点是对的，动它会让字幕与口播错开）。
    const crossing = clampCuesToFilm([{ text: '跨界', startSeconds: 8, endSeconds: 15 }], film)
    expect(crossing.length).toBe(1)
    expect(crossing[0]!.startSeconds).toBe(8)
    expect(crossing[0]!.endSeconds).toBe(10)
    // 起点已经在片外：整条丢弃。压成零长度会在成片上闪一帧字幕，比不显示更糟。
    expect(clampCuesToFilm([{ text: '片外', startSeconds: 12, endSeconds: 18 }], film)).toEqual([])
    // 成片长度读不出来（0 或非有限值）时不做无依据的裁剪。
    const all = [{ text: '不知道片长', startSeconds: 99, endSeconds: 120 }]
    expect(clampCuesToFilm(all, 0)).toBe(all)
    expect(clampCuesToFilm(all, Number.NaN)).toBe(all)
  })
})

describe('字幕生成：时间轴与字号都由画布决定', () => {
  it('按画布高度定字号与边距，PlayRes 与成片一致', () => {
    const ass = buildAssSubtitles([{ text: '第一句', startSeconds: 0, endSeconds: 4 }], { width: 720, height: 1280 })
    expect(ass).toContain('PlayResX: 720')
    expect(ass).toContain('PlayResY: 1280')
    // 1280 * 4.2% ≈ 54：换到 1080p 画布应等比放大，观感才一致。
    expect(ass, '字幕用随包思源黑体，不靠用户装没装字体').toContain('Style: Default,Source Han Sans CN Regular,54,')
    // 浅色背景（白墙/米色墙）上纯白字必须带描边与投影，否则糊在背景里看不清。
    // Style 行末尾几个数字依次是 BorderStyle, Outline, Shadow, Alignment：这里要 1,4,2,2。
    const styleLine = ass.split('\n').find(line => line.startsWith('Style: Default,')) ?? ''
    expect(styleLine.endsWith(',1,4,2,2,43,43,102,1'), '描边 4 / 投影 2 / 底部居中，浅色背景上也看得清').toBe(true)
    const hd = buildAssSubtitles([{ text: '第一句', startSeconds: 0, endSeconds: 4 }], { width: 1080, height: 1920 })
    expect(hd).toContain('Style: Default,Source Han Sans CN Regular,81,')
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

  it('按屏数均分：长句不会甩出一两个字的孤条（「。」「服。」那类）', () => {
    // 45 字、每屏 22 字：按"每屏切满"会切成 22 + 22 + 1（末屏只剩一个句号），
    // 那一屏会单独占一段时间，观感就是"字幕突然只剩一个句号"。按屏数均分得到 23 + 22。
    // 1080x1920、字号 81、边距 65 → 每行 11 字、每屏 2 行 = 22 字。
    const text = '很多姐妹一到换季，脸就紧绷、发痒，化妆还卡粉。它里面是神经酰胺加透明质酸，深层补水锁水一步到位。'
    const cues = paginateCues([{ text, startSeconds: 0, endSeconds: 6 }], { width: 1080, height: 1920 }, 81, 65)
    // 48 字、每屏 22 字：按"每屏切满"会切成 22 + 22 + 4——末屏只剩四个字，
    // 观感是字幕一闪而过。先按屏数均分得到 16/16/16，再尽量把断点挪到标点上。
    expect(cues.length).toBe(3)
    const sizes = cues.map(cue => cue.text.replaceAll('\n', '').length)
    expect(Math.min(...sizes), '不得出现只剩一两个字的孤条').toBeGreaterThanOrEqual(8)
    expect(Math.max(...sizes), '也不得把某屏撑爆').toBeLessThanOrEqual(22)
    expect(cues.map(cue => cue.text.replaceAll('\n', '')).join(''), '分页不能吞字').toBe(text)
  })

  it('断点尽量落在标点上：换屏不把句子拦腰截断', () => {
    // 每屏 22 字（1080x1920、字号 81、边距 65 → 每行 11 字 × 2 行）。
    // 24 字均分会切成 12 + 12：「它里面全是小分子保湿成」|「分，能钻进角质层。」——正好把词切开；
    // 该退到最近的「，」之后：「它里面全是小分子保湿成分，」|「能钻进角质层。」
    const text = '它里面全是小分子保湿成分，能钻进角质层，' + '第二天起来脸就不绷了。'
    const cues = paginateCues([{ text, startSeconds: 0, endSeconds: 8 }], { width: 1080, height: 1920 }, 81, 65)
    expect(cues.length).toBeGreaterThanOrEqual(2)
    // 每一屏（除最后一屏）都断在标点之后：不在句子中间断开。
    for (const cue of cues.slice(0, -1)) {
      const page = cue.text.replaceAll('\n', '')
      expect('，。！？；：、'.includes(page[page.length - 1]!), '换屏点应落在标点上：' + page).toBe(true)
    }
    expect(cues.map(c => c.text.replaceAll('\n', '')).join(''), '分页不能吞字').toBe(text)
    // 没有标点可用时就保持均分，不为了断句把内容丢掉。
    const noPunct = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'
    const plain = paginateCues([{ text: noPunct, startSeconds: 0, endSeconds: 8 }], { width: 1080, height: 1920 }, 81, 65)
    expect(plain.map(c => c.text.replaceAll('\n', '')).join('')).toBe(noPunct)
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
