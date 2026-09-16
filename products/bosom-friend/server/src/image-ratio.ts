/**
 * 图片成品尺寸处理：把模型生成的正方形原图按目标比例裁剪并缩放到成品尺寸。
 * 使用 Windows 自带 System.Drawing（PowerShell），零额外依赖；仅 Windows 桌面版使用。
 * @module @deepseek-ai/dsh-bosom-friend-server/image-ratio
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

/** 解析 "1080x1920" 之类成品尺寸。 */
export function parseSize(size: string): { width: number; height: number } | null {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(size.trim())
  if (m === null) return null
  const width = Number(m[1])
  const height = Number(m[2])
  return width >= 16 && height >= 16 ? { width, height } : null
}

/** 图片档位对齐视频：720p / 1080p，按比例映射为标准成品像素（与比例一一对应，绝不同时冲突）。 */
export const RATIO_TIERS: Record<string, Record<string, string>> = {
  '720p': {
    '1:1': '720x720',
    '4:3': '960x720',
    '3:4': '720x960',
    '9:16': '720x1280',
    '16:9': '1280x720',
  },
  '1080p': {
    '1:1': '1080x1080',
    '4:3': '1440x1080',
    '3:4': '1080x1440',
    '9:16': '1080x1920',
    '16:9': '1920x1080',
  },
}

export const IMAGE_TIERS = Object.keys(RATIO_TIERS)

/** 图片可选画幅：与档位表同一份权威，前端「画面比例」下拉与定价都由它派生。 */
export const IMAGE_RATIOS = Object.keys(RATIO_TIERS[IMAGE_TIERS[0] ?? ''] ?? {})

/** 档位 + 比例 → 成品像素；未知档位/比例返回空串（调用方保留原图）。 */
export function pixelFor(tier: string, ratio: string): string {
  return RATIO_TIERS[tier]?.[ratio] ?? ''
}

/** 图片定价行：档位 × 画幅一一对应，尺寸由 RATIO_TIERS 派生，不再出现正方形档位。 */
export interface ImagePricingRow {
  resolution: string
  aspectRatio: string
  size: string
  pricePerImage: number
}

/**
 * 枚举图片模型的定价行。
 *
 * @param ratios - 该模型支持的画幅；缺省为全部标准画幅。
 * @returns 每个「档位 + 画幅」一行，含成品像素尺寸。
 */
export function imagePricingRows(ratios: string[] = IMAGE_RATIOS): ImagePricingRow[] {
  return IMAGE_TIERS.flatMap(resolution => ratios
    .filter(ratio => pixelFor(resolution, ratio) !== '')
    .map(ratio => ({
      resolution,
      aspectRatio: ratio,
      size: pixelFor(resolution, ratio),
      pricePerImage: 0,
    })))
}

/**
 * 处理单张图片：输出裁剪缩放后的 PNG；失败返回空串，调用方保留原图。
 *
 * @param inputFile - 源图路径。
 * @param outputFile - 成品路径，必须与 `inputFile` 不同：System.Drawing 在 Dispose 前锁住源文件。
 * @param width - 成品宽（像素）。
 * @param height - 成品高（像素）。
 * @returns 成功返回 `outputFile`，失败返回空串。
 */
export function cropImageToSize(inputFile: string, outputFile: string, width: number, height: number): Promise<string> {
  return new Promise((resolve) => {
    const inPath = inputFile.replace(/'/g, "''")
    const outPath = outputFile.replace(/'/g, "''")
    // 必须整段包在 try 里并显式 exit 1：源图不是图片时 System.Drawing 会抛错，
    // 但 PowerShell 默认继续往下跑，脚本照样打印 OK——调用方会以为裁剪成功，
    // 拿到一个并不存在的成品路径（实测：坏源图 → 空 URL → 图片整张丢失）。
    const ps = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Drawing',
      'try{',
      `$img=[System.Drawing.Image]::FromFile('${inPath}')`,
      `$w=${width};$h=${height}`,
      '$srcW=$img.Width;$srcH=$img.Height',
      '$ratio=[double]$w/$h',
      '$srcRatio=[double]$srcW/$srcH',
      'if($srcRatio -gt $ratio){$cropW=[int]($srcH*$ratio);$cropH=$srcH;$x=[int](($srcW-$cropW)/2);$y=0}else{$cropW=$srcW;$cropH=[int]($srcW/$ratio);$x=0;$y=[int](($srcH-$cropH)/2)}',
      `$bmp=New-Object System.Drawing.Bitmap($w,$h)`,
      '$g=[System.Drawing.Graphics]::FromImage($bmp)',
      '$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
      '$g.DrawImage($img,(New-Object System.Drawing.Rectangle(0,0,$w,$h)),(New-Object System.Drawing.Rectangle($x,$y,$cropW,$cropH)),[System.Drawing.GraphicsUnit]::Pixel)',
      `$bmp.Save('${outPath}',[System.Drawing.Imaging.ImageFormat]::Png)`,
      '$g.Dispose();$bmp.Dispose();$img.Dispose()',
      `if(Test-Path '${outPath}'){Write-Output OK}else{Write-Output FAIL}`,
      '}catch{Write-Output ("FAIL: "+$_.Exception.Message);exit 1}',
    ].join(';')
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      timeout: 30000,
      cwd: homedir(),
    }, (error, stdout) => {
      // 自报 OK 且成品真的落盘才算成功；否则一律返回空串，调用方保留厂商原图。
      if (error === null && String(stdout).includes('OK') && existsSync(outputFile)) resolve(outputFile)
      else resolve('')
    })
  })
}

/** 把所需尺寸拼进图片提示词，指导模型按比例构图（原图仍为正方形，服务端随后裁剪）。 */
export function ratioPromptHint(ratio: string): string {
  const named: Record<string, string> = {
    '9:16': '竖版 9:16（人物/主体居中偏上，上下留白，适合抖音/小红书封面）',
    '3:4': '竖版 3:4（主体居中，适合小红书图文）',
    '16:9': '横版 16:9（宽幅构图，适合视频封面/展示）',
    '4:3': '横版 4:3（图文排版友好）',
    '1:1': '正方形 1:1（主体居中）',
  }
  return named[ratio] ?? ''
}
