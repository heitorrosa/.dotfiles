#Requires -Version 5.1
<#
.SYNOPSIS
  pwsh port of model-router.sh — pick model from config/model-routing.json.
.USAGE
  model-router.ps1 [configPath] [taskType] [complexity]
#>
param([string]$Config = 'config/model-routing.json', [string]$TaskType = 'research', [string]$Complexity = 'simple')
if (-not (Test-Path -LiteralPath $Config)) { 'opencode-zen/big-pickle'; exit 0 }
try {
  $cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
  $routing = $cfg.routing.$TaskType
  $tiers = $routing.tiers
  if (@('complex','hard','critical') -contains $Complexity) { $order = @('paid','free','fallback') }
  else { $order = @('free','paid','fallback') }
  foreach ($t in $order) { if ($tiers.$t -and $tiers.$t.Count -gt 0) { $tiers.$t[0]; exit 0 } }
  'kimi-k2.6'
} catch { 'kimi-k2.6' }
