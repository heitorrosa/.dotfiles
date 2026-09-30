. (Join-Path $PSScriptRoot 'Write-Log.ps1')
. (Join-Path $PSScriptRoot 'Format-Result.ps1')

Write-Log 'hello'

$obj = [pscustomobject]@{ Name = 'hello'; Status = 'ok' }
$output = $obj | Format-Result
Write-Output $output

if ($output -match 'hello') {
    Write-Output 'PASS'
} else {
    Write-Output 'FAIL'
    exit 1
}
