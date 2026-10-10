#Requires -Version 5.1
# pwsh shim for verify-package.sh — release-time only, not wired at runtime.
# Prefers bash when available (CI parity), else minimal npm pack smoke check.
$sh = Join-Path $PSScriptRoot 'verify-package.sh'
if (Get-Command bash -ErrorAction SilentlyContinue) { & bash $sh; exit $LASTEXITCODE }
npm pack --dry-run --silent | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error 'FAIL: npm pack dry-run failed'; exit 1 }
Write-Output 'Package dry-run OK (pwsh shim; full allowlist check runs under bash CI).'
