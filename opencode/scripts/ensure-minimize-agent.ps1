# ensure-minimize-agent.ps1
# Idempotent guard: starts the agent-browser minimizer watcher ONLY if none is running.
# Excludes the checking shell's own PID (its cmdline contains the script name too).
if (-not (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'minimize-agent-browser' -and $_.ProcessId -ne $PID })) {
  Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','C:\Users\Administrator\.config\opencode\scripts\minimize-agent-browser.ps1'
}
