
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { composeSegments } from '../../server/src/video-compose.ts'
import { runFfmpeg } from '../../server/src/ffmpeg.ts'

const dir = join(tmpdir(), 'bf-subs-demo')
mkdirSync(dir, { recursive: true })
const src = join(dir, 'src.mp4')
await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=24:duration=8',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:v', 'libx264', '-preset', 'veryfast',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src], 120_000)

const out = join(dir, 'out-long.mp4')
// 12 秒上限对应的真实长度：一句 50 字的口播稿
const long = '姐妹们注意了这款面霜我自己已经用了整整三个月真的特别好用今天直播间直降一百还送小样点下方链接就能拍'
console.log('cue length =', long.length)
const res = await composeSegments({
  segments: [src], outFile: out, resolution: '720p', aspectRatio: '9:16',
  subtitles: [{ text: long, startSeconds: 0, endSeconds: 8 }],
})
console.log('compose:', res.ok)
const frame = join(dir, 'frame-long.png')
await runFfmpeg(['-y', '-ss', '4', '-i', out, '-frames:v', '1', frame], 60_000)
console.log('frame ->', frame)
