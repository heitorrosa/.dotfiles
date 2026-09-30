. "$PSScriptRoot/ConvertFrom-Log.ps1"
. "$PSScriptRoot/Format-LogReport.ps1"

$fail = 0
function Assert($cond, $name) {
    if ($cond) { Write-Output "PASS: $name" } else { $fail++; Write-Output "FAIL: $name" }
}

$r = ConvertFrom-Log '2026-09-17T10:00:00 INFO Server started'
Assert ($r.Timestamp -eq '2026-09-17T10:00:00') 'TS parsed'
Assert ($r.Level -eq 'INFO') 'LEVEL parsed'
Assert ($r.Message -eq 'Server started') 'MSG parsed'

$r2 = ConvertFrom-Log '2026-09-17T10:01:00 ERROR Disk full on C:'
Assert ($r2.Level -eq 'ERROR' -and $r2.Message -eq 'Disk full on C:') 'MSG with spaces'

$rows = @($r, $r2)
$report = Format-LogReport $rows
Assert ($report -match 'Timestamp' -and $report -match 'Server started' -and $report -match 'Disk full') 'table renders rows'

Write-Output "`n--- demo report ---"
Write-Output $report

if ($fail) { Write-Output "`n$fail check(s) FAILED"; exit 1 } else { Write-Output "`nAll checks passed" }
