function Format-LogReport {
    param([Parameter(Mandatory)][array]$Rows)
    $wTs  = 'Timestamp'.Length; $wLv = 'Level'.Length; $wMsg = 'Message'.Length
    foreach ($r in $Rows) {
        if ($r.Timestamp.Length -gt $wTs)  { $wTs  = $r.Timestamp.Length }
        if ($r.Level.Length -gt $wLv)      { $wLv  = $r.Level.Length }
        if ($r.Message.Length -gt $wMsg)   { $wMsg = $r.Message.Length }
    }
    $fmt = "{0,-${wTs}}  {1,-${wLv}}  {2,-${wMsg}}"
    @(
        ($fmt -f 'Timestamp', 'Level', 'Message')
        ($fmt -f ('-'*$wTs), ('-'*$wLv), ('-'*$wMsg))
        foreach ($r in $Rows) { $fmt -f $r.Timestamp, $r.Level, $r.Message }
    ) -join "`r`n"
}
