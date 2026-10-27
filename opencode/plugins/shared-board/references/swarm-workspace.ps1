param(
  [Parameter(Mandatory = $true)]
  [string]$SwarmId
)

# Resolve and ensure the swarm brief workspace: .opencode/swarm/briefs/<swarm-id>/
# Single source of truth for brief/charter/envelope paths so they cannot drift.

if ([string]::IsNullOrWhiteSpace($SwarmId)) {
  [Console]::Error.WriteLine("usage: swarm-workspace.ps1 -SwarmId <id>")
  exit 2
}
if ($SwarmId -match '[\\/]') {
  [Console]::Error.WriteLine("invalid SwarmId (no path separators): $SwarmId")
  exit 2
}

$root = $null
try {
  $root = (git rev-parse --show-toplevel 2>$null).Trim()
} catch { }
if ([string]::IsNullOrWhiteSpace($root)) { $root = "D:\Repositories\eigen" }

$dir = Join-Path $root (Join-Path ".opencode/swarm/briefs" $SwarmId)
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Output (Resolve-Path $dir).Path
