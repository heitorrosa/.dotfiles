#Requires -Version 5.1
<#
.SYNOPSIS
  Windows PowerShell port of backup-state.sh (moedesux/autoresearch-opencode).
  Rolling backups of autoresearch state files: *.bak.yyyyMMdd_HHmmss, keep 5.
.USAGE
  backup-state.ps1 backup|restore <file>|restore-auto|list|cleanup|all
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('backup', 'restore', 'restore-auto', 'list', 'cleanup', 'all')]
  [string]$Command = 'backup',
  [Parameter(Position = 1)]
  [string]$File
)

$StateFiles = @('autoresearch.jsonl', 'autoresearch-dashboard.md', 'experiments/worklog.md')
$MaxBackups = 5

function Backup-One([string]$Target) {
  if (-not (Test-Path -LiteralPath $Target)) { return }
  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  Copy-Item -LiteralPath $Target -Destination "$Target.bak.${stamp}" -Force
}

function Backup-All {
  foreach ($f in $StateFiles) { Backup-One $f }
  foreach ($f in $StateFiles) {
    $dir = Split-Path -Parent $f
    if ([string]::IsNullOrEmpty($dir)) { $dir = '.' }
    $base = Split-Path -Leaf $f
    Get-ChildItem -LiteralPath $dir -Filter "$base.bak.*" -File -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      Select-Object -Skip $MaxBackups |
      Remove-Item -Force
  }
  Write-Host 'Backup complete'
}

function Restore-File([string]$Target) {
  if ([string]::IsNullOrEmpty($Target)) { Write-Error 'Usage: backup-state.ps1 restore <file>'; exit 1 }
  if (-not (Test-Path -LiteralPath $Target)) { Write-Error "Backup not found: $Target"; exit 1 }
  $orig = $Target -replace '\.bak\.\d{8}_\d{6}$', ''
  Copy-Item -LiteralPath $Target -Destination $orig -Force
  Write-Host "Restored $orig from $Target"
}

function Restore-Auto {
  $latest = Get-ChildItem -Filter 'autoresearch.jsonl.bak.*' -File -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
  if ($null -eq $latest) { Write-Error 'No autoresearch.jsonl backups found'; exit 1 }
  Restore-File $latest.FullName
}

function List-Backups {
  Get-ChildItem -Recurse -Filter '*.bak.*' -File -ErrorAction SilentlyContinue |
    Sort-Object FullName | ForEach-Object { $_.FullName }
}

function Cleanup-All {
  Get-ChildItem -Recurse -Filter '*.bak.*' -File -ErrorAction SilentlyContinue | Remove-Item -Force
  Write-Host 'All backups removed'
}

switch ($Command) {
  'backup'       { Backup-All }
  'restore'      { Restore-File $File }
  'restore-auto' { Restore-Auto }
  'list'         { List-Backups }
  'cleanup'      { Cleanup-All }
  'all'          { Backup-All }
}
