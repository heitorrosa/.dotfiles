function Format-Result {
    param(
        [Parameter(Mandatory = $true, ValueFromPipeline = $true)]
        $InputObject
    )
    process {
        $InputObject | Format-Table | Out-String
    }
}
