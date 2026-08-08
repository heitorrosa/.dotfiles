# ensure-minimize-agent.ps1
# Idempotent guard: starts the agent-browser minimizer watcher ONLY if none is running.
# Matches the actual daemon (-File ...minimize-agent-browser.ps1) so diagnostic
# shells that merely mention the name (or this script's own cmdline) don't trip it.
if (-not (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match '\-File .*minimize-agent-browser\.ps1' })) {
  Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','C:\Users\Administrator\.config\opencode\scripts\minimize-agent-browser.ps1'
}
