#Requires -Version 5.1
# pwsh port of init.sh — SessionStart checklist, fail-open.
$state = Join-Path (Get-Location).Path '.autoresearch/state.json'
if (Test-Path -LiteralPath $state) {
  try {
    $s = Get-Content -Raw -LiteralPath $state | ConvertFrom-Json
    if ($s.status -eq 'running' -or $s.status -eq 'initialized') {
      Write-Output 'Auto Research checklist:'
      Write-Output '- If fresh managed run, baseline first, then init results/state.'
      Write-Output '- Record every completed experiment before starting the next one.'
      Write-Output '- Keep retain/stop label gates satisfied before marking kept.'
      Write-Output '- Respect iteration and duration caps.'
      Write-Output '- After launch approval, continue by default unless stopped.'
    }
  } catch {}
}
