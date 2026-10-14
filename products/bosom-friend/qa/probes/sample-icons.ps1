param(
  [string[]]$Paths
)

Add-Type -AssemblyName System.Drawing

function Get-ImageSignature {
  param([string]$Path)
  try {
    $img = [System.Drawing.Image]::FromFile($Path)
    $bmp = New-Object System.Drawing.Bitmap($img)
    $img.Dispose()
    $w = $bmp.Width; $h = $bmp.Height
    $cells = @()
    for ($y = 0; $y -lt 8; $y++) {
      for ($x = 0; $x -lt 8; $x++) {
        $r = 0; $g = 0; $b = 0; $n = 0
        $x0 = [int]($bmp.Width * $x / 8); $x1 = [int]($bmp.Width * ($x + 1) / 8)
        $y0 = [int]($bmp.Height * $y / 8); $y1 = [int]($bmp.Height * ($y + 1) / 8)
        for ($py = $y0; $py -lt $y1; $py += 2) {
          for ($px = $x0; $px -lt $x1; $px += 2) {
            $c = $bmp.GetPixel($px, $py)
            if ($c.A -gt 40) { $r += $c.R; $g += $c.G; $b += $c.B; $n++ }
          }
        }
        if ($n -gt 0) { $cells += [string]::Format('{0:X2}{1:X2}{2:X2}', [int]($r/$n), [int]($g/$n), [int]($b/$n)) }
        else { $cells += '000000' }
      }
    }
    $bmp.Dispose()
    return @{ path = $Path; w = $w; h = $h; sig = ($cells -join '') }
  } catch {
    return @{ path = $Path; error = $_.Exception.Message }
  }
}

$results = foreach ($p in $Paths) { Get-ImageSignature -Path $p }
$results | ConvertTo-Json -Depth 3

function Compare-Sig {
  param($a, $b)
  $sum = 0
  for ($i = 0; $i -lt [Math]::Min($a.sig.Length, $b.sig.Length); $i += 6) {
    for ($j = 0; $j -lt 3; $j++) {
      $va = [Convert]::ToInt32($a.sig.Substring($i + 2*$j, 2), 16)
      $vb = [Convert]::ToInt32($b.sig.Substring($i + 2*$j, 2), 16)
      $sum += [Math]::Abs($va - $vb)
    }
  }
  return $sum
}

for ($i = 0; $i -lt $results.Count; $i++) {
  for ($j = $i + 1; $j -lt $results.Count; $j++) {
    if ($results[$i].sig -and $results[$j].sig) {
      $d = Compare-Sig $results[$i] $results[$j]
      Write-Output ("DIST [{0}] vs [{1}] = {2}" -f $results[$i].path, $results[$j].path, $d)
    }
  }
}
