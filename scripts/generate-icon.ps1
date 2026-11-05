# Original icon variants.
Add-Type -AssemblyName System.Drawing
$brandDir = Join-Path $PSScriptRoot '..\assets\brand'
$sourceImage = [System.Drawing.Bitmap]::new((Join-Path $brandDir 'omnia-original.png'))
$mask = [System.Drawing.Bitmap]::new($sourceImage.Width, $sourceImage.Height)
$left = $sourceImage.Width; $top = $sourceImage.Height; $right = 0; $bottom = 0
for ($y = 0; $y -lt $sourceImage.Height; $y++) {
  for ($x = 0; $x -lt $sourceImage.Width; $x++) {
    $pixel = $sourceImage.GetPixel($x, $y)
    $luminance = ($pixel.R * 0.2126 + $pixel.G * 0.7152 + $pixel.B * 0.0722)
    # Paper-mask threshold.
    $alpha = [int][Math]::Clamp((180 - $luminance) * 255 / 100, 0, 255)
    if ($alpha -gt 0) {
      $mask.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, 255, 255, 255))
      $left = [Math]::Min($left, $x); $top = [Math]::Min($top, $y)
      $right = [Math]::Max($right, $x); $bottom = [Math]::Max($bottom, $y)
    }
  }
}
$drawingWidth = $right - $left + 1; $drawingHeight = $bottom - $top + 1
$side = [int][Math]::Ceiling([Math]::Max($drawingWidth, $drawingHeight) * 1.16)
$offsetX = [int][Math]::Floor(($side - $drawingWidth) / 2)
$offsetY = [int][Math]::Floor(($side - $drawingHeight) / 2)
foreach ($variant in @('light', 'dark', 'light-on-black', 'dark-on-white')) {
  $canvas = [System.Drawing.Bitmap]::new($side, $side)
  $graphics = [System.Drawing.Graphics]::FromImage($canvas)
  if ($variant -eq 'light-on-black') { $graphics.Clear([System.Drawing.Color]::Black) }
  if ($variant -eq 'dark-on-white') { $graphics.Clear([System.Drawing.Color]::White) }
  $graphics.Dispose()
  for ($y = 0; $y -lt $drawingHeight; $y++) {
    for ($x = 0; $x -lt $drawingWidth; $x++) {
      $alpha = $mask.GetPixel($left + $x, $top + $y).A
      if ($variant -eq 'light-on-black') { $color = [System.Drawing.Color]::FromArgb(255, $alpha, $alpha, $alpha) }
      elseif ($variant -eq 'dark-on-white') { $tone = 255 - $alpha; $color = [System.Drawing.Color]::FromArgb(255, $tone, $tone, $tone) }
      elseif ($variant -eq 'light') { $color = [System.Drawing.Color]::FromArgb($alpha, 255, 255, 255) }
      else { $color = [System.Drawing.Color]::FromArgb($alpha, 0, 0, 0) }
      $canvas.SetPixel($offsetX + $x, $offsetY + $y, $color)
    }
  }
  $canvas.Save((Join-Path $brandDir "omnia-$variant.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $canvas.Dispose()
}
$mask.Dispose(); $sourceImage.Dispose()
function Resize-Png([string]$sourcePath, [int]$size) {
  $source = [System.Drawing.Image]::FromFile($sourcePath)
  $canvas = [System.Drawing.Bitmap]::new($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($canvas)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.DrawImage($source, 0, 0, $size, $size)
  $stream = [System.IO.MemoryStream]::new()
  $canvas.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $stream.ToArray()
  $stream.Dispose(); $graphics.Dispose(); $canvas.Dispose(); $source.Dispose()
  return ,$bytes
}
[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot '..\assets\icon.png'), (Resize-Png (Join-Path $brandDir 'omnia-light.png') 512))
# Circular desktop icon.
# Transparent corners.
$badge = [System.Drawing.Bitmap]::new(1024,1024)
$graphics = [System.Drawing.Graphics]::FromImage($badge)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.FillEllipse([System.Drawing.Brushes]::Black,24,24,976,976)
$ring = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(100,100,94),3)
$graphics.DrawEllipse($ring,24,24,976,976)
$drawing = [System.Drawing.Image]::FromFile((Join-Path $brandDir 'omnia-light.png'))
$graphics.DrawImage($drawing,102,102,820,820)
$badgePath=Join-Path $brandDir 'omnia-circle.png'
$badge.Save($badgePath,[System.Drawing.Imaging.ImageFormat]::Png)
$drawing.Dispose();$ring.Dispose();$graphics.Dispose();$badge.Dispose()
[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot '..\assets\app-icon.png'), (Resize-Png $badgePath 512))
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @($sizes | ForEach-Object { ,(Resize-Png $badgePath $_) })
$ico = [System.IO.MemoryStream]::new(); $writer = [System.IO.BinaryWriter]::new($ico)
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Length)
$offset = 6 + 16 * $sizes.Length
for ($i = 0; $i -lt $sizes.Length; $i++) {
  $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
  $writer.Write([byte]$dimension); $writer.Write([byte]$dimension); $writer.Write([uint16]0)
  $writer.Write([uint16]1); $writer.Write([uint16]32)
  $writer.Write([uint32]$images[$i].Length); $writer.Write([uint32]$offset)
  $offset += $images[$i].Length
}
foreach ($bytes in $images) { $writer.Write([byte[]]$bytes) }
[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot '..\assets\icon.ico'), $ico.ToArray())
$writer.Dispose(); $ico.Dispose()
Write-Output "Created four pixel-preserving variants, transparent web icon, circular desktop icon and multi-resolution ICO. Drawing bounds: $left,$top to $right,$bottom."
