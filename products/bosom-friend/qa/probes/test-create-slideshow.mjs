#!/usr/bin/env node
/** 直接验证本地滑动合成：按请求时长/比例/档位输出可播放视频。 */
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const serverSrc = join(repoRoot, 'products/bosom-friend/server/src/platform-login.ts')
const { createSlideshow } = await import(pathToFileURL(serverSrc).href)
const uploads = join(process.env.USERPROFILE ?? '.', '.bosom-friend', 'bosom-friend', 'uploads')
const frames = readdirSync(uploads)
  .filter((name) => name.startsWith('ai-img-') && name.endsWith('.png'))
  .slice(0, 2)
  .map((name) => join(uploads, name))
if (frames.length < 2) {
  console.error('NEED_FRAMES_MISSING')
  process.exit(2)
}

const target = join(repoRoot, 'products/bosom-friend/qa/evidence/duration-matrix')
mkdirSync(target, { recursive: true })
const dataRoot = join(target, 'tmp-create-slideshow')
mkdirSync(dataRoot, { recursive: true })

for (const [seconds, resolution, ratio] of [
  [5, '720p', '9:16'],
  [15, '720p', '9:16'],
  [30, '1080p', '9:16'],
  [60, '720p', '16:9'],
  [120, '1080p', '3:4'],
  [180, '720p', '1:1'],
]) {
  const assetId = `probe-${seconds}s.mp4`
  const url = await createSlideshow({ dataRoot }, frames, assetId, {
    duration: seconds,
    resolution,
    aspectRatio: ratio,
  })
  console.log(`${seconds}s ${resolution} ${ratio} -> ${url}`)
  const output = join(dataRoot, 'uploads', assetId)
  if (url && await import('node:fs').then((fs) => fs.existsSync(output))) {
    copyFileSync(output, join(target, assetId))
  }
}
