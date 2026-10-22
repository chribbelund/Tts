# Which program is in front, on Windows, run by Windows PowerShell so nothing
# has to be installed. screen-main.js puts a line before this one saying what
# to do: $Mode = 'watch' or $Mode = 'list'.
#
#   watch  One line each time another program comes to the front:
#            {"app":{"pid":123,"exe":"eldenring.exe","name":"ELDEN RING","title":"…"}}
#   list   One line with the programs that have a window open, then it stops:
#            {"apps":[{…}, …]}

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8

function Send($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

function Describe($p) {
  $name = ''
  # Games with anti-cheat and programs run as administrator don't let us look.
  try { $name = [string]$p.MainModule.FileVersionInfo.FileDescription } catch { $name = '' }
  if (-not $name) { $name = $p.ProcessName }
  @{ pid = $p.Id; exe = "$($p.ProcessName).exe"; name = $name.Trim(); title = [string]$p.MainWindowTitle }
}

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ChatReaderForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
} catch {
  Send @{ error = "Can't see which program is in front: $($_.Exception.Message)" }
  exit 1
}

if ($Mode -eq 'list') {
  $apps = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Id -ne $PID } | ForEach-Object { Describe $_ })
  Send @{ apps = $apps }
  exit 0
}

Send @{ ready = $true }
$last = -1
while ($true) {
  try {
    $procId = [uint32]0
    $window = [ChatReaderForeground]::GetForegroundWindow()
    if ($window -ne [IntPtr]::Zero) {
      $null = [ChatReaderForeground]::GetWindowThreadProcessId($window, [ref]$procId)
      if ($procId -ne 0 -and $procId -ne $last) {
        $last = $procId
        Send @{ app = (Describe (Get-Process -Id $procId)) }
      }
    }
  } catch [System.IO.IOException] {
    exit 0   # the app went away
  } catch {
    # The program closed between looking and asking about it; look again.
  }
  Start-Sleep -Milliseconds 800
}
