param(
  [Parameter(Mandatory = $true)]
  [string]$File
)

# Validate a lane envelope file: must contain all four headings
# Status:/Mutations:/Edge-Cases:/Deliverables: and total words <= 300.
# Exit 0 = valid; exit 3 = missing/over (details to stderr).

if ([string]::IsNullOrWhiteSpace($File)) {
  [Console]::Error.WriteLine("usage: check-envelope.ps1 -File <path>")
  exit 3
}
if (-not (Test-Path -LiteralPath $File)) {
  [Console]::Error.WriteLine("missing file: $File")
  exit 3
}

$text = Get-Content -LiteralPath $File -Raw
$need = @("Status:", "Mutations:", "Edge-Cases:", "Deliverables:")
$missing = @($need | Where-Object { $text -notmatch [regex]::Escape($_) })
$words = @($text -split '\s+' | Where-Object { $_ -ne '' }).Count

$errs = @()
foreach ($m in $missing) { $errs += "missing heading: $m" }
if ($words -gt 300) { $errs += "over limit: $words words (max 300)" }

if ($errs.Count -gt 0) {
  foreach ($e in $errs) { [Console]::Error.WriteLine($e) }
  exit 3
}
Write-Output "ok: $words words"
exit 0
