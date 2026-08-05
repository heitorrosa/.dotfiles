# ensure-via-cim.ps1 — guard + WMI-launch the daemon, fully hidden.
# The plugin spawns this once per session (bun, windowsHide -> no window).
# If the daemon is already running, exit silently (no WMI, no window).
# Otherwise launch wscript.exe via WMI: wscript is a GUI app so no console
# window can appear, and WMI/wscript ownership escapes bun's job object so
# the daemon survives the parent.
$existing = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match '\-File .*minimize-agent-browser\.ps1' }
if ($existing) { exit 0 }

$inner = 'wscript.exe "C:\Users\Administrator\.config\opencode\scripts\launch-daemon-hidden.vbs"'
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $inner } | Out-Null
