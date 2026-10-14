param(
  [string]$SourcePng,
  [string]$TargetIco
)

Add-Type -AssemblyName System.Drawing

$sizes = 256, 128, 64, 48, 32, 24, 16
$src = [System.Drawing.Image]::FromFile($SourcePng)
$entries = New-Object System.Collections.Generic.List[byte[]]
foreach ($size in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($src, $size, $size)
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $entries.Add($ms.ToArray())
  $ms.Dispose()
  $bmp.Dispose()
}
$src.Dispose()

$count = $entries.Count
$headerSize = 6
$dirSize = 16 * $count
$offset = $headerSize + $dirSize
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)
$bw.Write([UInt16]0)      # reserved
$bw.Write([UInt16]1)      # type: icon
$bw.Write([UInt16]$count)
foreach ($size in $sizes) {
  $bytes = $entries[[array]::IndexOf($sizes, $size)]
  $bw.Write([byte]($(if ($size -ge 256) { 0 } else { $size })))  # width
  $bw.Write([byte]($(if ($size -ge 256) { 0 } else { $size })))  # height
  $bw.Write([byte]0)      # palette
  $bw.Write([byte]0)      # reserved
  $bw.Write([UInt16]1)    # color planes
  $bw.Write([UInt16]32)   # bpp
  $bw.Write([UInt32]$bytes.Length)
  $bw.Write([UInt32]$offset)
  $offset += $bytes.Length
}
foreach ($bytes in $entries) {
  $bw.Write($bytes)
}
$bw.Flush()
[System.IO.File]::WriteAllBytes($TargetIco, $out.ToArray())
$out.Dispose()

$fi = Get-Item $TargetIco
Write-Output ("ICO written: {0} ({1} bytes, {2} sizes)" -f $fi.FullName, $fi.Length, $count)
