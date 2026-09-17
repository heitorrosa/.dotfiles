<#
.SYNOPSIS
  Detached launcher for opencode web UI (v2-like synced experience, single shared server).
  Launch: powershell -ExecutionPolicy Bypass -File C:\Users\Administrator\.config\opencode\launch-opencode-web.ps1
  Attach: opencode attach http://localhost:4096
  Web UI: http://localhost:4096
.DESCRIPTION
  Spawns opencode web detached via Start-Process with stdout/stderr redirected
  to a log file + PID file, then exits immediately. The harness must never block
  on the child: never run opencode web/serve synchronously in the invoking shell,
  never use Get-Content -Wait on the log (poll with Get-Content -Tail N instead).
  Requires opencode.json server block: port 4096, hostname 127.0.0.1
PHONE FOLLOW-UP (not enabled yet, local-first on purpose):
1. Tailscale serve (preferred over exposing 0.0.0.0 to LAN):
   tailscale serve --bg http://127.0.0.1:4096
   then open the https Tailscale URL from the phone (same tailnet).
2. Password-protect BEFORE any non-loopback exposure:
   set OPENCODE_SERVER_PASSWORD=<long-random> on the server side, then
   opencode attach https://<tailnet-name>:443 -u opencode -p <same>
   (username defaults to OPENCODE_SERVER_USERNAME or opencode).
3. mDNS alt (same LAN, no Tailscale): opencode serve --mdns --mdns-domain opencode.local
   NOTE: --mdns flips hostname default to 0.0.0.0, so set a password first.
4. To bind LAN directly (only with password set): change server block hostname
   to 0.0.0.0 in opencode.json AND relaunch with hostname 0.0.0.0.
DO NOT set hostname 0.0.0.0 without OPENCODE_SERVER_PASSWORD.
#>

$ErrorActionPreference = 'Stop'
$BaseDir = 'C:\Users\Administrator\.config\opencode'
$LogDir  = Join-Path $BaseDir 'logs'
$LogFile = Join-Path $LogDir 'opencode-web.log'
$ErrFile = Join-Path $LogDir 'opencode-web.err.log'
$PidFile = Join-Path $BaseDir 'opencode-web.pid'

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

$existing = netstat -ano | Select-String '127.0.0.1:4096'
if ($existing) {
  Write-Output 'Port 4096 already LISTENING - not spawning a second server:'
  $existing | ForEach-Object { Write-Output $_.Line }
  if (Test-Path -LiteralPath $PidFile) {
    $pidContent = Get-Content -LiteralPath $PidFile -Raw
    Write-Output ([string]::Concat('PID file: ', $pidContent))
  }
  exit 0
}

if (Test-Path -LiteralPath $PidFile) {
  $oldPid = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  $alive = Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | Where-Object { [string]$_.ProcessId -eq [string]$oldPid }
  if (-not $alive) { Remove-Item -LiteralPath $PidFile -Force }
}

$proc = Start-Process -FilePath 'opencode' -ArgumentList 'web','--port','4096','--hostname','127.0.0.1' -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile -WindowStyle Hidden -PassThru

$proc.Id | Set-Content -LiteralPath $PidFile -NoNewline
$msg = [string]::Concat('Launched opencode web PID ', $proc.Id, ' -> http://localhost:4096 (log: ', $LogFile, ')')
Write-Output $msg
exit 0
