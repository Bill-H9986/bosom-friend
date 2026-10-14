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

/**
 * 按区域裁切图片（原样取一块，不缩放、不居中）。
 *
 * 与 {@link cropImageToSize} 的分工：那个是"居中裁到目标比例再缩放"，服务出图档位；
 * 这个是"从原图取一个矩形"，服务**把一张拼图切成几块**——人物的四视图
 * （正面 / 侧面 / 背面 / 大头照）必须切成独立图片才能当多角度参考：
 * 整张拼图交出去，厂商按 **1 张**处理走 keyframe，画面会被锁死在这一帧上。
 *
 * @param inputFile - 源图路径。
 * @param outputFile - 成品路径，必须与源图不同（System.Drawing 在 Dispose 前锁住源文件）。
 * @param region - 裁切矩形（像素，左上角为原点）；越界部分夹回图内。
 * @returns 成功返回 `outputFile`，失败返回空串。
 */
export function cropImageRegion(
  inputFile: string,
  outputFile: string,
  region: { x: number, y: number, width: number, height: number },
): Promise<string> {
  return new Promise((resolve) => {
    const inPath = inputFile.replace(/'/g, "''")
    const outPath = outputFile.replace(/'/g, "''")
    const ps = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Drawing',
      'try{',
      `$img=[System.Drawing.Image]::FromFile('${inPath}')`,
      `$x=${region.x};$y=${region.y};$w=${region.width};$h=${region.height}`,
      // 按比例算出来的边界可能因取整越界一两个像素，夹回图内再画。
      'if($x -lt 0){$x=0};if($y -lt 0){$y=0}',
      'if($x+$w -gt $img.Width){$w=$img.Width-$x}',
      'if($y+$h -gt $img.Height){$h=$img.Height-$y}',
      'if($w -le 0 -or $h -le 0){Write-Output "FAIL: empty region";exit 1}',
      '$bmp=New-Object System.Drawing.Bitmap($w,$h)',
      '$g=[System.Drawing.Graphics]::FromImage($bmp)',
      '$g.DrawImage($img,(New-Object System.Drawing.Rectangle(0,0,$w,$h)),(New-Object System.Drawing.Rectangle($x,$y,$w,$h)),[System.Drawing.GraphicsUnit]::Pixel)',
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
      if (error === null && String(stdout).includes('OK') && existsSync(outputFile)) resolve(outputFile)
      else resolve('')
    })
  })
}

/**
 * 把图片补边到厂商要求的最小宽高比（背景色填充，原图居中）。
 *
 * 为什么必须补：Agnes 视频接口对输入图有硬校验——**宽高比必须在 0.4–2.5 之间**，
 * 否则直接 HTTP 400（厂商原文：输入图宽高比必须在 0.4–2.5 之间）。
 * 而从横向三视图里按人物列切出来的单格天生很窄（实测 262×960 = 0.27），
 * 三个角度图全部不合规、整条片子在第 1 镜就被拒。补边不改变构图，只把画布撑到合规。
 *
 * @param inputFile - 源图路径。
 * @param outputFile - 成品路径，必须与源图不同。
 * @param minAspect - 允许的最小宽高比（宽/高）。
 * @returns 成功返回 `outputFile`，失败返回空串。
 */
export function padImageToMinAspect(inputFile: string, outputFile: string, minAspect = 0.42): Promise<string> {
  return new Promise((resolve) => {
    const inPath = inputFile.replace(/'/g, "''")
    const outPath = outputFile.replace(/'/g, "''")
    const ps = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Drawing',
      'try{',
      `$img=[System.Drawing.Image]::FromFile('${inPath}')`,
      '$w=$img.Width;$h=$img.Height',
      `$min=${minAspect}`,
      'if(($w/$h) -ge $min){$img.Dispose();Write-Output "SKIP";exit 0}',
      '$newW=[int][math]::Ceiling($h*$min)',
      '$bmp=New-Object System.Drawing.Bitmap($newW,$h)',
      '$g=[System.Drawing.Graphics]::FromImage($bmp)',
      '$g.Clear([System.Drawing.Color]::FromArgb(255,244,244,244))',
      '$x=[int](($newW-$w)/2)',
      '$g.DrawImage($img,(New-Object System.Drawing.Rectangle($x,0,$w,$h)),(New-Object System.Drawing.Rectangle(0,0,$w,$h)),[System.Drawing.GraphicsUnit]::Pixel)',
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
      // SKIP = 本来就合规，调用方保留原文件即可。
      if (String(stdout).includes('SKIP')) { resolve(inputFile); return }
      if (error === null && String(stdout).includes('OK') && existsSync(outputFile)) resolve(outputFile)
      else resolve('')
    })
  })
}

/**
 * 检测一张人物拼图里**人物之间的空白列**，返回每一格的左右边界。
 *
 * 为什么不能按固定网格切：素材的版面是**不确定**的——实测用户传的是一张 720×960 的
 * **横向三视图**（三个人并排、各占约 1/3 宽），按 2×2 切出来的第一格是
 * \"正面那人的上半身 + 侧面那人的半个身子\"，等于把素材切废了。
 * 拼图的人物之间一定有**整列的背景色**，所以沿垂直方向扫一遍、找出这些空白列，
 * 就能按内容而不是按坐标切。
 *
 * @param inputFile - 拼图路径。
 * @returns 每格的 { x, width }（按从左到右）；检测不出（没有明显空白列）时返回空数组。
 */
export function detectColumnBounds(inputFile: string): Promise<Array<{ x: number, width: number }>> {
  return new Promise((resolve) => {
    const inPath = inputFile.replace(/'/g, "''")
    const ps = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Drawing',
      `$img=[System.Drawing.Image]::FromFile('${inPath}')`,
      '$w=$img.Width;$h=$img.Height',
      // 角落像素当背景色（拼图的背景通常是纯色）。
      '$bg=New-Object System.Drawing.Bitmap($img)',
      '$c=$bg.GetPixel(2,2)',
      // 逐列判定：这一列上均匀取 24 个采样点，全部与背景色接近就算空白列。
      '$blank=@()',
      'for($x=0;$x -lt $w;$x++){',
      '  $same=0;$n=0',
      '  for($k=1;$k -le 40;$k++){',
      '    $y=[int]($h*$k/41)',
      '    $p=$bg.GetPixel($x,$y);$n++',
      '    if([math]::Abs($p.R-$c.R) -lt 26 -and [math]::Abs($p.G-$c.G) -lt 26 -and [math]::Abs($p.B-$c.B) -lt 12){$same++}',
      '  }',
      '  if($same -eq $n){$blank+=$x}',
      '}',
      // 把连续空白列并成区间，取中间作为分界。
      '$segs=@();$start=-1',
      'for($i=0;$i -lt $blank.Count;$i++){',
      '  if($start -lt 0){$start=$blank[$i]}',
      '  if($i -eq $blank.Count-1 -or $blank[$i+1] -ne $blank[$i]+1){$segs+=,@($start,$blank[$i]);$start=-1}',
      '}',
      // 只保留"图内"的分界（太靠边的空白是画布留白，不是人物之间的缝）。
      '$cuts=@()',
      'foreach($s in $segs){$mid=[int](($s[0]+$s[1])/2);if($mid -gt $w*0.08 -and $mid -lt $w*0.92){$cuts+=$mid}}',
      'Write-Output ("OK " + $w + "|" + ($cuts -join ","))',
      '$bg.Dispose();$img.Dispose()',
    ].join(';')
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      timeout: 60000,
      cwd: homedir(),
    }, (error, stdout) => {
      const m = /OK ?(\d+)\|([0-9,]*)/.exec(String(stdout))
      if (error !== null || m === null) { resolve([]); return }
      const imageWidth = Number(m[1] ?? 0)
      const cuts = String(m[2] ?? '').split(',').filter(s => s !== '').map(Number).sort((a, b) => a - b)
      if (cuts.length === 0) { resolve([]); return }
      const bounds: Array<{ x: number, width: number }> = []
      let left = 0
      for (const cut of cuts) { if (cut - left > 8) { bounds.push({ x: left, width: cut - left }); left = cut } }
      // 最后一格一直画到图右边缘：之前漏了这一步，检出的总宽小于图宽，最后一格整个丢失
      // （实测 720 宽的横向三视图只切出 2 格、总宽 450）。
      if (imageWidth - left > 8) bounds.push({ x: left, width: imageWidth - left })
      resolve(bounds)
    })
  })
}

/**
 * 读图片的像素尺寸。
 *
 * 四视图切分要先知道原图多大，才能按 2×2 算出四个矩形。
 *
 * @param inputFile - 图片路径。
 * @returns 宽高；读不出来返回 null（调用方据此放弃切分、按原图继续，绝不硬切成四块废图）。
 */
export function readImageSize(inputFile: string): Promise<{ width: number, height: number } | null> {
  return new Promise((resolve) => {
    const inPath = inputFile.replace(/'/g, "''")
    const ps = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Drawing',
      `$img=[System.Drawing.Image]::FromFile('${inPath}')`,
      'Write-Output ("OK " + $img.Width + "x" + $img.Height)',
      '$img.Dispose()',
    ].join(';')
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      timeout: 20000,
      cwd: homedir(),
    }, (error, stdout) => {
      const m = /OK (\d+)x(\d+)/.exec(String(stdout))
      if (error === null && m !== null) resolve({ width: Number(m[1]), height: Number(m[2]) })
      else resolve(null)
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
