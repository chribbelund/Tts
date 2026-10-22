# Text recognition on Windows 10 and 11 with the OCR built into Windows
# (Windows.Media.Ocr), run by Windows PowerShell, so nothing has to be
# installed. screen-main.js starts it once and keeps it running.
#
# One job per line on stdin:  {"id":1,"png":"<base64>"}
# One answer per line out:    {"id":1,"lines":[{"text":"...","conf":1,"box":[x,y,w,h]}]}
# Boxes are fractions of the image, measured from the top left.

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8

function Send($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
} catch {
  Send @{ error = "Windows text recognition isn't available: $($_.Exception.Message)" }
  exit 1
}
if ($null -eq $engine) {
  Send @{ error = 'Windows has no text recognition for your languages. Add a language with "Optical character recognition" under Settings, Time & language, Language & region.' }
  exit 1
}

function Await($operation, [Type]$type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($operation))
  $null = $task.Wait(-1)
  $task.Result
}

$maxSide = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
Send @{ ready = $true; engine = 'Windows OCR'; maxSide = $maxSide; language = $engine.RecognizerLanguage.DisplayName }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = $null
  try {
    $job = $line | ConvertFrom-Json
    $id = $job.id
    $started = Get-Date
    $bytes = [Convert]::FromBase64String($job.png)
    $memory = New-Object System.IO.MemoryStream(, $bytes)
    $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $width = [double]$decoder.PixelWidth
    $height = [double]$decoder.PixelHeight
    $lines = New-Object System.Collections.ArrayList
    foreach ($l in $result.Lines) {
      $x1 = [double]::MaxValue; $y1 = [double]::MaxValue; $x2 = 0.0; $y2 = 0.0
      foreach ($w in $l.Words) {
        $r = $w.BoundingRect
        if ($r.X -lt $x1) { $x1 = $r.X }
        if ($r.Y -lt $y1) { $y1 = $r.Y }
        if ($r.X + $r.Width -gt $x2) { $x2 = $r.X + $r.Width }
        if ($r.Y + $r.Height -gt $y2) { $y2 = $r.Y + $r.Height }
      }
      if ($x2 -le $x1) { continue }
      $null = $lines.Add(@{ text = $l.Text; conf = 1; box = @(($x1 / $width), ($y1 / $height), (($x2 - $x1) / $width), (($y2 - $y1) / $height)) })
    }
    $bitmap.Dispose()
    $stream.Dispose()
    $memory.Dispose()
    Send @{ id = $id; lines = $lines.ToArray(); ms = [int]((Get-Date) - $started).TotalMilliseconds }
  } catch {
    Send @{ id = $id; error = $_.Exception.Message }
  }
}
