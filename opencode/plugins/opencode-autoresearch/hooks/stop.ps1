#Requires -Version 5.1
# pwsh port of stop.sh — flags background run as stopping, path-guarded.
$StatusFile = if ($env:AUTORESEARCH_STATE) { $env:AUTORESEARCH_STATE } else { '.autoresearch/state.json' }
$root = (Get-Location).Path
$abs = if ([IO.Path]::IsPathRooted($StatusFile)) { $StatusFile } else { Join-Path $root $StatusFile }
if ($abs -notlike ($root + '*')) { Write-Output 'Refusing state file outside workspace.'; exit 0 }
if (-not (Test-Path -LiteralPath $abs)) { Write-Output 'No active run.'; exit 0 }
try {
  $s = Get-Content -Raw -LiteralPath $abs | ConvertFrom-Json
  if ($s.mode -ne 'background') { Write-Output 'Only background runs can be stopped.'; exit 0 }
  $s.updated_at = (Get-Date).ToUniversalTime().ToString('o')
  $s.flags.stop_requested = $true
  $s.flags.background_active = $false
  $s.status = 'stopping'
  $tmp = "$abs.tmp.$PID"
  ($s | ConvertTo-Json -Depth 20) + "`n" | Set-Content -LiteralPath $tmp -Encoding utf8
  Move-Item -Force -LiteralPath $tmp -Destination $abs
  Write-Output ("Stop requested for run: " + $s.run_id)
} catch { Write-Output 'Could not update state.' }
