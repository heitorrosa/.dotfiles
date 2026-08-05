# minimize-agent-browser.ps1
# Standing daemon: whenever the chrome-devtools-mcp agent Thorium window
# ("User Data Agent") appears (MCP launch / restart), minimize it immediately.
# Thorium 150 ignores --start-minimized, so this is the only reliable way.
# The whole poll body is wrapped in try/catch: a transient error (e.g. the
# agent window closing between Get-Process and IsIconic, or a WMI hiccup)
# must never kill the daemon — unhandled exceptions previously did.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinMinD {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
while ($true) {
  try {
    $main = Get-CimInstance Win32_Process -Filter "Name='thorium.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match 'User Data Agent' -and $_.CommandLine -notmatch '--type=' } |
      Select-Object -First 1
    if ($main) {
      $p = Get-Process -Id $main.ProcessId -ErrorAction SilentlyContinue
      if ($p -and $p.MainWindowHandle -ne 0) {
        if (-not [WinMinD]::IsIconic($p.MainWindowHandle)) {
          [WinMinD]::ShowWindowAsync($p.MainWindowHandle, 6) | Out-Null
        }
      }
    }
  } catch {
    # transient poll errors must not kill the daemon
  }
  Start-Sleep -Seconds 2
}
