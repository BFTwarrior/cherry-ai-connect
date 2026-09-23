param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$IconVersion = '1.33'
)

Add-Type -AssemblyName System.Drawing

$size = 256
$bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
$graphics.Clear([System.Drawing.Color]::Transparent)
$graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver

$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(16, 16, 54, 54, 180, 90)
$path.AddArc(186, 16, 54, 54, 270, 90)
$path.AddArc(186, 186, 54, 54, 0, 90)
$path.AddArc(16, 186, 54, 54, 90, 90)
$path.CloseFigure()

$bounds = New-Object System.Drawing.Rectangle(16, 16, 224, 224)
$fill = New-Object System.Drawing.Drawing2D.LinearGradientBrush($bounds, [System.Drawing.Color]::FromArgb(255, 165, 108, 255), [System.Drawing.Color]::FromArgb(255, 103, 56, 183), 315)
$graphics.FillPath($fill, $path)
$edge = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, 205, 174, 255), 3)
$graphics.DrawPath($edge, $path)

$star = New-Object System.Drawing.Drawing2D.GraphicsPath
$star.AddLine(128, 51, 143, 113)
$star.AddLine(205, 128, 143, 143)
$star.AddLine(128, 205, 113, 143)
$star.AddLine(51, 128, 113, 113)
$star.CloseFigure()
$starPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 7)
$starPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$graphics.DrawPath($starPen, $star)

$appIconPath = Join-Path $ProjectRoot "electron\assets\app-$IconVersion.ico"
$frames = New-Object 'System.Collections.Generic.List[byte[]]'
foreach ($frameSize in @(16, 24, 32, 48, 64, 128, 256)) {
  $frame = New-Object System.Drawing.Bitmap($frameSize, $frameSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $frameGraphics = [System.Drawing.Graphics]::FromImage($frame)
  $frameGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $frameGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $frameGraphics.DrawImage($bitmap, (New-Object System.Drawing.Rectangle(0, 0, $frameSize, $frameSize)))
  $frameStream = New-Object System.IO.MemoryStream
  $frame.Save($frameStream, [System.Drawing.Imaging.ImageFormat]::Png)
  $frames.Add($frameStream.ToArray())
  $frameStream.Dispose()
  $frameGraphics.Dispose()
  $frame.Dispose()
}
$icoStream = [System.IO.File]::Open($appIconPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$writer = New-Object System.IO.BinaryWriter($icoStream)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$frames.Count)
$offset = 6 + 16 * $frames.Count
for ($index = 0; $index -lt $frames.Count; $index++) {
  $frameSize = @(16, 24, 32, 48, 64, 128, 256)[$index]
  $writer.Write([byte]($frameSize % 256))
  $writer.Write([byte]($frameSize % 256))
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$frames[$index].Length)
  $writer.Write([UInt32]$offset)
  $offset += $frames[$index].Length
}
foreach ($frameBytes in $frames) { $writer.Write($frameBytes) }
$writer.Flush()
$writer.Dispose()
$icoStream.Dispose()

$trayBitmap = New-Object System.Drawing.Bitmap(32, 32, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$trayGraphics = [System.Drawing.Graphics]::FromImage($trayBitmap)
$trayGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$trayGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$trayGraphics.DrawImage($bitmap, (New-Object System.Drawing.Rectangle(0, 0, 32, 32)), $bounds, [System.Drawing.GraphicsUnit]::Pixel)
$trayPath = Join-Path $ProjectRoot 'electron\assets\tray.png'
$trayBitmap.Save($trayPath, [System.Drawing.Imaging.ImageFormat]::Png)

$trayGraphics.Dispose()
$trayBitmap.Dispose()
$starPen.Dispose()
$star.Dispose()
$edge.Dispose()
$fill.Dispose()
$path.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output "Generated $appIconPath and $trayPath"
