#Requires -Version 5.1
<#
.SYNOPSIS
  pwsh port of cleanup.sh — AutoResearch artifact cleanup (dry-run by default).
.USAGE
  cleanup.ps1 [-Apply]
#>
param([switch]$Apply)
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
if ([string]::IsNullOrEmpty($RepoRoot)) { $RepoRoot = (Get-Location).Path }
function Remove-Guarded([string]$Path, [string]$Label) {
  if (-not $Path.StartsWith($RepoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Write-Error "refusing to remove path outside repository: $Path"; return
  }
  if ($Apply) { Remove-Item -Recurse -Force -LiteralPath $Path -ErrorAction SilentlyContinue; Write-Host "removed $Label`: $(Split-Path -Leaf $Path)" }
  else { Write-Host "would remove $Label`: $(Split-Path -Leaf $Path)" }
}
if ($Apply) { Write-Host 'AutoResearch cleanup starting...' } else { Write-Host 'AutoResearch cleanup dry run. Pass -Apply to delete files.' }
$exp = Join-Path $RepoRoot 'experiments'
if (Test-Path -LiteralPath $exp) {
  Get-ChildItem -LiteralPath $exp -Directory | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | ForEach-Object { Remove-Guarded $_.FullName 'old experiment' }
}
$cache = Join-Path $RepoRoot 'node_modules\.cache'
if (Test-Path -LiteralPath $cache) { Remove-Guarded $cache 'node_modules cache' }
Write-Host 'AutoResearch cleanup done'
