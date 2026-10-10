#Requires -Version 5.1
# pwsh port of status.sh — read-only state print, never mutates remotes.
$StatusFile = if ($env:AUTORESEARCH_STATE) { $env:AUTORESEARCH_STATE } else { '.autoresearch/state.json' }
if (Test-Path -LiteralPath $StatusFile) {
  try {
    $s = Get-Content -Raw -LiteralPath $StatusFile | ConvertFrom-Json
    Write-Output ("Auto Research run: " + $s.run_id)
    Write-Output ("Status: " + $s.status)
    Write-Output ("Mode: " + $s.mode)
    Write-Output ("Goal: " + $s.goal)
    Write-Output ("Iterations: " + $s.stats.total_iterations)
    Write-Output ("Kept: " + $s.stats.kept + " | Discarded: " + $s.stats.discarded)
    if ($s.flags.needs_human) { Write-Output 'NEEDS HUMAN' }
    if ($s.flags.stop_requested) { Write-Output 'STOP REQUESTED' }
  } catch { Write-Output 'No active run.' }
} else { Write-Output 'No active run.' }
