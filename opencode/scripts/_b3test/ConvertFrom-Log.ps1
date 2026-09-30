function ConvertFrom-Log {
    param([Parameter(Mandatory)][string]$Line)
    $m = [regex]::Match($Line, '^\s*(\S+)\s+(\S+)\s*(.*)$')
    if (-not $m.Success) { throw "Unparsable log line: '$Line'" }
    [pscustomobject]@{
        Timestamp = $m.Groups[1].Value
        Level     = $m.Groups[2].Value
        Message   = $m.Groups[3].Value
    }
}
