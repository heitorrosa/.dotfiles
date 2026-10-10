#Requires -Version 5.1
<#
.SYNOPSIS
  pwsh port of check-doc-changes.sh — fail CI when behavior files change w/o docs.
.USAGE
  check-doc-changes.ps1 [-DryRun] [baseRef]
#>
param([switch]$DryRun, [string]$BaseRef = 'HEAD~1')
Write-Host "Checking documentation changes against $BaseRef..."
$changed = (git diff --name-only $BaseRef HEAD 2>$null) -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if (-not $changed) { Write-Host 'No files changed.'; exit 0 }
$behavior = $changed | Where-Object { $_ -like 'src/*.ts' -or $_ -like 'commands/*.md' -or $_ -like 'skills/*/*.md' }
if (-not $behavior) { Write-Host 'No behavior-changing files modified.'; exit 0 }
$behavior | ForEach-Object { Write-Host "  - $_" }
$needDocs = $false
foreach ($f in $behavior) {
  $hit = $false
  foreach ($c in $changed) { if ($c -like 'README.md' -or $c -like 'wiki/*' -or $c -like 'docs/*' -or $c -like 'INSTALL.md') { $hit = $true; break } }
  if (-not $hit) { $needDocs = $true; break }
}
if ($needDocs) {
  if ($DryRun) { Write-Host '[DRY-RUN] Would fail CI - documentation updates required'; exit 0 }
  Write-Error 'FAIL: Documentation updates required for behavior changes'; exit 1
}
Write-Host 'All required documentation updates present.'
