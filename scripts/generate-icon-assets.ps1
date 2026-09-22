param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
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

$appIconPath = Join-Path $ProjectRoot 'electron\assets\app.ico'
$pngStream = New-Object System.IO.MemoryStream
$bitmap.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $pngStream.ToArray()
$icoStream = [System.IO.File]::Open($appIconPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$writer = New-Object System.IO.BinaryWriter($icoStream)
$writer.Write([byte[]](0, 0, 1, 0, 1, 0))
$writer.Write([byte[]](0, 0, 0, 0, 1, 0, 32, 0))
$writer.Write([System.BitConverter]::GetBytes([UInt32]$pngBytes.Length))
$writer.Write([System.BitConverter]::GetBytes([UInt32]22))
$writer.Write($pngBytes)
$writer.Flush()
$writer.Dispose()
$icoStream.Dispose()
$pngStream.Dispose()

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
